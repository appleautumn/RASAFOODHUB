import {
  verifyAccessJwt,
  readAccessToken,
  issuerFor,
  certsUrlFor,
  normalizeTeamDomain,
  parseAudList,
} from "./access-jwt.js";
import { resolveUser } from "./users.js";
import { handleApi, json } from "./api.js";
import { handleWhatsApp, handleWhatsAppAdmin, runOutboxTick } from "./whatsapp.js";

/* ---------------------------- 回应小工具 ---------------------------- */

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

/* --------------------------- 观察模式 --------------------------- */

/**
 * ACCESS_ENFORCE 开关。
 *
 * "true"（预设）  = 验不过就挡下来
 * "false"（观察） = 验不过**也放行**，但 /api/authcheck 照实回报本来会失败在哪
 *
 * 为什么要这个：Access application 刚建好的时候，team domain 或 AUD 很容易
 * 贴错一个字。设定错 + 直接强制 = 你自己也进不去，而且进不去就看不到错在哪。
 * 先跑观察模式，用真实登入确认 authcheck 回 ok，再改成强制部署。
 */
function enforcing(env) {
  return String(env.ACCESS_ENFORCE ?? "true").trim().toLowerCase() !== "false";
}

/**
 * 这个请求有没有真的经过 Cloudflare Access？
 *
 * ⚠️ 观察模式**只放行「经过了 Access、但 worker 这边验不过」的请求**。
 * 完全没经过 Access 的请求，观察模式一样挡。
 *
 * 这一条是刻意加的，规格没写。少了它，观察模式 = 整个 CRM 连同顾客资料
 * 直接公开在网际网路上 —— 只要有人知道网址就看得到。那个代价太大，
 * 而它对「设定贴错字」这个真正要解决的问题一点帮助都没有：
 * 贴错字的情境里 Access 是在的，JWT 也在，只是 worker 对不上而已。
 */
function cameThroughAccess(request) {
  return Boolean(readAccessToken(request));
}

/** 观察模式下的身分。刻意是 staff：这个模式是拿来验证设定的，不是拿来当日常登入用的。 */
function observeIdentity(reason, detail) {
  return {
    ok: true,
    observeMode: true,
    wouldHaveFailed: { reason, detail },
    claims: null,
    user: { email: "", name: "观察模式", role: "staff", knownUser: false },
  };
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
  if (!result.ok) {
    if (!enforcing(env) && cameThroughAccess(request)) {
      return observeIdentity(result.reason, result.detail);
    }
    return result;
  }

  const resolved = await resolveUser(env, result.email);
  if (!resolved.ok) {
    const detail = describeResolveFailure(resolved.reason, result.email);
    if (!enforcing(env) && cameThroughAccess(request)) {
      return observeIdentity(resolved.reason, detail);
    }
    return { ok: false, reason: resolved.reason, detail };
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
    // 观察模式开着的时候，这里一定要看得到 —— 它会放行验不过的请求
    enforce: enforcing(env),
    enforceWarning: enforcing(env)
      ? null
      : "⚠️ 观察模式：通过 Access 但 worker 验不过的请求会被放行。确认下面 ok 是 true 之后，把 ACCESS_ENFORCE 改回 true 再部署。",
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

async function serveApp(request, env) {
  if (env.ASSETS) return env.ASSETS.fetch(request);
  // 还没接上前端静态档时的占位回应
  return new Response("Worker 已就绪，但还没绑定静态资源（wrangler.toml 的 [assets]）。", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/* --------------------------- WhatsApp 路由 --------------------------- */

/** 桥接机（机器）打的：验 X-Bridge-Secret，不需要使用者身分 */
const BRIDGE_ROUTES = new Set(["/api/wa/status", "/api/wa/webhook", "/api/wa/send", "/api/wa/outbox"]);

/** 「WhatsApp 连接」页（人）打的：走 Access 使用者身分，而且只有 admin */
const WA_ADMIN_ROUTES = new Set(["/api/wa/qr", "/api/wa/reconnect", "/api/wa/test-send"]);

export default {
  /**
   * 出讯佇列的排程器。
   *
   * 刻意不做任何「补偿」逻辑：这一分钟没跑成，下一分钟再跑就好。
   * 排程时间是建立时算好的事实，不会因为漏跑一次而需要追赶 ——
   * 追赶正是会一次送出一大批、然后被封号的那种设计。
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOutboxTick(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // 诊断端点：不挡，方便你自己检查设定
    if (url.pathname === "/api/authcheck") return handleAuthcheck(request, env);

    // WhatsApp 桥接的**机器**端点：验的是共用 secret 而不是使用者身分，
    // 所以走在 authenticate() 前面 —— 桥接机没有浏览器、拿不到 OTP。
    // WA_BRIDGE_SECRET 没设定时这一整组回 503，等于不存在。
    //
    // ⚠️ 这里刻意用明确列举，不是 startsWith("/api/wa/")。同一个前缀下面
    //    同时有「机器走 secret」和「人走 Access + admin」两种端点，前缀比对
    //    一旦写错边界，就会变成桥接端点对使用者开放、或管理端点对拿到
    //    secret 的人开放。列举写死，加错的成本会立刻反映在测试上。
    if (BRIDGE_ROUTES.has(url.pathname)) return handleWhatsApp(request, env, url);

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

    // 之后要放只有 admin 能读的资料，挂在这个前缀底下就自动受保护
    if (url.pathname.startsWith("/api/admin/")) {
      if (user.role !== "admin") {
        return json({ ok: false, error: "forbidden", detail: "需要 admin 角色" }, 403);
      }
    }

    // 「WhatsApp 连接」页的两条。跟「团队活动」同一个等级：只有 admin。
    // 前端不显示这一页只是体贴，真正的把关在这里 —— staff 直接打 API 一样挡。
    if (WA_ADMIN_ROUTES.has(url.pathname)) {
      if (user.role !== "admin") {
        return json({ ok: false, error: "forbidden", detail: "需要 admin 角色" }, 403);
      }
      return handleWhatsAppAdmin(request, env, url);
    }

    // CRM 的资料读写。资源导向的 REST，筛选与排序在 SQL 里做，
    // 更新只写有改到的栏位并带乐观锁 —— 前端的 window.storage 转接层打这里。
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url, user);
    }

    return serveApp(request, env);
  },
};
