import test from "node:test";
import assert from "node:assert/strict";
import { extractMessage } from "../src/wa.js";

const wrap = (over = {}) => ({
  key: { remoteJid: "60123456789@s.whatsapp.net", id: "MSG-1", fromMe: false, ...over.key },
  message: over.message ?? { conversation: "hello" },
  messageTimestamp: "messageTimestamp" in over ? over.messageTimestamp : 1712345678,
  pushName: over.pushName ?? "Ah Kit",
});

test("一般文字讯息抽得出该有的栏位", () => {
  assert.deepEqual(extractMessage(wrap()), {
    id: "MSG-1",
    from: "60123456789@s.whatsapp.net",
    fromMe: false,
    text: "hello",
    timestamp: 1712345678,
    pushName: "Ah Kit",
  });
});

test("群组讯息不收", () => {
  assert.equal(extractMessage(wrap({ key: { remoteJid: "123-456@g.us" } })), null);
});

test("没有 message id 就不收", () => {
  assert.equal(extractMessage(wrap({ key: { id: "" } })), null);
});

test("各种讯息型别的文字都抽得到", () => {
  const cases = [
    [{ conversation: "A" }, "A"],
    [{ extendedTextMessage: { text: "B" } }, "B"],
    [{ imageMessage: { caption: "C" } }, "C"],
    [{ videoMessage: { caption: "D" } }, "D"],
    [{ documentMessage: { caption: "E" } }, "E"],
  ];
  for (const [message, expected] of cases) {
    assert.equal(extractMessage(wrap({ message })).text, expected, JSON.stringify(message));
  }
});

test("没有文字的讯息照收，body 是空字串 —— 不能因为没文字就丢掉讯息", () => {
  const r = extractMessage(wrap({ message: { imageMessage: {} } }));
  assert.equal(r.text, "");
  assert.equal(r.id, "MSG-1");
});

test("timestamp 原样往下传，不在这里判读", () => {
  // 三种型别都要原封不动交给 Worker 的 toEpochSeconds，
  // 在两个地方各写一套判读规则，迟早会不一致
  for (const ts of [1712345678, "1712345678", { low: 1712345678, high: 0, unsigned: true }]) {
    assert.deepEqual(extractMessage(wrap({ messageTimestamp: ts })).timestamp, ts);
  }
});

test("timestamp 缺失时传 null，让 Worker 那端略过整则", () => {
  assert.equal(extractMessage(wrap({ messageTimestamp: undefined })).timestamp, null);
});

test("fromMe 会照实传", () => {
  assert.equal(extractMessage(wrap({ key: { fromMe: true } })).fromMe, true);
});
