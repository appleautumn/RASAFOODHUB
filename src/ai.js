import Anthropic from "@anthropic-ai/sdk";

/**
 * AI 草稿代打。
 *
 * 前端原本直接打 api.anthropic.com —— 那只在 Claude artifact 沙箱里有效
 * （沙箱替它注入凭证）。搬到 Workers 之后必须由 worker 代打，因为：
 *   1. 浏览器端没有凭证可用，CORS 也会挡
 *   2. 把 API key 放进前端等于公开你的 Anthropic 帐单
 *
 * key 存成 Cloudflare secret（ANTHROPIC_API_KEY），永远不离开 worker。
 */

const MODEL = "claude-opus-5-5";
const MAX_TOKENS = 1000;

// 这个端点在 Access 后面，只有自己人用得到。上限是防手滑与防滥用，
// 不是防外人 —— 外人根本进不来。
const MAX_SYSTEM_CHARS = 20000;
const MAX_USER_CHARS = 4000;

export class AiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {{system: string, userText: string}} input
 * @param {{ANTHROPIC_API_KEY?: string}} env
 * @param {(opts: object) => {messages: {create: Function}}} [clientFactory] 测试用
 * @returns {Promise<{text: string, usage: object}>}
 */
export async function draftReply(input, env, clientFactory) {
  const system = typeof input?.system === "string" ? input.system.trim() : "";
  const userText = typeof input?.userText === "string" ? input.userText.trim() : "";

  if (!env?.ANTHROPIC_API_KEY) {
    throw new AiError(500, "no_api_key", "worker 没有设定 ANTHROPIC_API_KEY（用 wrangler secret put 设定）");
  }
  if (!system) throw new AiError(400, "no_system", "少了 system（AI 助理的设定还没填）");
  if (!userText) throw new AiError(400, "no_user_text", "少了 userText（要回覆的内容是空的）");
  if (system.length > MAX_SYSTEM_CHARS) {
    throw new AiError(413, "system_too_long", `system 超过 ${MAX_SYSTEM_CHARS} 字元`);
  }
  if (userText.length > MAX_USER_CHARS) {
    throw new AiError(413, "user_text_too_long", `userText 超过 ${MAX_USER_CHARS} 字元`);
  }

  const makeClient = clientFactory || ((opts) => new Anthropic(opts));
  const client = makeClient({ apiKey: env.ANTHROPIC_API_KEY });

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // 回覆只有 2–3 句、规则都写在 system 里，不需要深想。
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content: userText }],
    });
  } catch (err) {
    // SDK 的错误带 status；401 多半是 key 设错了
    const status = err?.status;
    const raw = String(err?.message || "");
    if (status === 401) throw new AiError(500, "bad_api_key", "ANTHROPIC_API_KEY 无效或已撤销");
    if (status === 429) throw new AiError(429, "rate_limited", "Anthropic 回传额度限制，稍后再试");
    // 余额用完是营运问题不是程式问题，讲清楚去哪儲值，别吐一整段 JSON
    if (/credit balance is too low/i.test(raw)) {
      throw new AiError(
        402,
        "no_credit",
        "Anthropic 帐户余额不足。到 console.anthropic.com 的 Plans & Billing 加值后即可继续，不用重新部署。"
      );
    }
    throw new AiError(502, "upstream_error", `呼叫 Anthropic 失败：${err?.message || "未知错误"}`);
  }

  // 安全分类器可能拒答；这时 content 里没有可用文字
  if (response.stop_reason === "refusal") {
    throw new AiError(422, "refused", "模型拒绝产生这则回覆，请改写输入或改交真人处理");
  }

  const text = (response.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!text) throw new AiError(502, "empty_reply", "模型回了空白内容");

  return {
    text,
    usage: {
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      model: response.model ?? MODEL,
    },
  };
}
