import {
  verifyAccessJwt,
  readAccessToken,
  issuerFor,
  certsUrlFor,
  normalizeTeamDomain,
  parseAudList,
} from "./access-jwt.js";
import { resolveUser } from "./users.js";

/* ---------------------------- 回应小工具 ---------------------------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function deniedPage(title, message) {
  const html = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font:16px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
       background:#f8fafc;color:#0f172a;display:grid;place-items:center;min-height:100vh;margin:0}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:32px;max-width:520px}
  h1{font-size:18px;margin:0 0 8px}
  p{margin:0 0 8px;color:#475569;font-size:14px}
  code{background:#f1f5f9;padding:2px 5px;border-radius:4px;font-size:13px}
</style>
<div class="card"><h1>${title}</h1><p>${message}</p>
<p>想看细节可以打开 <code>/api/authcheck</code>。</p></div>`;
  return new Response(html, {
    status: 403,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/* ------------------------------ 验证 ------------------------------ */

/**
 * 本机开发身分。
 *
 * 守门的是 __ALLOW_DEV_IDENTITY__，一个编译期常数：
 *   - wrangler.toml 的 [define] 把它固定成 false
 *   - 只有 npm run dev（--define __ALLOW_DEV_IDENTITY__:true）才是 true
 *
 * 打包时 `if (!false) return null` 会让整段后续程式码被消掉，
 * 正式产物里根本不存在这条路径。
 *
 * 刻意不用任何来自请求的讯号（hostname、cf-ray 之类）当条件——
 * 那些是请求方能影响的输入，编译期常数不是。
 */
function devIdentityEmail(env) {
  if (!__ALLOW_DEV_IDENTITY__) return null;
  return String(env.DEV_BYPASS_EMAIL || "").trim().toLowerCase() || null;
}

async function authenticate(request, env) {
  const bypass = devIdentityEmail(env);
  if (bypass) {
    const resolved = await resolveUser(env, bypass);
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason, detail: describeResolveFailure(resolved.reason, bypass) };
    }
    return { ok: true, claims: null, user: resolved.user, devBypass: true };
  }

  const token = readAccessToken(request);
  const result = await verifyAccessJwt(token, {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    aud: env.ACCESS_AUD,
  });
  if (!result.ok) return result;

  const resolved = await resolveUser(env, result.email);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason, detail: describeResolveFailure(resolved.reason, result.email) };
  }

  return { ok: true, claims: result.claims, user: resolved.user };
}

/* --------------------------- /api/authcheck --------------------------- */

/**
 * 永远回 200，让你在没登入、设定填错的时候也看得到「为什么不通过」。
 * 这里不会回传 token 本身，AUD 也只露前 8 码方便你比对。
 */
async function handleAuthcheck(request, env) {
  const token = readAccessToken(request);
  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  const aud = String(env.ACCESS_AUD || "");

  const config = {
    teamDomain: teamDomain || null,
    issuer: teamDomain ? issuerFor(teamDomain) : null,
    certsUrl: teamDomain ? certsUrlFor(teamDomain) : null,
    audConfigured: parseAudList(aud).length > 0,
    audPrefix: parseAudList(aud).length > 0 ? `${aud.slice(0, 8)}…` : null,
    d1Bound: Boolean(env.DB),
    requireUserRow: String(env.REQUIRE_USER_ROW || "false").toLowerCase() === "true",
    // 本机开发身分：两个都要成立才会生效
    devIdentityCompiledIn: Boolean(__ALLOW_DEV_IDENTITY__),
    devIdentityConfigured: Boolean(String(env.DEV_BYPASS_EMAIL || "").trim()),
  };

  const headers = {
    hasJwtHeader: Boolean(request.headers.get("Cf-Access-Jwt-Assertion")),
    hasCfAuthorizationCookie: /(?:^|;\s*)CF_Authorization=/.test(request.headers.get("Cookie") || ""),
    // 纯文字标头，只列出来给你对照 —— 系统不拿它当授权依据
    plaintextEmailHeader: request.headers.get("Cf-Access-Authenticated-User-Email") || null,
  };

  const bypass = devIdentityEmail(env);
  if (bypass) {
    const resolved = await resolveUser(env, bypass);
    return json({
      ok: resolved.ok,
      devBypass: true,
      warning: "目前走的是本机开发身分（DEV_BYPASS_EMAIL），没有验证任何 JWT。线上不会生效。",
      user: resolved.ok ? resolved.user : null,
      config,
      headers,
    });
  }

  const verification = await verifyAccessJwt(token, {
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    aud: env.ACCESS_AUD,
  });

  if (!verification.ok) {
    return json({
      ok: false,
      reason: verification.reason,
      detail: verification.detail,
      hint: HINTS[verification.reason] || "看 detail 的说明。",
      config,
      headers,
    });
  }

  const resolved = await resolveUser(env, verification.email);
  const claims = verification.claims;

  return json({
    ok: resolved.ok,
    reason: resolved.ok ? null : resolved.reason,
    hint: resolved.ok ? null : HINTS[resolved.reason],
    jwt: {
      verified: true,
      email: verification.email,
      issuer: claims.iss,
      audienceMatched: true,
      issuedAt: claims.iat ? new Date(claims.iat * 1000).toISOString() : null,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      identityNonce: claims.identity_nonce ? "present" : null,
    },
    user: resolved.ok ? resolved.user : null,
    config,
    headers,
  });
}

const RESOLVE_DETAIL = {
  user_inactive: (email) => `${email} 在 users 表里，但已停用（is_active = 0）`,
  user_not_in_table: (email) => `${email} 通过了 Access，但不在 users 表里`,
  db_not_bound: () => "worker 没有绑定 D1，查不了 users 表",
};

const describeResolveFailure = (reason, email) =>
  (RESOLVE_DETAIL[reason] || (() => reason))(email);

const HINTS = {
  no_token:
    "这个请求没经过 Cloudflare Access。检查 Access Application 的 hostname 有没有跟这个网址完全一致（含 workers.dev 的完整主机名），以及 path 有没有涵盖这条路径。",
  config_missing_team_domain: "wrangler.toml 的 [vars] 里补上 ACCESS_TEAM_DOMAIN（还留着 your-team… 那种占位文字也算没设定）。",
  config_missing_aud: "wrangler.toml 的 [vars] 里补上 ACCESS_AUD（Application 的 Application Audience Tag）。",
  aud_mismatch: "ACCESS_AUD 跟这个 Application 的 AUD 对不上，回 Zero Trust 后台复制一次。",
  iss_mismatch: "ACCESS_TEAM_DOMAIN 填错了，应该是 Zero Trust > Settings > Custom Pages 里看到的 team domain。",
  expired: "登入过期了，重新整理页面会自动跳回 Access 登入。",
  unknown_kid: "Cloudflare 轮换了签章金钥；重试一次即可，持续发生就检查 team domain。",
  bad_signature: "签章不对，这个 token 不是这个 team 发的。",
  unsupported_alg: "token 的演算法不是 RS256，直接挡掉。",
  db_not_bound: "wrangler.toml 里没有绑 D1（binding = \"DB\"）。",
  user_inactive: "这个 email 在 users 表里，但 is_active = 0，已停用。要恢复就把它设回 1。",
  user_not_in_table: "这个 email 通过了 Access，但不在 users 表里。到 users 表新增一行，或把 REQUIRE_USER_ROW 关掉。",
};

/* ------------------------------ 路由 ------------------------------ */

/* ---------------------------- 资料存取 ---------------------------- */

const MAX_VALUE_BYTES = 1024 * 1024; // 1 MiB，超过就挡下来而不是让 D1 报怪错
const VALID_KEY = /^[A-Za-z0-9:_\-.]{1,128}$/;

/**
 * 取代原本 Claude Artifact 环境的 window.storage。
 * 资料是全团队共用的一份，所以每个请求都必须先通过 Access 验证（呼叫端已确保）。
 */
async function handleStorage(request, env, url, user) {
  if (!env.DB) return json({ ok: false, error: "db_not_bound" }, 500);

  const key = decodeURIComponent(url.pathname.slice("/api/storage/".length));
  if (!VALID_KEY.test(key)) return json({ ok: false, error: "bad_key" }, 400);

  if (request.method === "GET") {
    const row = await env.DB.prepare(
      "SELECT key, value, updated_at, updated_by FROM app_state WHERE key = ?1"
    )
      .bind(key)
      .first();
    if (!row) return json({ ok: false, error: "not_found" }, 404);
    return json({ key: row.key, value: row.value, updatedAt: row.updated_at, updatedBy: row.updated_by });
  }

  if (request.method === "PUT") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "bad_json" }, 400);
    }
    const value = typeof body?.value === "string" ? body.value : null;
    if (value === null) return json({ ok: false, error: "value_must_be_string" }, 400);
    if (new TextEncoder().encode(value).length > MAX_VALUE_BYTES) {
      return json({ ok: false, error: "too_large", detail: "单一 key 上限 1 MiB" }, 413);
    }

    await env.DB.prepare(
      `INSERT INTO app_state (key, value, updated_at, updated_by)
       VALUES (?1, ?2, datetime('now'), ?3)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    )
      .bind(key, value, user.email)
      .run();
    return json({ ok: true, key });
  }

  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM app_state WHERE key = ?1").bind(key).run();
    return json({ ok: true, key });
  }

  return json({ ok: false, error: "method_not_allowed" }, 405);
}

async function serveApp(request, env) {
  if (env.ASSETS) return env.ASSETS.fetch(request);
  // 还没接上前端静态档时的占位回应
  return new Response("Worker 已就绪，但还没绑定静态资源（wrangler.toml 的 [assets]）。", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 诊断端点：不挡，方便你自己检查设定
    if (url.pathname === "/api/authcheck") return handleAuthcheck(request, env);

    const auth = await authenticate(request, env);
    if (!auth.ok) {
      if (url.pathname.startsWith("/api/")) {
        return json({ ok: false, error: "unauthorized", reason: auth.reason, detail: auth.detail }, 401);
      }
      return deniedPage(
        "未通过 Cloudflare Access 验证",
        "这个页面要先经由 Cloudflare Access 登入才能开启。"
      );
    }

    const { user } = auth;

    // 目前的登入身分（前端拿这个决定「团队活动」要不要出现）
    if (url.pathname === "/api/me") {
      return json({ ok: true, user: { ...user, isAdmin: user.role === "admin" } });
    }

    // CRM 的资料读写（前端的 window.storage 打这里）
    if (url.pathname.startsWith("/api/storage/")) {
      return handleStorage(request, env, url, user);
    }

    // 之后要放只有 admin 能读的资料，挂在这个前缀底下就自动受保护
    if (url.pathname.startsWith("/api/admin/")) {
      if (user.role !== "admin") {
        return json({ ok: false, error: "forbidden", detail: "需要 admin 角色" }, 403);
      }
    }

    return serveApp(request, env);
  },
};
