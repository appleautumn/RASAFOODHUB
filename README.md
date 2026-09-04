# Rasa CRM — Cloudflare Access 登入保护

登入这件事整包交给 Cloudflare Access（Zero Trust）：
使用者输入 email → Cloudflare 寄一次性验证码（One-time PIN）→ 输入后进系统。
我们不写登入页、不寄信、不管 session。

worker 只做一件事：**验证 Access 发的 JWT**，再从 `users` 表查这个人的角色。

👉 **从 Claude Artifact 搬过来：[docs/migrate-from-artifact.md](docs/migrate-from-artifact.md)**
👉 **Access 后台设定：[docs/cloudflare-access-setup.md](docs/cloudflare-access-setup.md)**

先跑 `npm run dev` 在本机看它动起来 —— 不需要网域、不需要 Access、不用花钱。

---

## 档案

| 档案 | 做什么 |
|---|---|
| `src/access-jwt.js` | 验 `Cf-Access-Jwt-Assertion`：签章、`iss`、`aud`、`exp`，四项全过才算数 |
| `src/users.js` | 查 `users` 表，决定这个 email 是 `admin` 还是 `staff` |
| `src/index.js` | worker 进入点：挡请求、`/api/me`、`/api/authcheck` |
| `schema.sql` | `users` 表（email / name / role） |
| `app/rasacrm.jsx` | CRM 前端，身分与角色改成向 `/api/me` 拿 |
| `app/main.jsx` | 前端进入点，补上 `window.storage`（改打 worker，资料存 D1）|
| `public/index.html` | 页面外壳，`npm run build` 产出 `public/app.js` 与 `app.css` |
| `tailwind.config.js` | Tailwind 在 build 时产生 CSS（不用 CDN，页面不依赖外部服务）|
| `test/access-jwt.test.mjs` | 20 个验证测试，含伪造 token 的情境 |
| `scripts/setup-access.mjs` | 用 API token 一次建好 Access 的 Application、Policy、登入方式 |
| `scripts/import-data.mjs` | 把 Claude Artifact 汇出的资料转成 SQL 灌进 D1 |

```bash
npm test        # 36 个测试，不需要网路、不需要 Cloudflare 帐号
npm run build   # 打包前端到 public/app.js
npm run deploy  # build + wrangler deploy
```

## 资料存在哪

原本的 CRM 用 `window.storage` 存资料 —— 那是 Claude Artifact 环境的 API，
**一般浏览器里没有这个东西**。直接搬到 Workers 上，开页面就会跳「读取资料失败」。

所以 `app/main.jsx` 补了一个同介面的实作（`app/storage-client.js`）。
`app/rasacrm.jsx` 里的程式码一行都没为此改动。

副作用是好的：资料从「每个人浏览器里各一份」变成**全团队共用一份**，
而且每次写入都记下是谁改的（`updated_by`）—— 对 CRM 来说这本来就是该有的样子。

### 底下是关联式资料表，不是一整包 JSON

一开始 `/api/storage/:key` 是 key-value 形状：整包 JSON 存进 D1 一个栏位，
读的时候整包捞出来。那个形状有一个不会报错的资料遗失问题 ——
**整包读 → 改 → 整包写 = 最后写入者全覆盖**。两个员工同时开着系统，
一个改 A 顾客、一个改 B 顾客，后存的那个会把前一个的改动整个盖掉，
没有冲突提示，没人会发现。

现在拆成 `customers` / `messages` / `notes` / `orders` / `tasks` /
`customer_tags` / `activities` / `settings`（见 `schema.sql`），API 也换成
资源导向的 REST：

- 筛选与排序在 SQL 里做（`WHERE` / `ORDER BY`），不是整包捞回前端过滤
- 分页用 cursor（keyset），第 100 页跟第 1 页一样快
- `PATCH` **只送有改到的栏位**，所以改不同顾客不会互相影响
- 同一位顾客的竞争由 `updated_at` 乐观锁挡下：对不上回 **409**，
  呼叫端重新载入，不会默默覆盖

`window.storage` 的介面形状完全没变，页面不知道底下换了引擎。

## 改资料库结构：怎么安全地跑一次 migration

**schema 改动不接进自动部署，一律手动跑。**

理由是可逆程度不同：程式部署错了，回滚版本几秒钟；schema 改错了要还原备份，
而这期间写进来的资料可能已经坏掉。两件事不该绑同一个触发。

### 规矩

- 改结构一律**新增**一支 `migrations/NNNN_名字.sql`，编号接续，不要回头改已经跑过的
  （改了也不会重跑，只会让正式库跟 repo 悄悄对不上）
- 档名照 `wrangler d1 migrations create` 产生的格式：四位数字 + 底线 + 小写名字
- `schema.sql` 是「现在的完整结构」，`migrations/` 是「怎么一步步走到现在」，
  两边要讲同一件事

### 步骤

```bash
# 1. 先看有哪些还没套用
npm run db:migrate:list

# 2. 本机先跑一次，确认 SQL 没问题
npm run db:migrate:local
npm test

# 3. 正式库
npm run db:migrate
```

`wrangler d1 migrations apply` 的行为（官方文件写明的）：

- 非互动环境会跳过确认步骤
- **套用前会先抓一份备份**
- 某一支失败会回滚那一支，先前成功的保留

### 跑之前自己检查这几件事

1. **这支是新增的，还是改了旧的？** 改旧的就停下来，改成新增一支
2. **有没有破坏性语句？** `DROP TABLE`、`DROP COLUMN`、没有 `WHERE` 的
   `DELETE` / `UPDATE`。有的话先想清楚：资料删掉就没了，备份是最后一道防线不是第一道
3. **能不能重跑？** 用 `CREATE TABLE IF NOT EXISTS`、`INSERT OR IGNORE` 这类写法，
   同一支跑两次结果要一样

### 目前的状态（2026-09）

正式库的两张原始表和关联式那批，都是**用后台 Console 手动跑的**，
所以 `d1_migrations` 里没有对应纪录。

`0001` 和 `0002` 都是 `CREATE TABLE IF NOT EXISTS`，之后真的跑
`db:migrate` 会是 no-op，只是把纪录补登上去 —— 不会出事，但**别以为纪录已经在那里**。

---

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

要留意的是 Access application 的 hostname 必须涵盖你**实际对外的每一个网址**。
`*.workers.dev` 本身是可以被 Access 保护的（self-hosted app 的 hostname
直接填完整主机名即可），但如果你同时开了 workers.dev 和自订网域、
却只替其中一个建了 application，另一个就是没锁的门。

## 两个设定不能动

**`wrangler.toml` 的 `run_worker_first = true`** —— 少了它，静态档会由资源层
直接回应，worker 根本不会执行，等于 `index.html` 和 `app.js` 不用登入就拿得到。
（实机踩过这个坑：单元测试抓不到，因为测试是直接呼叫 worker 的 fetch。）

**本机开发身分由编译期常数守门** —— `wrangler.toml` 的 `[define]` 把
`__ALLOW_DEV_IDENTITY__` 固定成 `false`，只有 `npm run dev` 会用
`--define` 覆写成 `true`。加上 `minify = true`，正式产物里那个函式
只剩「回传 null」，判断依据不是任何来自请求的输入（hostname、标头都不是），
所以打不动。

## 端点

| 路径 | 需要登入 | 回什么 |
|---|---|---|
| `/api/authcheck` | 否（永远回 200） | 验证过程的诊断结果，设定填错时看这个 |
| `/api/me` | 是 | `{ email, name, role, isAdmin }` |
| `GET /api/customers` | 是 | 顾客名单。`?stage=&priority=&tag=&excludeTag=&needsReply=&search=&sort=&cursor=&limit=&include=timeline` |
| `POST /api/customers` | 是 | 新增一位顾客 |
| `DELETE /api/customers` | 是 | 全部清空（前端的 resetAll） |
| `GET /api/customers/:id` | 是 | 单一顾客，含标签与时间轴 |
| `PATCH /api/customers/:id` | 是 | **只改送来的栏位**。要带 `updatedAt` 当乐观锁，对不上回 409 |
| `DELETE /api/customers/:id` | 是 | 删一位顾客（讯息 / 备注 / 标签一起走） |
| `GET·POST /api/customers/:id/messages` | 是 | 该顾客的讯息，cursor 分页 |
| `GET·POST /api/customers/:id/timeline` | 是 | 时间轴（messages ∪ notes） |
| `GET·POST /api/customers/:id/notes` | 是 | 内部备注与系统事件 |
| `GET·POST /api/customers/:id/orders` | 是 | 订单（表已建好，UI 还没用到） |
| `GET·POST /api/customers/:id/tasks` | 是 | 任务（表已建好，UI 还没用到） |
| `GET /api/stage-counts` | 是 | 每阶段人数，一次 `GROUP BY` |
| `GET·POST·DELETE /api/activities` | 是 | 团队操作纪录，只新增不覆盖 |
| `GET·PUT·DELETE /api/settings/:key` | 是 | 系统设定（`apps.ai` / `apps.automation` / `apps.campaigns`），也有乐观锁 |
| `/api/admin/*` | 是，且必须 `admin` | 之后要放只有 admin 能看的资料就挂这个前缀 |
| 其它 | 是 | CRM 本体 |

`/api/authcheck` 不挡是故意的 —— 设定错的时候你才看得到错在哪。
它不会回传 token，AUD 只露前 8 码。而且当 Access 正确挡在前面时，
没登入的人连这个端点都碰不到（会先被 Access 拦下）。

## 角色

角色只影响一件事：**只有 `admin` 看得到「团队活动」页**。
其它页面两种角色都一样。

两层，缺一不可：

- **能不能进门** → Cloudflare Access 的 Policy
- **进来算不算数、能做什么** → `users` 表的 `is_active` 与 `role`

通过 Access 只代表身分可信，不代表有权限。worker 每个请求都会再查一次
`users` 表：不在表里、或 `is_active = 0`，一律挡下。
所以停权一个人不必动 Access 后台：

```bash
npx wrangler d1 execute rasa-crm --remote \
  --command="UPDATE users SET is_active = 0 WHERE email = 'ahkit@example.com'"
```

前端右上角的角色标签是唯读的。以前那个可以自己切 admin/staff 的下拉选单已经拿掉了 ——
角色能自己选就不算权限。

目前 `users` 表里只有一个人：

| email | name | role | is_active |
|---|---|---|---|
| `rasafoodhubplt@gmail.com` | Rasa Admin | admin | 1 |

内容在 `seed.users.sql`，改完跑 `npm run db:seed`。

`wrangler.toml` 的 `REQUIRE_USER_ROW` 设成 `"true"`：不在 `users` 表里的 email
一律挡掉。设成 `"false"` 则改成「查不到就当 staff 放行」。

## 前端要接上去的地方

`app/rasacrm.jsx` 是改好的 CRM 元件。它开场会呼叫 `/api/me` 拿身分，
拿不到就不画出系统。把你现有的 build 流程指向这份档案，
产出的静态档放进 `public/`（`wrangler.toml` 的 `[assets]` 会把它服务出去）；
如果你的静态档是别的方式提供的，改 `src/index.js` 里的 `serveApp()` 即可 ——
验证与角色的部分不用动。
