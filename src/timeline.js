/**
 * 顾客时间轴 = messages ∪ notes。
 *
 * 拆成两张表是因为它们的用途不同：messages 有平台原始 id（重连补送时靠它去重）、
 * 有方向、之后要做汇总与排程；notes 是内部备注、阶段变更、系统动作、群发纪录。
 * 前端看到的还是原本那一条混在一起的时间轴，在这里组回去。
 */

import { placeholders, nextSeq, encodeCursor, decodeCursor, chunk } from "./sql.js";
import { runBatch } from "./customers.js";

// 前端时间轴事件的 type。message 进 messages，其余进 notes。
const MESSAGE_TYPE = "message";
const NOTE_KINDS = new Set(["note", "stage", "system", "campaign"]);

/**
 * 时间轴事件的形状刻意维持成前端原本那五个栏位。
 * direction / platform 这些是讯息资源自己的东西，只在 /messages 端点出现 ——
 * 转接层回给页面的物件多一个栏位都不要多。
 */
const messageToEntry = (r) => ({
  id: r.id,
  at: r.ts ?? null,
  by: r.author || "",
  type: MESSAGE_TYPE,
  text: r.body || "",
});

const noteToEntry = (r) => ({
  id: r.id,
  at: r.ts ?? null,
  by: r.author || "",
  type: NOTE_KINDS.has(r.kind) ? r.kind : "note",
  text: r.body || "",
});

/** ts 一样时用 seq 再用 id 决定先后，让排序结果每次都一样 */
function sortNewestFirst(entries) {
  return entries.sort((a, b) => {
    const at = a.at || "";
    const bt = b.at || "";
    if (at !== bt) return at < bt ? 1 : -1;
    if (a._seq !== b._seq) return (b._seq || 0) - (a._seq || 0);
    return a.id < b.id ? 1 : -1;
  });
}

const strip = (e) => {
  const { _seq, ...rest } = e;
  return rest;
};

/**
 * 一次把整页顾客的时间轴捞回来。
 * 一位顾客一次查询会变成 N+1 —— 列表页有 200 位顾客就是 200 趟往返。
 */
export async function loadTimelines(db, ids) {
  const map = new Map();
  if (!ids.length) return map;

  // 切块：D1 一句最多 100 个 bind 参数。列表页一次拿几百位顾客，不切会整句失败。
  for (const part of chunk(ids)) {
    const ph = placeholders(part.length);
    const [msgs, notes] = await Promise.all([
      db.prepare(
        `SELECT id, customer_id, direction, platform, body, author, ts, seq
         FROM messages WHERE customer_id IN (${ph})`
      ).bind(...part).all(),
      db.prepare(
        `SELECT id, customer_id, author, body, kind, ts, seq
         FROM notes WHERE customer_id IN (${ph})`
      ).bind(...part).all(),
    ]);

    for (const r of msgs.results || []) {
      if (!map.has(r.customer_id)) map.set(r.customer_id, []);
      map.get(r.customer_id).push({ ...messageToEntry(r), _seq: r.seq });
    }
    for (const r of notes.results || []) {
      if (!map.has(r.customer_id)) map.set(r.customer_id, []);
      map.get(r.customer_id).push({ ...noteToEntry(r), _seq: r.seq });
    }
  }

  for (const [id, entries] of map) map.set(id, sortNewestFirst(entries).map(strip));
  return map;
}

/** 单一顾客的讯息，cursor 分页（时间由新到旧） */
export async function listMessages(db, customerId, { cursor, limit = 100 } = {}) {
  const cur = decodeCursor(cursor);
  const binds = [customerId];
  let where = "customer_id = ?";
  if (cur) {
    where += " AND (COALESCE(ts,'') < ? OR (COALESCE(ts,'') = ? AND id < ?))";
    binds.push(cur.v, cur.v, cur.id);
  }
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const { results = [] } = await db
    .prepare(
      `SELECT id, customer_id, direction, platform, body, platform_msg_id, author, ts, seq
       FROM messages WHERE ${where}
       ORDER BY COALESCE(ts,'') DESC, id DESC LIMIT ?`
    )
    .bind(...binds, capped + 1)
    .all();

  const hasMore = results.length > capped;
  const page = hasMore ? results.slice(0, capped) : results;
  const last = page[page.length - 1];
  return {
    messages: page.map((r) => ({
      ...messageToEntry(r),
      direction: r.direction,
      platform: r.platform,
      platformMsgId: r.platform_msg_id ?? null,
    })),
    nextCursor: hasMore && last ? encodeCursor(last.ts ?? "", last.id) : null,
  };
}

export async function listNotes(db, customerId) {
  const { results = [] } = await db
    .prepare(`SELECT id, customer_id, author, body, kind, ts, seq FROM notes
              WHERE customer_id = ? ORDER BY COALESCE(ts,'') DESC, id DESC`)
    .bind(customerId)
    .all();
  return results.map(noteToEntry);
}

export async function loadTimeline(db, customerId) {
  return (await loadTimelines(db, [customerId])).get(customerId) || [];
}

/**
 * 写时间轴事件。
 *
 * 一律 INSERT OR IGNORE：同一则事件送两次不会变成两笔。
 * 讯息另外有 platform_msg_id 的唯一键，桥接机重连补送积压讯息也不会重复。
 */
export function timelineInserts(db, customerId, entries) {
  const stmts = [];
  for (const e of entries || []) {
    const id = String(e.id || "").trim();
    if (!id) continue;
    const seq = Number.isFinite(e.seq) ? e.seq : nextSeq();
    if (e.type === MESSAGE_TYPE) {
      stmts.push(
        db.prepare(
          `INSERT OR IGNORE INTO messages (id, customer_id, direction, platform, body, platform_msg_id, author, ts, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          id, customerId,
          e.direction === "out" ? "out" : "in",
          e.platform || "whatsapp",
          String(e.text ?? ""),
          e.platformMsgId || null,
          String(e.by ?? ""),
          e.at ?? null,
          seq
        )
      );
    } else {
      stmts.push(
        db.prepare(
          `INSERT OR IGNORE INTO notes (id, customer_id, author, body, kind, ts, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          id, customerId,
          String(e.by ?? ""),
          String(e.text ?? ""),
          NOTE_KINDS.has(e.type) ? e.type : "note",
          e.at ?? null,
          seq
        )
      );
    }
  }
  return stmts;
}

export async function appendTimeline(db, customerId, entries) {
  await runBatch(db, timelineInserts(db, customerId, entries));
}

/**
 * 汇总栏位从讯息表整个重算，不是 +1 累加。
 * 累加的话同一批资料重跑两次数字就翻倍；重算跑几次结果都一样。
 * MAX() 是为了不把时间往回拨 —— 往回拨会让顾客错误掉进「很久没联络」的自动化。
 */
export async function recomputeMessageSummary(db, customerId) {
  const row = await db
    .prepare(
      `SELECT MAX(ts) AS last_any,
              MAX(CASE WHEN direction = 'in' THEN ts END) AS last_in
       FROM messages WHERE customer_id = ?`
    )
    .bind(customerId)
    .first();

  await db
    .prepare(
      `UPDATE customers
       SET last_message_at = NULLIF(MAX(COALESCE(last_message_at, ''), COALESCE(?, '')), ''),
           last_customer_message_at = NULLIF(MAX(COALESCE(last_customer_message_at, ''), COALESCE(?, '')), '')
       WHERE id = ?`
    )
    .bind(row?.last_any ?? null, row?.last_in ?? null, customerId)
    .run();
}
