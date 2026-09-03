/**
 * orders / tasks / notes / activities / settings 的读写。
 *
 * orders 与 tasks 目前的六个页面还没有对应的操作 —— 收据是个案上的单一栏位，
 * 跟进日期是顾客上的一个日期。表与端点先建好（有外键、有索引），
 * 等后面阶段真的有多笔订单、多个任务时直接用，不必再动一次结构。
 */

import { placeholders, nowIso, nextUpdatedAt, nextSeq, encodeCursor, decodeCursor, chunk } from "./sql.js";
import { runBatch, changedRows } from "./customers.js";

/* ----------------------------- orders ----------------------------- */

const orderToApi = (r) => ({
  id: r.id, customerId: r.customer_id, amount: Number(r.amount) || 0,
  currency: r.currency, status: r.status, reference: r.reference || "",
  at: r.ts ?? null, createdAt: r.created_at,
});

export async function listOrders(db, customerId) {
  const { results = [] } = await db
    .prepare(`SELECT * FROM orders WHERE customer_id = ? ORDER BY COALESCE(ts,'') DESC, id DESC`)
    .bind(customerId).all();
  return results.map(orderToApi);
}

export async function createOrder(db, customerId, input) {
  const id = String(input.id || "").trim();
  if (!id) return { ok: false, status: 400, error: "id_required" };
  await db.prepare(
    `INSERT OR IGNORE INTO orders (id, customer_id, amount, currency, status, reference, ts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, customerId, Number(input.amount) || 0, input.currency || "MYR",
    input.status || "pending", String(input.reference ?? ""),
    input.at ?? null, nowIso()
  ).run();
  const row = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
  return { ok: true, status: 201, order: orderToApi(row) };
}

/* ------------------------------ tasks ------------------------------ */

const taskToApi = (r) => ({
  id: r.id, customerId: r.customer_id, type: r.type, title: r.title || "",
  dueAt: r.due_at ?? null, done: Number(r.done) === 1, doneAt: r.done_at ?? null,
  createdAt: r.created_at,
});

export async function listTasks(db, customerId) {
  const { results = [] } = await db
    .prepare(`SELECT * FROM tasks WHERE customer_id = ? ORDER BY done ASC, COALESCE(due_at,'') ASC, id ASC`)
    .bind(customerId).all();
  return results.map(taskToApi);
}

export async function createTask(db, customerId, input) {
  const id = String(input.id || "").trim();
  if (!id) return { ok: false, status: 400, error: "id_required" };
  await db.prepare(
    `INSERT OR IGNORE INTO tasks (id, customer_id, type, title, due_at, done, done_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, customerId, input.type || "follow_up", String(input.title ?? ""),
    input.dueAt ?? null, input.done ? 1 : 0, input.doneAt ?? null, nowIso()
  ).run();
  const row = await db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
  return { ok: true, status: 201, task: taskToApi(row) };
}

/* ---------------------------- activities ---------------------------- */

const activityToApi = (r) => ({
  id: r.id, at: r.at, actor: r.actor, actorEmail: r.actor_email,
  role: r.role, action: r.action, target: r.target, description: r.description,
});

/** 「团队活动」页。时间由新到旧，cursor 分页。 */
export async function listActivities(db, { cursor, limit = 800 } = {}) {
  const cur = decodeCursor(cursor);
  const binds = [];
  let where = "";
  if (cur) {
    where = "WHERE (at < ? OR (at = ? AND id < ?))";
    binds.push(cur.v, cur.v, cur.id);
  }
  const capped = Math.min(Math.max(Number(limit) || 800, 1), 2000);
  const { results = [] } = await db
    .prepare(`SELECT * FROM activities ${where} ORDER BY at DESC, seq DESC, id DESC LIMIT ?`)
    .bind(...binds, capped + 1)
    .all();

  const hasMore = results.length > capped;
  const page = hasMore ? results.slice(0, capped) : results;
  const last = page[page.length - 1];
  return {
    activities: page.map(activityToApi),
    nextCursor: hasMore && last ? encodeCursor(last.at, last.id) : null,
  };
}

/**
 * 活动纪录只新增，不覆盖。
 * INSERT OR IGNORE 让同一批送两次不会变成两笔 —— 前端重试也安全。
 */
export async function appendActivities(db, entries, actorEmail) {
  const stmts = [];
  for (const a of entries || []) {
    const id = String(a.id || "").trim();
    if (!id) continue;
    stmts.push(
      db.prepare(
        `INSERT OR IGNORE INTO activities (id, at, actor, actor_email, role, action, target, description, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, a.at || nowIso(), String(a.actor ?? ""), a.actorEmail || actorEmail || "",
        String(a.role ?? ""), String(a.action ?? ""), String(a.target ?? ""), String(a.description ?? ""),
        // 呼叫端是照时间由旧到新送进来的，所以 seq 会跟着时间递增
        Number.isFinite(a.seq) ? a.seq : nextSeq()
      )
    );
  }
  await runBatch(db, stmts);
  return stmts.length;
}

/* ----------------------------- settings ----------------------------- */

/**
 * 设定维持 key-value —— 设定本来就是这个形状。
 * 但拆成多个 key，改 AI 知识库的人跟改群发名单的人才不会互相覆盖。
 * 一样有乐观锁：带 expectedUpdatedAt 就挡得住覆盖，不带就是无条件写入。
 */
export async function getSetting(db, key) {
  return db.prepare("SELECT key, value, updated_at, updated_by FROM settings WHERE key = ?").bind(key).first();
}

export async function getSettings(db, keys) {
  if (!keys.length) return [];
  const out = [];
  for (const part of chunk(keys)) {
    const { results = [] } = await db
      .prepare(
        `SELECT key, value, updated_at, updated_by FROM settings
         WHERE key IN (${placeholders(part.length)})`
      )
      .bind(...part).all();
    out.push(...results);
  }
  return out;
}

export async function putSetting(db, key, value, expectedUpdatedAt, actorEmail) {
  const now = nowIso();
  if (expectedUpdatedAt) {
    // 新的 updated_at 一定要严格大于呼叫端读到的那个，
    // 否则同一毫秒内的两次写入会让这道锁失效 —— 第二个人的覆盖就沉默通过了
    const nextTs = nextUpdatedAt(expectedUpdatedAt);
    const result = await db
      .prepare("UPDATE settings SET value = ?, updated_at = ?, updated_by = ? WHERE key = ? AND updated_at = ?")
      .bind(value, nextTs, actorEmail, key, expectedUpdatedAt)
      .run();
    if (!changedRows(result)) {
      const current = await getSetting(db, key);
      if (current) {
        return { ok: false, status: 409, error: "conflict",
                 detail: "这项设定在你读取之后被别人改过了", current };
      }
    } else {
      return { ok: true, status: 200, updatedAt: nextTs };
    }
  }

  await db.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).bind(key, value, now, actorEmail).run();
  return { ok: true, status: 200, updatedAt: now };
}

export async function deleteSetting(db, key) {
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}
