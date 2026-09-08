/**
 * Baileys 连线。
 *
 * 三件事是刻意的，改动前先想清楚：
 *
 * 1. syncFullHistory 明确设成 false，且 messaging-history.set 直接忽略。
 *    这个专案不做历史回补。不是「先不做」—— 只要开着，平台会在装置第一次
 *    连结时推一大批历史进来，小实例会被撑爆，而 OOM 重启要重新扫码。
 *
 * 2. messages.upsert 的处理程序**保持同步**。Baileys 交给我们的物件很大
 *    （含解密后的 protobuf）。只要在处理程序里 await，那些物件就会被闭包
 *    留住、回收不掉。所以只抽栏位、丢佇列、立刻返回。
 *
 * 3. 515 restartRequired 不是错误。首次配对完一定会收到，要立刻重连。
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  Browsers,
  downloadContentFromMessage,
} from "@whiskeysockets/baileys";
import { rm, mkdir } from "node:fs/promises";
import { log } from "./log.js";

/**
 * 附件描述。
 *
 * **不在这里下载**。下载要 await，而事件处理程序必须同步做完（见档头第 2 点）。
 * 这里只抽出「等一下要怎么把它下载回来」需要的那几个小栏位，真正下载在
 * queue 推送前才做。
 *
 * 三个二进位栏位转成 base64 字串，因为佇列会落地成 JSON —— 直接放
 * Uint8Array 的话，重启读回来会变成 {"0":1,"1":2,…}，解密就失败了。
 */
function mediaDescriptor(content) {
  // documentWithCaptionMessage 是包了一层的文件讯息，先拆开
  const inner = content?.documentWithCaptionMessage?.message || content;

  const node = inner?.imageMessage
    ? { node: inner.imageMessage, kind: "image" }
    : inner?.documentMessage
      ? { node: inner.documentMessage, kind: "document" }
      : null;

  if (!node || !node.node?.url || !node.node?.mediaKey) return null;

  const b64 = (v) => (v ? Buffer.from(v).toString("base64") : "");
  const m = node.node;

  return {
    kind: node.kind,
    mimetype: String(m.mimetype || ""),
    fileName: String(m.fileName || ""),
    // Long 或 number 都可能，转成数字给上限判断用；转不出来给 0（不设限）
    fileLength: Number(m.fileLength?.toNumber?.() ?? m.fileLength ?? 0) || 0,
    url: String(m.url || ""),
    directPath: String(m.directPath || ""),
    mediaKey: b64(m.mediaKey),
    fileEncSha256: b64(m.fileEncSha256),
    fileSha256: b64(m.fileSha256),
    mediaKeyTimestamp: Number(m.mediaKeyTimestamp?.toNumber?.() ?? m.mediaKeyTimestamp ?? 0) || 0,
  };
}

/** 从 Baileys 的讯息物件抽出我们要的那几个栏位。纯函式，好测。 */
export function extractMessage(m) {
  const key = m?.key || {};
  const jid = String(key.remoteJid || "");

  // 群组讯息先不处理 —— 这个 CRM 是一对一售后，群组进来只会变噪音
  if (jid.endsWith("@g.us")) return null;

  const id = String(key.id || "");
  if (!id) return null;

  const content = m?.message || {};
  const inner = content.documentWithCaptionMessage?.message || content;
  const text =
    content.conversation ??
    content.extendedTextMessage?.text ??
    inner.imageMessage?.caption ??
    inner.videoMessage?.caption ??
    inner.documentMessage?.caption ??
    "";

  const media = mediaDescriptor(content);

  return {
    id,
    from: jid,
    fromMe: Boolean(key.fromMe),
    text: String(text || ""),
    // 原样往下传。型别不固定（数字 / 字串 / Long），判读是 Worker 那端
    // toEpochSeconds 的工作，这里不要自己转 —— 转错了两边规则会不一致。
    timestamp: m?.messageTimestamp ?? null,
    pushName: String(m?.pushName || ""),
    ...(media ? { media } : {}),
  };
}

/**
 * 把附件下载回来，转成 base64。
 *
 * 边下边数，超过上限就中断 —— 不要先整包收下来再检查大小，那样上限就
 * 只是个装饰，记忆体已经吃下去了。
 */
export async function downloadMedia(media, { maxBytes, download = downloadContentFromMessage } = {}) {
  const buf = (b64) => (b64 ? Buffer.from(b64, "base64") : undefined);
  const node = {
    url: media.url,
    directPath: media.directPath,
    mediaKey: buf(media.mediaKey),
    fileEncSha256: buf(media.fileEncSha256),
    fileSha256: buf(media.fileSha256),
    mediaKeyTimestamp: media.mediaKeyTimestamp || undefined,
    mimetype: media.mimetype,
  };

  const stream = await download(node, media.kind);
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`附件超过 ${maxBytes} bytes 上限`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("base64");
}

export function createWhatsApp({ config, queue }) {
  let sock = null;
  let state = "starting"; // starting | waiting_qr | connecting | connected | logged_out
  let currentQr = null;
  let phone = null;
  let lastError = null;
  let reconnectTimer = null;
  let closing = false;

  const status = () => ({
    state,
    connected: state === "connected",
    phone,
    hasQr: Boolean(currentQr),
    lastError,
  });

  async function start() {
    closing = false;
    await mkdir(config.authDir, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(config.authDir);

    sock = makeWASocket({
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys),
      },
      // QR 由 /qr 端点出图，不印在终端机
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome"),
      // ⚠️ 不要改成 true。见档头第 1 点。
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on("creds.update", saveCreds);

    // 历史同步事件直接丢掉，一个栏位都不看。
    sock.ev.on("messaging-history.set", () => {
      log.info("history_ignored", { reason: "本专案不做历史回补" });
    });

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQr = qr;
        state = "waiting_qr";
        log.info("qr_ready", {});
      }

      if (connection === "open") {
        currentQr = null;
        state = "connected";
        lastError = null;
        phone = String(sock?.user?.id || "").split(":")[0] || null;
        log.info("connected", { phone });
      }

      if (connection === "connecting" && state !== "waiting_qr") state = "connecting";

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        currentQr = null;

        if (code === DisconnectReason.loggedOut) {
          // 登入状态已经作废，留着只会一直失败。清掉并等重新扫码。
          state = "logged_out";
          lastError = "已被登出，需要重新扫码";
          log.warn("logged_out", {});
          rm(config.authDir, { recursive: true, force: true })
            .then(() => scheduleReconnect(2000))
            .catch((e) => log.error("auth_clear_failed", { error: String(e.message || e) }));
          return;
        }

        // 515 是首次配对后的正常流程，不是故障
        const expected = code === DisconnectReason.restartRequired;
        state = "connecting";
        lastError = expected ? null : `连线中断（code ${code ?? "?"}）`;
        log[expected ? "info" : "warn"]("disconnected", { code: code ?? null, expected });
        scheduleReconnect(expected ? 0 : 3000);
      }
    });

    // ⚠️ 同步。不要在这里 await 任何东西。见档头第 2 点。
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      // notify = 即时进讯。append 多半是自己送出后的回填，也一起收。
      if (type !== "notify" && type !== "append") return;
      for (const m of messages || []) {
        const compact = extractMessage(m);
        if (compact) queue.push(compact);
      }
    });

    return sock;
  }

  function scheduleReconnect(delayMs) {
    if (closing) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      start().catch((e) => {
        lastError = String(e.message || e);
        log.error("reconnect_failed", { error: lastError });
        scheduleReconnect(5000);
      });
    }, delayMs);
  }

  return {
    start,
    status,
    /** 目前的 QR 字串，没有就回 null（已连线时一定是 null） */
    qr: () => currentQr,

    async send(to, body) {
      if (state !== "connected") throw new Error(`还没连线（目前 ${state}）`);
      const jid = String(to).includes("@") ? String(to) : `${String(to).replace(/\D+/g, "")}@s.whatsapp.net`;
      const res = await sock.sendMessage(jid, { text: String(body) });
      return { id: res?.key?.id || null, jid };
    },

    /**
     * 清掉登入状态并重连 —— 会断线、要重新扫码。
     * 呼叫端一定要先做二次确认，这里不做防呆判断。
     */
    async resetAuth() {
      log.warn("reset_auth", {});
      closing = true;
      clearTimeout(reconnectTimer);
      try {
        sock?.end?.(new Error("reset-auth"));
      } catch {
        /* 已经断了就算了 */
      }
      await rm(config.authDir, { recursive: true, force: true });
      currentQr = null;
      phone = null;
      state = "starting";
      await start();
      return status();
    },
  };
}
