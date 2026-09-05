/**
 * customers 的读写。
 *
 * 两个重点：
 *  1. 筛选与排序都在 SQL 里做（WHERE / ORDER BY / LIMIT），不是整包捞回前端过滤。
 *  2. 更新只写有改到的栏位，而且带乐观锁 —— 两个人改同一位顾客，
 *     第二个人拿到 409，不会默默盖掉第一个人的改动。
 */

import { normalizePhone, phoneSearchVariants } from "./phone.js";
import {
  placeholders, nowIso, nextUpdatedAt, encodeCursor, decodeCursor,
  csv, likeEscape, boolInt, chunk,
} from "./sql.js";

/* ------------------------- 栏位对照 ------------------------- */

/**
 * API 栏位名 → 资料库栏位名。
 * 这张表同时也是白名单：不在这里的栏位，PATCH 一律忽略，
 * 呼叫端塞不进任意栏位。
 */
const FIELDS = {
  name: "name",
  whatsapp: "phone_raw", // 前端叫 whatsapp，资料库存原样字串；正规化的结果另外写进 phone
  platform: "platform",
  stage: "stage",
  priority: "priority",
  language: "language",
  contactType: "contact_type",
  locationName: "location_name",
  machineId: "machine_id",
  itemNo: "item_no",
  receiptDate: "receipt_date",
  receiptTime: "receipt_time",
  receiptAmount: "receipt_amount",
  paymentType: "payment_type",
  machineStatus: "machine_status",
  finexusStatus: "finexus_status",
  notes: "notes",
  broadcastOptIn: "broadcast_opt_in",
  needsReply: "needs_reply",
  nextFollowUpDate: "next_follow_up_date",
  followUpCount: "follow_up_count",
  createdAt: "created_at",
  lastInteractionAt: "last_interaction_at",
  lastMessageAt: "last_message_at",
  lastCustomerMessageAt: "last_customer_message_at",
  mergedInto: "merged_into",
};

const BOOL_FIELDS = new Set(["broadcastOptIn", "needsReply"]);
const INT_FIELDS = new Set(["followUpCount"]);
// 这几个由伺服器决定，呼叫端送来一律忽略
const SERVER_OWNED = new Set(["id", "updatedAt", "updatedBy", "tags", "timeline", "phone"]);

/** 一列 customers → 前端看到的顾客物件（timeline / tags 由呼叫端补上） */
export function rowToCustomer(row, { tags = [], timeline = [] } = {}) {
  return {
    id: row.id,
    name: row.name || "",
    whatsapp: row.phone_raw || "",
    phone: row.phone || "",
    platform: row.platform || "whatsapp",
    stage: row.stage,
    priority: row.priority,
    language: row.language || "",
    contactType: row.contact_type,
    locationName: row.location_name || "",
    machineId: row.machine_id || "",
    itemNo: row.item_no || "",
    receiptDate: row.receipt_date || "",
    receiptTime: row.receipt_time || "",
    receiptAmount: row.receipt_amount || "",
    paymentType: row.payment_type || "",
    machineStatus: row.machine_status,
    finexusStatus: row.finexus_status,
    notes: row.notes || "",
    broadcastOptIn: Number(row.broadcast_opt_in) === 1,
    needsReply: Number(row.needs_reply) === 1,
    nextFollowUpDate: row.next_follow_up_date || "",
    followUpCount: Number(row.follow_up_count) || 0,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at,
    lastInteractionAt: row.last_interaction_at ?? null,
    lastMessageAt: row.last_message_at ?? null,
    lastCustomerMessageAt: row.last_customer_message_at ?? null,
    mergedInto: row.merged_into ?? null,
    updatedBy: row.updated_by || "",
    tags,
    timeline,
  };
}

const SELECT_COLS = `id, name, phone, phone_raw, platform, stage, priority, language, contact_type,
  location_name, machine_id, item_no, receipt_date, receipt_time, receipt_amount, payment_type,
  machine_status, finexus_status, notes, broadcast_opt_in, needs_reply,
  next_follow_up_date, follow_up_count, created_at, updated_at, last_interaction_at,
  last_message_at, last_customer_message_at, merged_into, updated_by`;

/* --------------------------- 排序 --------------------------- */

// 优先级不是字典序（high < low < medium），要自己给个次序
const PRIORITY_RANK = `CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`;

/**
 * 允许的排序方式。COALESCE 是必要的 ——
 * 时间戳可以是 NULL（「不知道」跟「现在」是两件事），NULL 参与比较会让 keyset 分页断掉。
 */
const SORTS = {
  updatedAt: { expr: `COALESCE(updated_at, '')`, dir: "DESC" },
  updatedAtAsc: { expr: `COALESCE(updated_at, '')`, dir: "ASC" },
  createdAt: { expr: `COALESCE(created_at, '')`, dir: "DESC" },
  lastMessageAt: { expr: `COALESCE(last_message_at, '')`, dir: "DESC" },
  // 「最久未处理」：最后讯息时间由旧到新。从没讲过话的（NULL）排最前面，那本来就是最久没处理的。
  oldestContact: { expr: `COALESCE(last_message_at, '')`, dir: "ASC" },
  nextFollowUp: { expr: `COALESCE(next_follow_up_date, '')`, dir: "ASC" },
  name: { expr: `COALESCE(name, '')`, dir: "ASC" },
  priority: { expr: PRIORITY_RANK, dir: "ASC" },
  stage: { expr: `COALESCE(stage, '')`, dir: "ASC" },
};
export const SORT_KEYS = Object.keys(SORTS);
const DEFAULT_SORT = "updatedAt";

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;

/**
 * 把 query string 翻成 WHERE / ORDER BY / LIMIT。
 * 回传 { sql, binds, sortKey, limit } —— 拆出来是为了测试可以直接检查产生的 SQL。
 */
export function buildCustomerQuery(params) {
  const where = [];
  const binds = [];

  // 合并掉的记录预设不出现在列表里（软合并：资料还在，只是不重复列出）
  if (params.get("includeMerged") !== "1") where.push("merged_into IS NULL");

  const stages = csv(params.get("stage"));
  if (stages.length) {
    where.push(`stage IN (${placeholders(stages.length)})`);
    binds.push(...stages);
  }

  const priorities = csv(params.get("priority"));
  if (priorities.length) {
    where.push(`priority IN (${placeholders(priorities.length)})`);
    binds.push(...priorities);
  }

  const contactTypes = csv(params.get("contactType"));
  if (contactTypes.length) {
    where.push(`contact_type IN (${placeholders(contactTypes.length)})`);
    binds.push(...contactTypes);
  }

  const platforms = csv(params.get("platform"));
  if (platforms.length) {
    where.push(`platform IN (${placeholders(platforms.length)})`);
    binds.push(...platforms);
  }

  const languages = csv(params.get("language"));
  if (languages.length) {
    where.push(`language IN (${placeholders(languages.length)})`);
    binds.push(...languages);
  }

  if (params.has("needsReply")) {
    where.push("needs_reply = ?");
    binds.push(boolInt(params.get("needsReply")));
  }

  if (params.has("broadcastOptIn")) {
    where.push("broadcast_opt_in = ?");
    binds.push(boolInt(params.get("broadcastOptIn")));
  }

  // 标签走关联表，所以「有这个标签」「没有这个标签」都是真的 SQL 条件
  const tags = csv(params.get("tag"));
  if (tags.length) {
    where.push(
      `EXISTS (SELECT 1 FROM customer_tags ct WHERE ct.customer_id = customers.id
               AND ct.tag IN (${placeholders(tags.length)}))`
    );
    binds.push(...tags);
  }
  const excludeTags = csv(params.get("excludeTag"));
  if (excludeTags.length) {
    where.push(
      `NOT EXISTS (SELECT 1 FROM customer_tags ct WHERE ct.customer_id = customers.id
                   AND ct.tag IN (${placeholders(excludeTags.length)}))`
    );
    binds.push(...excludeTags);
  }

  // 跟进到期：日期字串是 YYYY-MM-DD，字典序就是时间序
  const followUpBefore = params.get("followUpBefore");
  if (followUpBefore) {
    where.push("next_follow_up_date != '' AND next_follow_up_date <= ?");
    binds.push(followUpBefore);
  }

  const quietBefore = params.get("lastMessageBefore");
  if (quietBefore) {
    where.push("(last_message_at IS NULL OR last_message_at <= ?)");
    binds.push(quietBefore);
  }

  // 搜寻要容错：电话的国码、空格、横线、开头 0 都要搜得到
  const search = String(params.get("search") || "").trim();
  if (search) {
    const like = `%${likeEscape(search)}%`;
    const clauses = [
      "name LIKE ? ESCAPE '\\'",
      "phone_raw LIKE ? ESCAPE '\\'",
      "machine_id LIKE ? ESCAPE '\\'",
      "location_name LIKE ? ESCAPE '\\'",
    ];
    binds.push(like, like, like, like);
    for (const variant of phoneSearchVariants(search)) {
      clauses.push("phone LIKE ? ESCAPE '\\'");
      binds.push(`%${likeEscape(variant)}%`);
    }
    where.push(`(${clauses.join(" OR ")})`);
  }

  const sortKey = SORTS[params.get("sort")] ? params.get("sort") : DEFAULT_SORT;
  const sort = SORTS[sortKey];

  // keyset 分页：接在上一页最后一列之后，不是 OFFSET。
  // 第 100 页跟第 1 页一样快，而且中间有人新增资料也不会漏读或重读。
  const cursor = decodeCursor(params.get("cursor"));
  if (cursor) {
    const cmp = sort.dir === "DESC" ? "<" : ">";
    where.push(`(${sort.expr} ${cmp} ? OR (${sort.expr} = ? AND id ${cmp} ?))`);
    binds.push(cursor.v, cursor.v, cursor.id);
  }

  let limit = Number.parseInt(params.get("limit") ?? "", 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  const whereSql = where.length ? `WHERE ${where.join("\n  AND ")}` : "";
  const sql =
    `SELECT ${SELECT_COLS}, ${sort.expr} AS __sortval\n` +
    `FROM customers\n${whereSql}\n` +
    `ORDER BY ${sort.expr} ${sort.dir}, id ${sort.dir}\n` +
    `LIMIT ?`;

  return { sql, binds: [...binds, limit + 1], limit, sortKey };
}

/* --------------------------- 读 --------------------------- */

export async function listCustomers(db, params, { attach } = {}) {
  const { sql, binds, limit } = buildCustomerQuery(params);
  const { results = [] } = await db.prepare(sql).bind(...binds).all();

  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;

  const extras = attach ? await attach(page.map((r) => r.id)) : { tags: new Map(), timeline: new Map() };
  const customers = page.map((row) =>
    rowToCustomer(row, {
      tags: extras.tags?.get(row.id) || [],
      timeline: extras.timeline?.get(row.id) || [],
    })
  );

  const last = page[page.length - 1];
  return {
    customers,
    nextCursor: hasMore && last ? encodeCursor(last.__sortval, last.id) : null,
  };
}

export async function getCustomerRow(db, id) {
  return db.prepare(`SELECT ${SELECT_COLS} FROM customers WHERE id = ?`).bind(id).first();
}

export async function loadTags(db, ids) {
  const map = new Map();
  if (!ids.length) return map;
  // 切块：D1 一句最多 100 个 bind 参数，整页几百个 id 直接塞进 IN 会整句失败
  for (const part of chunk(ids)) {
    const { results = [] } = await db
      .prepare(
        `SELECT customer_id, tag FROM customer_tags
         WHERE customer_id IN (${placeholders(part.length)}) ORDER BY tag`
      )
      .bind(...part)
      .all();
    for (const r of results) {
      if (!map.has(r.customer_id)) map.set(r.customer_id, []);
      map.get(r.customer_id).push(r.tag);
    }
  }
  return map;
}

/** 每阶段人数（Dashboard 的阶段卡片）—— 一次 GROUP BY，不是十次 count */
export async function stageCounts(db) {
  const { results = [] } = await db
    .prepare("SELECT stage, COUNT(*) AS n FROM customers WHERE merged_into IS NULL GROUP BY stage")
    .all();
  return Object.fromEntries(results.map((r) => [r.stage, Number(r.n)]));
}

/* --------------------------- 写 --------------------------- */

function coerce(apiField, value) {
  if (BOOL_FIELDS.has(apiField)) return boolInt(value);
  if (INT_FIELDS.has(apiField)) return Number.parseInt(value, 10) || 0;
  if (apiField === "createdAt" || apiField.endsWith("At")) return value == null || value === "" ? null : String(value);
  if (apiField === "mergedInto") return value || null;
  return value == null ? "" : String(value);
}

/** 只挑白名单里的栏位，其它一律丢掉 */
function pickAssignments(patch) {
  const sets = [];
  const binds = [];
  for (const [apiField, dbCol] of Object.entries(FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, apiField)) continue;
    if (SERVER_OWNED.has(apiField)) continue;
    sets.push(`${dbCol} = ?`);
    binds.push(coerce(apiField, patch[apiField]));
    // whatsapp 改了就一起更新正规化后的 phone，两个栏位不会各走各的
    if (apiField === "whatsapp") {
      sets.push("phone = ?");
      binds.push(normalizePhone(patch[apiField]));
    }
  }
  return { sets, binds };
}

export async function createCustomer(db, input, actorEmail) {
  const id = String(input.id || "").trim();
  if (!id) return { ok: false, status: 400, error: "id_required" };

  // 已经有这个 id 就明讲，不要让主键冲突变成一个没人看得懂的 500。
  // 汇入脚本重跑、前端重送，撞到的都是这条。
  const existing = await db.prepare("SELECT id FROM customers WHERE id = ?").bind(id).first();
  if (existing) {
    return {
      ok: false, status: 409, error: "already_exists",
      detail: `顾客 ${id} 已经存在。要改资料请用 PATCH。`,
      current: await getCustomerRow(db, id),
    };
  }

  const now = nowIso();
  const patch = { ...input };
  for (const k of SERVER_OWNED) delete patch[k];

  const { sets, binds } = pickAssignments(patch);
  const cols = ["id", "updated_at", "updated_by"];
  const vals = [id, input.updatedAt || now, actorEmail];
  for (let i = 0; i < sets.length; i++) {
    cols.push(sets[i].slice(0, sets[i].indexOf(" =")));
    vals.push(binds[i]);
  }
  // createdAt 没送就补现在。这是「现在真的建立了一位顾客」，不是在猜历史时间。
  if (!cols.includes("created_at")) {
    cols.push("created_at");
    vals.push(now);
  }

  await db
    .prepare(`INSERT INTO customers (${cols.join(", ")}) VALUES (${placeholders(cols.length)})`)
    .bind(...vals)
    .run();

  if (Array.isArray(input.tags)) await replaceTags(db, id, input.tags);
  return { ok: true, status: 201, row: await getCustomerRow(db, id) };
}

/**
 * 栏位级更新 + 乐观锁。
 *
 * expectedUpdatedAt 是呼叫端「读到的」updated_at。中间被别人改过就对不上，
 * UPDATE 影响 0 列，回 409 并附上目前的资料，让呼叫端重新载入而不是默默覆盖。
 */
export async function patchCustomer(db, id, patch, expectedUpdatedAt, actorEmail) {
  if (!expectedUpdatedAt) {
    return { ok: false, status: 400, error: "updated_at_required",
             detail: "PATCH 必须带上读取时拿到的 updatedAt，否则挡不住互相覆盖" };
  }

  const { sets, binds } = pickAssignments(patch);
  const tagsChanged = Array.isArray(patch.tags);
  if (!sets.length && !tagsChanged) {
    const row = await getCustomerRow(db, id);
    if (!row) return { ok: false, status: 404, error: "not_found" };
    return { ok: true, status: 200, row, unchanged: true };
  }

  const nextTs = nextUpdatedAt(expectedUpdatedAt);
  const result = await db
    .prepare(
      `UPDATE customers SET ${[...sets, "updated_at = ?", "updated_by = ?"].join(", ")}
       WHERE id = ? AND updated_at = ?`
    )
    .bind(...binds, nextTs, actorEmail, id, expectedUpdatedAt)
    .run();

  if (!changedRows(result)) {
    const row = await getCustomerRow(db, id);
    if (!row) return { ok: false, status: 404, error: "not_found" };
    return {
      ok: false,
      status: 409,
      error: "conflict",
      detail: "这笔资料在你读取之后被别人改过了，请重新载入再改一次",
      current: row,
    };
  }

  if (tagsChanged) await replaceTags(db, id, patch.tags);
  return { ok: true, status: 200, row: await getCustomerRow(db, id) };
}

export async function deleteCustomer(db, id) {
  const result = await db.prepare("DELETE FROM customers WHERE id = ?").bind(id).run();
  return changedRows(result) > 0;
}

export async function replaceTags(db, id, tags) {
  const clean = [...new Set((tags || []).map((t) => String(t).trim()).filter(Boolean))];
  const stmts = [db.prepare("DELETE FROM customer_tags WHERE customer_id = ?").bind(id)];
  for (const tag of clean) {
    stmts.push(db.prepare("INSERT OR IGNORE INTO customer_tags (customer_id, tag) VALUES (?, ?)").bind(id, tag));
  }
  await runBatch(db, stmts);
}

/* --------------------------- 小工具 --------------------------- */

/** D1 的 run() 把影响列数放在 meta.changes；本机测试的替身也照这个形状 */
export function changedRows(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

/** D1 有 batch()，没有的话就一句一句跑，行为一样 */
export async function runBatch(db, stmts) {
  if (!stmts.length) return;
  if (typeof db.batch === "function") return db.batch(stmts);
  for (const s of stmts) await s.run();
}
