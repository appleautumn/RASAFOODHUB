/**
 * 附件：抽描述、下载、送出。
 *
 * 这条路最容易出的错是「附件下载失败，整则讯息跟着没了」。
 * 讯息永远比附件重要 —— 下面几项就是在钉这件事。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { extractMessage, downloadMedia } from "../src/wa.js";
import { createQueue } from "../src/queue.js";

const key = (over = {}) => ({ remoteJid: "60123456789@s.whatsapp.net", id: "abc", fromMe: false, ...over });

const imageMessage = (over = {}) => ({
  url: "https://mmg.whatsapp.net/x",
  directPath: "/v/x",
  mediaKey: Buffer.from([1, 2, 3]),
  fileEncSha256: Buffer.from([4, 5]),
  fileSha256: Buffer.from([6, 7]),
  mediaKeyTimestamp: 1757462400,
  mimetype: "image/jpeg",
  fileLength: 12345,
  jpegThumbnail: Buffer.alloc(2048, 9),
  caption: "收据在这",
  ...over,
});

/* ------------------------------ 抽描述 ------------------------------ */

test("图片讯息抽得出附件描述，缩图不带走", () => {
  const m = extractMessage({ key: key(), message: { imageMessage: imageMessage() }, messageTimestamp: 1 });
  assert.equal(m.text, "收据在这");
  assert.equal(m.media.kind, "image");
  assert.equal(m.media.mimetype, "image/jpeg");
  assert.equal(m.media.fileLength, 12345);
  assert.equal("jpegThumbnail" in m.media, false, "缩图不该跟着进佇列");
});

test("二进位栏位存成 base64 字串 —— 佇列会落地成 JSON", () => {
  const m = extractMessage({ key: key(), message: { imageMessage: imageMessage() }, messageTimestamp: 1 });
  assert.equal(typeof m.media.mediaKey, "string");
  assert.deepEqual([...Buffer.from(m.media.mediaKey, "base64")], [1, 2, 3]);
  // 转成 JSON 再读回来，值要一模一样（这是重启接回来那条路）
  const round = JSON.parse(JSON.stringify(m.media));
  assert.deepEqual(round, m.media);
});

test("PDF 文件也收，包了一层 caption 的写法一样认得", () => {
  const doc = { ...imageMessage(), mimetype: "application/pdf", fileName: "receipt.pdf" };
  const a = extractMessage({ key: key(), message: { documentMessage: doc }, messageTimestamp: 1 });
  assert.equal(a.media.kind, "document");
  assert.equal(a.media.fileName, "receipt.pdf");

  const b = extractMessage({
    key: key({ id: "b" }),
    message: { documentWithCaptionMessage: { message: { documentMessage: { ...doc, caption: "单据" } } } },
    messageTimestamp: 1,
  });
  assert.equal(b.media.kind, "document");
  assert.equal(b.text, "单据");
});

test("纯文字讯息没有 media 栏位", () => {
  const m = extractMessage({ key: key(), message: { conversation: "hi" }, messageTimestamp: 1 });
  assert.equal("media" in m, false);
});

test("少了 url 或 mediaKey 就不当附件 —— 下载不回来的描述没有用", () => {
  const noUrl = extractMessage({ key: key(), message: { imageMessage: imageMessage({ url: "" }) }, messageTimestamp: 1 });
  assert.equal("media" in noUrl, false);
  const noKey = extractMessage({ key: key(), message: { imageMessage: imageMessage({ mediaKey: null }) }, messageTimestamp: 1 });
  assert.equal("media" in noKey, false);
});

/* ------------------------------- 下载 ------------------------------- */

const media = { kind: "image", mimetype: "image/jpeg", url: "u", directPath: "d", mediaKey: "AQID", fileEncSha256: "", fileSha256: "", mediaKeyTimestamp: 0 };

async function* chunks(...parts) {
  for (const p of parts) yield Buffer.from(p);
}

test("下载回来是 base64", async () => {
  const b64 = await downloadMedia(media, { maxBytes: 100, download: async () => chunks("he", "llo") });
  assert.equal(Buffer.from(b64, "base64").toString(), "hello");
});

test("base64 的 mediaKey 会还原成 Buffer 再交给 Baileys", async () => {
  let got = null;
  await downloadMedia(media, { maxBytes: 100, download: async (node) => { got = node; return chunks("x"); } });
  assert.ok(Buffer.isBuffer(got.mediaKey));
  assert.deepEqual([...got.mediaKey], [1, 2, 3]);
});

test("超过上限就中断，不会先整包收下来", async () => {
  let pulled = 0;
  async function* big() {
    while (true) { pulled += 1; yield Buffer.alloc(10); }
  }
  await assert.rejects(
    () => downloadMedia(media, { maxBytes: 25, download: async () => big() }),
    /上限/
  );
  assert.ok(pulled <= 4, `超过上限就该停，实际拉了 ${pulled} 块`);
});

/* ------------------------------ 佇列 ------------------------------ */

const config = {
  workerUrl: "https://worker.test", queueMax: 100, drainBatch: 20,
  drainIntervalMs: 1, rssSoftLimitMb: 9999, rssBackoffFactor: 2,
};

function makeQueue({ downloadMedia: dl, fail = false } = {}) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body).messages);
    if (fail) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ ok: true, results: [] }), {
      headers: { "content-type": "application/json" },
    });
  };
  const q = createQueue({ config, fetchImpl, headers: () => ({}), downloadMedia: dl });
  return { q, sent };
}

const withMedia = (id) => ({ id, from: "x", text: "", media: { kind: "image", mimetype: "image/jpeg" } });
const plain = (id) => ({ id, from: "x", text: "hi" });

test("带附件的讯息自己一则一送，不跟别人挤同一个请求", async () => {
  const { q, sent } = makeQueue({ downloadMedia: async () => "QkFTRTY0" });
  q.push(withMedia("a"));
  q.push(plain("b"));
  q.push(plain("c"));

  await q.drainOnce();
  assert.equal(sent[0].length, 1);
  assert.equal(sent[0][0].id, "a");
  assert.equal(sent[0][0].media.dataBase64, "QkFTRTY0");

  await q.drainOnce();
  assert.equal(sent[1].length, 2, "剩下的纯文字可以一起送");
});

test("纯文字批次会停在下一个附件之前", async () => {
  const { q, sent } = makeQueue({ downloadMedia: async () => "eA==" });
  q.push(plain("a"));
  q.push(plain("b"));
  q.push(withMedia("c"));
  await q.drainOnce();
  assert.deepEqual(sent[0].map((m) => m.id), ["a", "b"]);
});

test("下载失败：讯息照送，附件标成读不到", async () => {
  const { q, sent } = makeQueue({ downloadMedia: async () => { throw new Error("网路断了"); } });
  q.push(withMedia("a"));
  await q.drainOnce();

  assert.equal(sent[0][0].id, "a");
  assert.equal(sent[0][0].media, undefined);
  assert.match(sent[0][0].mediaSkipped, /网路断了/);
  assert.equal(q.stats().mediaFailed, 1);
});

test("没有下载器时不假装有附件", async () => {
  const { q, sent } = makeQueue();
  q.push(withMedia("a"));
  await q.drainOnce();
  assert.equal(sent[0][0].media, undefined);
  assert.equal(sent[0][0].mediaSkipped, "no_downloader");
});

test("送失败放回佇列的是精简的那份，不是几 MB 的 base64", async () => {
  const { q } = makeQueue({ downloadMedia: async () => "QkFTRTY0", fail: true });
  q.push(withMedia("a"));
  await q.drainOnce();

  assert.equal(q.length, 1);
  const spooled = [];
  const q2 = createQueue({
    config, fetchImpl: async () => new Response("{}"), headers: () => ({}),
    spool: { load: () => [], save: (items) => spooled.push(JSON.stringify(items)), enabled: true },
    downloadMedia: async () => "QkFTRTY0",
  });
  q2.push(withMedia("a"));
  await q2.drainOnce().catch(() => {});
  assert.equal(spooled.some((s) => s.includes("QkFTRTY0")), false, "base64 不该进磁碟");
});
