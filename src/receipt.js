/**
 * 读收据：把截图或 PDF 交给 Claude，问出付款方式、日期、时间、金额。
 *
 * 为什么要这一步：顾客传的是图片，图片里的字这边读不到。
 * 没有这一步，收据上的日期时间金额就得有人一张一张看着打进去 ——
 * 而那正是最容易打错、也最没人想做的一段。
 *
 * 三条界线：
 *   1. **图片不留**。读完就丢，只留读出来的那几个栏位。
 *      这是顾客的付款凭证，我们没有理由存着它。
 *   2. **读不出来就说读不出来**。模型不准猜一个日期填上去 ——
 *      猜出来的日期会拿去跟 FINEXUS 对帐，对不上时没人知道是猜的。
 *   3. **只填空栏位**（由呼叫端负责）。同事查证过才填的值不会被盖掉。
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-opus-5";
const MAX_TOKENS = 400;

/** 认得的图片格式。其他一律不送 —— 送了也是白花钱。 */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const PDF_TYPE = "application/pdf";

/** 付款方式只收这三种，其他一律当作读不出来 */
const PAYMENT_TYPES = new Set(["qr", "card", "cash"]);

const PROMPT = `这是一张付款收据（自动贩卖机交易）。读出下面四项，用 JSON 回覆。

要读的：
- payment_type：付款方式。QR（DuitNow / Touch n Go / 扫码之类）填 "qr"；
  刷卡 / Debit / Credit / Contactless 填 "card"；现金填 "cash"；看不出来填 ""。
- date：交易日期，格式 YYYY-MM-DD。收据上是 DD/MM/YYYY 的话照马来西亚写法转（日在前）。
- time：交易时间，24 小时制 HH:MM。
- amount：交易金额，只要数字，两位小数，例如 "5.50"。不要币别符号。

规则：
- 读不到的那一项就填空字串 ""。**绝对不要猜、不要推测、不要用今天的日期补上。**
  这些值会拿去跟付款闸道对帐，猜出来的值比空的更糟。
- 整张看不清楚（糊掉、太暗、被裁掉、根本不是收据）就把 readable 设成 false，
  并在 reason 用一句中文说明原因。
- 只输出 JSON，不要任何其他文字。

JSON 格式：
{"readable": true, "reason": "", "payment_type": "", "date": "", "time": "", "amount": ""}`;

/**
 * 读一张收据。
 *
 * 回传 { ok, fields, readable, reason }。
 * fields 只包含真的读到的栏位，键名跟顾客资料表对齐，呼叫端可以直接合并。
 */
export async function readReceipt(env, { mimetype, dataBase64, fetchImpl = fetch }) {
  const key = String(env.ANTHROPIC_API_KEY || "").trim();
  if (!key) return { ok: false, status: 503, error: "ai_not_configured" };

  const type = String(mimetype || "").toLowerCase().split(";")[0].trim();
  const block = contentBlock(type, dataBase64);
  if (!block) return { ok: false, status: 415, error: "unsupported_media", detail: type || "(没有 mimetype)" };

  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: String(env.RECEIPT_MODEL || env.AI_MODEL || "").trim() || DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        // 这是抄写工作，不是推理工作。低强度够用，也便宜得多。
        output_config: { effort: "low" },
        messages: [{ role: "user", content: [block, { type: "text", text: PROMPT }] }],
      }),
    });
  } catch (err) {
    return { ok: false, status: 502, error: "ai_unreachable", detail: String(err?.message || err) };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, status: 502, error: "ai_error", detail: `HTTP ${res.status} ${body.slice(0, 300)}` };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, status: 502, error: "ai_bad_json" };
  }

  const text = (data?.content || [])
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("\n");

  const parsed = parseJson(text);
  if (!parsed) return { ok: false, status: 502, error: "ai_unparsable", detail: text.slice(0, 200) };

  return { ok: true, ...normalize(parsed) };
}

function contentBlock(type, dataBase64) {
  const data = String(dataBase64 || "");
  if (!data) return null;
  if (type === PDF_TYPE) {
    return { type: "document", source: { type: "base64", media_type: PDF_TYPE, data } };
  }
  if (IMAGE_TYPES.has(type)) {
    return { type: "image", source: { type: "base64", media_type: type, data } };
  }
  return null;
}

/**
 * 从回覆里挖出 JSON。
 *
 * 就算 prompt 讲了「只输出 JSON」，模型偶尔还是会包一层 ```json。
 * 与其相信它每次都听话，不如在这里挡掉 —— 这个失败模式很安静。
 */
function parseJson(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** 模型讲的话不能直接当资料用。每一项都照我们自己的规则再验一次。 */
function normalize(parsed) {
  const readable = parsed.readable !== false;
  const reason = String(parsed.reason || "").slice(0, 200);

  if (!readable) return { readable: false, reason: reason || "收据看不清楚", fields: {} };

  const fields = {};

  const payment = String(parsed.payment_type || "").trim().toLowerCase();
  if (PAYMENT_TYPES.has(payment)) fields.paymentType = payment;

  const date = String(parsed.date || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date))) fields.receiptDate = date;

  const time = String(parsed.time || "").trim();
  const t = time.match(/^(\d{1,2}):(\d{2})$/);
  if (t && Number(t[1]) <= 23 && Number(t[2]) <= 59) {
    fields.receiptTime = `${t[1].padStart(2, "0")}:${t[2]}`;
  }

  const amount = String(parsed.amount || "").replace(/[^\d.]/g, "");
  const n = Number(amount);
  if (amount && Number.isFinite(n) && n > 0) fields.receiptAmount = n.toFixed(2);

  return { readable: true, reason, fields };
}
