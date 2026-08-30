# Rasa CRM — Cloudflare Access 登入保护

登入这件事整包交给 Cloudflare Access（Zero Trust）：
使用者输入 email → Cloudflare 寄一次性验证码（One-time PIN）→ 输入后进系统。
我们不写登入页、不寄信、不管 session。

worker 只做一件事：**验证 Access 发的 JWT**，再从 `users` 表查这个人的角色。

👉 **第一次设定看这份：[docs/cloudflare-access-setup.md](docs/cloudflare-access-setup.md)**

---

## 档案

| 档案 | 做什么 |
|---|---|
| `src/access-jwt.js` | 验 `Cf-Access-Jwt-Assertion`：签章、`iss`、`aud`、`exp`，四项全过才算数 |
| `src/users.js` | 查 `users` 表，决定这个 email 是 `admin` 还是 `staff` |
| `src/index.js` | worker 进入点：挡请求、`/api/me`、`/api/authcheck` |
| `schema.sql` | `users` 表（email / name / role） |
| `app/rasacrm.jsx` | CRM 前端，身分与角色改成向 `/api/me` 拿 |
| `test/access-jwt.test.mjs` | 20 个验证测试，含伪造 token 的情境 |

```bash
npm test        # 跑验证逻辑的测试（不需要网路、不需要 Cloudflare 帐号）
npm run deploy  # 部署
```

## 为什么不信 `Cf-Access-Authenticated-User-Email`

Access 会带两个东西进来：

- `Cf-Access-Authenticated-User-Email` —— 纯文字，**没有任何签章**
- `Cf-Access-Jwt-Assertion` —— RS256 签名的 JWT

纯文字标头只有在「请求一定经过 Access」时才可信。
但只要有人绕过 Access 直接打到 worker，他就能自己塞一个
`Cf-Access-Authenticated-User-Email: boss@rasafoodhub.com` 进来，worker 分辨不出来。

所以这里的授权只看 JWT：签章用 Cloudflare 的公钥验、`iss` 要是你的 team、
`aud` 要是这个 application、`exp` 要还没过期。伪造的人拿不到 Cloudflare 的私钥，
签不出过得了的 token。纯文字标头只在 `/api/authcheck` 里列出来给你对照，
**不参与任何判断**。

配套的一件事：`wrangler.toml` 里 `workers_dev = false`。
`*.workers.dev` 不受 Access 保护，留着等于把上面这套全绕过去。

## 端点

| 路径 | 需要登入 | 回什么 |
|---|---|---|
| `/api/authcheck` | 否（永远回 200） | 验证过程的诊断结果，设定填错时看这个 |
| `/api/me` | 是 | `{ email, name, role, isAdmin }` |
| `/api/admin/*` | 是，且必须 `admin` | 之后要放只有 admin 能看的资料就挂这个前缀 |
| 其它 | 是 | CRM 本体 |

`/api/authcheck` 不挡是故意的 —— 设定错的时候你才看得到错在哪。
它不会回传 token，AUD 只露前 8 码。而且当 Access 正确挡在前面时，
没登入的人连这个端点都碰不到（会先被 Access 拦下）。

## 角色

角色只影响一件事：**只有 `admin` 看得到「团队活动」页**。
其它页面两种角色都一样。

- 谁**能不能登入** → Cloudflare Access 的 Policy 决定
- 登入后**是什么角色** → `users` 表决定

前端右上角的角色标签是唯读的。以前那个可以自己切 admin/staff 的下拉选单已经拿掉了 ——
角色能自己选就不算权限。

`users` 表里查不到的 email 预设当 `staff`（看不到团队活动）。
想更严格，把 `wrangler.toml` 的 `REQUIRE_USER_ROW` 设成 `"true"`，
不在表里的人就直接挡掉。

## 前端要接上去的地方

`app/rasacrm.jsx` 是改好的 CRM 元件。它开场会呼叫 `/api/me` 拿身分，
拿不到就不画出系统。把你现有的 build 流程指向这份档案，
产出的静态档放进 `public/`（`wrangler.toml` 的 `[assets]` 会把它服务出去）；
如果你的静态档是别的方式提供的，改 `src/index.js` 里的 `serveApp()` 即可 ——
验证与角色的部分不用动。
