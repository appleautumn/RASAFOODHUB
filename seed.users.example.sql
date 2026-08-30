-- 复制成 seed.users.sql 改成你自己的 email 再执行。
-- 注意：这里的 email 必须跟 Access Policy 里允许的 email 一模一样（全小写）。
INSERT INTO users (email, name, role) VALUES
  ('rasafoodhubplt@gmail.com', 'Rasa Admin', 'admin')
ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role;

-- 同事的例子（只会看到除了「团队活动」以外的页面）：
-- INSERT INTO users (email, name, role) VALUES
--   ('staff@example.com', 'Ah Kit', 'staff')
-- ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role;
