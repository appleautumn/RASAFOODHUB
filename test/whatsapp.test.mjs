import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { createTestDb } from "./helpers/d1.mjs";
import {
  toEpochSeconds,
  parseJid,
  ingestMessage,
  NEW_MESSAGE_TAG,
  NEEDS_PHONE_TAG,
  SYSTEM_ACTOR,
} from "../src/whatsapp.js";

const SECRET = "bridge-secret-for-tests";

const env = (db, overrides = {}) => ({
  DB: db,
  WA_BRIDGE_SECRET: SECRET,
  ACCESS_TEAM_DOMAIN: "rasafoodhub.cloudflareaccess.com",
  ACCESS_AUD: "test-aud-tag",
  REQUIRE_USER_ROW: "true",
  ...overrides,
});

const post = (path, body, headers = {}) =>
  new Request(`https://x.workers.dev${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const withSecret = (secret = SECRET) => ({ "X-Bridge-Secret": secret });

/** 一则合法的进讯，测试各自覆写需要的栏位 */
const msg = (over = {}) => ({
  id: "MSG-1",
  from: "60123456789@s.whatsapp.net",
  fromMe: false,
  text: "hello",
  timestamp: 1712345678,
  pushName: "Ah Kit",
  ...over,
});

/* ========================= 时间戳判读 ========================= */

test("时间戳：数字、字串、Long 物件三种型别都转得对", () => {
  assert.equal(toEpochSeconds(1712345678), 1712345678, "数字");
  assert.equal(toEpochSeconds("1712345678"), 1712345678, "字串");
  // Long：high 是高 32 位元，low 当无号数
  assert.equal(toEpochSeconds({ low: 1712345678, high: 0, unsigned: true }), 1712345678, "Long 物件");
  assert.equal(toEpochSeconds({ toNumber: () => 1712345678 }), 1712345678, "有 toNumber 的物件");
  // 毫秒也认得出来，不会被当成公元 5 万年
  assert.equal(toEpochSeconds(1712345678000), 1712345678, "毫秒");
});

test("时间戳：判读不出来一律回 0，绝不退回「现在」", () => {
  const now = Math.floor(Date.now() / 1000);
  for (const bad of [null, undefined, "", "abc", NaN, Infinity, -1, 0, {}, [], true, false, "12ab"]) {
    const got = toEpochSeconds(bad);
    assert.equal(got, 0, `${JSON.stringify(bad)} 应该回 0，却回了 ${got}`);
    // 这一行才是重点：万一哪天有人「顺手」改成退回现在，这里会立刻red
    assert.ok(Math.abs(got - now) > 1000, `${JSON.stringify(bad)} 被退回成了现在`);
  }
});

test("时间戳判读不出来时，整则讯息被略过 —— 而且什么都没写进去", async () => {
  const db = createTestDb();
  const r = await ingestMessage(db, msg({ timestamp: "not-a-time" }));

  assert.equal(r.status, "skipped");
  assert.equal(r.reason, "bad_timestamp");
  assert.equal(db._rows("SELECT * FROM messages").length, 0, "讯息不该被写进去");
  assert.equal(db._rows("SELECT * FROM customers").length, 0, "顾客也不该被开出来");
});

/* ========================= 幂等 ========================= */

test("同一则讯息送两次，messages 只有一笔", async () => {
  const db = createTestDb();
  const first = await ingestMessage(db, msg());
  const second = await ingestMessage(db, msg());

  assert.equal(first.status, "stored");
  assert.equal(second.status, "duplicate");

  const rows = db._rows("SELECT id, platform_msg_id FROM messages");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "wa-MSG-1");
  assert.equal(rows[0].platform_msg_id, "MSG-1");
  assert.equal(db._rows("SELECT id FROM customers").length, 1, "顾客也不该被开成两位");
});

/* ========================= 号码正规化 ========================= */

test("五种写法全部正规化成同一个号码", () => {
  const forms = [
    "012-3456789",
    "0123456789",
    "60123456789",
    "+60 12-345 6789",
    "60123456789@s.whatsapp.net",
  ];
  const got = forms.map((f) => parseJid(f).phone);
  assert.deepEqual(
    got,
    Array(forms.length).fill("60123456789"),
    `正规化结果不一致：${JSON.stringify(Object.fromEntries(forms.map((f, i) => [f, got[i]])))}`
  );
});

test("带装置编号的 JID 也拿得到号码", () => {
  assert.equal(parseJid("60123456789:12@s.whatsapp.net").phone, "60123456789");
});

test("同一个人用不同写法进来，只会是同一位顾客", async () => {
  const db = createTestDb();
  await ingestMessage(db, msg({ id: "A", from: "60123456789@s.whatsapp.net" }));
  await ingestMessage(db, msg({ id: "B", from: "0123456789" }));

  assert.equal(db._rows("SELECT id FROM customers").length, 1);
  assert.equal(db._rows("SELECT id FROM messages").length, 2);
});

/* ========================= 隐藏 ID（LID） ========================= */

test("只拿得到 LID 时：phone 留空、phone_raw 存 JID、打「待补号码」标签", async () => {
  const db = createTestDb();
  const r = await ingestMessage(db, msg({ id: "L1", from: "1234567890123@lid", pushName: "谁" }));

  assert.equal(r.status, "stored");
  const c = db._row("SELECT * FROM customers");
  assert.equal(c.phone, "", "LID 不该产生任何 phone");
  assert.equal(c.phone_raw, "1234567890123@lid", "画面上要看得出这不是电话");

  const tags = db._rows("SELECT tag FROM customer_tags WHERE customer_id = ?", c.id).map((t) => t.tag);
  assert.ok(tags.includes(NEEDS_PHONE_TAG), `少了「${NEEDS_PHONE_TAG}」标签：${tags}`);
  assert.ok(tags.includes(NEW_MESSAGE_TAG), `少了「${NEW_MESSAGE_TAG}」标签：${tags}`);
});

test("绝对不会拿 LID 拼出一个假号码", async () => {
  const db = createTestDb();
  await ingestMessage(db, msg({ id: "L2", from: "1234567890123@lid" }));
  // 若哪天有人把 LID 丢进 normalizePhone，这里会变成 601234567890123 之类
  const phones = db._rows("SELECT phone FROM customers").map((r) => r.phone);
  assert.deepEqual(phones, [""], `LID 污染了号码栏位：${JSON.stringify(phones)}`);
});

/* ========================= 自动开顾客 ========================= */

test("认不出的号码会自动开一位顾客，带「新讯息」标签", async () => {
  const db = createTestDb();
  const r = await ingestMessage(db, msg());

  assert.equal(r.customerCreated, true);
  const c = db._row("SELECT * FROM customers");
  assert.equal(c.platform, "whatsapp");
  assert.equal(c.stage, "new");
  assert.equal(c.contact_type, "customer");
  assert.equal(c.phone, "60123456789");
  assert.equal(c.updated_by, SYSTEM_ACTOR, "系统写入要标成系统，不要伪装成人");

  const tags = db._rows("SELECT tag FROM customer_tags WHERE customer_id = ?", c.id).map((t) => t.tag);
  assert.deepEqual(tags, [NEW_MESSAGE_TAG]);
});

test("已经存在的顾客不会被重开，讯息挂到既有那位身上", async () => {
  const db = createTestDb();
  db._exec(`INSERT INTO customers (id, name, phone, phone_raw, updated_at)
            VALUES ('cust-1', '旧客', '60123456789', '012-3456789', '2026-01-01T00:00:00.000Z')`);

  const r = await ingestMessage(db, msg());
  assert.equal(r.customerId, "cust-1");
  assert.equal(r.customerCreated, false);
  assert.equal(db._rows("SELECT id FROM customers").length, 1);
  // 正规化不改变使用者看到的东西
  assert.equal(db._row("SELECT phone_raw FROM customers").phone_raw, "012-3456789");
});

/* ========================= 时间只能往前 ========================= */

test("收到较旧的讯息，不会把 last_message_at 往回拨", async () => {
  const db = createTestDb();
  const NEWER = "2026-06-01T00:00:00.000Z";
  db._exec(`INSERT INTO customers (id, name, phone, phone_raw, updated_at,
              last_message_at, last_customer_message_at, last_interaction_at)
            VALUES ('cust-1', '旧客', '60123456789', '012-3456789',
                    '2026-06-01T00:00:00.000Z', '${NEWER}', '${NEWER}', '${NEWER}')`);

  // 2024-04-05 左右，比 NEWER 旧很多
  await ingestMessage(db, msg({ timestamp: 1712345678 }));

  const c = db._row("SELECT * FROM customers");
  assert.equal(c.last_message_at, NEWER, "时间被往回拨了");
  assert.equal(c.last_customer_message_at, NEWER, "时间被往回拨了");
  assert.equal(c.last_interaction_at, NEWER, "时间被往回拨了");
  // 但讯息本身还是要收进来，而且带的是它自己真正的时间
  const m = db._row("SELECT ts FROM messages");
  assert.equal(m.ts, "2024-04-05T19:34:38.000Z");
});

test("收到较新的讯息，时间会往前推", async () => {
  const db = createTestDb();
  const OLDER = "2020-01-01T00:00:00.000Z";
  db._exec(`INSERT INTO customers (id, name, phone, phone_raw, updated_at, last_message_at)
            VALUES ('cust-1', '旧客', '60123456789', '012-3456789',
                    '2020-01-01T00:00:00.000Z', '${OLDER}')`);

  await ingestMessage(db, msg({ timestamp: 1712345678 }));
  assert.equal(db._row("SELECT last_message_at FROM customers").last_message_at,
    "2024-04-05T19:34:38.000Z");
});

test("这个阶段不做任何自动行为：needs_reply / stage 都不会被动到", async () => {
  const db = createTestDb();
  db._exec(`INSERT INTO customers (id, name, phone, phone_raw, updated_at, stage, needs_reply, priority)
            VALUES ('cust-1', '旧客', '60123456789', '012-3456789',
                    '2026-01-01T00:00:00.000Z', 'verifying', 0, 'high')`);

  await ingestMessage(db, msg());

  const c = db._row("SELECT * FROM customers");
  assert.equal(c.needs_reply, 0, "needs_reply 被动到了");
  assert.equal(c.stage, "verifying", "stage 被动到了");
  assert.equal(c.priority, "high", "priority 被动到了");
});

/* ========================= secret 把关 ========================= */

test("WA_BRIDGE_SECRET 没设定 → 503，整组端点是死的", async () => {
  const db = createTestDb();
  for (const missing of [{}, { WA_BRIDGE_SECRET: "" }, { WA_BRIDGE_SECRET: "   " }]) {
    const e = env(db, missing);
    delete e.WA_BRIDGE_SECRET;
    Object.assign(e, missing);
    const res = await worker.fetch(post("/api/wa/webhook", msg(), withSecret()), e);
    assert.equal(res.status, 503, `${JSON.stringify(missing)} 应该回 503`);
    assert.equal((await res.json()).error, "bridge_not_configured");
  }
  assert.equal(db._rows("SELECT * FROM messages").length, 0);
});

test("没带 secret → 401", async () => {
  const db = createTestDb();
  const res = await worker.fetch(post("/api/wa/webhook", msg()), env(db));
  assert.equal(res.status, 401);
  assert.equal(db._rows("SELECT * FROM messages").length, 0);
});

test("secret 错误 → 403，而且什么都没写进去", async () => {
  const db = createTestDb();
  const res = await worker.fetch(
    post("/api/wa/webhook", msg(), withSecret("wrong-secret")),
    env(db)
  );
  assert.equal(res.status, 403);
  assert.equal(db._rows("SELECT * FROM messages").length, 0);
});

test("secret 只差一个字元也挡得住", async () => {
  const db = createTestDb();
  const res = await worker.fetch(
    post("/api/wa/webhook", msg(), withSecret(SECRET + "x")),
    env(db)
  );
  assert.equal(res.status, 403);
});

/* ========================= 端点 ========================= */

test("带对 secret 的 webhook：讯息进 D1", async () => {
  const db = createTestDb();
  const res = await worker.fetch(post("/api/wa/webhook", msg(), withSecret()), env(db));
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.stored, 1);

  const m = db._row("SELECT * FROM messages");
  assert.equal(m.body, "hello");
  assert.equal(m.direction, "in");
  assert.equal(m.platform, "whatsapp");
});

test("一次送多则，逐则回报结果", async () => {
  const db = createTestDb();
  const payload = {
    messages: [
      msg({ id: "M1" }),
      msg({ id: "M2", timestamp: "坏掉的" }),
      msg({ id: "M1" }), // 重复
    ],
  };
  const res = await worker.fetch(post("/api/wa/webhook", payload, withSecret()), env(db));
  const body = await res.json();

  assert.equal(body.received, 3);
  assert.equal(body.stored, 1);
  assert.equal(body.skipped, 1);
  assert.equal(body.duplicate, 1);
  assert.equal(db._rows("SELECT * FROM messages").length, 1);
});

test("fromMe 的讯息记成 out", async () => {
  const db = createTestDb();
  await worker.fetch(post("/api/wa/webhook", msg({ fromMe: true }), withSecret()), env(db));
  const m = db._row("SELECT * FROM messages");
  assert.equal(m.direction, "out");
  assert.equal(m.author, SYSTEM_ACTOR);
  // 出讯不该动到「顾客最后来讯」的时间
  assert.equal(db._row("SELECT last_customer_message_at FROM customers").last_customer_message_at, null);
});

test("/api/wa/status 这阶段回 not_connected", async () => {
  const db = createTestDb();
  const req = new Request("https://x.workers.dev/api/wa/status", { headers: withSecret() });
  const res = await worker.fetch(req, env(db));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.connected, false);
  assert.equal(body.state, "not_connected");
});

test("/api/wa/send 只写纪录，不宣称已送出", async () => {
  const db = createTestDb();
  db._exec(`INSERT INTO customers (id, name, phone, phone_raw, updated_at)
            VALUES ('cust-1', '旧客', '60123456789', '012-3456789', '2026-01-01T00:00:00.000Z')`);

  const res = await worker.fetch(
    post("/api/wa/send", { customerId: "cust-1", body: "在吗", actor: "staff@rasafoodhub.com" }, withSecret()),
    env(db)
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.queued, true);
  assert.equal(body.delivered, false, "这阶段不可以宣称已送达");

  const m = db._row("SELECT * FROM messages WHERE direction = 'out'");
  assert.equal(m.body, "在吗");
  assert.equal(m.author, "staff@rasafoodhub.com", "谁按的送出要留痕");
});

test("/api/wa/send 没指明 actor 就标成系统", async () => {
  const db = createTestDb();
  db._exec(`INSERT INTO customers (id, name, phone, phone_raw, updated_at)
            VALUES ('cust-1', 'x', '60123456789', '012', '2026-01-01T00:00:00.000Z')`);
  await worker.fetch(post("/api/wa/send", { customerId: "cust-1", body: "hi" }, withSecret()), env(db));
  assert.equal(db._row("SELECT author FROM messages").author, SYSTEM_ACTOR);
});

test("/api/wa/send 对不存在的顾客回 404", async () => {
  const db = createTestDb();
  const res = await worker.fetch(
    post("/api/wa/send", { customerId: "nope", body: "hi" }, withSecret()),
    env(db)
  );
  assert.equal(res.status, 404);
});
