# 进度

每个阶段做完就更新这一份。中途换对话也接得回来。

| 阶段 | 内容 | 状态 | 完成日期 |
|---|---|---|---|
| 0 | 把 key-value blob 换成关联式资料表 | ✅ 完成 | 2026-09-02 |
| 1 | 安全与权限（审计纪录、部署闸门、把 Access 开起来） | 🟡 进行中 | |
| 2 | 讯息接入（桥接机、历史回补、节流） | ⬜ 未开始 | |
| 3 | 销售阶段与背景自动化 | ⬜ 未开始 | |
| 4 | AI 与对话流程 | ⬜ 未开始 | |
| 5 | 营运工具（群发、合并、Inbox、备份） | ⬜ 未开始 | |

---

## 阶段 0 — 资料模型（2026-09-02）

### 改了什么

**资料层**

| 档案 | 改动 |
|---|---|
| `schema.sql` | 整个重写。从 2 张表（`users`、`app_state`）变成 9 张 |
| `migrations/002-relational-schema.sql` | 给已经建好的资料库用。只加东西，`app_state` 原封不动留着 |
| `src/phone.js` | 新增。电话正规化与搜寻变体 |
| `src/sql.js` | 新增。cursor 编解码、乐观锁时间戳、D1 参数上限的切块 |
| `src/customers.js` | 新增。顾客的查询建构、栏位级更新、乐观锁 |
| `src/timeline.js` | 新增。messages ∪ notes 的读写与汇总重算 |
| `src/records.js` | 新增。orders / tasks / activities / settings |
| `src/api.js` | 新增。资源导向的路由 |
| `src/index.js` | 移除 `handleStorage`，`/api/*` 转给 `handleApi` |

**前端（页面程式码一行都没改）**

| 档案 | 改动 |
|---|---|
| `app/storage-client.js` | 新增。`window.storage` 的新实作 —— 介面形状不变，背后改打 REST |
| `app/main.jsx` | 只剩「装上转接层 + render」 |
| `app/rasacrm.jsx` | **完全没动** |

**其它**

| 档案 | 改动 |
|---|---|
| `scripts/import-data.mjs` | 重写。产出新表结构的 SQL；电话正规化、时间戳缺失留空、汇入顾客一律低优先且不落新客 |
| `test/helpers/d1.mjs` | 新增。用 `node:sqlite` 做的 D1 替身，跑真的 SQL，并照 D1 的 100 参数上限 |
| `test/schema.test.mjs` | 新增。表 / 外键 / 索引 / `EXPLAIN QUERY PLAN` |
| `test/api.test.mjs` | 新增。REST 行为、并发、筛选排序、分页 |
| `test/storage-client.test.mjs` | 新增。转接层的介面合约与两分页并发 |
| `test/worker.test.mjs` | 原本打 `/api/storage/` 的几项改指向新端点；验证意图不变 |
| `README.md` / `STATUS.md` / `docs/cloudflare-access-setup.md` | 端点表与说明更新 |
| `package.json` | 加 `db:migrate` / `db:migrate:local` / `db:dump-app-state` |

### 解决了什么

**互相覆盖（正在发生的资料遗失）。** 原本整包读→改→整包写，两个人同时开着系统
各改各的顾客，后存的会把前一个的改动整个盖掉。现在 `PATCH` 只写有改到的栏位，
不同顾客互不影响；同一位顾客的竞争由 `updated_at` 乐观锁挡下，第二个人拿到 409。

**查不了。** 筛选、排序、分页全部进 SQL（`WHERE` / `ORDER BY` / keyset cursor），
不是整包捞回前端过滤。

### 验收结果

| 项目 | 结果 |
|---|---|
| 两个分页各改一位不同顾客，两边改动都在 | ✅ 真实浏览器实测 |
| 同一位顾客同栏位，第二个存档收到 409 不是默默覆盖 | ✅ 真实浏览器实测 |
| 三个筛选 + 排序，SQL 里真的有 WHERE / ORDER BY | ✅ 印出 SQL + `EXPLAIN QUERY PLAN` 证明走索引 |
| 5000 笔假资料，列表页第一屏载入时间 | ✅ 1.6s（含全部资料载入）；筛选查询 21ms |
| 汇入脚本跑完，抽验十笔电话与时间戳 | ✅ 十笔全对；全库 0 笔被填成今天 |
| 六个页面逐页点过，画面与操作完全相同 | ✅ 六页逐像素比对，差异 0 |

自动化测试 **112 项全过**（`npm test`，不需要网路与 Cloudflare 帐号）。

### 已知未完成 / 待讨论

1. ~~409 的提示文字~~ —— 已修，见下面「阶段 0 补件」。
2. **`orders` / `tasks`**：表、外键、索引、端点都建好了，但目前六个页面没有对应操作
   （收据是个案上的单一栏位，跟进是顾客上的一个日期），所以 UI 还没写进去。
3. **列表页仍然一次拿全部顾客**：为了「页面完全不用动」，转接层维持
   「一次给页面整份名单」的形状。API 已经支援筛选与 cursor 分页，
   之后要逐页优化可以一页一页来。
4. **汇入会覆盖优先级**：照规格，汇入的顾客一律标成低优先、且不落进「新进线」
   （原本标成 new 的会改落 `dormant`，脚本会印出有几笔）。
   如果你希望保留汇出档里的真实优先级与阶段，跟我说，我改成可选。

---

## 阶段 0 补件 — 409 提示文字（2026-09-02）

禁令解除后补的。原本冲突时员工看到的是「储存失败，刚才的改动可能没存下来。」——
没说是谁、没说该怎么办，而且 2.6 秒就消失。

| 档案 | 改动 |
|---|---|
| `app/storage-client.js` | 冲突讯息改讲**顾客名字**（原本是 `fx0000` 这种内部 id）；`err.conflicts` 维持给程式用的 id，另外多一个 `err.conflictNames` |
| `app/rasacrm.jsx` | toast 支援 `{ text, tone, sticky }`；冲突用红色、**不自动消失**、附「重新载入」与关闭按钮 |

现在的文字长这样：

> ⚠️ Muhammad Faiz 已经被其他同事改过了，你刚才对他的修改没有存进去。请重新载入拿到最新资料，再改一次。　[重新载入] [×]

实测：讯息里有人名、没有裸露 id、等 4 秒还在、按「重新载入」之后看到同事存的值且可以正常再改一次。
一般提示（黑底、2.6 秒消失、无按钮）行为完全没变。

---

## 阶段 1（进行中）

### 已完成：`ACCESS_ENFORCE` 观察模式

规格要的「不要一次到位，会把人锁在外面」那个开关。

- `"true"`（预设）= 验不过就挡
- `"false"` = 观察模式，验不过也放行，`/api/authcheck` 照实回报本来会失败在哪

**我多加了一条规格没写的限制**：观察模式**只放行「有经过 Access、但 worker 这边验不过」的请求**；
完全没经过 Access 的请求照样挡。少了这条，忘记改回 `true` 就等于把整个 CRM
连同顾客资料公开在网际网路上，而它对「设定贴错字」这个真正要解决的问题毫无帮助。

### 阶段 1 还没做

- `audit_log` 表（`before` / `after`）与「团队活动」页改吃它
- 部署闸门（测试不过就 `exit 1`）
- Access application 本身 —— 你在 Dashboard 操作

### 阶段 1 之前要知道的

- 线上资料库如果已经建过表，要先跑 `npm run db:migrate`，再把旧 blob 搬过去：
  `npm run db:dump-app-state > app_state.json` → `node scripts/import-data.mjs app_state.json`
  → `npx wrangler d1 execute rasa-crm --remote --file=./import.sql`
- `app_state` 表刻意留着不删。全部确认无误之后你再自己决定要不要 `DROP`。

---

## 线上部署现况（2026-09-02 实测）

**网址：<https://rasa-crm.appleautumn-hhl.workers.dev>** —— 已经在你自己的帐号里，D1 也绑好了。

打 `/api/authcheck` 的结果：

| 检查项 | 状态 |
|---|---|
| worker 在跑 | ✅ 403 是它回的 |
| D1 绑定 | ✅ `d1Bound: true` |
| 请求带 Access JWT | ❌ `hasJwtHeader: false`，没有 CF_Authorization cookie |
| `ACCESS_TEAM_DOMAIN` | ❌ 还是 `your-team.cloudflareaccess.com` |
| `ACCESS_AUD` | ❌ 没设 |

**目前是死结**：worker 要 JWT 才放行，但这个主机名前面没有 Access application，
没有东西会把人导去登入页；就算建好了，worker 的设定指向假的 team domain 也会拒绝。

### 解开它（前两步只有帐号拥有者能做）

1. Zero Trust → Access → Applications → **Add a self-hosted application**
   - Application name：随便，例如 `Rasa CRM`
   - **Session Duration**：24 小时之类
   - **Public hostname**：`rasa-crm.appleautumn-hhl.workers.dev`（不要加 `https://`、不要加尾斜线）
   - Path 留空 = 保护整个站
2. 加一条 Policy
   - Action：**Allow**
   - Include：**Emails** → `rasafoodhubplt@gmail.com`（要加同事就一起加）
   - 登入方式选 **One-time PIN**（Zero Trust → Settings → Authentication 里要先启用）
3. 建好之后抄两个值给我：
   - **team domain**：Zero Trust → Settings → Custom Pages，长得像 `xxx.cloudflareaccess.com`
   - **AUD tag**：Access → Applications → 你的 app → Overview → Application Audience (AUD) Tag
4. 我把这两个填进 `wrangler.toml`，先设 `ACCESS_ENFORCE = "false"`（观察模式）
5. 你 `npm run deploy`，用真实登入打开 `/api/authcheck`，确认 `ok: true`
6. 我改回 `ACCESS_ENFORCE = "true"`，你再 deploy 一次 —— 完成

> 第 4~6 步是刻意分两次部署的。一次到位的话，team domain 或 AUD 贴错一个字
> 就是你自己也进不去，而且进不去就看不到错在哪。
