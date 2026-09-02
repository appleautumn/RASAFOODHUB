# 从 Claude Artifact 搬到 Cloudflare Workers

你的 CRM 现在跑在 Claude Artifact 里。搬家要处理三件事：

1. **程式跑得起来** —— artifact 提供的 `window.storage` 在一般浏览器没有（已处理好）
2. **资料要跟过去** —— 不会自动搬，得手动汇出汇入
3. **网址要能被 Access 保护** —— 必须是自订网域

建议照这个顺序做，因为**第 1 步不用花任何钱，先确认东西是好的再说**。

---

## 第 1 步：先在自己电脑上跑起来（免费，不需要网域）

```bash
git clone <你的 repo>
cd RASAFOODHUB
git checkout claude/cloudflare-access-setup-hh1wml
npm install

cp .dev.vars.example .dev.vars   # 里面是本机用的登入身分
npm run db:init:local            # 建本机资料库
npm run db:seed:local            # 写入你的 admin 帐号
npm run dev
```

打开 <http://localhost:8787>

> ✅ **成功的样子**：CRM 整个跑起来，右上角显示 `rasafoodhubplt@gmail.com` 和
> `admin` 标签，左边看得到「团队活动」。
>
> 这时候还没有 Cloudflare Access —— `.dev.vars` 里的 `DEV_BYPASS_EMAIL`
> 让你在本机直接以那个 email 的身分进去。
> **这个只在 localhost 生效**，线上的网址不可能是 localhost，所以它开不了线上的门。

想试 staff 看到什么，把 `.dev.vars` 里的 email 换成一个 staff 的，重开 `npm run dev`
——「团队活动」应该会消失。

---

## 第 2 步：把 artifact 里的资料搬出来

**在还开着的 artifact 页面上**：

1. 按 `F12` 打开开发者工具 → 切到 **Console**
2. 贴上这段，按 Enter：

```js
copy(JSON.stringify(Object.fromEntries(await Promise.all(
  ["rasa-crm:main", "rasa-crm:log", "rasa-crm:apps"].map(async (k) =>
    [k, (await window.storage.get(k))?.value ?? null])
))))
```

3. 资料已经复制到剪贴簿了。在专案资料夹建一个 `export.json`，贴上、存档
4. 转成 SQL 并汇入：

```bash
node scripts/import-data.mjs export.json
npx wrangler d1 execute rasa-crm --local --file=./import.sql   # 先灌本机试
npm run dev                                                    # 确认资料都在
```

> ✅ **成功的样子**：`import-data.mjs` 印出每个 key 和大小，
> 重开 `npm run dev` 后顾客名单跟 artifact 里一模一样。
>
> 重复汇入是安全的，同一个 key 会覆盖而不是报错。

如果 artifact 里本来就没什么资料（都是示范资料），这步整个跳过就好。

---

## 第 3 步：网域（这步要花钱，绕不过去）

Cloudflare Access **保护不了 `*.workers.dev`**。任何人都能直接打那个网址，
JWT 标头也就无从验起。所以一定要有自己的网域。

- **已经有网域** → 加进 Cloudflare（Dashboard → **Add a site**），把 DNS 转过来
- **没有网域** → Cloudflare Dashboard 左边 **Domain Registration** → **Register Domain**，
  一年大约 US$10 起。在 Cloudflare 买的好处是买完就直接在你帐号里，不用再搬 DNS

有网域之后，把 `wrangler.toml` 里的 `routes` 改成你的网址：

```toml
routes = [
  { pattern = "crm.你的网域.com", custom_domain = true }
]
```

---

## 第 4 步：部署上线

```bash
npm run db:init        # 在线上资料库建表
npm run db:seed        # 写入 admin 帐号
npm run deploy         # build + 部署
```

有资料要搬的话，再跑一次汇入（这次是 `--remote`）：

```bash
npx wrangler d1 execute rasa-crm --remote --file=./import.sql
```

> ⚠️ 这时候网站是**没有保护**的，任何人知道网址都能打开。
> 所以下一步要马上做完。

---

## 第 5 步：套上 Cloudflare Access

照 [cloudflare-access-setup.md](cloudflare-access-setup.md) 走。
里面有脚本可以一次做完，也有一步步点的版本。

设定完回来把 `wrangler.toml` 的 `ACCESS_TEAM_DOMAIN` 和 `ACCESS_AUD` 填好
（脚本会自动填），再 `npm run deploy` 一次。

> ✅ **全部完成的样子**：无痕视窗打开你的网址 → Cloudflare 要 email →
> 收到验证码 → 进得去 CRM → 打开 `/api/authcheck` 看到 `"ok": true`。

---

## 顺序为什么是这样

| 步骤 | 花钱 | 卡住的话 |
|---|---|---|
| 1. 本机跑起来 | 免费 | 程式有问题，先修好再往下 |
| 2. 搬资料 | 免费 | 资料出不来，至少程式是好的 |
| 3. 网域 | ~US$10/年 | 这是唯一一定要花钱的地方 |
| 4. 部署 | 免费额度内 | — |
| 5. Access | 免费（50 人内）| 可能要绑卡验证 |

前两步做完，你手上就有一套确定能跑的东西了。第 3 步再决定要不要花那笔钱。
