-- 把已经建好的资料库（只有 users + app_state）升级到关联式结构。
-- 全新的资料库不用跑这个 —— schema.sql 里已经有了。
--
--   npx wrangler d1 execute rasa-crm --local  --file=./migrations/002-relational-schema.sql
--   npx wrangler d1 execute rasa-crm --remote --file=./migrations/002-relational-schema.sql
--
-- 这个档案只「加」东西，不删任何资料：app_state 原封不动留着，
-- 让你可以先把旧 blob 汇出来（见下面）灌进新表，确认没问题之后再自己决定要不要丢。
--
-- 搬旧资料的步骤：
--   1. npx wrangler d1 execute rasa-crm --local --json \
--        --command="SELECT key, value FROM app_state" > app_state.json
--   2. node scripts/import-data.mjs app_state.json
--   3. npx wrangler d1 execute rasa-crm --local --file=./import.sql
--   4. 全部确认无误之后（不急，可以放几天）：DROP TABLE app_state;

/* ----------------------------- customers ----------------------------- */

CREATE TABLE IF NOT EXISTS customers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',

  -- phone 是正规化后的号码（只有数字、含国码、没有开头 0），所有比对与找重复都用它。
  -- phone_raw 是员工实际输入的字串，原样存着 —— 画面上显示的是这个，
  -- 正规化不会改变使用者看到的东西。
  phone         TEXT NOT NULL DEFAULT '',
  phone_raw     TEXT NOT NULL DEFAULT '',
  platform      TEXT NOT NULL DEFAULT 'whatsapp',

  stage         TEXT NOT NULL DEFAULT 'new',
  priority      TEXT NOT NULL DEFAULT 'medium',
  language      TEXT NOT NULL DEFAULT '',
  contact_type  TEXT NOT NULL DEFAULT 'customer',

  location_name TEXT NOT NULL DEFAULT '',
  machine_id    TEXT NOT NULL DEFAULT '',
  item_no       TEXT NOT NULL DEFAULT '',
  receipt_date  TEXT NOT NULL DEFAULT '',
  receipt_time  TEXT NOT NULL DEFAULT '',
  receipt_amount TEXT NOT NULL DEFAULT '',
  machine_status TEXT NOT NULL DEFAULT 'unknown',
  finexus_status TEXT NOT NULL DEFAULT 'unknown',

  notes            TEXT NOT NULL DEFAULT '',
  broadcast_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (broadcast_opt_in IN (0, 1)),
  needs_reply      INTEGER NOT NULL DEFAULT 0 CHECK (needs_reply IN (0, 1)),
  next_follow_up_date TEXT NOT NULL DEFAULT '',
  follow_up_count  INTEGER NOT NULL DEFAULT 0,

  -- 时间戳一律可以是 NULL。「不知道」跟「现在」是两件事 ——
  -- 缺时间戳的资料如果填成现在，那批资料会被当成今天的活动，
  -- 之后所有依赖时间的分类逻辑都会歪掉。
  created_at    TEXT,
  updated_at    TEXT NOT NULL,
  last_interaction_at TEXT,
  last_message_at     TEXT,
  last_customer_message_at TEXT,

  -- 软合并指标。跨平台重复顾客合并后指向主记录，资料不删除。
  merged_into   TEXT REFERENCES customers(id) ON DELETE SET NULL,

  updated_by    TEXT NOT NULL DEFAULT ''
);

-- 电话：找重复、跨平台合并、Inbox 搜寻
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
-- 阶段：Dashboard 每阶段人数、Pipeline 筛选
CREATE INDEX IF NOT EXISTS idx_customers_stage ON customers(stage);
-- 最后讯息时间：「最久未处理」排序、长期无回应扫描
CREATE INDEX IF NOT EXISTS idx_customers_last_message_at ON customers(last_message_at);
-- 列表预设排序的键
CREATE INDEX IF NOT EXISTS idx_customers_updated_at ON customers(updated_at);
-- 待回覆队列
CREATE INDEX IF NOT EXISTS idx_customers_needs_reply ON customers(needs_reply);
-- 跟进到期扫描
CREATE INDEX IF NOT EXISTS idx_customers_next_follow_up ON customers(next_follow_up_date);
-- 合并后的记录预设不出现在列表里
CREATE INDEX IF NOT EXISTS idx_customers_merged_into ON customers(merged_into);

/* --------------------------- customer_tags --------------------------- */

-- 标签拆成一张关联表，不是塞成 JSON 阵列。
-- 「排除某标签 × 某阶段 × 排序」这种名单条件要能进 WHERE，塞 JSON 就只能捞回来过滤。
CREATE TABLE IF NOT EXISTS customer_tags (
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  PRIMARY KEY (customer_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_customer_tags_tag ON customer_tags(tag);

/* ------------------------------ messages ----------------------------- */

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  direction   TEXT NOT NULL DEFAULT 'in' CHECK (direction IN ('in', 'out')),
  platform    TEXT NOT NULL DEFAULT 'whatsapp',
  body        TEXT NOT NULL DEFAULT '',
  -- 平台给的原始 message id。桥接机重连补送积压讯息时，
  -- INSERT OR IGNORE 配这个唯一键就不会写成两笔。
  platform_msg_id TEXT UNIQUE,
  author      TEXT NOT NULL DEFAULT '',
  ts          TEXT,
  -- 同一毫秒内写进来的多则讯息，用这个决定先后，让排序结果稳定
  seq         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_customer_ts ON messages(customer_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_platform_msg_id ON messages(platform_msg_id);

/* ------------------------------- notes ------------------------------- */

-- 顾客时间轴上不是讯息的那些事件：内部备注、阶段变更、系统动作、群发纪录。
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  author      TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'note',
  ts          TEXT,
  seq         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_notes_customer_ts ON notes(customer_id, ts);

/* ------------------------------ orders ------------------------------- */

CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount      REAL NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'MYR',
  status      TEXT NOT NULL DEFAULT 'pending',
  reference   TEXT NOT NULL DEFAULT '',
  ts          TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_customer_ts ON orders(customer_id, ts);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

/* ------------------------------- tasks ------------------------------- */

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'follow_up',
  title       TEXT NOT NULL DEFAULT '',
  due_at      TEXT,
  done        INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  done_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_customer ON tasks(customer_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(done, due_at);

/* ----------------------------- activities ---------------------------- */

-- 「团队活动」页的资料来源。
-- 这张也必须是真的表：留在 blob 里的话，两个人同时操作，
-- 各自的操作纪录会互相覆盖 —— 那正是这次要修掉的问题。
CREATE TABLE IF NOT EXISTS activities (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL DEFAULT '',
  actor_email TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL DEFAULT '',
  target      TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  -- 同一毫秒内写进来的多笔纪录用这个决定先后。
  -- 「团队活动」页是照阵列顺序直接画的，没有 seq 的话同秒的几列每次载入都会换位置。
  seq         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_activities_at ON activities(at);

/* ------------------------------ settings ----------------------------- */

-- 系统设定与开关。这张维持 key-value —— 设定本来就是这个形状。
-- 但拆成多个 key（apps.ai / apps.automation / apps.campaigns），
-- 让改 AI 知识库的人跟改群发名单的人不会互相覆盖。
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT ''
);
