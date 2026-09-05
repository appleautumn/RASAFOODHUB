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
  NICKNAME_TAG,
  SYSTEM_ACTOR,
} from "../src/whatsapp.js";

const SECRET = "bridge-secret-for-tests";

// wrangler 的 [define] 编译期常数。正式产物固定 false，测试里也一样 ——
// 本机开发身分不该在这些测试里生效。
globalThis.__ALLOW_DEV_IDENTITY__ = false;

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
  // name 目前是 WhatsApp 暱称，标起来 —— 顾客填了表格才知道真名
  assert.deepEqual(tags.sort(), [NEW_MESSAGE_TAG, NICKNAME_TAG].sort());
});

test("没有暱称就不标「暱称待确认」—— name 本来就是空的", async () => {
  const db = createTestDb();
  await ingestMessage(db, msg({ pushName: "" }));
  const c = db._row("SELECT * FROM customers");
  const tags = db._rows("SELECT tag FROM customer_tags WHERE customer_id = ?", c.id).map((t) => t.tag);
  assert.deepEqual(tags, [NEW_MESSAGE_TAG]);
});

test("顾客在表格里写的名字盖过暱称，而且只盖这一次", async () => {
  const db = createTestDb();
  const first = await ingestMessage(db, msg({ id: "m1", pushName: "Ali" }));
  assert.equal(db._row("SELECT * FROM customers").name, "Ali");

  await ingestMessage(db, msg({ id: "m2", text: "Name : Ali bin Ahmad" }));
  assert.equal(db._row("SELECT * FROM customers").name, "Ali bin Ahmad");
  const tags = db._rows("SELECT tag FROM customer_tags WHERE customer_id = ?", first.customerId).map((t) => t.tag);
  assert.equal(tags.includes(NICKNAME_TAG), false, "填过一次就该拿掉标签");

  // 之后重发的旧表格不该再改名字
  await ingestMessage(db, msg({ id: "m3", text: "Name : Someone Else" }));
  assert.equal(db._row("SELECT * FROM customers").name, "Ali bin Ahmad");
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

test("/api/wa/send 对不存在的顾客回 404", async () => {
  const db = createTestDb();
  const res = await worker.fetch(
    post("/api/wa/send", { customerId: "nope", body: "hi" }, withSecret()),
    env(db)
  );
  assert.equal(res.status, 404);
});

/* ================== 「WhatsApp 连接」页的管理端点 ================== */

/**
 * 这两条走 Access 使用者身分，不是 X-Bridge-Secret。
 * 测试要用带 JWT 的请求，所以借 worker.test.mjs 那套签章工具。
 */

const ADMIN = "admin@rasafoodhub.com";
const STAFF = "staff@rasafoodhub.com";

const KID = "wa-admin-kid";
const TEAM = "rasafoodhub.cloudflareaccess.com";
const AUD = "test-aud-tag";

const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"]
);
const pubJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
const jwksBody = JSON.stringify({ keys: [{ kty: "RSA", alg: "RS256", use: "sig", kid: KID, n: pubJwk.n, e: pubJwk.e }] });

const b64 = (o) => Buffer.from(new TextEncoder().encode(JSON.stringify(o))).toString("base64url");

async function jwtFor(email) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: "RS256", kid: KID, typ: "JWT" })}.${b64({
    iss: `https://${TEAM}`, aud: [AUD], email, iat: now - 5, exp: now + 3600,
  })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(new Uint8Array(sig)).toString("base64url")}`;
}

/** db 里放好 admin 与 staff，并把 fetch 换成可控的替身 */
function adminEnv(db, { bridge, url = "https://bridge.test", secret = "s3cret" } = {}) {
  db._exec(`INSERT OR REPLACE INTO users (email, name, role, is_active) VALUES
    ('${ADMIN}', 'Admin', 'admin', 1), ('${STAFF}', 'Staff', 'staff', 1)`);

  globalThis.fetch = async (target, init) => {
    // Access 验证会去抓 JWKS
    if (String(target).includes("/cdn-cgi/access/certs")) return new Response(jwksBody);
    return bridge(String(target), init);
  };

  return { ...env(db), ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, WA_BRIDGE_URL: url, WA_BRIDGE_SECRET: secret };
}

const asUser = async (path, email, method = "GET") =>
  new Request(`https://x.workers.dev${path}`, {
    method,
    headers: { "Cf-Access-Jwt-Assertion": await jwtFor(email) },
  });

test("staff 打 /api/wa/qr 会被挡，而且不会去碰桥接机", async () => {
  const db = createTestDb();
  let touched = false;
  const e = adminEnv(db, { bridge: async () => { touched = true; return new Response("", { status: 200 }); } });

  const res = await worker.fetch(await asUser("/api/wa/qr", STAFF), e);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "forbidden");
  assert.equal(touched, false, "staff 的请求不该转发到桥接机");
});

test("staff 打 /api/wa/reconnect 一样被挡", async () => {
  const db = createTestDb();
  const e = adminEnv(db, { bridge: async () => new Response("", { status: 200 }) });
  const res = await worker.fetch(await asUser("/api/wa/reconnect", STAFF, "POST"), e);
  assert.equal(res.status, 403);
});

test("admin 拿得到 QR 图片，而且 secret 不会外流给浏览器", async () => {
  const db = createTestDb();
  let seenHeaders = null;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const e = adminEnv(db, {
    bridge: async (target, init) => {
      seenHeaders = init?.headers || {};
      assert.match(target, /\/qr$/);
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    },
  });

  const res = await worker.fetch(await asUser("/api/wa/qr", ADMIN), e);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("cache-control"), "no-store", "QR 会过期，不能被快取");

  // Worker 有带 secret 去问桥接机
  assert.equal(seenHeaders["X-Bridge-Secret"], "s3cret");
  // 但回给浏览器的东西完全不含 secret
  const body = Buffer.from(await res.arrayBuffer()).toString("utf8");
  assert.ok(!body.includes("s3cret"), "secret 外流到浏览器了");
  for (const [, v] of res.headers) assert.ok(!String(v).includes("s3cret"), "secret 出现在回应标头");
});

test("桥接机说已连线时，回 JSON 带号码而不是图片", async () => {
  const db = createTestDb();
  const e = adminEnv(db, {
    bridge: async () =>
      new Response(JSON.stringify({ ok: false, error: "already_connected", phone: "60123456789" }), {
        status: 409, headers: { "content-type": "application/json" },
      }),
  });
  const body = await (await worker.fetch(await asUser("/api/wa/qr", ADMIN), e)).json();
  assert.equal(body.connected, true);
  assert.equal(body.phone, "60123456789");
});

test("QR 还没产生时回「等待中」，不是错误", async () => {
  const db = createTestDb();
  const e = adminEnv(db, {
    bridge: async () =>
      new Response(JSON.stringify({ ok: false, error: "qr_not_ready", state: "connecting" }), {
        status: 503, headers: { "content-type": "application/json" },
      }),
  });
  const res = await worker.fetch(await asUser("/api/wa/qr", ADMIN), e);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.connected, false);
  assert.equal(body.waiting, true);
  assert.equal(body.state, "connecting");
});

test("桥接机连不上时回 502，讲清楚是桥接机的问题", async () => {
  const db = createTestDb();
  const e = adminEnv(db, { bridge: async () => { throw new Error("connect ECONNREFUSED"); } });
  const res = await worker.fetch(await asUser("/api/wa/qr", ADMIN), e);
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "bridge_unreachable");
});

test("没设 WA_BRIDGE_URL 时回 503，跟机器端同一条规则", async () => {
  const db = createTestDb();
  const e = adminEnv(db, { bridge: async () => new Response("", { status: 200 }) });
  delete e.WA_BRIDGE_URL;
  const res = await worker.fetch(await asUser("/api/wa/qr", ADMIN), e);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "bridge_not_configured");
});

test("reconnect 会带上二次确认参数送给桥接机", async () => {
  const db = createTestDb();
  let sent = null;
  const e = adminEnv(db, {
    bridge: async (target, init) => {
      assert.match(target, /\/reset-auth$/);
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true, reset: true, state: "waiting_qr" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });
  const body = await (await worker.fetch(await asUser("/api/wa/reconnect", ADMIN, "POST"), e)).json();
  assert.equal(body.ok, true);
  assert.equal(body.reset, true);
  assert.equal(sent.confirm, "i-mean-it", "少了防呆参数，桥接机会拒绝");
});

test("管理端点不吃 X-Bridge-Secret —— 拿到 secret 也进不来", async () => {
  const db = createTestDb();
  const e = adminEnv(db, { bridge: async () => new Response("", { status: 200 }) });
  // 没有 Access JWT，只带机器用的 secret
  const req = new Request("https://x.workers.dev/api/wa/qr", { headers: { "X-Bridge-Secret": "s3cret" } });
  const res = await worker.fetch(req, e);
  assert.equal(res.status, 401, "管理端点必须要求使用者身分");
});

/* ================== /api/wa/send：真的送出（阶段 B） ================== */

/** 机器端点 + 已设定桥接机。fetch 被换掉，不会真的连出去。 */
function sendEnv(db, bridge) {
  globalThis.fetch = async (target, init) => bridge(String(target), init);
  return { ...env(db), WA_BRIDGE_URL: "https://bridge.test", WA_BRIDGE_SECRET: SECRET };
}

const bridgeOk = (id = "3EB0ABC") => async () =>
  new Response(JSON.stringify({ ok: true, id, jid: "60123@s.whatsapp.net" }), {
    status: 200, headers: { "content-type": "application/json" },
  });

const seedCustomer = (db, over = {}) => {
  const c = { id: "cust-1", phone: "60123456789", phone_raw: "012-3456789", merged_into: null, ...over };
  db._exec(`INSERT INTO customers (id, name, phone, phone_raw, updated_at, merged_into)
            VALUES ('${c.id}', 'x', '${c.phone}', '${c.phone_raw}',
                    '2026-01-01T00:00:00.000Z', ${c.merged_into ? `'${c.merged_into}'` : "NULL"})`);
  return c;
};

test("送出时会把顾客号码交给桥接机，并带上 secret", async () => {
  const db = createTestDb();
  seedCustomer(db);
  let seen = null;
  const e = sendEnv(db, async (target, init) => {
    seen = { target, headers: init.headers, body: JSON.parse(init.body) };
    return bridgeOk()();
  });

  const res = await worker.fetch(
    post("/api/wa/send", { customerId: "cust-1", body: "在吗" }, withSecret()), e
  );
  assert.equal(res.status, 200);
  assert.match(seen.target, /\/send$/);
  assert.equal(seen.body.to, "60123456789", "要送到正规化后的号码");
  assert.equal(seen.body.body, "在吗");
  assert.equal(seen.headers["X-Bridge-Secret"], SECRET);
});

test("送出成功后回 delivered:true，并用平台的 message id 记录", async () => {
  const db = createTestDb();
  seedCustomer(db);
  const e = sendEnv(db, bridgeOk("3EB0XYZ"));

  const body = await (await worker.fetch(
    post("/api/wa/send", { customerId: "cust-1", body: "hi", actor: "staff@rasafoodhub.com" }, withSecret()), e
  )).json();

  assert.equal(body.delivered, true);
  assert.equal(body.platformMsgId, "3EB0XYZ");

  const m = db._row("SELECT * FROM messages WHERE direction = 'out'");
  assert.equal(m.id, "wa-3EB0XYZ", "id 要用平台的 id 推出来");
  assert.equal(m.platform_msg_id, "3EB0XYZ");
  assert.equal(m.author, "staff@rasafoodhub.com", "谁按的送出要留痕");
});

test("平台把自己送的讯息推回来时不会变成两笔", async () => {
  const db = createTestDb();
  seedCustomer(db);
  const e = sendEnv(db, bridgeOk("3EB0SAME"));

  await worker.fetch(post("/api/wa/send", { customerId: "cust-1", body: "hi" }, withSecret()), e);
  // 平台稍后以 fromMe 的形式推回同一则
  await ingestMessage(db, msg({ id: "3EB0SAME", fromMe: true, from: "60123456789@s.whatsapp.net", text: "hi" }));

  assert.equal(db._rows("SELECT id FROM messages").length, 1, "同一则被记成两笔了");
});

test("没设定桥接机时回 503，而且不写纪录", async () => {
  const db = createTestDb();
  seedCustomer(db);
  const e = sendEnv(db, bridgeOk());
  delete e.WA_BRIDGE_URL;

  const res = await worker.fetch(post("/api/wa/send", { customerId: "cust-1", body: "hi" }, withSecret()), e);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "bridge_not_configured");
  assert.equal(db._rows("SELECT * FROM messages").length, 0, "没送出去就不该留下已送出的纪录");
});

test("桥接机送失败时回 502，而且不写纪录", async () => {
  const db = createTestDb();
  seedCustomer(db);
  const e = sendEnv(db, async () =>
    new Response(JSON.stringify({ ok: false, error: "send_failed", detail: "还没连线" }), {
      status: 503, headers: { "content-type": "application/json" },
    }));

  const res = await worker.fetch(post("/api/wa/send", { customerId: "cust-1", body: "hi" }, withSecret()), e);
  assert.equal(res.status, 502);
  assert.equal(db._rows("SELECT * FROM messages").length, 0, "送失败却留下纪录，之后没人查得出真相");
});

test("只有隐藏 ID 的顾客送不了，回 409 并说明原因", async () => {
  const db = createTestDb();
  seedCustomer(db, { id: "cust-lid", phone: "", phone_raw: "123456@lid" });
  let touched = false;
  const e = sendEnv(db, async () => { touched = true; return bridgeOk()(); });

  const res = await worker.fetch(post("/api/wa/send", { customerId: "cust-lid", body: "hi" }, withSecret()), e);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "customer_has_no_phone");
  assert.equal(touched, false, "没号码就不该去打桥接机");
});

test("已合并的顾客不再收讯息", async () => {
  const db = createTestDb();
  seedCustomer(db, { id: "cust-main" });
  seedCustomer(db, { id: "cust-dup", phone: "60999888777", merged_into: "cust-main" });
  const e = sendEnv(db, bridgeOk());

  const res = await worker.fetch(post("/api/wa/send", { customerId: "cust-dup", body: "hi" }, withSecret()), e);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "customer_merged");
});

/* ================== /api/wa/test-send：admin 在扫码页试送 ================== */

test("admin 可以试送，staff 不行", async () => {
  const db = createTestDb();
  let sentTo = null;
  const e = adminEnv(db, {
    bridge: async (target, init) => {
      if (target.includes("/send")) { sentTo = JSON.parse(init.body).to; return bridgeOk("3EB0T")(); }
      return new Response("{}", { status: 404 });
    },
  });

  const staffRes = await worker.fetch(await asUser("/api/wa/test-send", STAFF, "POST"), e);
  assert.equal(staffRes.status, 403);
  assert.equal(sentTo, null, "staff 的请求不该送出任何东西");

  const req = new Request("https://x.workers.dev/api/wa/test-send", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": await jwtFor(ADMIN), "content-type": "application/json" },
    body: JSON.stringify({ to: "012-3456789", body: "测试" }),
  });
  const body = await (await worker.fetch(req, e)).json();
  assert.equal(body.sent, true);
  assert.equal(sentTo, "60123456789", "号码要正规化后再送");
});

test("试送不自己写纪录 —— 等 webhook 回来时才收录，避免记成两笔", async () => {
  const db = createTestDb();
  const e = adminEnv(db, { bridge: bridgeOk("3EB0T2") });
  const req = new Request("https://x.workers.dev/api/wa/test-send", {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": await jwtFor(ADMIN), "content-type": "application/json" },
    body: JSON.stringify({ to: "60123456789", body: "测试" }),
  });
  await worker.fetch(req, e);
  assert.equal(db._rows("SELECT * FROM messages").length, 0);
});
