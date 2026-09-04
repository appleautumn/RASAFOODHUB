/**
 * 进讯佇列与推送迴圈。
 *
 * 为什么要有佇列：Baileys 的事件处理程序必须**同步**做完。它交给我们的
 * 物件很大（含解密后的原始 protobuf），只要我们在处理程序里 await 任何
 * 东西，那些物件就会被闭包留住、回收不掉。小实例的记忆体很快就满，
 * 而 OOM 重启在这个专案特别贵 —— 重启后要重新扫码。
 *
 * 所以处理程序只做一件事：抽出需要的几个栏位、丢进佇列、立刻返回。
 * 真正的推送由这里的 drain 迴圈慢慢做。
 */

import { log } from "./log.js";

const mb = (bytes) => Math.round(bytes / 1024 / 1024);

export function createQueue({
  config,
  fetchImpl = fetch,
  headers,
  rssBytes = () => process.memoryUsage.rss(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const items = [];
  const stats = { pushed: 0, sent: 0, failed: 0, dropped: 0, batches: 0, lastError: null };
  let running = false;
  let stopped = false;

  /**
   * 佇列满了怎么办：丢掉**最新**的那一则，并且大声记下它的 id。
   *
   * 没有好选择 —— 满了就代表已经落后。丢旧的会破坏对话顺序，丢新的会漏
   * 掉最近的讯息。选丢新的，因为被丢掉的那一则 id 会进日志与 /health 的
   * dropped 计数，事后能查、能补；无声的丢弃才是真正的失败。
   */
  function push(item) {
    if (items.length >= config.queueMax) {
      stats.dropped += 1;
      log.error("queue_overflow", {
        droppedId: item?.id ?? null,
        queueLength: items.length,
        totalDropped: stats.dropped,
      });
      return false;
    }
    items.push(item);
    stats.pushed += 1;
    return true;
  }

  async function flush(batch) {
    const res = await fetchImpl(`${config.workerUrl}/api/wa/webhook`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ messages: batch }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`worker ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json().catch(() => ({}));
  }

  async function drainOnce() {
    if (items.length === 0) return { sent: 0, waitMs: config.drainIntervalMs };

    const batch = items.splice(0, config.drainBatch);
    stats.batches += 1;

    try {
      await flush(batch);
      stats.sent += batch.length;
      stats.lastError = null;
    } catch (err) {
      stats.failed += batch.length;
      stats.lastError = String(err.message || err).slice(0, 300);
      // 推不出去就放回队首重试。Worker 那边靠 platform_msg_id 的 UNIQUE
      // 挡重复，所以重送是安全的 —— 宁可重送，不要漏送。
      items.unshift(...batch);
      log.warn("drain_failed", { queueLength: items.length, error: stats.lastError });
      return { sent: 0, waitMs: config.drainIntervalMs * config.rssBackoffFactor };
    }

    // 每批量一次 rss。超过软上限就把间隔拉长，让 GC 追上。
    // 慢一点没关系，OOM 才贵。
    const rss = rssBytes();
    const overSoftLimit = mb(rss) > config.rssSoftLimitMb;
    if (overSoftLimit) {
      log.warn("rss_over_soft_limit", {
        rssMb: mb(rss),
        softLimitMb: config.rssSoftLimitMb,
        queueLength: items.length,
      });
      if (global.gc) global.gc();
    }

    return {
      sent: batch.length,
      waitMs: overSoftLimit
        ? config.drainIntervalMs * config.rssBackoffFactor
        : config.drainIntervalMs,
    };
  }

  async function run() {
    if (running) return;
    running = true;
    while (!stopped) {
      const { waitMs } = await drainOnce();
      await sleep(waitMs);
    }
    running = false;
  }

  return {
    push,
    drainOnce,
    run,
    stop: () => {
      stopped = true;
    },
    get length() {
      return items.length;
    },
    stats: () => ({ ...stats, queueLength: items.length }),
  };
}
