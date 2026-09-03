-- 基线：正式库现在真实的样子。
--
-- 这个资料库是先用 schema.sql / 后台 Console 建起来的，之后才接上
-- migrations，所以第一支的工作不是「改结构」，而是「把现况登记下来」，
-- 让后面的 migration 有一个明确的起点。
--
-- 整支都是 CREATE TABLE IF NOT EXISTS：对已经有这两张表的正式库跑起来
-- 是完全的 no-op，只会在 d1_migrations 留下一笔「0001 已套用」；对全新的
-- 资料库则会真的建表。两种情况的结果一致 —— 这是它能安全补跑的原因。
--
-- 之后要改结构一律新增下一支（0002、0003…），不要回头改这支：
-- 已经套用过的 migration 改了也不会重跑，只会让正式库跟 repo 对不上。

CREATE TABLE IF NOT EXISTS users (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  -- 停权开关。设 0 之后就算 Access 放他进门，worker 一样挡下来。
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- email 一律存小写，worker 查询前也会转小写，两边才对得上
  CHECK (email = lower(email))
);

CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT NOT NULL DEFAULT ''
);
