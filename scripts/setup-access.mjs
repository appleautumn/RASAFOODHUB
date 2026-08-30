#!/usr/bin/env node
/**
 * 一次跑完 Cloudflare Access 的所有设定。
 *
 *   CLOUDFLARE_API_TOKEN=xxx node scripts/setup-access.mjs \
 *     --hostname crm.rasafoodhub.com \
 *     --email rasafoodhubplt@gmail.com \
 *     --team rasafoodhub
 *
 * 它会做：
 *   1. 验 token、找出 account id
 *   2. 确认（必要时建立）Zero Trust organization，拿到 team domain
 *   3. 找出 One-time PIN 这个登入方式
 *   4. 建立 Self-hosted Application 指向你的网址（只允许 One-time PIN）
 *   5. 建立 Policy：只放行指定的 email
 *   6. 把 team domain 与 AUD tag 写回 wrangler.toml
 *
 * 重复执行是安全的：已经存在的东西会更新，不会建出第二份。
 */

import { readFileSync, writeFileSync } from "node:fs";

const API = "https://api.cloudflare.com/client/v4";

/* ---------------------------- 参数处理 ---------------------------- */

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    args[key] = value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const token = process.env.CLOUDFLARE_API_TOKEN || args.token;
const hostname = args.hostname;
const email = (args.email || "").trim().toLowerCase();
const teamName = (args.team || "rasafoodhub").trim().toLowerCase();
const appName = args.name || "Rasa CRM";
const sessionDuration = args.session || "24h";

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

if (!token) die("没有 token。用 CLOUDFLARE_API_TOKEN=xxx 带进来，或加 --token xxx");
if (!hostname) die("少了 --hostname，例如 --hostname crm.rasafoodhub.com");
if (!email) die("少了 --email，例如 --email rasafoodhubplt@gmail.com");

/* ---------------------------- API 小工具 ---------------------------- */

const PERMISSION_HINT = {
  "access/organizations": "Account → Access: Organizations, Identity Providers, and Groups → Edit",
  "access/identity_providers": "Account → Access: Organizations, Identity Providers, and Groups → Edit",
  "access/apps": "Account → Access: Apps and Policies → Edit",
  accounts: "Account → Account Settings → Read",
};

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  let body;
  try {
    body = await res.json();
  } catch {
    die(`Cloudflare 回了看不懂的东西（HTTP ${res.status}），路径 ${path}`);
  }

  if (res.status === 403) {
    const key = Object.keys(PERMISSION_HINT).find((k) => path.includes(k));
    die(
      `token 权限不够（403），卡在 ${path}\n` +
        (key ? `  请在 token 里补上：${PERMISSION_HINT[key]}` : "  请检查 token 的权限设定")
    );
  }

  return { ok: body.success === true, status: res.status, body, errors: body.errors || [] };
}

const firstError = (r) => r.errors?.[0]?.message || `HTTP ${r.status}`;

/* ------------------------------ 步骤 ------------------------------ */

async function step1FindAccount() {
  const verify = await api("/user/tokens/verify");
  if (!verify.ok) die(`token 无效或已过期：${firstError(verify)}`);
  console.log("✓ token 有效");

  const accounts = await api("/accounts");
  if (!accounts.ok || !accounts.body.result?.length) {
    die(`列不出帐号：${firstError(accounts)}\n  token 需要 Account → Account Settings → Read`);
  }
  const account = accounts.body.result[0];
  if (accounts.body.result.length > 1) {
    console.log(`  （有 ${accounts.body.result.length} 个帐号，用第一个：${account.name}）`);
  }
  console.log(`✓ 帐号：${account.name}`);
  return account.id;
}

async function step2EnsureOrganization(accountId) {
  const existing = await api(`/accounts/${accountId}/access/organizations`);
  if (existing.ok && existing.body.result?.auth_domain) {
    const domain = existing.body.result.auth_domain;
    console.log(`✓ Zero Trust 已开通，team domain：${domain}`);
    return domain;
  }

  console.log("… Zero Trust 还没开通，尝试建立");
  const created = await api(`/accounts/${accountId}/access/organizations`, {
    method: "POST",
    body: JSON.stringify({ name: appName, auth_domain: `${teamName}.cloudflareaccess.com` }),
  });

  if (!created.ok) {
    die(
      `建不了 Zero Trust organization：${firstError(created)}\n\n` +
        "  这通常表示要先在后台走一次开通流程（选方案、可能要绑卡）。\n" +
        "  请打开 https://one.dash.cloudflare.com 点完那一段，team name 填 " +
        `「${teamName}」，然后重跑这支脚本。`
    );
  }
  const domain = created.body.result.auth_domain;
  console.log(`✓ Zero Trust 已开通，team domain：${domain}`);
  return domain;
}

async function step3FindOtpProvider(accountId) {
  const idps = await api(`/accounts/${accountId}/access/identity_providers`);
  if (!idps.ok) {
    console.log(`  （读不到登入方式清单：${firstError(idps)}，改用「全部可用方式」）`);
    return null;
  }
  const otp = (idps.body.result || []).find((p) => p.type === "onetimepin");
  if (otp) {
    console.log("✓ 找到 One-time PIN（Email OTP）");
    return otp.id;
  }
  const others = (idps.body.result || []).length;
  console.log(
    others === 0
      ? "✓ 目前没有设定其它登入方式，One-time PIN 会是唯一选项"
      : "  （清单里没有 One-time PIN，将不限制登入方式）"
  );
  return null;
}

async function step4EnsureApp(accountId, otpId) {
  const payload = {
    name: appName,
    domain: hostname,
    type: "self_hosted",
    session_duration: sessionDuration,
    app_launcher_visible: true,
    ...(otpId ? { allowed_idps: [otpId], auto_redirect_to_identity: true } : {}),
  };

  const list = await api(`/accounts/${accountId}/access/apps`);
  if (!list.ok) die(`列不出 Application：${firstError(list)}`);
  const existing = (list.body.result || []).find((a) => a.domain === hostname);

  const result = existing
    ? await api(`/accounts/${accountId}/access/apps/${existing.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
    : await api(`/accounts/${accountId}/access/apps`, {
        method: "POST",
        body: JSON.stringify(payload),
      });

  if (!result.ok) die(`${existing ? "更新" : "建立"} Application 失败：${firstError(result)}`);
  const app = result.body.result;
  console.log(`✓ Application ${existing ? "已更新" : "已建立"}：${app.name} → ${app.domain}`);
  return app;
}

async function step5EnsurePolicy(accountId, appId) {
  const payload = {
    name: "allow-team",
    decision: "allow",
    include: [{ email: { email } }],
  };

  const list = await api(`/accounts/${accountId}/access/apps/${appId}/policies`);
  const existing = list.ok ? (list.body.result || []).find((p) => p.name === "allow-team") : null;

  const result = existing
    ? await api(`/accounts/${accountId}/access/apps/${appId}/policies/${existing.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
    : await api(`/accounts/${accountId}/access/apps/${appId}/policies`, {
        method: "POST",
        body: JSON.stringify(payload),
      });

  if (!result.ok) die(`${existing ? "更新" : "建立"} Policy 失败：${firstError(result)}`);
  console.log(`✓ Policy ${existing ? "已更新" : "已建立"}：只放行 ${email}`);
}

function step6WriteConfig(teamDomain, aud) {
  const path = new URL("../wrangler.toml", import.meta.url).pathname;
  let toml = readFileSync(path, "utf8");
  toml = toml.replace(/^ACCESS_TEAM_DOMAIN = ".*"$/m, `ACCESS_TEAM_DOMAIN = "${teamDomain}"`);
  toml = toml.replace(/^ACCESS_AUD = ".*"$/m, `ACCESS_AUD = "${aud}"`);
  writeFileSync(path, toml);
  console.log("✓ wrangler.toml 的 ACCESS_TEAM_DOMAIN 与 ACCESS_AUD 已填好");
}

/* ------------------------------ 主流程 ------------------------------ */

console.log(`\n设定 Cloudflare Access：${hostname}\n`);

const accountId = await step1FindAccount();
const teamDomain = await step2EnsureOrganization(accountId);
const otpId = await step3FindOtpProvider(accountId);
const app = await step4EnsureApp(accountId, otpId);
await step5EnsurePolicy(accountId, app.id);
step6WriteConfig(teamDomain, app.aud);

console.log(`
─────────────────────────────────────────────
全部设定完成。

  网址          ${hostname}
  team domain   ${teamDomain}
  可登入的 email ${email}
  登入方式       One-time PIN（Cloudflare 寄验证码到 email）

接下来换你做（我做不到，验证码寄到你信箱）：

  1. 开无痕视窗打开 https://${hostname}
  2. 应该看到 Cloudflare 的 email 输入框 → 填 ${email}
  3. 收信拿 6 位数验证码（寄件人 noreply@notify.cloudflare.com，记得翻垃圾邮件）
  4. 输入后应该进得去

做完记得回 https://dash.cloudflare.com/profile/api-tokens 把这个 token Revoke 掉。
─────────────────────────────────────────────
`);
