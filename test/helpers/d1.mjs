/**
 * 用 node:sqlite 做一个 D1 形状的替身。
 *
 * 刻意不写「假资料库」—— 假的只会验到我自己写的假逻辑。
 * D1 底下就是 SQLite，这里跑的是真的 SQL：真的 WHERE、真的 ORDER BY、
 * 真的唯一键冲突、真的 changes 计数。测试里断言的东西线上也成立。
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { D1_MAX_BINDINGS } from "../../src/sql.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(here, "..", "..", "schema.sql");

/** D1 的 ?1 ?2 具名参数与 ? 位置参数都要能跑 */
const toPositional = (sql) => sql.replace(/\?\d+/g, "?");

export function createTestDb({ schema = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  if (schema) sqlite.exec(readFileSync(SCHEMA, "utf8"));

  const db = {
    prepare(sql) {
      const text = toPositional(sql);
      let args = [];
      const api = {
        bind(...a) {
          // D1 一句最多 100 个 bind 参数 —— 比 SQLite 自己的 999 低很多。
          // 替身照 D1 的上限来，否则这类 bug 要等资料量长起来才在线上炸。
          if (a.length > D1_MAX_BINDINGS) {
            throw new Error(
              `too many SQL variables: 这一句绑了 ${a.length} 个参数，D1 上限是 ${D1_MAX_BINDINGS}。` +
              `把 IN (?,?,…) 切块（src/sql.js 的 chunk）。SQL: ${text.slice(0, 120)}…`
            );
          }
          // SQLite 不吃 boolean / undefined，先转成它认得的型别
          args = a.map((v) => {
            if (v === undefined) return null;
            if (typeof v === "boolean") return v ? 1 : 0;
            return v;
          });
          return api;
        },
        async first() {
          const stmt = sqlite.prepare(text);
          return stmt.get(...args) ?? null;
        },
        async all() {
          const stmt = sqlite.prepare(text);
          return { results: stmt.all(...args), success: true };
        },
        async run() {
          const stmt = sqlite.prepare(text);
          const info = stmt.run(...args);
          // D1 把影响列数放在 meta.changes
          return {
            success: true,
            meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
          };
        },
        async raw() {
          const stmt = sqlite.prepare(text);
          return stmt.all(...args).map((r) => Object.values(r));
        },
      };
      return api;
    },

    async batch(stmts) {
      const out = [];
      sqlite.exec("BEGIN");
      try {
        for (const s of stmts) out.push(await s.run());
        sqlite.exec("COMMIT");
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
      return out;
    },

    /* -------- 测试自己用的小工具，worker 不会碰 -------- */

    _exec: (sql) => sqlite.exec(sql),
    _rows: (sql, ...args) => sqlite.prepare(toPositional(sql)).all(...args),
    _row: (sql, ...args) => sqlite.prepare(toPositional(sql)).get(...args) ?? null,
    _close: () => sqlite.close(),
    /** EXPLAIN QUERY PLAN —— 用来证明查询真的走了索引，不是整表扫描 */
    _plan: (sql, ...args) =>
      sqlite.prepare("EXPLAIN QUERY PLAN " + toPositional(sql)).all(...args).map((r) => r.detail),
  };

  return db;
}

/** worker 的 env。ASSETS 回一段可辨识的 HTML，方便断言「有没有把 CRM 吐出来」。 */
export function testEnv(db, overrides = {}) {
  return {
    ACCESS_TEAM_DOMAIN: "rasafoodhub.cloudflareaccess.com",
    ACCESS_AUD: "test-aud-tag",
    REQUIRE_USER_ROW: "true",
    DB: db,
    ASSETS: {
      fetch: async () =>
        new Response("<html>CRM</html>", { headers: { "content-type": "text/html" } }),
    },
    ...overrides,
  };
}

export function seedUsers(db, users) {
  for (const u of users) {
    db._exec(
      `INSERT INTO users (email, name, role, is_active) VALUES (
         '${u.email}', '${u.name.replace(/'/g, "''")}', '${u.role}', ${u.is_active})`
    );
  }
}
