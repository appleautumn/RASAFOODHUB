-- users 表的内容。改完执行：npm run db:seed
--
-- ⚠️ 这里的 email 必须跟 Access Policy 里允许的 email 一模一样（全小写）。
--    两边对不上 = 登入得进来，但角色查不到。
INSERT INTO users (email, name, role) VALUES
  ('rasafoodhubplt@gmail.com', 'Rasa Admin', 'admin')
ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role;

-- 以后要加同事，解掉下面的注解、改成他的 email（staff 看不到「团队活动」页）。
-- 记得同一个 email 也要加进 Access 的 Policy，否则他连登入页都过不了。
-- INSERT INTO users (email, name, role) VALUES
--   ('staff@example.com', 'Ah Kit', 'staff')
-- ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role;
