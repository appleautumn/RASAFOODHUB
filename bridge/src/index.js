/**
 * 启动流程。
 *
 * 顺序是刻意的：先起 HTTP（Railway 的健康检查要马上有回应），再连 WhatsApp。
 * 反过来的话，第一次扫码前健康检查会一直失败，Railway 会不停重启这个服务。
 */

import { readConfig, workerHeaders } from "./config.js";
import { createQueue } from "./queue.js";
import { createSpool } from "./spool.js";
import { createWhatsApp, downloadMedia } from "./wa.js";
import { createBridgeServer } from "./server.js";
import { log } from "./log.js";

// 最早的一行。Railway 的日志偶尔会漏掉中间的输出，有这行就能分辨
// 「行程根本没起来」和「起来了但后面出事」。
log.info("boot", { node: process.version, pid: process.pid });

const config = readConfig();

// 佇列落地在持久磁碟上，重启才不会把已收到、还没送出的讯息弄丢
const spool = createSpool(config.spoolPath);
const queue = createQueue({
  config,
  headers: () => workerHeaders(config),
  spool,
  downloadMedia: (media) => downloadMedia(media, { maxBytes: config.mediaMaxBytes }),
});
const wa = createWhatsApp({ config, queue });
const server = createBridgeServer({ config, wa, queue });

// 绑定失败（埠被占用、权限不足）预设是静默的 —— 没有这个处理器，
// 服务看起来「还活着」但根本没在听，对外就是 502 而日志一片空白。
server.on("error", (err) => {
  log.error("listen_failed", { port: config.port, error: String(err.message || err) });
  process.exit(1);
});

server.listen(config.port, () => {
  // address() 是它「真正」绑到哪，不是我们「以为」的那个 ——
  // 平台的转发对不上时，这一行是唯一分得出差别的证据。
  log.info("listening", {
    port: config.port,
    address: JSON.stringify(server.address()),
    workerUrl: config.workerUrl,
    authDir: config.authDir,
    spoolPath: config.spoolPath,
    restoredFromSpool: queue.length,
    hasServiceToken: Boolean(config.accessClientId && config.accessClientSecret),
  });
});

queue.run().catch((e) => log.error("drain_loop_died", { error: String(e.message || e) }));

wa.start().catch((e) => log.error("wa_start_failed", { error: String(e.message || e) }));

// 没被接住的错误预设只会把行程打死、留下一段 node 自己的堆叠。
// 先记成结构化日志再退出，才查得到是哪里断的。
process.on("unhandledRejection", (reason) => {
  log.error("unhandled_rejection", { error: String(reason?.stack || reason).slice(0, 500) });
});
process.on("uncaughtException", (err) => {
  log.error("uncaught_exception", { error: String(err?.stack || err).slice(0, 500) });
  process.exit(1);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log.info("shutting_down", { signal: sig, queueLength: queue.length });
    queue.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  });
}
