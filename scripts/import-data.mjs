#!/usr/bin/env node
/**
 * 把旧的 key-value blob 资料转成新的关联式资料表。
 *
 *   node scripts/import-data.mjs export.json
 *   → 产出 import.sql
 *   → npx wrangler d1 execute rasa-crm --local  --file=./import.sql   # 先在本机试
 *   → npx wrangler d1 execute rasa-crm --remote --file=./import.sql
 *
 * 两种输入都吃：
 *   1. Claude Artifact 汇出的 { "rasa-crm:main": "<json 字串>", ... }
 *      （怎么来的看 docs/migrate-from-artifact.md）
 *   2. D1 里既有的 app_state：
 *      npx wrangler d1 execute rasa-crm --local --json \
 *        --command="SELECT key, value FROM app_state" > app_state.json
 *
 * 汇入时刻意做的三件事（每一件都是为了不让旧资料污染日常操作）：
 *
 *   - 电话统一正规化后再存。少了这一步，之后所有比对、找重复、跨平台合并都会歪。
 *   - 时间戳缺失就留空，绝不填「现在」。填现在会让那批资料被当成今天的活动，
 *     之后所有依赖时间的分类逻辑全错。
 *   - 汇入建立的顾客一律标成低优先，而且不标成新客 —— 否则新客清单会被灌爆。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { normalizePhone } from "../src/phone.js";

const KEY_MAIN = "rasa-crm:main";
const KEY_LOG = "rasa-crm:log";
const KEY_APPS = "rasa-crm:apps";

// 汇入的顾客落在哪个阶段。
//
// 「新进线」是给真的刚进线的人用的 —— 汇入的是既有顾客，一笔都不该落在那里，
// 否则每天早上的新客清单会被历史资料灌爆，员工就不会再看那份清单了。
// 所以：原本就有阶段的沿用（那是真实的销售状态），
//       原本没有阶段、或原本标成 new 的，一律落进冷名单。
const IMPORT_STAGE = "dormant";
const IMPORT_PRIORITY = "low";
const NOT_FOR_IMPORT = new Set(["new"]);

function importStage(stage) {
  const s = String(stage || "").trim();
  return !s || NOT_FOR_IMPORT.has(s) ? IMPORT_STAGE : s;
}

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

const input = process.argv[2];
if (!input) die("用法：node scripts/import-data.mjs export.json");

let raw;
try {
  raw = JSON.parse(readFileSync(input, "utf8"));
} catch (e) {
  die(`读不了 ${input}：${e.message}`);
}

/* --------------------- 两种输入格式都收敛成同一个 map --------------------- */

function toKeyMap(data) {
  // wrangler d1 execute --json 的输出：[{ results: [{ key, value }, ...] }]
  const wrangler = Array.isArray(data) ? data : data?.results ? [data] : null;
  if (wrangler) {
    const map = {};
    for (const block of wrangler) {
      for (const row of block.results || []) {
        if (row && typeof row.key === "string") map[row.key] = row.value;
      }
    }
    if (Object.keys(map).length) return map;
  }
  if (data && typeof data === "object" && !Array.isArray(data)) return data;
  die("认不出这个档案的格式。要嘛是 artifact 汇出的 { key: jsonString }，要嘛是 wrangler --json 的输出。");
}

const keyed = toKeyMap(raw);

function parseKey(key) {
  const value = keyed[key];
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return value; // 已经是物件
  try {
    return JSON.parse(value);
  } catch {
    die(`${key} 的值不是合法 JSON，八成是复制的时候少了一段`);
  }
}

const main = parseKey(KEY_MAIN) || {};
const log = parseKey(KEY_LOG) || {};
const apps = parseKey(KEY_APPS);

/* ------------------------------ SQL 小工具 ------------------------------ */

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** 时间戳：认不出来就是 NULL。这里绝不回填「现在」。 */
const ts = (v) => {
  if (v === null || v === undefined || v === "") return "NULL";
  const t = Date.parse(v);
  if (Number.isNaN(t)) return "NULL";
  return q(new Date(t).toISOString());
};
const int = (v) => (Number.parseInt(v, 10) || 0);
const bool = (v) => (v ? 1 : 0);

const lines = [
  "-- 由 scripts/import-data.mjs 产生",
  `-- 来源：${input}`,
  "--",
  "-- 汇入的顾客一律低优先、不标成新客，时间戳缺失就留空（不是填今天）。",
  "",
];

const warnings = [];
const stats = { customers: 0, messages: 0, notes: 0, activities: 0, tags: 0, settings: 0,
                noTimestamp: 0, remappedFromNew: 0 };

/* ------------------------------- customers ------------------------------ */

const customers = Array.isArray(main.customers) ? main.customers : [];
const seenIds = new Set();
let seq = 0;

for (const c of customers) {
  const id = String(c?.id ?? "").trim();
  if (!id) {
    warnings.push("有一笔顾客没有 id，略过");
    continue;
  }
  if (seenIds.has(id)) {
    warnings.push(`顾客 id 重复：${id}，只保留第一笔`);
    continue;
  }
  seenIds.add(id);

  if (importStage(c.stage) !== (c.stage || IMPORT_STAGE)) stats.remappedFromNew += 1;

  const rawPhone = c.whatsapp ?? c.phone ?? "";
  const phone = normalizePhone(rawPhone);
  if (rawPhone && !phone) warnings.push(`${id} 的电话「${rawPhone}」正规化后是空的`);

  // updated_at 是 NOT NULL（乐观锁要用）。真的缺就退回建立时间，
  // 两个都没有才用一个固定的、明显不是「今天」的时间戳，方便事后一眼看出是汇入的。
  const updatedAt = c.updatedAt || c.createdAt || null;
  // 认不出来的时间戳（缺、空字串、乱写）最后都会是 NULL，一起算进来
  if (ts(c.createdAt) === "NULL") stats.noTimestamp += 1;

  lines.push(
    `INSERT OR IGNORE INTO customers (`,
    `  id, name, phone, phone_raw, platform, stage, priority, language, contact_type,`,
    `  location_name, machine_id, item_no, receipt_date, receipt_time, receipt_amount,`,
    `  machine_status, finexus_status, notes, broadcast_opt_in, needs_reply,`,
    `  next_follow_up_date, follow_up_count, created_at, updated_at,`,
    `  last_interaction_at, last_message_at, last_customer_message_at, updated_by`,
    `) VALUES (`,
    `  ${q(id)}, ${q(c.name ?? "")}, ${q(phone)}, ${q(rawPhone)}, ${q(c.platform || "whatsapp")},`,
    `  ${q(importStage(c.stage))}, ${q(IMPORT_PRIORITY)}, ${q(c.language ?? "")}, ${q(c.contactType || "customer")},`,
    `  ${q(c.locationName ?? "")}, ${q(c.machineId ?? "")}, ${q(c.itemNo ?? "")},`,
    `  ${q(c.receiptDate ?? "")}, ${q(c.receiptTime ?? "")}, ${q(c.receiptAmount ?? "")},`,
    `  ${q(c.machineStatus || "unknown")}, ${q(c.finexusStatus || "unknown")}, ${q(c.notes ?? "")},`,
    `  ${bool(c.broadcastOptIn)}, ${bool(c.needsReply)},`,
    `  ${q(c.nextFollowUpDate ?? "")}, ${int(c.followUpCount)},`,
    `  ${ts(c.createdAt)}, ${updatedAt ? ts(updatedAt) : q(new Date(0).toISOString())},`,
    `  ${ts(c.lastInteractionAt)}, ${ts(c.lastMessageAt)}, ${ts(c.lastCustomerMessageAt)}, 'import'`,
    `);`,
    ""
  );
  stats.customers += 1;

  for (const tag of new Set((c.tags || []).map((t) => String(t).trim()).filter(Boolean))) {
    lines.push(`INSERT OR IGNORE INTO customer_tags (customer_id, tag) VALUES (${q(id)}, ${q(tag)});`);
    stats.tags += 1;
  }

  // 时间轴：type=message 进 messages，其余进 notes
  for (const e of c.timeline || []) {
    const eid = String(e?.id ?? "").trim();
    if (!eid) continue;
    seq += 1;
    if (e.type === "message") {
      lines.push(
        `INSERT OR IGNORE INTO messages (id, customer_id, direction, platform, body, author, ts, seq)`,
        `VALUES (${q(eid)}, ${q(id)}, ${q(e.direction === "out" ? "out" : "in")},`,
        `        ${q(e.platform || c.platform || "whatsapp")}, ${q(e.text ?? "")}, ${q(e.by ?? "")}, ${ts(e.at)}, ${seq});`
      );
      stats.messages += 1;
    } else {
      const kind = ["note", "stage", "system", "campaign"].includes(e.type) ? e.type : "note";
      lines.push(
        `INSERT OR IGNORE INTO notes (id, customer_id, author, body, kind, ts, seq)`,
        `VALUES (${q(eid)}, ${q(id)}, ${q(e.by ?? "")}, ${q(e.text ?? "")}, ${q(kind)}, ${ts(e.at)}, ${seq});`
      );
      stats.notes += 1;
    }
  }
  if ((c.timeline || []).length) lines.push("");
}

// 汇总栏位从讯息表重算，不是从旧 blob 抄。整批重跑几次结果一样。
if (stats.customers) {
  lines.push(
    "-- last_message_at 从讯息表重算。MAX() 保护：只会往前走，不会把时间往回拨。",
    `UPDATE customers SET`,
    `  last_message_at = NULLIF(MAX(COALESCE(last_message_at, ''), COALESCE(`,
    `    (SELECT MAX(ts) FROM messages m WHERE m.customer_id = customers.id), '')), ''),`,
    `  last_customer_message_at = NULLIF(MAX(COALESCE(last_customer_message_at, ''), COALESCE(`,
    `    (SELECT MAX(ts) FROM messages m WHERE m.customer_id = customers.id AND m.direction = 'in'), '')), '')`,
    `WHERE updated_by = 'import';`,
    ""
  );
}

/* ------------------------------ activities ------------------------------ */

for (const a of Array.isArray(log.activities) ? log.activities : []) {
  const aid = String(a?.id ?? "").trim();
  if (!aid) continue;
  // activities.at 是 NOT NULL。认不出时间的纪录宁可略过，也不要盖上今天的日期。
  const at = ts(a.at);
  if (at === "NULL") {
    warnings.push(`活动纪录 ${aid} 没有可辨识的时间，略过（不填今天）`);
    continue;
  }
  lines.push(
    `INSERT OR IGNORE INTO activities (id, at, actor, actor_email, role, action, target, description)`,
    `VALUES (${q(aid)}, ${at}, ${q(a.actor ?? "")}, ${q(a.actorEmail ?? "")}, ${q(a.role ?? "")},`,
    `        ${q(a.action ?? "")}, ${q(a.target ?? "")}, ${q(a.description ?? "")});`
  );
  stats.activities += 1;
}
if (stats.activities) lines.push("");

/* ------------------------------- settings ------------------------------- */

if (apps && typeof apps === "object") {
  for (const section of ["ai", "automation", "campaigns"]) {
    if (!(section in apps)) continue;
    lines.push(
      `INSERT INTO settings (key, value, updated_at, updated_by)`,
      `VALUES (${q("apps." + section)}, ${q(JSON.stringify(apps[section]))}, ${q(new Date().toISOString())}, 'import')`,
      `ON CONFLICT(key) DO UPDATE SET value = excluded.value,`,
      `  updated_at = excluded.updated_at, updated_by = excluded.updated_by;`,
      ""
    );
    stats.settings += 1;
  }
}

/* -------------------------------- 输出 -------------------------------- */

if (!stats.customers && !stats.activities && !stats.settings) die("没有任何资料可以汇入");

const out = process.argv[3] || "import.sql";
writeFileSync(out, lines.join("\n"));

console.log(`
✓ 已产生 ${out}

  顾客      ${stats.customers}
  标签      ${stats.tags}
  讯息      ${stats.messages}
  备注/事件 ${stats.notes}
  活动纪录  ${stats.activities}
  设定      ${stats.settings}
`);

if (stats.noTimestamp) {
  console.log(`  ⚠ 有 ${stats.noTimestamp} 笔顾客没有可辨识的建立时间，created_at 留空（不填今天）`);
}
if (stats.remappedFromNew) {
  console.log(
    `  ⚠ 有 ${stats.remappedFromNew} 笔原本标成「新进线」，改落进「${IMPORT_STAGE}」\n` +
    `    （汇入的是既有顾客，让它们留在新客清单会把那份清单灌爆）`
  );
}
if (warnings.length) {
  console.log(`\n  注意事项 ${warnings.length} 则：`);
  for (const w of warnings.slice(0, 20)) console.log(`    · ${w}`);
  if (warnings.length > 20) console.log(`    · …还有 ${warnings.length - 20} 则`);
}

console.log(`
汇入的顾客一律是低优先、没有阶段的落在「${IMPORT_STAGE}」，
不会灌爆新客清单。

先在本机试：
  npx wrangler d1 execute rasa-crm --local --file=./${out}

确认没问题再上线上：
  npx wrangler d1 execute rasa-crm --remote --file=./${out}
`);
