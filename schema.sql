-- users：谁是什么角色。
-- 「谁能登入」由 Cloudflare Access 的 Policy 决定，不是这张表。
-- 这张表只回答一件事：这个 email 是 admin 还是 staff。
CREATE TABLE IF NOT EXISTS users (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- email 一律存小写，worker 查询前也会转小写，两边才对得上
  CHECK (email = lower(email))
);

-- app_state：CRM 的资料（顾客、活动纪录、AI/自动化设定）。
-- 前端原本呼叫 window.storage 存这些，现在改存这里，全团队共用同一份。
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT NOT NULL DEFAULT ''
);
