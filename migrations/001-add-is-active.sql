-- 只有在加这个栏位之前就已经跑过 db:init 的资料库才需要执行。
-- 全新的资料库不用 —— schema.sql 里已经有了。
--
--   npx wrangler d1 execute rasa-crm --remote --file=./migrations/001-add-is-active.sql
ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;
