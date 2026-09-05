/**
 * 设定与启动前检查。
 *
 * 缺了必要设定就在启动时直接失败，不要带着半残的状态跑起来 ——
 * 那会变成「服务看起来活着，但讯息默默流不到 Worker」，最难查的那种。
 */

import { createHash, timingSafeEqual } from "node:crypto";

const required = ["WORKER_URL", "WA_BRIDGE_SECRET"];

function readConfig(envSource = process.env) {
  const missing = required.filter((k) => !String(envSource[k] || "").trim());
  if (missing.length) {
    throw new Error(
      `缺少必要的环境变数：${missing.join(", ")}。\n` +
        `Railway 的 service → Variables 里补上，或本机复制 .env.example 成 .env。`
    );
  }

  return {
    port: Number(envSource.PORT || 3000),
    // 结尾斜线会让 workerUrl + "/api/..." 变成双斜线
    workerUrl: String(envSource.WORKER_URL).trim().replace(/\/+$/, ""),
    secret: String(envSource.WA_BRIDGE_SECRET).trim(),
    authDir: String(envSource.AUTH_DIR || "/data/auth").trim(),
    // 佇列落地的位置。跟 auth 放同一颗持久磁碟，重启才接得回来。
    // 刻意放在 authDir 的**同层**而不是里面 —— reset-auth 会删掉整个
    // auth 目录，佇列不该跟着被删。
    spoolPath: String(envSource.SPOOL_PATH || "/data/queue.jsonl").trim(),

    // Cloudflare Access Service Token。没设也能启动 —— 本机测试时 Worker
    // 可能没挡 Access。但线上少了它，所有请求都会被 Access 拦在门外。
    accessClientId: String(envSource.CF_ACCESS_CLIENT_ID || "").trim(),
    accessClientSecret: String(envSource.CF_ACCESS_CLIENT_SECRET || "").trim(),

    // 佇列与推送节奏。数字保守取值：宁可慢，OOM 才贵。
    queueMax: Number(envSource.QUEUE_MAX || 5000),
    drainBatch: Number(envSource.DRAIN_BATCH || 20),
    drainIntervalMs: Number(envSource.DRAIN_INTERVAL_MS || 500),
    // rss 超过这个数字就把推送间隔拉长，让 GC 追得上
    rssSoftLimitMb: Number(envSource.RSS_SOFT_LIMIT_MB || 320),
    rssBackoffFactor: Number(envSource.RSS_BACKOFF_FACTOR || 6),

    // 附件上限。收据截图通常几百 KB；超过这个就不下载，讯息照送。
    // 抓 2 MB 是因为 base64 会再胖三分之一，加上 JSON 之后还要塞得进
    // 一个 Worker 请求 —— 上限订在这里，比在下游发现 body 太大好查。
    mediaMaxBytes: Number(envSource.MEDIA_MAX_BYTES || 2 * 1024 * 1024),
  };
}

export { readConfig };

/**
 * 共用 secret 比对。
 *
 * 两边都先 SHA-256 再比，比的是等长的摘要，用 timingSafeEqual ——
 * 不直接比明文，也不让比较时间泄漏任何东西。
 */
export function secretMatches(presented, configured) {
  if (!presented || !configured) return false;
  const a = createHash("sha256").update(String(presented)).digest();
  const b = createHash("sha256").update(String(configured)).digest();
  return timingSafeEqual(a, b);
}

/** 打进 Worker 的标头：共用 secret + Access Service Token */
export function workerHeaders(config) {
  const headers = {
    "content-type": "application/json",
    "X-Bridge-Secret": config.secret,
  };
  if (config.accessClientId && config.accessClientSecret) {
    headers["CF-Access-Client-Id"] = config.accessClientId;
    headers["CF-Access-Client-Secret"] = config.accessClientSecret;
  }
  return headers;
}
