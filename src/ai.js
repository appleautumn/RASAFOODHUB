/**
 * 呼叫 Claude 产草稿 —— 在 Worker 里，不在浏览器里。
 *
 * 原本前端是直接 fetch api.anthropic.com。那条路有两个问题：
 *   1. 要放 API key 的话，key 会跟着 JS 一起送到每一台开过後台的电脑
 *   2. 没放 key 的话，那个呼叫根本不会成功
 * 所以搬进 Worker：key 是 Worker secret，浏览器只看得到草稿。
 *
 * 这里**只产草稿，永远不送**。送出去是 outbox 的事，而且要人按。
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-opus-5";
const MAX_TOKENS = 600;

/**
 * 产一段草稿。
 *
 * 没设 ANTHROPIC_API_KEY 就回 503 —— 跟桥接机同一个原则：
 * 没设定等于不能用，不是「先放行看看」。
 */
export async function draftReply(env, { system, userText, fetchImpl = fetch }) {
  const key = String(env.ANTHROPIC_API_KEY || "").trim();
  if (!key) return { ok: false, status: 503, error: "ai_not_configured" };

  const model = String(env.AI_MODEL || "").trim() || DEFAULT_MODEL;

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
        model,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: "user", content: userText }],
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
    .join("\n")
    .trim();

  if (!text) return { ok: false, status: 502, error: "ai_empty" };
  return { ok: true, draft: text, model };
}
