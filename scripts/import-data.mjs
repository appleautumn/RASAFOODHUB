#!/usr/bin/env node
/**
 * 把 Claude Artifact 里的 CRM 资料转成可以灌进 D1 的 SQL。
 *
 *   node scripts/import-data.mjs export.json
 *   → 产出 import.sql
 *   → npx wrangler d1 execute rasa-crm --remote --file=./import.sql
 *
 * export.json 怎么来的看 docs/migrate-from-artifact.md。
 */

import { readFileSync, writeFileSync } from "node:fs";

const KNOWN_KEYS = ["rasa-crm:main", "rasa-crm:log", "rasa-crm:apps"];
const input = process.argv[2];

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

if (!input) die("用法：node scripts/import-data.mjs export.json");

let data;
try {
  data = JSON.parse(readFileSync(input, "utf8"));
} catch (e) {
  die(`读不了 ${input}：${e.message}`);
}
if (!data || typeof data !== "object" || Array.isArray(data)) {
  die("export.json 应该是一个物件：{ \"rasa-crm:main\": \"...\", ... }");
}

const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

const lines = ["-- 由 scripts/import-data.mjs 产生", ""];
let imported = 0;

for (const [key, value] of Object.entries(data)) {
  if (value === null || value === undefined) {
    console.log(`  略过 ${key}（是空的）`);
    continue;
  }
  if (typeof value !== "string") {
    die(`${key} 的值必须是字串（artifact 存的就是 JSON 字串），现在是 ${typeof value}`);
  }
  try {
    JSON.parse(value);
  } catch {
    die(`${key} 的值不是合法 JSON，八成是复制的时候少了一段`);
  }
  if (!KNOWN_KEYS.includes(key)) {
    console.log(`  ⚠ ${key} 不是预期的 key，还是会一起汇入`);
  }

  // 单一 upsert：已经有这个 key 就覆盖，不会因为主键冲突整批中断
  lines.push(
    `INSERT INTO app_state (key, value, updated_at, updated_by)`,
    `VALUES (${sqlString(key)}, ${sqlString(value)}, datetime('now'), 'import')`,
    `ON CONFLICT(key) DO UPDATE SET`,
    `  value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by;`,
    ""
  );

  const size = (new TextEncoder().encode(value).length / 1024).toFixed(1);
  console.log(`  ✓ ${key}（${size} KB）`);
  imported += 1;
}

if (imported === 0) die("没有任何资料可以汇入");

writeFileSync("import.sql", lines.join("\n"));
console.log(`
✓ 已产生 import.sql（${imported} 笔）

灌进线上资料库：
  npx wrangler d1 execute rasa-crm --remote --file=./import.sql

先在本机试：
  npx wrangler d1 execute rasa-crm --local --file=./import.sql
`);
