-- 出讯佇列。
--
-- 为什么要一张表而不是直接送：非官方的 WhatsApp 接法，送太快、送太多、
-- 送给没互动过的人都会被封号，而封号没有申诉管道。所以每一则都要先排队、
-- 算好时间、到点才送，而且随时看得出「排了什么、送了什么、为什么没送」。
--
-- scheduled_at 在**建立时**就算好，不是送的时候才算。这样节流是名单建立
-- 当下就固定下来的事实，不会因为 cron 跑得快慢而漂移。

CREATE TABLE IF NOT EXISTS wa_outbox (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  media_url    TEXT NOT NULL DEFAULT '',

  -- 预定送出时间（ISO 8601）。建立时算好，之后不再变动。
  scheduled_at TEXT NOT NULL,

  --   queued    等到点
  --   sending   已被某次 cron 取走，正在处理（原子性取件用，防两个 cron 抢同一笔）
  --   sent      送出去了
  --   failed    送失败，error 有原因
  --   cancelled 送出前重查发现不该送（顾客变成需回覆、已合并…），reason 记在 error
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'cancelled')),

  attempts     INTEGER NOT NULL DEFAULT 0,
  sent_at      TEXT,
  error        TEXT NOT NULL DEFAULT '',

  created_at   TEXT NOT NULL,
  -- 谁排的这一则。系统排的标成 system:*，不要伪装成人。
  created_by   TEXT NOT NULL DEFAULT ''
);

-- cron 每次问的都是同一个问题：「有哪些到点了、还在等的？」
CREATE INDEX IF NOT EXISTS idx_wa_outbox_due ON wa_outbox(status, scheduled_at);

-- 顾客页要看「这个人排了什么、送过什么」
CREATE INDEX IF NOT EXISTS idx_wa_outbox_customer ON wa_outbox(customer_id, scheduled_at);
