# 进度

每个阶段做完就更新这一份。中途换对话也接得回来。

| 阶段 | 内容 | 状态 | 完成日期 |
|---|---|---|---|
| 0 | 把 key-value blob 换成关联式资料表 | ✅ 完成 | 2026-09-02 |
| 1 | 安全与权限（审计纪录、部署闸门、把 Access 开起来） | ⬜ 未开始 | |
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

自动化测试 **101 项全过**（`npm test`，不需要网路与 Cloudflare 帐号）。

### 已知未完成 / 待讨论

1. **409 的提示文字**：前端的 toast 是写死的「储存失败，刚才的改动可能没存下来。」
   转接层丢出的详细讯息（哪几位顾客冲突、要重新整理）只进主控台。
   要让使用者看到更清楚的说明就得动 `rasacrm.jsx`，这阶段不准动，所以留着。
2. **`orders` / `tasks`**：表、外键、索引、端点都建好了，但目前六个页面没有对应操作
   （收据是个案上的单一栏位，跟进是顾客上的一个日期），所以 UI 还没写进去。
3. **列表页仍然一次拿全部顾客**：为了「页面完全不用动」，转接层维持
   「一次给页面整份名单」的形状。API 已经支援筛选与 cursor 分页，
   之后要逐页优化可以一页一页来。
4. **汇入会覆盖优先级**：照规格，汇入的顾客一律标成低优先、且不落进「新进线」
   （原本标成 new 的会改落 `dormant`，脚本会印出有几笔）。
   如果你希望保留汇出档里的真实优先级与阶段，跟我说，我改成可选。

### 阶段 1 之前要知道的

- 线上资料库如果已经建过表，要先跑 `npm run db:migrate`，再把旧 blob 搬过去：
  `npm run db:dump-app-state > app_state.json` → `node scripts/import-data.mjs app_state.json`
  → `npx wrangler d1 execute rasa-crm --remote --file=./import.sql`
- `app_state` 表刻意留着不删。全部确认无误之后你再自己决定要不要 `DROP`。
