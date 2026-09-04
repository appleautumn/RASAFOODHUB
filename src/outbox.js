/**
 * 出讯佇列：排程、节流、送出。
 *
 * 这个模组存在的唯一理由是**不要被封号**。
 *
 * WhatsApp 这条是非官方接法，被封没有申诉管道，号码连同对话纪录一起没了。
 * 触发封号的主要是接收方的检举与封锁，其次才是量与频率 —— 量我们控制得了，
 * 名单是谁得由人决定。所以这里的每一个设计都偏向「宁可慢、宁可不送」。
 */

import { nowIso, nextSeq } from "./sql.js";

/** 影子模式：true = 逻辑照跑、纪录照留，但不真的送出。**预设开着**。 */
export const SHADOW_KEY = "wa.shadow_mode";
/** 两则之间至少间隔几秒 */
export const SPACING_KEY = "wa.spacing_seconds";
/** 一天最多送几则 */
export const DAILY_CAP_KEY = "wa.daily_cap";

export const DEFAULTS = {
  [SHADOW_KEY]: "true",
  [SPACING_KEY]: "90",
  [DAILY_CAP_KEY]: "40",
};

/** cron 每次最多处理几笔。刻意小 —— 宁可下一分钟再送。 */
export const BATCH_LIMIT = 8;

/* ----------------------------- 设定 ----------------------------- */

export async function readSettings(db) {
  const keys = Object.keys(DEFAULTS);
  const { results } = await db
    .prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => "?").join(", ")})`)
    .bind(...keys)
    .all();

  const stored = Object.fromEntries((results || []).map((r) => [r.key, r.value]));
  const raw = { ...DEFAULTS, ...stored };

  return {
    // 只有明确写着 "false" 才关掉影子模式。任何其它值（空字串、乱码、
    // 没设定）都当成「还在影子模式」—— 打开真发送必须是刻意的动作。
    shadow: String(raw[SHADOW_KEY]).trim().toLowerCase() !== "false",
    spacingSeconds: positiveInt(raw[SPACING_KEY], Number(DEFAULTS[SPACING_KEY])),
    dailyCap: positiveInt(raw[DAILY_CAP_KEY], Number(DEFAULTS[DAILY_CAP_KEY])),
  };
}

/** 设定值坏掉时回预设，不要变成 0 或 NaN —— 那会让节流整个失效 */
function positiveInt(value, fallback) {
  const n = Number(String(value).trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/* ----------------------------- 排程 ----------------------------- */

/**
 * 算出这一批每一则的送出时间。
 *
 * 规则：接在「已经排好的最后一则」之后，每 spacingSeconds 一则；
 * 同一天排满 dailyCap 则就推到隔天再继续。
 *
 * 在建立时就算好，是因为节流必须是**名单建立当下就固定的事实**。
 * 如果留到送的时候才算，cron 跑得密一点、或有人手动触发，节流就漂掉了。
 */
export function planSchedule({ count, startFrom, lastScheduledAt, sentTodayCount, spacingSeconds, dailyCap }) {
  const out = [];
  const start = new Date(startFrom);

  // 从「现在」和「最后一则已排程」之间较晚的那个接下去
  let cursor = lastScheduledAt && new Date(lastScheduledAt) > start ? new Date(lastScheduledAt) : start;
  let dayKey = cursor.toISOString().slice(0, 10);
  let usedToday = sentTodayCount;

  for (let i = 0; i < count; i++) {
    if (i > 0 || lastScheduledAt) cursor = new Date(cursor.getTime() + spacingSeconds * 1000);

    // 跨过午夜就重算当天用量
    const cursorDay = cursor.toISOString().slice(0, 10);
    if (cursorDay !== dayKey) {
      dayKey = cursorDay;
      usedToday = 0;
    }

    if (usedToday >= dailyCap) {
      // 推到隔天 00:00 之后的第一格
      const next = new Date(`${dayKey}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      cursor = next;
      dayKey = cursor.toISOString().slice(0, 10);
      usedToday = 0;
    }

    out.push(cursor.toISOString());
    usedToday += 1;
  }
  return out;
}

/* ----------------------------- 入列 ----------------------------- */

export async function enqueue(db, { items, actor }) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, status: 400, error: "no_items" };
  }

  const settings = await readSettings(db);
  const now = nowIso();
  const today = now.slice(0, 10);

  const last = await db
    .prepare("SELECT scheduled_at FROM wa_outbox WHERE status IN ('queued','sending') ORDER BY scheduled_at DESC LIMIT 1")
    .first();

  const usedToday = await db
    .prepare("SELECT COUNT(*) AS n FROM wa_outbox WHERE substr(scheduled_at, 1, 10) = ? AND status != 'cancelled'")
    .bind(today)
    .first();

  const times = planSchedule({
    count: items.length,
    startFrom: now,
    lastScheduledAt: last?.scheduled_at ?? null,
    sentTodayCount: Number(usedToday?.n ?? 0),
    spacingSeconds: settings.spacingSeconds,
    dailyCap: settings.dailyCap,
  });

  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const customerId = String(items[i]?.customerId ?? "").trim();
    const body = String(items[i]?.body ?? "");
    if (!customerId || !body) return { ok: false, status: 400, error: "customer_and_body_required" };

    rows.push({
      id: `ob-${crypto.randomUUID()}`,
      customerId,
      body,
      mediaUrl: String(items[i]?.mediaUrl ?? ""),
      scheduledAt: times[i],
    });
  }

  await db.batch(
    rows.map((r) =>
      db
        .prepare(
          `INSERT INTO wa_outbox (id, customer_id, body, media_url, scheduled_at, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(r.id, r.customerId, r.body, r.mediaUrl, r.scheduledAt, now, actor)
    )
  );

  return {
    ok: true,
    status: 201,
    queued: rows.length,
    shadow: settings.shadow,
    spacingSeconds: settings.spacingSeconds,
    dailyCap: settings.dailyCap,
    firstAt: rows[0].scheduledAt,
    lastAt: rows[rows.length - 1].scheduledAt,
    ids: rows.map((r) => r.id),
  };
}

/* --------------------------- 送出前重查 --------------------------- */

/**
 * 从排进佇列到真的要送，中间可能过了几小时。顾客的状态可能已经变了。
 * 回 null 表示可以送，回字串表示不该送的原因。
 *
 * 这些条件全部偏向「不送」。漏送一则排程讯息，成本是有人晚点手动补；
 * 误送一则，成本可能是被检举、被封号。两边不对等。
 */
export function refusalReason(customer) {
  if (!customer) return "customer_not_found";
  if (customer.merged_into) return `已合并到 ${customer.merged_into}`;
  if (customer.contact_type !== "customer") return `contact_type 是 ${customer.contact_type}`;
  if (!customer.phone) return "没有可拨的号码（只有隐藏 ID）";

  // 没有同意接收群发的人，不送排程讯息。
  //
  // 这道检查只挡 outbox 这条路 —— 同事在对话里手动回覆走的是
  // /api/wa/send，不经过这里。会被检举的是「没找过你的人收到你的讯息」，
  // 而 broadcast_opt_in 正是记录「这个人愿不愿意收」的栏位。
  if (!customer.broadcast_opt_in) return "broadcast_opt_in 是 0，没有同意接收群发";

  // 顾客正在等我们回覆时，不该插一则排程讯息进去
  if (customer.needs_reply) return "顾客正在等回覆，排程讯息先跳过";
  return null;
}

/* ----------------------------- 取件 ----------------------------- */

/**
 * 原子性取件：把 queued 改成 sending，只有真的改到的那一方拿得到这一笔。
 *
 * 没有这一步的话，两个同时触发的 cron 会取到同一批，同一则送两次 ——
 * 顾客收到重复讯息，而且白白多送一则（算进封号风险）。
 */
export async function claimDue(db, { now = nowIso(), limit = BATCH_LIMIT } = {}) {
  const { results } = await db
    .prepare(
      `SELECT id FROM wa_outbox
        WHERE status = 'queued' AND scheduled_at <= ?
        ORDER BY scheduled_at ASC
        LIMIT ?`
    )
    .bind(now, limit)
    .all();

  const claimed = [];
  for (const row of results || []) {
    const res = await db
      .prepare("UPDATE wa_outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'queued'")
      .bind(row.id)
      .run();
    // changes === 0 表示别人先抢到了，跳过
    if ((res.meta?.changes ?? 0) > 0) claimed.push(row.id);
  }

  if (claimed.length === 0) return [];

  const { results: full } = await db
    .prepare(
      `SELECT o.*, c.phone, c.contact_type, c.needs_reply, c.merged_into, c.broadcast_opt_in
         FROM wa_outbox o
         LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.id IN (${claimed.map(() => "?").join(", ")})
        ORDER BY o.scheduled_at ASC`
    )
    .bind(...claimed)
    .all();

  return full || [];
}

/* ----------------------------- 送出 ----------------------------- */

const finish = (db, id, status, { error = "", sentAt = null } = {}) =>
  db
    .prepare("UPDATE wa_outbox SET status = ?, error = ?, sent_at = ? WHERE id = ?")
    .bind(status, error, sentAt, id)
    .run();

/**
 * 处理一批取到的讯息。
 *
 * @param send  async ({ to, body }) => { ok, id } —— 真正送出的动作，
 *              由呼叫端注入。影子模式下不会被呼叫。
 */
export async function processBatch(db, rows, { send, shadow, recordMessage }) {
  const result = { sent: 0, cancelled: 0, failed: 0, shadow: Boolean(shadow), details: [] };

  for (const row of rows) {
    const refusal = refusalReason({
      id: row.customer_id,
      phone: row.phone,
      contact_type: row.contact_type,
      needs_reply: row.needs_reply,
      merged_into: row.merged_into,
      broadcast_opt_in: row.broadcast_opt_in,
    });

    if (refusal) {
      await finish(db, row.id, "cancelled", { error: refusal });
      result.cancelled += 1;
      result.details.push({ id: row.id, status: "cancelled", reason: refusal });
      continue;
    }

    // 影子模式：逻辑全部跑完、状态照写，就是不真的送。
    // 这样你可以先看「该送给谁、送什么」都对了，再打开。
    if (shadow) {
      await finish(db, row.id, "sent", { error: "shadow", sentAt: nowIso() });
      result.sent += 1;
      result.details.push({ id: row.id, status: "sent", shadow: true });
      continue;
    }

    try {
      const sent = await send({ to: row.phone, body: row.body });
      if (!sent?.ok) throw new Error(sent?.detail || sent?.error || "send_failed");

      await finish(db, row.id, "sent", { sentAt: nowIso() });
      if (recordMessage) await recordMessage(row, sent);
      result.sent += 1;
      result.details.push({ id: row.id, status: "sent", platformMsgId: sent.id ?? null });
    } catch (err) {
      await finish(db, row.id, "failed", { error: String(err.message || err).slice(0, 300) });
      result.failed += 1;
      result.details.push({ id: row.id, status: "failed", error: String(err.message || err).slice(0, 200) });
    }
  }

  return result;
}
