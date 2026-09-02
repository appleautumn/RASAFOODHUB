-- users：两层授权的第二层。
-- Cloudflare Access 决定「能不能进门」；这张表决定「进来算不算数、能做什么」。
-- 通过 Access 但不在这张表里、或 is_active = 0 的人，worker 一样挡下来。
CREATE TABLE IF NOT EXISTS users (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  -- 停权开关。设 0 之后就算 Access 放他进门，worker 一样挡下来。
  -- 不必动 Access Policy，改这里立刻生效。
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
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
