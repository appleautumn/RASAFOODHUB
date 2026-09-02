# Rasa CRM × Cloudflare Access — 进度快照

> 2026-09-02 · 分支 `claude/cloudflare-access-setup-hh1wml` · 8 个 commit 已推送
> 测试 **47 项全过**（`npm test`，不需要网路与 Cloudflare 帐号）

**一句话：程式码全部就绪，卡在一个点 —— 我没有你 Cloudflare 帐号的凭证。**

---

## ✅ 已完成

### 验证与授权

| 项目 | 说明 |
|---|---|
| JWT 验证 | 验 `Cf-Access-Jwt-Assertion` 的签章、`iss`、`aud`、`exp`，只接受 RS256 |
| 挡伪造 | `alg:none`、HS256 换签、换私钥重签、签后窜改 payload 全部测试涵盖 |
| JWKS | 公钥快取一小时，遇到没看过的 `kid` 重取（有最短间隔，防打手） |
| 不信纯文字标头 | `Cf-Access-Authenticated-User-Email` 只在诊断输出里列出，不参与判断 |
| 静态档也要验证 | `run_worker_first = true`，否则 `index.html` / `app.js` 不用登入就拿得到 |
| 本机开发身分 | 由编译期常数 `__ALLOW_DEV_IDENTITY__` 守门，正式产物里那段被 minify 剥掉 |

### 两层授权

- **Access Policy** 决定「能不能进门」
- **`users` 表** 决定「进来算不算数、能做什么」

`users` 表：`email` / `name` / `role`(admin·staff) / `is_active`。
通过 Access 但不在表里、或 `is_active = 0` → 一律挡下。
停权不必动 Access 后台：

```bash
npx wrangler d1 execute rasa-crm --remote \
  --command="UPDATE users SET is_active = 0 WHERE email = 'someone@example.com'"
```

角色只影响一件事：**只有 admin 看得到「团队活动」页**。
前端右上角的角色标签是唯读的，原本那个可以自己切 admin/staff 的下拉选单已移除。

### 端点

| 路径 | 需要登入 | 回什么 |
|---|---|---|
| `/api/authcheck` | 否（永远 200） | 验证过程诊断，设定填错时看这个 |
| `/api/me` | 是 | `{ email, name, role, isActive, isAdmin }` |
| `/api/storage/:key` | 是 | CRM 资料读写，存 D1，记录 `updated_by` |
| `/api/admin/*` | 是，且 admin | 预留给之后只有 admin 能看的资料 |
| 其它 | 是 | CRM 本体 |

### 前端与建置

- `window.storage` 改打 `/api/storage/*` —— 原本那是 Claude Artifact 的 API，一般浏览器没有
- 资料从「每人浏览器各一份」变成**全团队共用一份**
- esbuild 打包 + Tailwind 在 build 时产 CSS（不依赖 `cdn.tailwindcss.com`）
- 身分与角色开场向 `/api/me` 拿，拿不到就不画出系统

### 工具与文件

| 档案 | 用途 |
|---|---|
| `scripts/setup-access.mjs` | 一次建好 Access 的 Application、Policy、One-time PIN，并回填 `wrangler.toml` |
| `scripts/import-data.mjs` | 把 artifact 汇出的资料转成 SQL 灌进 D1 |
| `docs/cloudflare-access-setup.md` | Zero Trust 后台逐步清单 |
| `docs/migrate-from-artifact.md` | 从 Claude Artifact 搬到 Workers 的五步 |
| `migrations/001-add-is-active.sql` | 已建表的资料库补 `is_active` 栏位 |

---

## ⚠️ 部分完成：部署

CRM **已经在线上跑**：<https://rasa-crm.gentle-jupiter.workers.dev>
（实测回 401，是 worker 在回应；D1 已建表，`users` 里有 admin）

**但它在 wrangler 的临时帐号里，不在你的帐号。** 认领没成功，所以你的
Workers & Pages 看起来是空的。那个临时帐号会自己过期消失，不用管它。

---

## ❌ 未完成

| # | 项目 | 卡在哪 |
|---|---|---|
| 1 | 部署到**你自己的**帐号 | 认证。OAuth 试三次失败（前两次是我的监听器活不过工具呼叫间隔） |
| 2 | Access application + OTP login | 完全没开始，需要 Access 权限（OAuth 范围里没有） |
| 3 | 网址改短 | 要你在后台改帐号子域，只有你能做 |
| 4 | 搬 artifact 既有资料 | 脚本写好了，还没跑 |
| 5 | WhatsApp / Baileys 扫码桥接 | 没开始 |

### 关于网址

`dashboard.rasa` **不可能** —— `.rasa` 不是真实顶级网域，不在 IANA 根区，
没有任何 DNS 解析得到，谁都注册不到。

可行的：

| 方案 | 结果 | 花费 | 谁能做 |
|---|---|---|---|
| 改 worker 名 + 帐号子域 | `dashboard.rasa.workers.dev` | 免费 | 子域只有你能改（Workers & Pages → Subdomain → Change） |
| 买网域 | `dashboard.rasafoodhub.com` | ~US$10/年 | 你 |

⚠️ **先定网址，再设 Access。** Access application 绑主机名，先设好再改网址就要重做。

---

## 我讲错、后来修正的

| 我说过 | 实际上 | 后果 |
|---|---|---|
| Access 保护不了 `*.workers.dev`，必须先买网域 | **错**。self-hosted app 按主机名保护，直接填 workers.dev 完整主机名即可 | 我拿错误前提当采购理由，已从整个 repo 清掉 |
| 没登入连静态档都拿不到 | **当时是错的**。资源层会绕过 worker，`/` 与 `/app.js` 回 200 | 实机跑才发现，已用 `run_worker_first` 修正并补迴归测试 |
| 编译期常数让那段程式码「根本不存在」 | **讲过头**。没开 minify 只是变成永远到不了的死码 | 已开 `minify = true`，现在成立 |
| 没有你的凭证完全不可能部署 | **错**。wrangler 有 `--temporary`，部署到临时帐号再认领 | 早点想到能省好几轮 |

---

## 下一步（建议顺序）

1. **解决认证** —— 建一个 API token 给我，或走 OAuth
   建议 token：一个字串，没有时序与 process 存活问题
2. **部署到你的帐号** → Workers & Pages 不再是空的
3. **决定最终网址**（改帐号子域）
4. **Access + OTP** —— `npm run access:setup` 一次做完
5. **搬 artifact 资料** —— `node scripts/import-data.mjs export.json`
6. **WhatsApp / Baileys** —— 另议。Workers 跑不了 Baileys（需要长驻连线），
   要另外找地方放

### Token 权限（一次给齐，做完撤销）

<https://dash.cloudflare.com/profile/api-tokens> → Create Token → Create Custom Token

| 类型 | 项目 | 权限 | 用途 |
|---|---|---|---|
| Account | Workers Scripts | Edit | 部署 |
| Account | D1 | Edit | 资料库 |
| Account | Account Settings | Read | 找 account id |
| Account | Access: Apps and Policies | Edit | 建 application 与 policy |
| Account | Access: Organizations, Identity Providers, and Groups | Edit | team domain 与 One-time PIN |

TTL 设到明天。**不要给 Global API Key。**

---

## 本机就能做的（不需要任何凭证）

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:init:local && npm run db:seed:local
npm run dev          # http://localhost:8787
npm test             # 47 项
```

打开就能看到完整 CRM，右上角是你的 email + admin 标签。
把 `.dev.vars` 的 email 换成 staff 的，「团队活动」会消失。
