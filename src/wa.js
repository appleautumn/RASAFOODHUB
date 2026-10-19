/**
 * WhatsApp 桥接的探测。
 *
 * 2026-09-04 曾经有一版 worker 设了 WA_BRIDGE_URL / WA_BRIDGE_SECRET，
 * 後来被覆盖掉。secret 还在，但没有程式码在用。
 * 这里先确认那台桥接主机是否还活著，再决定是接回去还是重架。
 */

const PROBE_TIMEOUT_MS = 8000;
const BODY_SNIPPET_CHARS = 300;

/** 只露出主机名让人辨认是哪台，不回传完整网址（内含路径或 token 的话会外泄） */
function describeTarget(raw) {
  try {
    const u = new URL(String(raw));
    return { host: u.host, protocol: u.protocol.replace(":", ""), hasPath: u.pathname !== "/" };
  } catch {
    return null;
  }
}

/**
 * 敲一下桥接主机。不送任何资料，只看它回不回应。
 * @returns {Promise<object>} 诊断结果，可直接回给已登入的 admin
 */
export async function probeBridge(env, fetchImpl = fetch) {
  const url = String(env?.WA_BRIDGE_URL || "").trim();
  const target = describeTarget(url);

  const base = {
    urlConfigured: Boolean(url),
    secretConfigured: Boolean(String(env?.WA_BRIDGE_SECRET || "").trim()),
    target,
  };

  if (!url) return { ...base, reachable: false, reason: "no_url", detail: "worker 没有设定 WA_BRIDGE_URL" };
  if (!target) return { ...base, reachable: false, reason: "bad_url", detail: "WA_BRIDGE_URL 不是合法网址" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: env.WA_BRIDGE_SECRET ? { authorization: `Bearer ${env.WA_BRIDGE_SECRET}` } : {},
    });
    let snippet = "";
    try {
      snippet = (await res.text()).slice(0, BODY_SNIPPET_CHARS);
    } catch {
      snippet = "(读不到内容)";
    }
    return {
      ...base,
      reachable: true,
      httpStatus: res.status,
      bodySnippet: snippet,
      detail: res.ok
        ? "桥接主机有回应 —— 看 bodySnippet 判断是不是当初那支服务"
        : `主机活著但回 HTTP ${res.status}`,
    };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    return {
      ...base,
      reachable: false,
      reason: aborted ? "timeout" : "unreachable",
      detail: aborted
        ? `${PROBE_TIMEOUT_MS / 1000} 秒内没有回应，主机大概已经关了`
        : `连不上：${err?.message || "未知错误"}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
