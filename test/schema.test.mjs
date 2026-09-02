/**
 * 结构本身：表、外键、索引，还有「查询真的走了索引吗」。
 *
 * 最后那一项用 EXPLAIN QUERY PLAN 验，不是用眼睛看 ——
 * 索引建了但查询用不到是很常见的事，而且不会报错，只会慢。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.mjs";
import { buildCustomerQuery } from "../src/customers.js";

const objects = (db, type) =>
  db._rows(`SELECT name FROM sqlite_master WHERE type='${type}'`).map((r) => r.name);

test("该有的表都在", () => {
  const db = createTestDb();
  const tables = objects(db, "table");
  for (const t of ["customers", "customer_tags", "messages", "notes", "orders", "tasks",
                   "notes", "activities", "settings", "users"]) {
    assert.ok(tables.includes(t), `少了 ${t} 表`);
  }
  db._close();
});

test("规格点名的索引都建了", () => {
  const db = createTestDb();
  const idx = objects(db, "index");
  // customers：电话、阶段、最后讯息时间
  assert.ok(idx.includes("idx_customers_phone"));
  assert.ok(idx.includes("idx_customers_stage"));
  assert.ok(idx.includes("idx_customers_last_message_at"));
  // messages：顾客外键 + 时间戳、平台 message id
  assert.ok(idx.includes("idx_messages_customer_ts"));
  assert.ok(idx.includes("idx_messages_platform_msg_id"));
  db._close();
});

test("外键是真的：顾客不存在就写不进讯息", () => {
  const db = createTestDb();
  assert.throws(
    () => db._exec(`INSERT INTO messages (id, customer_id, body) VALUES ('m1', 'nobody', 'hi')`),
    /FOREIGN KEY/i
  );
  db._close();
});

test("删掉顾客，他的讯息 / 备注 / 标签一起走（ON DELETE CASCADE）", () => {
  const db = createTestDb();
  db._exec(`INSERT INTO customers (id, updated_at) VALUES ('c1', '2026-01-01T00:00:00.000Z')`);
  db._exec(`INSERT INTO messages (id, customer_id, body) VALUES ('m1', 'c1', 'hi')`);
  db._exec(`INSERT INTO notes (id, customer_id, body) VALUES ('n1', 'c1', 'note')`);
  db._exec(`INSERT INTO customer_tags (customer_id, tag) VALUES ('c1', '回头客')`);
  db._exec(`DELETE FROM customers WHERE id = 'c1'`);
  assert.equal(db._rows("SELECT * FROM messages").length, 0);
  assert.equal(db._rows("SELECT * FROM notes").length, 0);
  assert.equal(db._rows("SELECT * FROM customer_tags").length, 0);
  db._close();
});

test("platform_msg_id 是唯一的 —— 桥接机重连补送不会写成两笔", () => {
  const db = createTestDb();
  db._exec(`INSERT INTO customers (id, updated_at) VALUES ('c1', '2026-01-01T00:00:00.000Z')`);
  db._exec(
    `INSERT OR IGNORE INTO messages (id, customer_id, body, platform_msg_id)
     VALUES ('m1', 'c1', 'hi', 'WA-ABC')`
  );
  // 同一则平台讯息，换了本地 id 再送一次
  db._exec(
    `INSERT OR IGNORE INTO messages (id, customer_id, body, platform_msg_id)
     VALUES ('m2', 'c1', 'hi', 'WA-ABC')`
  );
  assert.equal(db._rows("SELECT * FROM messages").length, 1);
  db._close();
});

test("时间戳可以是 NULL —— 「不知道」跟「现在」不是同一件事", () => {
  const db = createTestDb();
  db._exec(
    `INSERT INTO customers (id, updated_at, created_at, last_message_at)
     VALUES ('c1', '2026-01-01T00:00:00.000Z', NULL, NULL)`
  );
  const row = db._row("SELECT created_at, last_message_at FROM customers WHERE id='c1'");
  assert.equal(row.created_at, null);
  assert.equal(row.last_message_at, null);
  db._close();
});

/* ---------------- 查询计划：证明筛选真的走索引 ---------------- */

test("按阶段筛选走 idx_customers_stage，不是整表扫描", () => {
  const db = createTestDb();
  const { sql, binds } = buildCustomerQuery(new URLSearchParams("stage=verifying"));
  const plan = db._plan(sql, ...binds).join(" | ");
  assert.match(plan, /idx_customers_stage/, `查询计划里没看到索引：${plan}`);
  assert.doesNotMatch(plan, /SCAN customers(?! USING)/, `还是整表扫描：${plan}`);
  db._close();
});

test("按电话查走 idx_customers_phone", () => {
  const db = createTestDb();
  const plan = db._plan("SELECT id FROM customers WHERE phone = ?", "60123456789").join(" | ");
  assert.match(plan, /idx_customers_phone/, plan);
  db._close();
});

test("标签筛选走 idx_customer_tags_tag", () => {
  const db = createTestDb();
  const { sql, binds } = buildCustomerQuery(new URLSearchParams("tag=%E5%9B%9E%E5%A4%B4%E5%AE%A2"));
  const plan = db._plan(sql, ...binds).join(" | ");
  assert.match(plan, /idx_customer_tags_tag|customer_tags/, plan);
  db._close();
});

test("一位顾客的讯息走 idx_messages_customer_ts", () => {
  const db = createTestDb();
  const plan = db
    ._plan("SELECT id FROM messages WHERE customer_id = ? ORDER BY ts DESC", "c1")
    .join(" | ");
  assert.match(plan, /idx_messages_customer_ts/, plan);
  db._close();
});
