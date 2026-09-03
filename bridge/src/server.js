/**
 * 桥接机的 HTTP 介面。
 *
 * /health          不验 secret —— Railway 的健康检查要打它，而且它不含任何机密
 * /qr              验 secret，回 PNG
 * /send            验 secret，Worker 呼叫它送讯息
 * /reset-auth      验 secret + 二次确认，会断线并要求重新扫码
 *
 * ⚠️ secret 一律从标头读，不从查询字串读。放在网址里会留在浏览器纪录、
 *    proxy 日志、以及任何人的截图里。
 */

import { createServer } from "node:http";
import QRCode from "qrcode";
import { secretMatches } from "./config.js";
import { log } from "./log.js";

const json = (res, status, body) => {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
};

async function readBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (total === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createBridgeServer({ config, wa, queue }) {
  const startedAt = Date.now();

  const authorized = (req) => secretMatches(req.headers["x-bridge-secret"], config.secret);

  const handler = async (req, res) => {
    const url = new URL(req.url, "http://bridge.local");
    const path = url.pathname;

    /* ---------------- /health：不验 secret ---------------- */
    if (path === "/health" && req.method === "GET") {
      const mem = process.memoryUsage();
      return json(res, 200, {
        ok: true,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        whatsapp: wa.status(),
        queue: queue.stats(),
        memory: {
          rssMb: Math.round(mem.rss / 1024 / 1024),
          heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
          rssSoftLimitMb: config.rssSoftLimitMb,
        },
      });
    }

    /* ---------------- 以下全部要 secret ---------------- */
    if (!authorized(req)) {
      // 不分「没带」与「带错」，避免回应本身变成探测工具
      return json(res, 401, { ok: false, error: "unauthorized" });
    }

    if (path === "/qr" && req.method === "GET") {
      const status = wa.status();
      if (status.connected) {
        return json(res, 409, { ok: false, error: "already_connected", phone: status.phone });
      }
      const qr = wa.qr();
      if (!qr) {
        return json(res, 503, { ok: false, error: "qr_not_ready", state: status.state });
      }
      const png = await QRCode.toBuffer(qr, { type: "png", width: 320, margin: 1 });
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": png.length,
        "cache-control": "no-store",
      });
      return res.end(png);
    }

    if (path === "/status" && req.method === "GET") {
      return json(res, 200, { ok: true, ...wa.status() });
    }

    if (path === "/send" && req.method === "POST") {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { ok: false, error: "bad_json" });
      }
      const to = String(body?.to || "").trim();
      const text = String(body?.body || "");
      if (!to) return json(res, 400, { ok: false, error: "to_required" });
      if (!text) return json(res, 400, { ok: false, error: "body_required" });

      try {
        const sent = await wa.send(to, text);
        // 只记 id 与长度，绝不记内文 —— 那是顾客资料
        log.info("sent", { id: sent.id, chars: text.length });
        return json(res, 200, { ok: true, ...sent });
      } catch (e) {
        return json(res, 503, { ok: false, error: "send_failed", detail: String(e.message || e) });
      }
    }

    if (path === "/reset-auth" && req.method === "POST") {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { ok: false, error: "bad_json" });
      }
      // 防呆：这个动作会断线并要求重新扫码，不能被误触
      if (body?.confirm !== "i-mean-it") {
        return json(res, 400, {
          ok: false,
          error: "confirmation_required",
          detail: '这会断线并需要重新扫码。确定的话送 {"confirm":"i-mean-it"}。',
        });
      }
      const status = await wa.resetAuth();
      return json(res, 200, { ok: true, reset: true, ...status });
    }

    return json(res, 404, { ok: false, error: "not_found" });
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((e) => {
      log.error("request_failed", { path: req.url, error: String(e.message || e) });
      if (!res.headersSent) json(res, 500, { ok: false, error: "internal" });
    });
  });

  return server;
}
