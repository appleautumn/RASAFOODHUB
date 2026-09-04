/**
 * WhatsApp 桥接机的 Worker 这一端。
 *
 * 桥接机（Baileys，跑在常驻主机上）与这里之间是机器对机器：不走 Cloudflare
 * Access 的使用者身分，改用一个共用 secret。人走 OTP，机器走 secret。
 *
 * ⚠️ 这个模组刻意不依赖 dashboard 那一侧的任何东西（api.js 的资源层、
 *    使用者身分、乐观锁）。之后 Meta 的 webhook 带不了自订标头，必须把
 *    webhook 拆成一支不挡 Access 的独立 Worker 时，整个档案可以直接搬走。
 *    唯一的对外相依是 phone.js 与 sql.js 这两个纯工具。
 */

import { normalizePhone } from "./phone.js";
import { nowIso, nextSeq } from "./sql.js";

const PLATFORM = "whatsapp";
/** 系统写入的 actor。不要伪装成人 —— 团队活动页要分得出来是机器写的。 */
export const SYSTEM_ACTOR = "system:whatsapp";
/** 认不出号码而自动开出来的顾客，打这个标签让人工去确认 */
export const NEW_MESSAGE_TAG = "新讯息";
/** 只拿得到隐藏 ID、没有电话号码的顾客 */
export const NEEDS_PHONE_TAG = "待补号码";

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/* ============================ 时间戳 ============================ */

/**
 * Baileys 的 messageTimestamp 型别不固定：数字、字串、或 Long 物件
 * （{low, high, unsigned}）都可能出现。
 *
 * 回传 Unix 秒数；**判读不出来一律回 0**。
 *
 * ⚠️ 绝对不能在判读失败时退回「现在」。旧讯息被标成今天不会有任何错误
 *    讯息，但之后每一条依赖时间的分类与自动化都会跟着歪 —— 这种错找起来
 *    极贵。回 0 让呼叫端把整则讯息略过，是刻意选的：宁可少一则、也不要
 *    默默写错一批。
 */
export function toEpochSeconds(value) {
  if (value === null || value === undefined) return 0;

  // Long 物件（protobuf 的 64 位元整数）。先认它，因为 Number(物件) 会得到 NaN。
  if (typeof value === "object") {
    if (typeof value.toNumber === "function") return normalizeEpoch(value.toNumber());
    if (typeof value.low === "number" && typeof value.high === "number") {
      // high 是高 32 位元，low 要当成无号数看
      return normalizeEpoch(value.high * 4294967296 + (value.low >>> 0));
    }
    return 0;
  }

  if (typeof value === "boolean") return 0;

  const n = typeof value === "number" ? value : Number(String(value).trim());
  return normalizeEpoch(n);
}

/**
 * 秒与毫秒的分界。10 位数是秒、13 位数是毫秒，1e11 落在两者中间很宽的空档：
 * 用秒解读是公元 5138 年，用毫秒解读是 1973 年。任何真实讯息都不会落在附近，
 * 所以这个判断不会误伤。
 */
const MS_THRESHOLD = 1e11;

function normalizeEpoch(n) {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const seconds = n >= MS_THRESHOLD ? Math.floor(n / 1000) : Math.floor(n);
  // 上限挡明显荒谬的值（西元 3000 年之后），下限挡 1970 附近的杂讯
  if (seconds <= 0 || seconds > 32503680000) return 0;
  return seconds;
}

export const epochToIso = (seconds) => new Date(seconds * 1000).toISOString();

/* ============================ 号码 ============================ */

/**
 * Baileys 给的是 JID，不是号码：
 *   60123456789@s.whatsapp.net      一般号码
 *   60123456789:12@s.whatsapp.net   带装置编号
 *   1234567890123@lid               隐藏 ID，没有号码可取
 *
 * 回 { phone, local, lid, raw }：
 *   phone  正规化后的比对用值（隐藏 ID 时为空字串）
 *   local  平台给的原始 local part，拿来当 phone_raw 显示
 *   lid    隐藏 ID
 *   raw    原始 JID
 */
export function parseJid(jid) {
  const raw = String(jid ?? "").trim();
  if (!raw) return { phone: "", local: "", lid: "", raw: "" };

  const at = raw.indexOf("@");
  const domain = at === -1 ? "" : raw.slice(at + 1).toLowerCase();
  let local = at === -1 ? raw : raw.slice(0, at);

  // 装置编号（:12）不是号码的一部分
  const colon = local.indexOf(":");
  if (colon !== -1) local = local.slice(0, colon);

  // 隐藏 ID：这里没有号码可用。阶段 C 会处理对照，现阶段照样收讯息，
  // 只是这位顾客暂时没有 phone。
  // 隐藏 ID：phone 一定留空。
  // ⚠️ 绝对不要拿 LID 去拼一个看起来像电话的字串 —— 那会污染号码比对，
  //    之后找重复顾客会整批出错，而且错得很安静。
  if (domain === "lid") return { phone: "", local, lid: local, raw };

  return { phone: normalizePhone(local), local, lid: "", raw };
}

/** 粗筛用的后 9 码 */
const tail9 = (phone) => String(phone || "").slice(-9);

/**
 * 找顾客。先用完整号码精准查（走得到 idx_customers_phone），没中再用后 9 码
 * 粗筛、拿回来在 JS 里用完整号码判定 —— 涵盖两边国码写法不一致的情形。
 */
async function findCustomerByPhone(db, phone) {
  if (!phone) return null;

  const exact = await db
    .prepare("SELECT id, phone, last_message_at FROM customers WHERE phone = ? LIMIT 1")
    .bind(phone)
    .first();
  if (exact) return exact;

  const tail = tail9(phone);
  if (tail.length < 7) return null;
  const { results } = await db
    .prepare("SELECT id, phone, last_message_at FROM customers WHERE phone LIKE ? LIMIT 25")
    .bind(`%${tail}`)
    .all();
  return (results || []).find((r) => tail9(r.phone) === tail) || null;
}

/** 隐藏 ID 的顾客用 phone_raw 存 JID，靠它认回来 */
async function findCustomerByJid(db, raw) {
  if (!raw) return null;
  return db
    .prepare("SELECT id, phone, last_message_at FROM customers WHERE phone_raw = ? LIMIT 1")
    .bind(raw)
    .first();
}

/* ============================ 写入 ============================ */

/**
 * 自动开一位顾客。
 *
 * 讯息绝对不能掉 —— 宁可开一笔要人工确认的顾客，也不要因为号码认不出来
 * 就把讯息丢掉。id 由号码推出（决定性的），所以同一个号码的两则讯息同时
 * 进来也只会开出一位。
 */
async function createCustomer(db, { phone, local, lid, raw, displayName }) {
  const id = phone ? `wa-${phone}` : `wa-lid-${lid}`;
  const now = nowIso();

  // phone_raw 是画面上显示的字串。自动建立时没有「员工输入的原字串」，
  // 就用平台给的：一般号码显示号码本身，隐藏 ID 显示完整 JID（带 @lid），
  // 让人一眼看出那不是电话号码。
  const phoneRaw = lid ? raw : local || phone;

  // created_at 用现在是对的：这位顾客确实是现在被建立的，
  // 跟「讯息发生在什么时候」是两件事，不要混用。
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO customers
         (id, name, phone, phone_raw, platform, stage, contact_type,
          created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 'new', 'customer', ?, ?, ?)`
    )
    .bind(id, String(displayName || ""), phone, phoneRaw, PLATFORM, now, now, SYSTEM_ACTOR)
    .run();

  const created = (res.meta?.changes ?? 0) > 0;
  if (created) {
    const tags = lid ? [NEW_MESSAGE_TAG, NEEDS_PHONE_TAG] : [NEW_MESSAGE_TAG];
    for (const tag of tags) {
      await db
        .prepare("INSERT OR IGNORE INTO customer_tags (customer_id, tag) VALUES (?, ?)")
        .bind(id, tag)
        .run();
    }
  }
  return { id, created };
}

/**
 * 顾客身上的时间戳一律用 MAX() 往前推，绝不往回拨。
 *
 * 少了这道保护，一则补送的旧讯息会把 last_message_at 拉回过去，顾客就会
 * 错误地掉进「很久没联络」那类自动化里。COALESCE 是因为这些栏位可以是
 * NULL，而 SQLite 的 MAX() 只要有一个 NULL 就整个回 NULL。
 */
async function touchCustomerTimestamps(db, customerId, iso, direction) {
  const sets = [
    "last_interaction_at = MAX(COALESCE(last_interaction_at, ''), ?)",
    "last_message_at = MAX(COALESCE(last_message_at, ''), ?)",
  ];
  const binds = [iso, iso];

  if (direction === "in") {
    sets.push("last_customer_message_at = MAX(COALESCE(last_customer_message_at, ''), ?)");
    binds.push(iso);
  }

  // 这一列确实被改动了，updated_at / updated_by 就要照实反映，
  // 不留痕的写入之后没人查得出来是谁动的。
  sets.push("updated_at = ?", "updated_by = ?");
  binds.push(nowIso(), SYSTEM_ACTOR);

  await db
    .prepare(`UPDATE customers SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds, customerId)
    .run();
}

/**
 * 收一则讯息。
 *
 * 阶段 A 只做「收进来、写进去」：不自动回覆、不改阶段、不动 needs_reply、
 * 不判断要不要转真人。那些等后面的阶段。
 */
export async function ingestMessage(db, raw) {
  const platformMsgId = String(raw?.id ?? "").trim();
  if (!platformMsgId) return { status: "skipped", reason: "missing_id" };

  const seconds = toEpochSeconds(raw?.timestamp);
  if (seconds === 0) {
    // 判读不出时间就整则略过 —— 不猜、更不退回「现在」
    return { status: "skipped", reason: "bad_timestamp", id: platformMsgId };
  }
  const iso = epochToIso(seconds);

  const jid = parseJid(raw?.from);
  if (!jid.phone && !jid.lid) return { status: "skipped", reason: "bad_jid", id: platformMsgId };

  const direction = raw?.fromMe ? "out" : "in";

  let customer =
    (await findCustomerByPhone(db, jid.phone)) || (await findCustomerByJid(db, jid.raw));
  let customerCreated = false;
  if (!customer) {
    const made = await createCustomer(db, { ...jid, displayName: raw?.pushName });
    customer = { id: made.id };
    customerCreated = made.created;
  }

  // 幂等：id 由平台 message id 推出，platform_msg_id 上还有 UNIQUE。
  // 桥接机重连补送积压讯息时，同一则不会写成两笔。
  const insert = await db
    .prepare(
      `INSERT OR IGNORE INTO messages
         (id, customer_id, direction, platform, body, platform_msg_id, author, ts, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      `wa-${platformMsgId}`,
      customer.id,
      direction,
      PLATFORM,
      String(raw?.text ?? ""),
      platformMsgId,
      direction === "in" ? String(raw?.pushName || "") : SYSTEM_ACTOR,
      iso,
      nextSeq()
    )
    .run();

  const inserted = (insert.meta?.changes ?? 0) > 0;
  // 重复的讯息不要再去动顾客的时间戳：那是没有意义的写入，
  // 而且会让 updated_at 无谓地跳动，干扰前端的乐观锁。
  if (inserted) await touchCustomerTimestamps(db, customer.id, iso, direction);

  return {
    status: inserted ? "stored" : "duplicate",
    id: platformMsgId,
    customerId: customer.id,
    customerCreated,
    ts: iso,
  };
}

/* ============================ 认证 ============================ */

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 等长字串的定时比较。比对的是两串 hex 摘要，长度固定，不会外泄长度资讯。 */
function equalHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 共用 secret 检查。
 *
 * ⚠️ 没设定 WA_BRIDGE_SECRET 一律回 503。「没设定 = 全开」是绝对不行的 ——
 *    这条也是这段程式码推上线不会有任何影响的原因：secret 没设，整组端点
 *    就是死的。
 */
async function checkSecret(request, env) {
  const configured = String(env.WA_BRIDGE_SECRET || "").trim();
  if (!configured) {
    return {
      ok: false,
      response: jsonResponse(
        {
          ok: false,
          error: "bridge_not_configured",
          detail: "WA_BRIDGE_SECRET 没设定，WhatsApp 桥接端点目前是关闭的。",
          hint: "npx wrangler secret put WA_BRIDGE_SECRET",
        },
        503
      ),
    };
  }

  const presented = request.headers.get("X-Bridge-Secret");
  if (!presented) {
    return { ok: false, response: jsonResponse({ ok: false, error: "missing_bridge_secret" }, 401) };
  }

  const [a, b] = await Promise.all([sha256Hex(presented), sha256Hex(configured)]);
  if (!equalHex(a, b)) {
    return { ok: false, response: jsonResponse({ ok: false, error: "bad_bridge_secret" }, 403) };
  }
  return { ok: true };
}

/* ====================== 人用的管理端点 ====================== */

/**
 * 这两条给「WhatsApp 连接」页用，呼叫的是**人**不是机器：
 * 走 Cloudflare Access 使用者身分 + users 表的 admin 判定，不验 X-Bridge-Secret。
 *
 * secret 不经过浏览器 —— Worker 拿着 WA_BRIDGE_SECRET 去跟桥接机要，
 * 浏览器只拿到结果（QR 图片或状态 JSON）。
 */

/** 打桥接机。回 { ok, response } 或 { ok:false, response:错误回应 } */
async function callBridge(env, path, init = {}) {
  const base = String(env.WA_BRIDGE_URL || "").trim().replace(/\/+$/, "");
  const secret = String(env.WA_BRIDGE_SECRET || "").trim();

  // 跟机器端同一条规则：没设定就是死的，不会「没设定 = 全开」
  if (!base || !secret) {
    return {
      ok: false,
      response: jsonResponse(
        {
          ok: false,
          error: "bridge_not_configured",
          detail: "WA_BRIDGE_URL 或 WA_BRIDGE_SECRET 没设定，桥接机还没接上。",
          hint: "npx wrangler secret put WA_BRIDGE_URL / WA_BRIDGE_SECRET",
        },
        503
      ),
    };
  }

  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...(init.headers || {}), "X-Bridge-Secret": secret },
    });
    return { ok: true, res };
  } catch (err) {
    // 桥接机没开、网址错、主机重启中都会走到这里
    return {
      ok: false,
      response: jsonResponse(
        {
          ok: false,
          error: "bridge_unreachable",
          detail: String(err?.message || err).slice(0, 200),
        },
        502
      ),
    };
  }
}

/**
 * 请桥接机把讯息送出去。
 *
 * 回 { ok, id } 或 { ok:false, response }。id 是平台给的 message id ——
 * 一定要记下来：我们送出的讯息，平台稍后会以 fromMe 的形式再推回来一次，
 * 用同一个 id 写入才会被 platform_msg_id 的 UNIQUE 挡掉，不会变成两笔。
 */
async function sendViaBridge(env, { to, body }) {
  const call = await callBridge(env, "/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to, body }),
  });
  if (!call.ok) return { ok: false, response: call.response };

  const reply = await call.res.json().catch(() => ({}));
  if (!call.res.ok || reply.ok !== true) {
    return {
      ok: false,
      response: jsonResponse(
        {
          ok: false,
          error: "send_failed",
          status: call.res.status,
          detail: reply.detail ?? reply.error ?? null,
        },
        502
      ),
    };
  }
  return { ok: true, id: reply.id ?? null, jid: reply.jid ?? null };
}

export async function handleWhatsAppAdmin(request, env, url) {
  const path = url.pathname;

  // 回 QR 图片，或「已经连上了」。页面每 20 秒左右打一次这条。
  if (path === "/api/wa/qr" && request.method === "GET") {
    const call = await callBridge(env, "/qr");
    if (!call.ok) return call.response;
    const { res } = call;

    if (res.status === 200) {
      // 原样把 PNG 转给浏览器。QR 会过期，绝对不能被快取。
      return new Response(res.body, {
        status: 200,
        headers: {
          "content-type": res.headers.get("content-type") || "image/png",
          "cache-control": "no-store",
        },
      });
    }

    const body = await res.json().catch(() => ({}));
    if (res.status === 409) {
      // 桥接机说已经连上了 —— 页面看到这个就切成「已连线」并显示号码
      return jsonResponse({ ok: true, connected: true, phone: body.phone ?? null });
    }
    if (res.status === 503) {
      return jsonResponse({
        ok: true,
        connected: false,
        waiting: true,
        state: body.state ?? "unknown",
        detail: "桥接机还没产生 QR，稍等一下再试。",
      });
    }
    return jsonResponse(
      { ok: false, error: "bridge_error", status: res.status, detail: body.error ?? null },
      502
    );
  }

  // 触发重新扫码。会断线，所以桥接机那端还要一个二次确认参数。
  if (path === "/api/wa/reconnect" && request.method === "POST") {
    const call = await callBridge(env, "/reset-auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "i-mean-it" }),
    });
    if (!call.ok) return call.response;

    const body = await call.res.json().catch(() => ({}));
    if (!call.res.ok) {
      return jsonResponse(
        { ok: false, error: "reset_failed", status: call.res.status, detail: body.error ?? null },
        502
      );
    }
    return jsonResponse({ ok: true, reset: true, state: body.state ?? "waiting_qr" });
  }

  // 在「WhatsApp 连接」页上试送一则，确认出讯这条路真的通。
  //
  // 刻意**不**在这里写 messages 表：送出去之后平台会把这则以 fromMe 的
  // 形式推回 webhook，那条路径会照正常规则收录它。在这里再写一次只会
  // 变成两笔来源不同的纪录。
  if (path === "/api/wa/test-send" && request.method === "POST") {
    const parsed = await readJson(request);
    if (!parsed.ok) return jsonResponse({ ok: false, error: "bad_json" }, 400);

    const to = String(parsed.body?.to ?? "").trim();
    const body = String(parsed.body?.body ?? "");
    if (!to) return jsonResponse({ ok: false, error: "to_required" }, 400);
    if (!body) return jsonResponse({ ok: false, error: "body_required" }, 400);

    const sent = await sendViaBridge(env, { to: normalizePhone(to), body });
    if (!sent.ok) return sent.response;

    return jsonResponse({
      ok: true,
      sent: true,
      id: sent.id,
      to: normalizePhone(to),
      detail: "已请桥接机送出。这则会经由 webhook 回来，自动记进对话纪录。",
    });
  }

  return jsonResponse({ ok: false, error: "not_found" }, 404);
}

/* ============================ 路由 ============================ */

async function readJson(request) {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
}

export async function handleWhatsApp(request, env, url) {
  const gate = await checkSecret(request, env);
  if (!gate.ok) return gate.response;

  if (!env.DB) return jsonResponse({ ok: false, error: "db_not_bound" }, 503);

  const path = url.pathname;

  // 桥接机连线状态。阶段 A 还没有桥接机，固定回 not_connected。
  if (path === "/api/wa/status" && request.method === "GET") {
    return jsonResponse({
      ok: true,
      connected: false,
      state: "not_connected",
      detail: "阶段 A：Worker 这端已就绪，桥接机还没接上。",
    });
  }

  if (path === "/api/wa/webhook" && request.method === "POST") {
    const parsed = await readJson(request);
    if (!parsed.ok) return jsonResponse({ ok: false, error: "bad_json" }, 400);

    const list = Array.isArray(parsed.body?.messages)
      ? parsed.body.messages
      : parsed.body
        ? [parsed.body]
        : [];
    if (list.length === 0) return jsonResponse({ ok: false, error: "no_messages" }, 400);

    const results = [];
    for (const item of list) results.push(await ingestMessage(env.DB, item));

    const count = (s) => results.filter((r) => r.status === s).length;
    return jsonResponse({
      ok: true,
      received: list.length,
      stored: count("stored"),
      duplicate: count("duplicate"),
      skipped: count("skipped"),
      results,
    });
  }

  // 阶段 A：只写一笔待送出纪录，不真的送。实际送出等阶段 B 的桥接机。
  if (path === "/api/wa/send" && request.method === "POST") {
    const parsed = await readJson(request);
    if (!parsed.ok) return jsonResponse({ ok: false, error: "bad_json" }, 400);

    const customerId = String(parsed.body?.customerId ?? "").trim();
    const body = String(parsed.body?.body ?? "");
    if (!customerId) return jsonResponse({ ok: false, error: "customer_id_required" }, 400);
    if (!body) return jsonResponse({ ok: false, error: "body_required" }, 400);

    const customer = await env.DB
      .prepare("SELECT id, phone, phone_raw, merged_into FROM customers WHERE id = ?")
      .bind(customerId)
      .first();
    if (!customer) return jsonResponse({ ok: false, error: "customer_not_found" }, 404);

    // 只拿得到隐藏 ID 的顾客没有号码可送。这不是错误，是资料还不完整 ——
    // 讲清楚是哪一种，呼叫端才知道要去补号码而不是重试。
    if (!customer.phone) {
      return jsonResponse(
        {
          ok: false,
          error: "customer_has_no_phone",
          detail: `${customerId} 只有隐藏 ID（${customer.phone_raw}），没有可拨的号码。`,
        },
        409
      );
    }
    // 合并掉的顾客不该再收到讯息 —— 那会送到一个已经不用的对话
    if (customer.merged_into) {
      return jsonResponse(
        { ok: false, error: "customer_merged", detail: `已合并到 ${customer.merged_into}` },
        409
      );
    }

    const sent = await sendViaBridge(env, { to: customer.phone, body });
    if (!sent.ok) return sent.response;

    // 呼叫端可以指明是哪位同事按的送出；没指明就是系统写的，照实标记。
    const actor = String(parsed.body?.actor ?? "").trim() || SYSTEM_ACTOR;
    const iso = nowIso();
    // 用平台给的 id。稍后这则会以 fromMe 的形式从 webhook 回来，
    // 那时 INSERT OR IGNORE 配 platform_msg_id 的 UNIQUE 就会挡掉重复。
    const id = sent.id ? `wa-${sent.id}` : `wa-out-${crypto.randomUUID()}`;

    await env.DB
      .prepare(
        `INSERT OR IGNORE INTO messages
           (id, customer_id, direction, platform, body, platform_msg_id, author, ts, seq)
         VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?)`
      )
      .bind(id, customerId, PLATFORM, body, sent.id, actor, iso, nextSeq())
      .run();

    await touchCustomerTimestamps(env.DB, customerId, iso, "out");

    return jsonResponse({ ok: true, id, platformMsgId: sent.id, delivered: true });
  }

  return jsonResponse({ ok: false, error: "not_found" }, 404);
}
