# 用 Cloudflare Access（Zero Trust）保护 Rasa CRM — 从零开始

目标：使用者打开 CRM 网址 → Cloudflare 挡在前面要 email → 寄一次性验证码 →
输入正确才进得来。登入页、寄信、session 全部由 Cloudflare 处理，我们一行都不用写。

全部做完大概 20 分钟。照顺序做，每一步都有「看到什么代表成功」。

> ### 想少点几下？用脚本
>
> 第 1～4 步（team domain、Application、Policy、One-time PIN、抓 AUD 填进 `wrangler.toml`）
> 可以让脚本一次做完，你只要生一个 API token：
>
> 1. 开 <https://dash.cloudflare.com/profile/api-tokens> → **Create Token**
>    → **Create Custom Token** → **Get started**
> 2. Permissions 加三行，TTL 设到明天，建立后复制那串：
>    - Account → **Access: Apps and Policies** → Edit
>    - Account → **Access: Organizations, Identity Providers, and Groups** → Edit
>    - Account → **Account Settings** → Read
> 3. 执行（换成你的网址）：
>
> ```bash
> CLOUDFLARE_API_TOKEN=贴在这里 npm run access:setup -- \
>   --hostname crm.rasafoodhub.com \
>   --email rasafoodhubplt@gmail.com \
>   --team rasafoodhub
> ```
>
> 重复执行是安全的，不会建出第二份。跑完直接跳到**第 5 步**测试。
> 若它说 Zero Trust 还没开通，就先做第 1 步再重跑。
> 最后记得回 API Tokens 页面把 token **Revoke** 掉。

---

## 第 0 步：先确认前置条件（很重要，跳过后面会卡住）

Access 只保护「走 Cloudflare 代理的自订网域」。
**`xxx.workers.dev` 这种网址 Access 保护不到**，任何人都能直接打到你的 worker。

所以你的 CRM 必须挂在自己的网域上，例如 `crm.rasafoodhub.com`。

1. 打开 <https://dash.cloudflare.com> → 左边 **Workers & Pages** → 点你的 CRM worker
2. 上方分页 **Settings** → **Domains & Routes**
3. 看看清单里有没有一个自订网域（像 `crm.rasafoodhub.com`）
   - **有** → 记下这个网址，进行第 1 步
   - **没有** → 点 **Add** → **Custom Domain** → 输入 `crm.你的网域.com` → **Add Domain**
     （前提是这个网域已经加进 Cloudflare 帐号里）
4. 同一个清单里如果看到 `xxx.workers.dev`，点它右边 **Remove / Disable**，把它关掉

> ✅ **成功的样子**：Domains & Routes 里只剩一个自订网域，
> 用浏览器打开它可以看到你的 CRM（这时还没有登入保护，正常）。

---

## 第 1 步：进 Zero Trust 后台，第一次设定 team name

1. 打开 <https://one.dash.cloudflare.com>
   （或从 <https://dash.cloudflare.com> 左边选单点 **Zero Trust**）
2. 第一次进来会要你 **选一个 team name**。
   输入一个短英文名字，例如 `rasafoodhub`。
   Cloudflare 会给你一个网址：`rasafoodhub.cloudflareaccess.com`
   → **这串东西等一下要贴进程式设定，先抄下来**
3. 接着会要你选方案：选 **Zero Trust Free**（50 人以内免费）。
   即使是免费方案，Cloudflare 也会要你填一张卡做验证，填完不会扣款。
4. 进到 Zero Trust 首页

> ✅ **成功的样子**：左边看得到 **Access**、**Networks**、**Settings** 等选单，
> 而且 **Settings → Custom Pages** 页面上方会显示你的 team domain
> `你的名字.cloudflareaccess.com`。忘记 team domain 时就来这里看。

---

## 第 2 步：把登入方式设成 One-time PIN（Email OTP）

先设登入方式，等一下建 Application 时才选得到。

1. 左边选单 **Settings**（最下面）→ **Authentication**
2. 找到 **Login methods** 区块
3. 里面本来就会有一个 **One-time PIN** —— 这就是 Email OTP，Cloudflare 内建，不用设定、不用申请
4. 如果清单里还有 Google、GitHub 之类的，先不用管，第 3 步会指定只用 One-time PIN

> 「寄验证码到 email」就是这一项，Cloudflare 自己寄、自己验，
> 不用申请、不用接 SMTP、不用买寄信服务，我们也不写任何程式。

> ✅ **成功的样子**：Login methods 清单里看得到 **One-time PIN**（它无法被删除，一定存在）。

---

## 第 3 步：建立 Application 指向你的 worker 网址

1. 左边选单 **Access** → **Applications** → 右上角 **Add an application**
2. 类型选 **Self-hosted**
3. **Application name**：`Rasa CRM`
4. **Session Duration**：选 `24 hours`（一天要重新登入一次；想少输入验证码就选 1 week）
5. 往下找到 **Public hostname**（或 **Add public hostname**）填你的网址：
   - Subdomain：`crm`
   - Domain：从下拉选 `rasafoodhub.com`
   - Path：**留空**（留空 = 整个网站都保护，包含 `/api/*`）
6. 下一步会到 **Access Policies** —— 这是第 4 步的内容，先照第 4 步做
7. 再下一步 **Login methods**（有些版面叫 Authentication）：
   - 把 **Accept all available identity providers** 关掉
   - 只勾 **One-time PIN**
8. 按 **Save**

建完之后回到 **Access → Applications**，点进 `Rasa CRM`：

9. 在 **Overview**（或 Settings）分页找到 **Application Audience (AUD) Tag**，
   是一长串英数字。点旁边的复制钮 → **这串等一下要贴进程式设定，抄下来**

> ✅ **成功的样子**：Applications 清单里出现一列 `Rasa CRM`，
> Type 是 `Self-hosted`，Hostname 是 `crm.rasafoodhub.com`。
> 而且你手上有两串东西了：team domain 和 AUD tag。

---

## 第 4 步：设 Policy —— 只放行指定的几个 email

在第 3 步的第 6 点（或事后进 Application → **Policies** → **Add a policy**）：

1. **Policy name**：`allow-team`
2. **Action**：选 **Allow**
3. **Configure rules** → **Include** 区块：
   - **Selector**：下拉选 **Emails**
   - **Value**：输入 `rasafoodhubplt@gmail.com`，**按 Enter**
     （一定要按 Enter，看到它变成一个小方块才算加进去）
   - 目前就你一个人，这样就好；以后要加同事再回来这里加
4. 按 **Next / Save**

> 💡 如果整间公司都用同一个网域的信箱，Selector 可以改选
> **Emails ending in**，值填 `@rasafoodhub.com`，就不用一个一个加。

> ✅ **成功的样子**：Application 的 **Policies** 分页里有一条 `allow-team`，
> Action 显示 **Allow**，Rules 那栏看得到你输入的 email 数量。

---

## 第 5 步：用无痕视窗测试

**测试 A：允许的 email 进得来**

1. 开一个**无痕视窗**（Chrome：`Ctrl/Cmd + Shift + N`）
2. 打开 `https://crm.rasafoodhub.com`
3. 应该看到 **Cloudflare Access 的登入页**：一个 email 输入框 + **Send me a code** 按钮
4. 输入 `rasafoodhubplt@gmail.com` → 按 **Send me a code**
5. 画面变成「输入验证码」；同时你的信箱会收到一封信，
   寄件人是 `noreply@notify.cloudflare.com`，里面有 6 位数字
   （**没收到就翻垃圾邮件匣**，Gmail 常丢进去）
6. 把码贴进去 → 按 **Sign in**
7. 进入 CRM

> ✅ **成功的样子**：右上角「已登入」显示的是**你的 email**，
> 旁边有一个 `admin` 或 `staff` 的小标签，而且**不能点、不能改**。

**测试 B：不允许的 email 进不来**

1. 另开一个无痕视窗，打开同一个网址
2. 输入一个**不在 Policy 里**的 email（例如随便一个 gmail）
3. 有两种正常结果：收不到信，或收到码输入后被挡

> ✅ **成功的样子**：看到 Cloudflare 的拒绝画面
> （`That account does not have access` 之类），进不了 CRM。

**测试 C：确认 Access 真的挡在 worker 前面**

在终端机执行（不带任何登入资讯）：

```bash
curl -sSI https://crm.rasafoodhub.com/api/authcheck | head -5
```

> ✅ **成功的样子**：回 `HTTP/2 302`，`location` 指向
> `https://你的team.cloudflareaccess.com/cdn-cgi/access/login/...`
> —— 代表请求连 worker 都没碰到就被 Access 拦下来了。
>
> ❌ **有问题的样子**：直接回一段 JSON（`"reason": "no_token"`）。
> 这代表这个网址**没有**被 Access 保护，请回第 0 步确认
> workers.dev 已关闭、第 3 步的 hostname 有没有打错。

**登出**（想重测时用）：打开 `https://你的team.cloudflareaccess.com/logout`

---

## 第 6 步：把设定填进 worker 并部署

1. 打开 `wrangler.toml`，改 `[vars]` 三个值：

```toml
[vars]
ACCESS_TEAM_DOMAIN = "rasafoodhub.cloudflareaccess.com"   # 第 1 步抄的
ACCESS_AUD = "第 3 步复制的那串 AUD tag"
REQUIRE_USER_ROW = "true"
```

同时确认 `routes` 里的网域是你自己的，而且 `workers_dev = false`。

2. 建 D1 资料库（users 表放这里）：

```bash
npx wrangler d1 create rasa-crm
```

把它印出来的 `database_id` 贴回 `wrangler.toml` 的 `[[d1_databases]]`。

3. 建表 + 填人：

```bash
npm run db:init   # 建 users 表
npm run db:seed   # 写入 rasafoodhubplt@gmail.com = admin（内容在 seed.users.sql）
npm run db:list   # 看一眼有没有写进去
```

> ✅ **成功的样子**：`db:list` 印出一行
> `rasafoodhubplt@gmail.com | Rasa Admin | admin`。
>
> ⚠️ `REQUIRE_USER_ROW` 目前设成 `"true"`，也就是「不在 users 表里的人一律挡掉」。
> 所以这三行**一定要在 `wrangler deploy` 之前跑完**，否则连你自己都会被挡在外面
> （真的挡到了也不用慌：打开 `/api/authcheck` 会写 `user_not_in_table`，补跑 `db:seed` 就好）。

4. 部署：

```bash
npx wrangler deploy
```

5. 回无痕视窗登入一次，然后打开
   `https://crm.rasafoodhub.com/api/authcheck`

> ✅ **成功的样子**：一段 JSON，`"ok": true`，
> `jwt.verified` 是 `true`，`user.email` 是你的信箱，`user.role` 是 `admin`。

---

## `/api/authcheck` 看不懂时的对照表

| `reason` | 意思 | 怎么修 |
|---|---|---|
| `no_token` | 请求没经过 Access | workers.dev 没关，或 Application 的 hostname 打错 |
| `config_missing_team_domain` | 没填 team domain | 补 `wrangler.toml` 的 `ACCESS_TEAM_DOMAIN` |
| `config_missing_aud` | 没填 AUD | 补 `wrangler.toml` 的 `ACCESS_AUD` |
| `iss_mismatch` | team domain 填错 | 回 Settings → Custom Pages 看正确的 team domain |
| `aud_mismatch` | AUD 填错 | 回 Application → Overview 重新复制 AUD tag |
| `expired` | 登入过期 | 重新整理页面即可 |
| `bad_signature` | token 不是这个 team 发的 | 通常是 team domain 填成别人的 |
| `unknown_kid` | Cloudflare 换了签章金钥 | 重试一次；一直发生就检查 team domain |
| `user_not_in_table` | 通过 Access 但 users 表没这个人 | 到 users 表加一行，或把 `REQUIRE_USER_ROW` 设回 `false` |
| `db_not_bound` | 没绑 D1 | `wrangler.toml` 的 `[[d1_databases]]` 没设好 |

---

## 之后要加人 / 改角色

**加一个能登入的人**（两个地方都要做，缺一不可）：

1. Zero Trust → Access → Applications → `Rasa CRM` → Policies → `allow-team`
   → 在 Emails 里加上他的 email → Save
2. 加进 users 表决定他的角色（`REQUIRE_USER_ROW = "true"` 时这步不做他进不来）：

```bash
npx wrangler d1 execute rasa-crm --remote \
  --command="INSERT INTO users (email, name, role) VALUES ('ahkit@example.com', 'Ah Kit', 'staff')"
```

**把某人升成 admin**（他会开始看得到「团队活动」）：

```bash
npx wrangler d1 execute rasa-crm --remote \
  --command="UPDATE users SET role = 'admin' WHERE email = 'ahkit@example.com'"
```

改完请对方重新整理页面。

**踢掉一个人**：把他从 **Policy 的 email 清单里删掉**。
只从 users 表删除是不够的 —— 挡人的是 Access，不是这张表。
