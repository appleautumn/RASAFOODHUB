/**
 * Cloudflare Access JWT 验证
 *
 * Access 会在每个通过登入的请求上加一个标头：Cf-Access-Jwt-Assertion，
 * 内容是一个 RS256 签名的 JWT。这里做的事：
 *   1. 只接受 RS256（挡掉 alg:none / HS256 这类「用公钥当密钥」的伪造手法）
 *   2. 用你的 team domain 的 JWKS 公钥验签名
 *   3. 检查 iss（发行者）= https://<team>.cloudflareaccess.com
 *   4. 检查 aud（Application Audience Tag）= 你那个 Access Application 的 AUD
 *   5. 检查 exp / nbf（时效），允许 60 秒时钟误差
 *
 * 签名先验，claims 后验 —— 没验过签名的 payload 一律不信。
 */

const CLOCK_SKEW_SECONDS = 60;
const JWKS_TTL_MS = 60 * 60 * 1000; // 公钥快取一小时
const JWKS_MIN_REFETCH_MS = 60 * 1000; // 遇到没看过的 kid，最多每分钟重抓一次

/** certsUrl -> { fetchedAt, lastAttemptAt, keys: Map<kid, CryptoKey> } */
const jwksCache = new Map();

/* ----------------------------- 小工具 ----------------------------- */

function base64urlToBytes(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64urlToJSON(input) {
  return JSON.parse(new TextDecoder().decode(base64urlToBytes(input)));
}

/**
 * 把使用者可能填的各种写法都收敛成 team domain：
 *   "rasafoodhub"                              -> rasafoodhub.cloudflareaccess.com
 *   "rasafoodhub.cloudflareaccess.com"         -> 原样
 *   "https://rasafoodhub.cloudflareaccess.com/"-> 去掉协定与结尾斜线
 */
export function normalizeTeamDomain(raw) {
  let value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  value = value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!value.includes(".")) value = `${value}.cloudflareaccess.com`;
  return value;
}

export function issuerFor(teamDomain) {
  return `https://${normalizeTeamDomain(teamDomain)}`;
}

export function certsUrlFor(teamDomain) {
  return `${issuerFor(teamDomain)}/cdn-cgi/access/certs`;
}

/**
 * 允许用逗号分隔填多个 AUD（例如同一份 code 跑 staging 与 production）。
 *
 * 真正的 AUD tag 是一串十六进位字元。设定档里还留着占位说明文字时
 * （含空白或非 ASCII），当作没设定 —— 否则 /api/authcheck 会说
 * 「已设定」，害人往错的方向找问题。
 */
export function parseAudList(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && /^[\x21-\x7e]+$/.test(s) && !/^[<{].*[>}]$/.test(s));
}

/* ------------------------------ JWKS ------------------------------ */

async function importJwk(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

async function fetchJwks(certsUrl, fetchImpl) {
  const res = await fetchImpl(certsUrl, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
  const body = await res.json();
  const keys = new Map();
  for (const jwk of body.keys || []) {
    // 只收 RSA 公钥；其它类型直接忽略，不给伪造留后门
    if (jwk.kty !== "RSA" || !jwk.n || !jwk.e || !jwk.kid) continue;
    if (jwk.alg && jwk.alg !== "RS256") continue;
    try {
      keys.set(jwk.kid, await importJwk(jwk));
    } catch {
      /* 单一把钥匙坏掉不该拖垮其它把 */
    }
  }
  if (keys.size === 0) throw new Error("JWKS 里没有可用的 RSA 公钥");
  return keys;
}

/**
 * 拿 kid 对应的公钥。快取过期、或遇到没看过的 kid（Cloudflare 会轮换金钥）时重抓，
 * 但重抓有最短间隔，避免有人乱送 kid 就把 worker 变成 JWKS 打手。
 */
async function getVerificationKey(certsUrl, kid, fetchImpl) {
  const now = Date.now();
  let entry = jwksCache.get(certsUrl);
  const expired = !entry || now - entry.fetchedAt > JWKS_TTL_MS;
  const unknownKid = entry && !entry.keys.has(kid);
  const mayRefetch = !entry || now - entry.lastAttemptAt > JWKS_MIN_REFETCH_MS;

  if (expired || (unknownKid && mayRefetch)) {
    const previous = entry;
    entry = { fetchedAt: previous?.fetchedAt ?? 0, lastAttemptAt: now, keys: previous?.keys ?? new Map() };
    jwksCache.set(certsUrl, entry);
    try {
      entry.keys = await fetchJwks(certsUrl, fetchImpl);
      entry.fetchedAt = Date.now();
    } catch (err) {
      // 抓不到而且手上一把旧钥匙都没有 —— 只能承认拿不到公钥
      if (!previous || previous.keys.size === 0) {
        jwksCache.delete(certsUrl);
        throw err;
      }
    }
  }
  return entry.keys.get(kid) || null;
}

/** 测试与除错用：清掉公钥快取 */
export function clearJwksCache() {
  jwksCache.clear();
}

/* ----------------------------- 主验证 ----------------------------- */

function fail(reason, detail) {
  return { ok: false, reason, detail: detail || "" };
}

/**
 * @param {string} token  Cf-Access-Jwt-Assertion 的值（或 CF_Authorization cookie）
 * @param {{teamDomain: string, aud: string, now?: number, fetchImpl?: typeof fetch}} options
 * @returns {Promise<{ok: boolean, reason?: string, detail?: string, claims?: object, email?: string}>}
 */
export async function verifyAccessJwt(token, options) {
  const teamDomain = normalizeTeamDomain(options.teamDomain);
  const audList = parseAudList(options.aud);
  const fetchImpl = options.fetchImpl || fetch;
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);

  if (!teamDomain) return fail("config_missing_team_domain", "ACCESS_TEAM_DOMAIN 没设定");
  if (audList.length === 0) return fail("config_missing_aud", "ACCESS_AUD 没设定");
  if (!token) return fail("no_token", "请求上没有 Cf-Access-Jwt-Assertion");

  const parts = token.split(".");
  if (parts.length !== 3) return fail("malformed_token", "JWT 不是 header.payload.signature 三段");

  let header;
  let claims;
  try {
    header = base64urlToJSON(parts[0]);
    claims = base64urlToJSON(parts[1]);
  } catch {
    return fail("malformed_token", "header 或 payload 不是合法的 base64url JSON");
  }

  // 只认 RS256。alg:none 与 HS256 都是拿公钥当共享密钥的经典伪造路数。
  if (header.alg !== "RS256") return fail("unsupported_alg", `alg=${header.alg ?? "(无)"}，只接受 RS256`);
  if (!header.kid) return fail("malformed_token", "header 少了 kid");

  const certsUrl = certsUrlFor(teamDomain);
  let key;
  try {
    key = await getVerificationKey(certsUrl, header.kid, fetchImpl);
  } catch (err) {
    return fail("jwks_unavailable", `抓不到公钥：${err.message}`);
  }
  if (!key) return fail("unknown_kid", `公钥清单里没有 kid=${header.kid}`);

  const signature = base64urlToBytes(parts[2]);
  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedData);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return fail("bad_signature", "签章验证不通过");

  // ↓ 以下的 claims 已经被签章保护，可以信了
  const expectedIssuer = issuerFor(teamDomain);
  if (claims.iss !== expectedIssuer) {
    return fail("iss_mismatch", `iss=${claims.iss ?? "(无)"}，预期 ${expectedIssuer}`);
  }

  const tokenAud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!tokenAud.some((a) => audList.includes(a))) {
    return fail("aud_mismatch", "token 的 aud 不在允许清单里（Application AUD 填错了？）");
  }

  if (typeof claims.exp !== "number") return fail("malformed_token", "payload 少了 exp");
  if (claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    return fail("expired", `已过期于 ${new Date(claims.exp * 1000).toISOString()}`);
  }
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    return fail("not_yet_valid", "token 的生效时间还没到");
  }

  const email = String(claims.email || "").trim().toLowerCase();
  if (!email) return fail("no_email", "token 里没有 email（Access application 的身分设定有问题）");

  return { ok: true, claims, email };
}

/** Access 会同时放标头与 cookie；标头优先，cookie 是给直接开网页的情况用的 */
export function readAccessToken(request) {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header.trim();
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}
