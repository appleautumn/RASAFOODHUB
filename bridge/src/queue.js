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
  // 落地存放。预设是个什么都不做的替身，测试不必碰磁碟。
  spool = { load: () => [], save: () => {}, enabled: false },
}) {
  // 开机先把上次没送完的接回来，再接受新的
  const items = spool.load();
  const stats = {
    pushed: 0, sent: 0, failed: 0, dropped: 0, batches: 0, lastError: null,
    // Worker 收下了、但自己判定不收录的则数（时间戳判读不出、JID 不合法…）。
    // 这些重送也没用，所以不放回佇列 —— 但绝不能无声无息，否则又是一次
    // 「显示成功、资料没进去」。
    skippedByWorker: 0,
    lastWorkerReply: null,
  };
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
    spool.save(items);
    return true;
  }

  /**
   * 把一批讯息推给 Worker。
   *
   * ⚠️ 这里对「成功」的认定要严格，原因是踩过一次：
   *
   * Cloudflare Access 挡在 Worker 前面。没带 Service Token 的请求会收到
   * 302，转去 Access 的登入页。而 fetch 预设会跟随转址，且 302 会把 POST
   * 降级成 GET —— 拿回来的是一个「200 OK 的 HTML 登入页」。只看 res.ok
   * 的话，这会被当成送达成功，讯息就此消失，而且不留任何错误。
   *
   * 所以：不跟随转址，3xx 一律是失败；而且回应必须是 Worker 那份 JSON，
   * 拿到 HTML 就代表被中间层拦截了。宁可重送，不要漏送。
   */
  async function flush(batch) {
    const res = await fetchImpl(`${config.workerUrl}/api/wa/webhook`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ messages: batch }),
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      throw new Error(
        `worker ${res.status} 转址：请求没有到达 Worker，多半是被 Cloudflare Access 挡下 ` +
          `（CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET 没设，或 Access 那边还没加 Service Auth 政策）`
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`worker ${res.status}: ${text.slice(0, 200)}`);
    }

    // 到这里状态码是 2xx，但内容仍可能是别人回的。Worker 成功时一定回 JSON。
    const type = res.headers.get("content-type") || "";
    if (!type.includes("json")) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `worker 回了非 JSON（content-type: ${type || "无"}）：这不是 Worker 的回应，` +
          `请求被中途拦截了。开头：${text.slice(0, 120)}`
      );
    }

    const body = await res.json().catch(() => null);
    if (!body || body.ok !== true) {
      throw new Error(`worker 回应不是 ok:true：${JSON.stringify(body).slice(0, 200)}`);
    }
    return body;
  }

  async function drainOnce() {
    if (items.length === 0) return { sent: 0, waitMs: config.drainIntervalMs };

    const batch = items.splice(0, config.drainBatch);
    stats.batches += 1;

    try {
      const reply = await flush(batch);
      stats.sent += batch.length;
      stats.lastError = null;

      // Worker 回的是逐则结果。ok:true 只代表「请求有到、有处理」，
      // 不代表每一则都收录了 —— 这两件事上次就是混在一起才掉了讯息。
      stats.lastWorkerReply = {
        at: new Date().toISOString(),
        received: reply.received ?? null,
        stored: reply.stored ?? null,
        duplicate: reply.duplicate ?? null,
        skipped: reply.skipped ?? null,
      };

      // 这批已经确定进 Worker 了，从磁碟上拿掉，重启才不会重送一次。
      // （重送本身是安全的，但没必要。）
      spool.save(items);

      const skipped = (reply.results || []).filter((r) => r.status === "skipped");
      if (skipped.length) {
        stats.skippedByWorker += skipped.length;
        log.error("worker_skipped_messages", {
          count: skipped.length,
          // 逐则的原因，这是判断「为什么没进 D1」唯一有用的东西
          reasons: skipped.map((r) => `${r.id}:${r.reason}`).slice(0, 10),
        });
      }
    } catch (err) {
      stats.failed += batch.length;
      stats.lastError = String(err.message || err).slice(0, 300);
      // 推不出去就放回队首重试。Worker 那边靠 platform_msg_id 的 UNIQUE
      // 挡重复，所以重送是安全的 —— 宁可重送，不要漏送。
      items.unshift(...batch);
      spool.save(items);
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
    stats: () => ({ ...stats, queueLength: items.length, spooled: spool.enabled }),
  };
}
