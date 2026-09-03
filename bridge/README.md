# WhatsApp 桥接机

Baileys 跑在常驻主机上，把 WhatsApp 的进讯转给 `rasa-crm` Worker，
并提供 `/send` 让 Worker 送讯息出去。

Cloudflare Workers 跑不了这个 —— Baileys 需要一条长期存在的 WebSocket。

## 为什么要独立一台

```
  顾客的 WhatsApp
        │
        ▼
  ┌──────────────────┐  POST /api/wa/webhook  ┌──────────────┐
  │ 这台（Railway）   │ ─────────────────────► │ Worker       │
  │ Baileys（扫码）   │ ◄───────────────────── │ rasa-crm     │
  └──────────────────┘  POST {这台}/send       └──────────────┘
     长连线 WebSocket      两边各带共用 secret        D1
```

## 端点

| 端点 | secret | 说明 |
|---|---|---|
| `GET /health` | 不需要 | 连线状态、rss、佇列长度。Railway 的健康检查打这个 |
| `GET /status` | 需要 | 只回连线状态 |
| `GET /qr` | 需要 | 回 PNG。已连线回 409，QR 还没产生回 503 |
| `POST /send` | 需要 | `{"to":"60123456789","body":"..."}` |
| `POST /reset-auth` | 需要 | `{"confirm":"i-mean-it"}`。会断线并需要重新扫码 |

secret 一律从 `X-Bridge-Secret` **标头**读。放在查询字串里不会被接受 ——
网址会留在浏览器纪录、proxy 日志和截图里。

## 环境变数

| 变数 | 必要 | 说明 |
|---|---|---|
| `WORKER_URL` | ✅ | 例如 `https://rasa-crm.appleautumn-hhl.workers.dev`，结尾不要斜线 |
| `WA_BRIDGE_SECRET` | ✅ | 跟 Worker 的同名 secret **必须一模一样** |
| `AUTH_DIR` | | 预设 `/data/auth`。Railway 的 Volume 要挂在 `/data` |
| `CF_ACCESS_CLIENT_ID` | | Access Service Token。线上少了它会被 Access 拦在门外 |
| `CF_ACCESS_CLIENT_SECRET` | | 同上 |
| `PORT` | | Railway 会自己给 |

调校用（有预设值，通常不用动）：`QUEUE_MAX` `DRAIN_BATCH`
`DRAIN_INTERVAL_MS` `RSS_SOFT_LIMIT_MB` `RSS_BACKOFF_FACTOR`

缺 `WORKER_URL` 或 `WA_BRIDGE_SECRET` 会**启动失败**，不会带着半残状态跑起来。

## Railway 设定

1. **New Project** → **Deploy from GitHub repo** → `appleautumn/RASAFOODHUB`
2. Service 的 **Settings → Root Directory** 填 **`bridge`**
   ⚠️ 一定要填。不填它会去建整个 repo（那是 Cloudflare Worker，不是这个）
3. **Settings → Volumes** → **New Volume**，Mount path 填 **`/data`**
   没有这颗磁碟，每次重启都要重新扫码
4. **Variables** 贴上 `WORKER_URL` 与 `WA_BRIDGE_SECRET`（以及两个 Access token）
5. **Settings → Networking → Generate Domain**，拿到对外网址

健康检查、重启策略、start command 都在 `railway.json` 里，不用手动设。

## 本机跑

```bash
cd bridge
npm install
cp .env.example .env      # 填 WORKER_URL 与 WA_BRIDGE_SECRET
AUTH_DIR=./.auth npm start
curl localhost:3000/health
```

`npm test` 是离线的，不连网路、不需要 WhatsApp 帐号。

## 刻意的设计，改动前先读

**不做历史回补。** `syncFullHistory` 明确设成 `false`，`messaging-history.set`
事件直接忽略。不是「先不做」—— 只要开着，平台会在装置第一次连结时推一大批
历史进来，小实例会被撑爆，而 OOM 重启要重新扫码。

**`messages.upsert` 的处理程序是同步的。** Baileys 给的物件很大（含解密后的
protobuf）。只要在处理程序里 `await` 任何东西，那些物件就会被闭包留住、回收
不掉。所以只抽栏位、丢佇列、立刻返回，推送交给 drain 迴圈慢慢做。

**时间戳原样往上传。** 型别不固定（数字 / 字串 / Long），判读规则写在 Worker
的 `toEpochSeconds` 一处。两边各写一套迟早不一致。

**推送失败会把整批放回队首重试。** Worker 那端靠 `platform_msg_id` 的 UNIQUE
挡重复，所以重送是安全的 —— 宁可重送，不要漏送。

**佇列满了丢最新那则，并记下 id。** 满了代表已经落后，没有好选择。丢新的至少
让被丢掉的 id 进日志与 `/health` 的 `dropped` 计数，事后查得到、补得回来；
无声的丢弃才是真正的失败。

**日志不记讯息内文。** 那是顾客资料，日志会被保存、会被贴出来。只记 id 与长度。
