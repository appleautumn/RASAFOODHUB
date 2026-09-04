/**
 * 启动流程。
 *
 * 顺序是刻意的：先起 HTTP（Railway 的健康检查要马上有回应），再连 WhatsApp。
 * 反过来的话，第一次扫码前健康检查会一直失败，Railway 会不停重启这个服务。
 */

import { readConfig, workerHeaders } from "./config.js";
import { createQueue } from "./queue.js";
import { createWhatsApp } from "./wa.js";
import { createBridgeServer } from "./server.js";
import { log } from "./log.js";

const config = readConfig();

const queue = createQueue({ config, headers: () => workerHeaders(config) });
const wa = createWhatsApp({ config, queue });
const server = createBridgeServer({ config, wa, queue });

server.listen(config.port, () => {
  log.info("listening", {
    port: config.port,
    workerUrl: config.workerUrl,
    authDir: config.authDir,
    hasServiceToken: Boolean(config.accessClientId && config.accessClientSecret),
  });
});

queue.run().catch((e) => log.error("drain_loop_died", { error: String(e.message || e) }));

wa.start().catch((e) => log.error("wa_start_failed", { error: String(e.message || e) }));

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log.info("shutting_down", { signal: sig, queueLength: queue.length });
    queue.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  });
}
