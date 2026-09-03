/**
 * REST API 的行为。
 *
 * 重点是那个正在咬人的问题：整包读→改→整包写 = 最后写入者全覆盖。
 * 下面「两个人同时改」那几项就是在验它真的修掉了。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTestDb, testEnv, seedUsers } from "./helpers/d1.mjs";
import { handleApi } from "../src/api.js";

const USER = { email: "rasafoodhubplt@gmail.com", name: "Rasa Admin", role: "admin" };
const OTHER = { email: "ahkit@example.com", name: "Ah Kit", role: "staff" };

function setup() {
  const db = createTestDb();
  seedUsers(db, [
    { email: USER.email, name: USER.name, role: "admin", is_active: 1 },
    { email: OTHER.email, name: OTHER.name, role: "staff", is_active: 1 },
  ]);
  return { db, env: testEnv(db) };
}

/** 直接打 handleApi，跳过 Access 验证（那一层由 worker.test.mjs 顾） */
async function call(env, method, path, body, user = USER) {
  const url = new URL(`https://crm.rasafoodhub.com${path}`);
  const request = new Request(url, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  const res = await handleApi(request, env, url, user);
  let json = null;
  try {
    json = JSON.parse(await res.text());
  } catch {
    /* 没有 body */
  }
  return { status: res.status, body: json };
}

const customer = (over = {}) => ({
  id: "c1",
  name: "Nurul Aisyah",
  whatsapp: "+60 12-345 6789",
  stage: "new",
  priority: "medium",
  tags: [],
  timeline: [],
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

/* ------------------------------ 基本读写 ------------------------------ */

test("建立顾客之后读得回来，形状跟前端要的一样", async () => {
  const { env } = setup();
  const created = await call(env, "POST", "/api/customers", { customer: customer() });
  assert.equal(created.status, 201);

  const got = await call(env, "GET", "/api/customers/c1");
  assert.equal(got.status, 200);
  assert.equal(got.body.customer.name, "Nurul Aisyah");
  // 画面上显示的是员工输入的原样字串，不是正规化的结果
  assert.equal(got.body.customer.whatsapp, "+60 12-345 6789");
  assert.ok(Array.isArray(got.body.customer.tags));
  assert.ok(Array.isArray(got.body.customer.timeline));
});

test("电话存的时候就正规化好了，之后的比对才不会歪", async () => {
  const { db, env } = setup();
  await call(env, "POST", "/api/customers", { customer: customer({ whatsapp: "012-345 6789" }) });
  const row = db._row("SELECT phone, phone_raw FROM customers WHERE id='c1'");
  assert.equal(row.phone, "60123456789");
  assert.equal(row.phone_raw, "012-345 6789");
});

test("电话搜寻容错：国码、空格、横线、开头 0 都找得到同一个人", async () => {
  const { env } = setup();
  await call(env, "POST", "/api/customers", { customer: customer({ whatsapp: "+60 12-345 6789" }) });
  for (const q of ["0123456789", "60123456789", "123456789", "+60123456789"]) {
    const r = await call(env, "GET", `/api/customers?search=${encodeURIComponent(q)}`);
    assert.equal(r.body.customers.length, 1, `搜「${q}」应该找得到`);
  }
});

/* --------------------- 并发：这次要修的那个问题 --------------------- */

test("两个人同时改不同顾客，两边的改动都还在", async () => {
  const { env } = setup();
  await call(env, "POST", "/api/customers", { customer: customer({ id: "A", name: "顾客 A" }) });
  await call(env, "POST", "/api/customers", { customer: customer({ id: "B", name: "顾客 B" }) });

  // 两个分页各自读到自己的那一份
  const aBefore = (await call(env, "GET", "/api/customers/A")).body.customer;
  const bBefore = (await call(env, "GET", "/api/customers/B")).body.customer;

  // 各改各的，交错送出
  const r1 = await call(env, "PATCH", "/api/customers/A",
    { patch: { stage: "verifying" }, updatedAt: aBefore.updatedAt }, USER);
  const r2 = await call(env, "PATCH", "/api/customers/B",
    { patch: { priority: "high" }, updatedAt: bBefore.updatedAt }, OTHER);

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);

  const a = (await call(env, "GET", "/api/customers/A")).body.customer;
  const b = (await call(env, "GET", "/api/customers/B")).body.customer;
  assert.equal(a.stage, "verifying", "A 的改动被盖掉了");
  assert.equal(b.priority, "high", "B 的改动被盖掉了");
  assert.equal(a.name, "顾客 A");
  assert.equal(b.name, "顾客 B");
});

test("同一位顾客同一栏位同时改，第二个人收到 409 而不是默默覆盖", async () => {
  const { env } = setup();
  await call(env, "POST", "/api/customers", { customer: customer() });

  // 两边都先读，拿到同一个 updatedAt
  const read1 = (await call(env, "GET", "/api/customers/c1")).body.customer;
  const read2 = (await call(env, "GET", "/api/customers/c1")).body.customer;
  assert.equal(read1.updatedAt, read2.updatedAt);

  const first = await call(env, "PATCH", "/api/customers/c1",
    { patch: { stage: "verifying" }, updatedAt: read1.updatedAt }, USER);
  assert.equal(first.status, 200);

  const second = await call(env, "PATCH", "/api/customers/c1",
    { patch: { stage: "closed" }, updatedAt: read2.updatedAt }, OTHER);
  assert.equal(second.status, 409, "第二次写入应该被挡下来");
  assert.equal(second.body.error, "conflict");
  // 而且要把目前的资料一起给回去，前端才知道该载入什么
  assert.equal(second.body.current.stage, "verifying");

  // 第一个人的改动完好
  const now = (await call(env, "GET", "/api/customers/c1")).body.customer;
  assert.equal(now.stage, "verifying");
});

test("同一毫秒内的两次写入，锁一样挡得住", async () => {
  const { env } = setup();
  await call(env, "POST", "/api/customers", { customer: customer() });
  const read = (await call(env, "GET", "/api/customers/c1")).body.customer;

  // Date.now() 停在同一毫秒，模拟两个请求挤在一起
  const realNow = Date.now;
  Date.now = () => 1788000000000;
  const RealDate = global.Date;
  global.Date = class extends RealDate {
    constructor(...a) {
      super(...(a.length ? a : [1788000000000]));
    }
    static now() {
      return 1788000000000;
    }
  };
  try {
    const a = await call(env, "PATCH", "/api/customers/c1",
      { patch: { priority: "high" }, updatedAt: read.updatedAt });
    const b = await call(env, "PATCH", "/api/customers/c1",
      { patch: { priority: "low" }, updatedAt: read.updatedAt });
    assert.equal(a.status, 200);
    assert.equal(b.status, 409, "同一毫秒的第二次写入也要挡");
  } finally {
    global.Date = RealDate;
    Date.now = realNow;
  }
});

test("PATCH 没带 updatedAt 就拒收 —— 不给「无条件覆盖」这条路", async () => {
  const { env } = setup();
  await call(env, "POST", "/api/customers", { customer: customer() });
  const r = await call(env, "PATCH", "/api/customers/c1", { patch: { stage: "closed" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "updated_at_required");
});

test("PATCH 只动送来的栏位，其它栏位原封不动", async () => {
  const { env } = setup();
  await call(env, "POST", "/api/customers", {
    customer: customer({ notes: "别打给他，只能传讯息", machineId: "RFH-204", tags: ["回头客"] }),
  });
  const before = (await call(env, "GET", "/api/customers/c1")).body.customer;

  await call(env, "PATCH", "/api/customers/c1",
    { patch: { stage: "verifying" }, updatedAt: before.updatedAt });

  const after = (await call(env, "GET", "/api/customers/c1")).body.customer;
  assert.equal(after.stage, "verifying");
  assert.equal(after.notes, "别打给他，只能传讯息");
  assert.equal(after.machineId, "RFH-204");
  assert.deepEqual(after.tags, ["回头客"]);
});

test("写入会记下是谁改的", async () => {
  const { db, env } = setup();
  await call(env, "POST", "/api/customers", { customer: customer() });
  const before = (await call(env, "GET", "/api/customers/c1")).body.customer;
  await call(env, "PATCH", "/api/customers/c1",
    { patch: { stage: "verifying" }, updatedAt: before.updatedAt }, OTHER);
  assert.equal(db._row("SELECT updated_by FROM customers WHERE id='c1'").updated_by, OTHER.email);
});

/* ----------------------- 筛选与排序都在 SQL ----------------------- */

async function seedMany(env, n = 30) {
  const stages = ["new", "verifying", "pending_remote", "closed", "dormant"];
  for (let i = 0; i < n; i++) {
    await call(env, "POST", "/api/customers", {
      customer: customer({
        id: `c${String(i).padStart(3, "0")}`,
        name: `顾客 ${i}`,
        stage: stages[i % stages.length],
        priority: i % 3 === 0 ? "high" : "medium",
        needsReply: i % 2 === 0,
        tags: i % 6 === 0 ? ["回头客", "夜班"] : ["夜班"],
        lastMessageAt: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
        updatedAt: `2026-09-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      }),
    });
  }
}

test("三个筛选条件 + 排序，回来的每一笔都真的符合条件", async () => {
  const { env } = setup();
  await seedMany(env);

  const r = await call(env, "GET",
    "/api/customers?stage=verifying&priority=high&needsReply=1&tag=%E5%9B%9E%E5%A4%B4%E5%AE%A2&sort=oldestContact");
  assert.equal(r.status, 200);
  assert.ok(r.body.customers.length > 0, "条件太严，没有资料可验");
  for (const c of r.body.customers) {
    assert.equal(c.stage, "verifying");
    assert.equal(c.priority, "high");
    assert.equal(c.needsReply, true);
    assert.ok(c.tags.includes("回头客"));
  }
  // oldestContact = 最后讯息时间由旧到新
  const times = r.body.customers.map((c) => c.lastMessageAt || "");
  assert.deepEqual(times, [...times].sort());
});

test("排除标签是真的 SQL 条件，不是捞回来再过滤", async () => {
  const { env } = setup();
  await seedMany(env);
  const r = await call(env, "GET", "/api/customers?excludeTag=%E5%9B%9E%E5%A4%B4%E5%AE%A2");
  assert.ok(r.body.customers.length > 0);
  for (const c of r.body.customers) assert.ok(!c.tags.includes("回头客"));
});

test("cursor 分页：翻完整份名单不重复、不遗漏", async () => {
  const { env } = setup();
  await seedMany(env, 30);

  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const qs = new URLSearchParams({ limit: "7", sort: "updatedAt" });
    if (cursor) qs.set("cursor", cursor);
    const r = await call(env, "GET", `/api/customers?${qs}`);
    seen.push(...r.body.customers.map((c) => c.id));
    cursor = r.body.nextCursor;
    pages += 1;
    assert.ok(pages < 20, "分页停不下来");
  } while (cursor);

  assert.equal(seen.length, 30, "总数对不上");
  assert.equal(new Set(seen).size, 30, "有重复的资料");
});

test("每阶段人数是 GROUP BY 算的，不是把整库捞回前端数", async () => {
  const { env } = setup();
  await seedMany(env, 30);
  const r = await call(env, "GET", "/api/stage-counts");
  assert.equal(r.status, 200);
  const total = Object.values(r.body.counts).reduce((a, b) => a + b, 0);
  assert.equal(total, 30);
  assert.equal(r.body.counts.verifying, 6);
});

test("软合并的记录预设不出现在列表里，资料还在", async () => {
  const { env } = setup();
  await call(env, "POST", "/api/customers", { customer: customer({ id: "main" }) });
  await call(env, "POST", "/api/customers", { customer: customer({ id: "dup" }) });
  const dup = (await call(env, "GET", "/api/customers/dup")).body.customer;
  await call(env, "PATCH", "/api/customers/dup",
    { patch: { mergedInto: "main" }, updatedAt: dup.updatedAt });

  const list = await call(env, "GET", "/api/customers");
  assert.deepEqual(list.body.customers.map((c) => c.id), ["main"]);
  // 但资料没有被删掉
  assert.equal((await call(env, "GET", "/api/customers/dup")).status, 200);
  const withMerged = await call(env, "GET", "/api/customers?includeMerged=1");
  assert.equal(withMerged.body.customers.length, 2);
});

/* ------------------------------ 时间轴 ------------------------------ */

test("时间轴写进 messages / notes，读出来还是原本那一条", async () => {
  const { db, env } = setup();
  await call(env, "POST", "/api/customers", {
    customer: customer({
      timeline: [
        { id: "t1", at: "2026-08-01T00:00:00.000Z", by: "系统", type: "message", text: "顾客来讯" },
        { id: "t2", at: "2026-08-02T00:00:00.000Z", by: "Rasa Admin", type: "note", text: "已回电" },
      ],
    }),
  });

  assert.equal(db._rows("SELECT * FROM messages").length, 1);
  assert.equal(db._rows("SELECT * FROM notes").length, 1);

  const c = (await call(env, "GET", "/api/customers/c1")).body.customer;
  // 新的在前面，跟原本前端 unshift 的顺序一样
  assert.deepEqual(c.timeline.map((e) => e.id), ["t2", "t1"]);
  assert.equal(c.timeline[0].type, "note");
  assert.equal(c.timeline[1].type, "message");
  assert.equal(c.timeline[1].by, "系统");
});

test("同一批时间轴送两次不会变成两笔", async () => {
  const { db, env } = setup();
  await call(env, "POST", "/api/customers", { customer: customer() });
  const before = (await call(env, "GET", "/api/customers/c1")).body.customer;
  const entry = { id: "t1", at: "2026-08-01T00:00:00.000Z", by: "系统", type: "message", text: "hi" };

  await call(env, "PATCH", "/api/customers/c1",
    { patch: {}, updatedAt: before.updatedAt, timeline: [entry] });
  const mid = (await call(env, "GET", "/api/customers/c1")).body.customer;
  await call(env, "PATCH", "/api/customers/c1",
    { patch: {}, updatedAt: mid.updatedAt, timeline: [entry] });

  assert.equal(db._rows("SELECT * FROM messages").length, 1);
});

test("汇总时间是重算出来的，而且不会把时间往回拨", async () => {
  const { db, env } = setup();
  await call(env, "POST", "/api/customers", { customer: customer() });
  const c0 = (await call(env, "GET", "/api/customers/c1")).body.customer;

  await call(env, "PATCH", "/api/customers/c1", {
    patch: {}, updatedAt: c0.updatedAt,
    timeline: [{ id: "t2", at: "2026-08-20T00:00:00.000Z", by: "顾客", type: "message", text: "新的" }],
  });
  assert.equal(
    db._row("SELECT last_message_at FROM customers WHERE id='c1'").last_message_at,
    "2026-08-20T00:00:00.000Z"
  );

  // 之后回补一则更旧的历史讯息 —— last_message_at 不可以被拉回去
  const c1 = (await call(env, "GET", "/api/customers/c1")).body.customer;
  await call(env, "PATCH", "/api/customers/c1", {
    patch: {}, updatedAt: c1.updatedAt,
    timeline: [{ id: "t1", at: "2026-05-01T00:00:00.000Z", by: "顾客", type: "message", text: "很久以前" }],
  });
  assert.equal(
    db._row("SELECT last_message_at FROM customers WHERE id='c1'").last_message_at,
    "2026-08-20T00:00:00.000Z",
    "时间被往回拨了 —— 这会让顾客错误掉进「很久没联络」的自动化"
  );
});

test("单一顾客的讯息可以 cursor 分页", async () => {
  const { env } = setup();
  await call(env, "POST", "/api/customers", { customer: customer() });
  const before = (await call(env, "GET", "/api/customers/c1")).body.customer;
  const timeline = Array.from({ length: 12 }, (_, i) => ({
    id: `m${String(i).padStart(2, "0")}`,
    at: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    by: "顾客", type: "message", text: `第 ${i} 则`,
  }));
  await call(env, "PATCH", "/api/customers/c1", { patch: {}, updatedAt: before.updatedAt, timeline });

  const seen = [];
  let cursor = null;
  do {
    const qs = new URLSearchParams({ limit: "5" });
    if (cursor) qs.set("cursor", cursor);
    const r = await call(env, "GET", `/api/customers/c1/messages?${qs}`);
    seen.push(...r.body.messages.map((m) => m.id));
    cursor = r.body.nextCursor;
  } while (cursor);

  assert.equal(seen.length, 12);
  assert.equal(new Set(seen).size, 12);
});

/* ----------------------- 活动纪录与设定 ----------------------- */

test("活动纪录只新增不覆盖，两个人各自的操作都留得下来", async () => {
  const { env } = setup();
  await call(env, "POST", "/api/activities", {
    activities: [{ id: "a1", at: "2026-09-01T10:00:00.000Z", actor: "Rasa Admin", action: "换阶段" }],
  }, USER);
  await call(env, "POST", "/api/activities", {
    activities: [{ id: "a2", at: "2026-09-01T10:00:01.000Z", actor: "Ah Kit", action: "加纪录" }],
  }, OTHER);

  const r = await call(env, "GET", "/api/activities");
  assert.equal(r.body.activities.length, 2);
  assert.deepEqual(r.body.activities.map((a) => a.id), ["a2", "a1"]);
});

test("同一批活动纪录送两次不会变成两笔", async () => {
  const { env } = setup();
  const batch = { activities: [{ id: "a1", at: "2026-09-01T10:00:00.000Z", actor: "X", action: "Y" }] };
  await call(env, "POST", "/api/activities", batch);
  await call(env, "POST", "/api/activities", batch);
  assert.equal((await call(env, "GET", "/api/activities")).body.activities.length, 1);
});

test("设定拆成多个 key：改 AI 知识库不会盖掉别人改的群发名单", async () => {
  const { env } = setup();
  await call(env, "PUT", "/api/settings/apps.ai", { value: JSON.stringify({ product: "第一版" }) });
  await call(env, "PUT", "/api/settings/apps.campaigns", { value: JSON.stringify([{ id: "cp1" }]) });

  const ai = await call(env, "GET", "/api/settings/apps.ai");
  await call(env, "PUT", "/api/settings/apps.ai",
    { value: JSON.stringify({ product: "第二版" }), updatedAt: ai.body.updatedAt }, OTHER);

  const both = await call(env, "GET", "/api/settings?keys=apps.ai,apps.campaigns");
  assert.equal(JSON.parse(both.body.settings["apps.ai"].value).product, "第二版");
  assert.equal(JSON.parse(both.body.settings["apps.campaigns"].value)[0].id, "cp1");
});

test("设定也有乐观锁", async () => {
  const { env } = setup();
  await call(env, "PUT", "/api/settings/apps.ai", { value: "{}" });
  const read = await call(env, "GET", "/api/settings/apps.ai");

  const a = await call(env, "PUT", "/api/settings/apps.ai",
    { value: JSON.stringify({ v: 1 }), updatedAt: read.body.updatedAt });
  const b = await call(env, "PUT", "/api/settings/apps.ai",
    { value: JSON.stringify({ v: 2 }), updatedAt: read.body.updatedAt });
  assert.equal(a.status, 200);
  assert.equal(b.status, 409);
});

/* --------------------------- 挡下乱来的请求 --------------------------- */

test("PATCH 塞不进白名单以外的栏位", async () => {
  const { db, env } = setup();
  await call(env, "POST", "/api/customers", { customer: customer() });
  const before = (await call(env, "GET", "/api/customers/c1")).body.customer;
  const r = await call(env, "PATCH", "/api/customers/c1", {
    patch: { stage: "verifying", updated_by: "hacker@example.com", id: "别人" },
    updatedAt: before.updatedAt,
  });
  assert.equal(r.status, 200);
  const row = db._row("SELECT id, updated_by FROM customers WHERE id='c1'");
  assert.equal(row.id, "c1");
  assert.equal(row.updated_by, USER.email);
});

test("搜寻字串里的 % 是字面意思，不会整库全中", async () => {
  const { env } = setup();
  await call(env, "POST", "/api/customers", { customer: customer({ id: "a", name: "阿明" }) });
  await call(env, "POST", "/api/customers", { customer: customer({ id: "b", name: "50%折扣" }) });
  const r = await call(env, "GET", "/api/customers?search=%25");
  assert.equal(r.body.customers.length, 1);
  assert.equal(r.body.customers[0].id, "b");
});

test("乱七八糟的 id 会被挡", async () => {
  const { env } = setup();
  const r = await call(env, "GET", "/api/customers/" + encodeURIComponent("../../etc/passwd"));
  assert.equal(r.status, 400);
});

test("重复的 id 回 409，不是一个看不懂的 500", async () => {
  const { env } = setup();
  assert.equal((await call(env, "POST", "/api/customers", { customer: customer() })).status, 201);
  const again = await call(env, "POST", "/api/customers", { customer: customer({ name: "另一个人" }) });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "already_exists");
  // 原本那笔不会被动到
  assert.equal((await call(env, "GET", "/api/customers/c1")).body.customer.name, "Nurul Aisyah");
});

test("没这个人回 404", async () => {
  const { env } = setup();
  assert.equal((await call(env, "GET", "/api/customers/nobody")).status, 404);
});

test("没绑 D1 时回 500，而不是抛例外", async () => {
  const r = await call(testEnv(null, { DB: null }), "GET", "/api/customers");
  assert.equal(r.status, 500);
  assert.equal(r.body.error, "db_not_bound");
});
