-- 机器清单。
--
-- 为什么要这张表：顾客的 Location 与 Machine ID 一直是自由文字，
-- 打错的机号会一路带到 FINEXUS 核实才被发现。有了清单，顾客讲的地方
-- 可以对回一台真实存在的机器，机号不用他们打。
--
-- 目前是一个点位一台机，所以 machine_id 唯一。之后同一个点位放两台时，
-- 这个唯一键还是对的（机号本来就不该重复），location_name 会有两列。

CREATE TABLE IF NOT EXISTS machines (
  id            TEXT PRIMARY KEY,

  -- 机器萤幕左边显示的那串。顾客照着念的就是它。
  machine_id    TEXT NOT NULL UNIQUE,
  -- 点位全名，顾客与员工看到的都是这个
  location_name TEXT NOT NULL,

  -- 顾客不会讲全名。「selayang」「selayang hospital」「医院那台」都要对得上，
  -- 所以这里放用换行分隔的别名，比对时一起看。
  aliases       TEXT NOT NULL DEFAULT '',

  -- 分区，之后要按区看报表用得到。现在可以留空。
  area          TEXT NOT NULL DEFAULT '',

  --   active     正常营运
  --   paused     暂停（维修中、场地关闭）
  --   retired    已撤机 —— 留着不删，旧个案还指着它
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'paused', 'retired')),

  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  updated_by    TEXT NOT NULL DEFAULT ''
);

-- 顾客讲了地方要找回机器：比对时整张捞出来做正规化比对（35 列，很小），
-- 这个索引是给「按点位排序的清单页」用的
CREATE INDEX IF NOT EXISTS idx_machines_location ON machines(location_name);
CREATE INDEX IF NOT EXISTS idx_machines_status ON machines(status);
