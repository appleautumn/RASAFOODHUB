import test from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.mjs";
import {
  planSchedule, readSettings, enqueue, refusalReason, claimDue, processBatch,
  SHADOW_KEY, SPACING_KEY, DAILY_CAP_KEY, DEFAULTS,
} from "../src/outbox.js";

const seedCustomer = (db, over = {}) => {
  const c = {
    id: "c1", phone: "60123456789", contact_type: "customer",
    needs_reply: 0, broadcast_opt_in: 1, merged_into: null, ...over,
  };
  db._exec(`INSERT INTO customers
      (id, name, phone, phone_raw, contact_type, needs_reply, broadcast_opt_in, merged_into, updated_at)
    VALUES ('${c.id}', 'x', '${c.phone}', '012', '${c.contact_type}',
            ${c.needs_reply}, ${c.broadcast_opt_in},
            ${c.merged_into ? `'${c.merged_into}'` : "NULL"}, '2026-01-01T00:00:00.000Z')`);
  return c;
};

const setSetting = (db, key, value) =>
  db._exec(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('${key}', '${value}', '2026-01-01T00:00:00.000Z')`);

/* ========================= 影子模式的预设 ========================= */

test("没设定时预设是影子模式 —— 真发送必须是刻意打开的", async () => {
  const db = createTestDb();
  assert.equal((await readSettings(db)).shadow, true);
});

test("只有明确写 false 才关掉影子模式", async () => {
  const db = createTestDb();
  for (const v of ["true", "", "yes", "0", "乱码", "FALSE "]) {
    setSetting(db, SHADOW_KEY, v);
    const s = await readSettings(db);
    // "FALSE " 去空白转小写之后就是 false，该关
    const expected = v.trim().toLowerCase() !== "false";
    assert.equal(s.shadow, expected, `值 ${JSON.stringify(v)} 判断错了`);
  }
});

test("节流设定坏掉时回预设，不会变成 0", async () => {
  const db = createTestDb();
  setSetting(db, SPACING_KEY, "abc");
  setSetting(db, DAILY_CAP_KEY, "0");
  const s = await readSettings(db);
  assert.equal(s.spacingSeconds, Number(DEFAULTS[SPACING_KEY]), "0 或乱码会让节流失效");
  assert.equal(s.dailyCap, Number(DEFAULTS[DAILY_CAP_KEY]));
});

/* ========================= 排程 ========================= */

test("每则之间隔 spacingSeconds", () => {
  const times = planSchedule({
    count: 3, startFrom: "2026-09-05T00:00:00.000Z", lastScheduledAt: null,
    sentTodayCount: 0, spacingSeconds: 90, dailyCap: 100,
  });
  assert.deepEqual(times, [
    "2026-09-05T00:00:00.000Z",
    "2026-09-05T00:01:30.000Z",
    "2026-09-05T00:03:00.000Z",
  ]);
});

test("接在已排程的最后一则之后，不会跟既有的挤在一起", () => {
  const times = planSchedule({
    count: 2, startFrom: "2026-09-05T00:00:00.000Z",
    lastScheduledAt: "2026-09-05T10:00:00.000Z",
    sentTodayCount: 0, spacingSeconds: 60, dailyCap: 100,
  });
  assert.equal(times[0], "2026-09-05T10:01:00.000Z");
  assert.equal(times[1], "2026-09-05T10:02:00.000Z");
});

test("排满当日上限就推到隔天", () => {
  const times = planSchedule({
    count: 3, startFrom: "2026-09-05T23:00:00.000Z", lastScheduledAt: null,
    sentTodayCount: 1, spacingSeconds: 60, dailyCap: 2,
  });
  assert.match(times[0], /^2026-09-05/);
  assert.match(times[1], /^2026-09-06/, "第 2 则就该跨天了（当天已用 1 + 这批 1 = 上限）");
  assert.match(times[2], /^2026-09-06/);
});

/* ========================= 入列 ========================= */

test("入列会把时间算好写进去，并回报节流参数", async () => {
  const db = createTestDb();
  seedCustomer(db);
  const res = await enqueue(db, {
    items: [{ customerId: "c1", body: "一" }, { customerId: "c1", body: "二" }],
    actor: "staff@rasafoodhub.com",
  });

  assert.equal(res.ok, true);
  assert.equal(res.queued, 2);
  assert.equal(res.shadow, true, "预设该是影子模式");

  const rows = db._rows("SELECT * FROM wa_outbox ORDER BY scheduled_at");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "queued");
  assert.equal(rows[0].created_by, "staff@rasafoodhub.com", "谁排的要留痕");
  assert.notEqual(rows[0].scheduled_at, rows[1].scheduled_at, "两则不能排在同一秒");
});

test("少了 customerId 或 body 就整批拒绝", async () => {
  const db = createTestDb();
  seedCustomer(db);
  const res = await enqueue(db, { items: [{ customerId: "c1", body: "ok" }, { body: "缺 id" }], actor: "x" });
  assert.equal(res.ok, false);
  assert.equal(db._rows("SELECT * FROM wa_outbox").length, 0, "有问题就整批不写，不要写一半");
});

/* ========================= 送出前重查 ========================= */

test("这些状态一律不送", () => {
  const base = { phone: "60123", contact_type: "customer", needs_reply: 0, broadcast_opt_in: 1, merged_into: null };
  assert.equal(refusalReason(null), "customer_not_found");
  assert.match(refusalReason({ ...base, merged_into: "c9" }), /已合并/);
  assert.match(refusalReason({ ...base, contact_type: "supplier" }), /contact_type/);
  assert.match(refusalReason({ ...base, phone: "" }), /没有可拨的号码/);
  assert.match(refusalReason({ ...base, broadcast_opt_in: 0 }), /broadcast_opt_in/);
  assert.match(refusalReason({ ...base, needs_reply: 1 }), /等回覆/);
  assert.equal(refusalReason(base), null, "都正常时应该放行");
});

/* ========================= 原子性取件 ========================= */

test("只取到点的，还没到的不动", async () => {
  const db = createTestDb();
  seedCustomer(db);
  db._exec(`INSERT INTO wa_outbox (id, customer_id, body, scheduled_at, created_at) VALUES
    ('a','c1','早','2026-09-05T00:00:00.000Z','2026-09-05T00:00:00.000Z'),
    ('b','c1','晚','2099-01-01T00:00:00.000Z','2026-09-05T00:00:00.000Z')`);

  const rows = await claimDue(db, { now: "2026-09-05T12:00:00.000Z" });
  assert.deepEqual(rows.map((r) => r.id), ["a"]);
  assert.equal(db._row("SELECT status FROM wa_outbox WHERE id='b'").status, "queued", "还没到点的不该被动");
});

test("取过的不会被再取一次 —— 两个 cron 同时跑也不会重送", async () => {
  const db = createTestDb();
  seedCustomer(db);
  db._exec(`INSERT INTO wa_outbox (id, customer_id, body, scheduled_at, created_at) VALUES
    ('a','c1','x','2026-09-05T00:00:00.000Z','2026-09-05T00:00:00.000Z')`);

  const first = await claimDue(db, { now: "2026-09-05T12:00:00.000Z" });
  const second = await claimDue(db, { now: "2026-09-05T12:00:00.000Z" });

  assert.equal(first.length, 1);
  assert.equal(second.length, 0, "第二次不该再拿到同一笔");
  assert.equal(db._row("SELECT attempts FROM wa_outbox WHERE id='a'").attempts, 1);
});

test("每次最多取 BATCH_LIMIT 笔 —— 宁可慢", async () => {
  const db = createTestDb();
  seedCustomer(db);
  const values = Array.from({ length: 20 }, (_, i) =>
    `('x${i}','c1','x','2026-09-05T00:00:00.000Z','2026-09-05T00:00:00.000Z')`).join(",");
  db._exec(`INSERT INTO wa_outbox (id, customer_id, body, scheduled_at, created_at) VALUES ${values}`);

  const rows = await claimDue(db, { now: "2026-09-05T12:00:00.000Z" });
  assert.equal(rows.length, 8);
});

/* ========================= 送出 ========================= */

const rowsFor = async (db) => claimDue(db, { now: "2099-01-01T00:00:00.000Z" });

function queueOne(db, over = {}) {
  db._exec(`INSERT INTO wa_outbox (id, customer_id, body, scheduled_at, created_at, created_by)
            VALUES ('o1','${over.customerId ?? "c1"}','你好','2026-09-05T00:00:00.000Z','2026-09-05T00:00:00.000Z','staff@x')`);
}

test("影子模式：全部逻辑跑完、纪录照写，但不呼叫送出", async () => {
  const db = createTestDb();
  seedCustomer(db);
  queueOne(db);
  let called = false;

  const res = await processBatch(db, await rowsFor(db), {
    shadow: true,
    send: async () => { called = true; return { ok: true, id: "x" }; },
  });

  assert.equal(called, false, "影子模式不可以真的送");
  assert.equal(res.sent, 1);
  const row = db._row("SELECT * FROM wa_outbox WHERE id='o1'");
  assert.equal(row.status, "sent");
  assert.equal(row.error, "shadow", "要看得出这笔是影子模式的，不是真的送了");
});

test("关掉影子模式才会真的送，并写进 messages", async () => {
  const db = createTestDb();
  seedCustomer(db);
  queueOne(db);
  const sentTo = [];

  const res = await processBatch(db, await rowsFor(db), {
    shadow: false,
    send: async ({ to, body }) => { sentTo.push({ to, body }); return { ok: true, id: "3EB0OB" }; },
    recordMessage: async (row, sent) =>
      db._exec(`INSERT INTO messages (id, customer_id, direction, body, platform_msg_id, author, ts)
                VALUES ('wa-${sent.id}','${row.customer_id}','out','${row.body}','${sent.id}','${row.created_by}','2026-09-05T00:00:00.000Z')`),
  });

  assert.equal(res.sent, 1);
  assert.deepEqual(sentTo, [{ to: "60123456789", body: "你好" }]);
  assert.equal(db._row("SELECT status FROM wa_outbox WHERE id='o1'").status, "sent");
  assert.equal(db._row("SELECT author FROM messages").author, "staff@x", "谁排的要跟着进纪录");
});

test("送出前顾客变成需回覆 → 跳过并记录原因", async () => {
  const db = createTestDb();
  seedCustomer(db);
  queueOne(db);
  const rows = await rowsFor(db);
  // 取件之后、送出之前，顾客状态变了
  db._exec("UPDATE customers SET needs_reply = 1 WHERE id = 'c1'");
  rows[0].needs_reply = 1;

  let called = false;
  const res = await processBatch(db, rows, { shadow: false, send: async () => { called = true; } });

  assert.equal(called, false, "不该送出");
  assert.equal(res.cancelled, 1);
  const row = db._row("SELECT * FROM wa_outbox WHERE id='o1'");
  assert.equal(row.status, "cancelled");
  assert.match(row.error, /等回覆/, "要记下为什么没送");
});

test("没同意接收群发的人会被跳过", async () => {
  const db = createTestDb();
  seedCustomer(db, { broadcast_opt_in: 0 });
  queueOne(db);
  let called = false;
  const res = await processBatch(db, await rowsFor(db), { shadow: false, send: async () => { called = true; } });

  assert.equal(called, false);
  assert.equal(res.cancelled, 1);
  assert.match(db._row("SELECT error FROM wa_outbox WHERE id='o1'").error, /broadcast_opt_in/);
});

test("送出失败记成 failed 并留下原因，不会假装送出去了", async () => {
  const db = createTestDb();
  seedCustomer(db);
  queueOne(db);

  const res = await processBatch(db, await rowsFor(db), {
    shadow: false,
    send: async () => { throw new Error("桥接机还没连线"); },
  });

  assert.equal(res.failed, 1);
  const row = db._row("SELECT * FROM wa_outbox WHERE id='o1'");
  assert.equal(row.status, "failed");
  assert.match(row.error, /还没连线/);
  assert.equal(row.sent_at, null, "没送出去就不该有送出时间");
});

test("桥接机回 ok:false 也算失败，不是成功", async () => {
  const db = createTestDb();
  seedCustomer(db);
  queueOne(db);
  const res = await processBatch(db, await rowsFor(db), {
    shadow: false,
    send: async () => ({ ok: false, error: "bridge_send_failed" }),
  });
  assert.equal(res.failed, 1);
  assert.equal(res.sent, 0);
});
