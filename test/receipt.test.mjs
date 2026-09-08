/**
 * 读收据。
 *
 * 这里最重要的一组断言是「读不出来不要猜」—— 猜出来的日期会拿去跟
 * FINEXUS 对帐，对不上的时候没有人会知道那个值是猜的。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readReceipt } from "../src/receipt.js";
import { createTestDb, testEnv, seedUsers } from "./helpers/d1.mjs";
import { ingestMessage } from "../src/whatsapp.js";

const B64 = "aGVsbG8="; // 内容无所谓，这些测试不会真的送出去

function fakeAi(payload, { status = 200 } = {}) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init, body: JSON.parse(init.body) });
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    if (status !== 200) return new Response(text, { status });
    return new Response(
      JSON.stringify({ content: [{ type: "text", text }] }),
      { headers: { "content-type": "application/json" } }
    );
  };
  return { seen, fetchImpl };
}

const env = { ANTHROPIC_API_KEY: "sk-test" };

/* ----------------------------- 送出去的形状 ----------------------------- */

test("图片走 image block，PDF 走 document block", async () => {
  const img = fakeAi({ readable: true, payment_type: "qr", date: "2025-09-12", time: "14:30", amount: "5.50" });
  await readReceipt(env, { mimetype: "image/jpeg", dataBase64: B64, fetchImpl: img.fetchImpl });
  const imgBlock = img.seen[0].body.messages[0].content[0];
  assert.equal(imgBlock.type, "image");
  assert.equal(imgBlock.source.media_type, "image/jpeg");
  assert.equal(imgBlock.source.data, B64);

  const pdf = fakeAi({ readable: true, amount: "5.50" });
  await readReceipt(env, { mimetype: "application/pdf", dataBase64: B64, fetchImpl: pdf.fetchImpl });
  const pdfBlock = pdf.seen[0].body.messages[0].content[0];
  assert.equal(pdfBlock.type, "document");
  assert.equal(pdfBlock.source.media_type, "application/pdf");
});

test("mimetype 带 charset 也认得", async () => {
  const ai = fakeAi({ readable: true, amount: "1.00" });
  const r = await readReceipt(env, { mimetype: "image/png; charset=binary", dataBase64: B64, fetchImpl: ai.fetchImpl });
  assert.equal(r.ok, true);
});

test("不认得的格式不送出去，省一次呼叫", async () => {
  const ai = fakeAi({ readable: true });
  const r = await readReceipt(env, { mimetype: "audio/ogg", dataBase64: B64, fetchImpl: ai.fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.error, "unsupported_media");
  assert.equal(ai.seen.length, 0);
});

test("没设 API key 就不呼叫", async () => {
  const ai = fakeAi({ readable: true });
  const r = await readReceipt({}, { mimetype: "image/jpeg", dataBase64: B64, fetchImpl: ai.fetchImpl });
  assert.equal(r.status, 503);
  assert.equal(ai.seen.length, 0);
});

/* ------------------------------- 读回来的值 ------------------------------- */

test("四项都读到，格式正规化", async () => {
  const ai = fakeAi({ readable: true, payment_type: "QR", date: "2025-09-12", time: "9:05", amount: "RM 5.5" });
  const r = await readReceipt(env, { mimetype: "image/jpeg", dataBase64: B64, fetchImpl: ai.fetchImpl });
  assert.deepEqual(r.fields, {
    paymentType: "qr", receiptDate: "2025-09-12", receiptTime: "09:05", receiptAmount: "5.50",
  });
});

test("模型包了 ```json 也解得开", async () => {
  const ai = fakeAi('```json\n{"readable": true, "amount": "4.20"}\n```');
  const r = await readReceipt(env, { mimetype: "image/jpeg", dataBase64: B64, fetchImpl: ai.fetchImpl });
  assert.equal(r.fields.receiptAmount, "4.20");
});

test("读不清楚就是读不清楚，不给任何栏位", async () => {
  const ai = fakeAi({ readable: false, reason: "太暗了看不到金额", date: "2025-09-12" });
  const r = await readReceipt(env, { mimetype: "image/jpeg", dataBase64: B64, fetchImpl: ai.fetchImpl });
  assert.equal(r.readable, false);
  assert.match(r.reason, /太暗/);
  assert.deepEqual(r.fields, {});
});

test("格式不对的值一律丢掉，不勉强收下", async () => {
  const ai = fakeAi({
    readable: true, payment_type: "touch n go", date: "12/09/2025", time: "25:99", amount: "0",
  });
  const r = await readReceipt(env, { mimetype: "image/jpeg", dataBase64: B64, fetchImpl: ai.fetchImpl });
  assert.deepEqual(r.fields, {}, "宁可空着让人补，也不要写一个错的进去");
});

test("模型回了不是 JSON 的东西，当作失败", async () => {
  const ai = fakeAi("我看不懂这张图片");
  const r = await readReceipt(env, { mimetype: "image/jpeg", dataBase64: B64, fetchImpl: ai.fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.error, "ai_unparsable");
});

test("上游出错照实回报", async () => {
  const ai = fakeAi("boom", { status: 500 });
  const r = await readReceipt(env, { mimetype: "image/jpeg", dataBase64: B64, fetchImpl: ai.fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.error, "ai_error");
});

/* --------------------------- 收讯路径整条走一次 --------------------------- */

const msg = (over = {}) => ({
  id: `wamid-${Math.random().toString(36).slice(2)}`,
  from: "60123456789@s.whatsapp.net",
  fromMe: false,
  text: "",
  timestamp: 1757462400,
  pushName: "Ali",
  ...over,
});

function setup(overrides = {}) {
  const db = createTestDb();
  seedUsers(db, [{ email: "a@b.com", name: "A", role: "admin", is_active: 1 }]);
  return { db, env: testEnv(db, overrides) };
}

const one = (db, sql) => db.prepare(sql).first();

function stubGlobalAi(payload) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(String(url));
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(payload) }] }),
      { headers: { "content-type": "application/json" } }
    );
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

test("收据进来，读出来的值写进个案，图片不留", async () => {
  const { db, env } = setup({ ANTHROPIC_API_KEY: "sk-test" });
  const ai = stubGlobalAi({ readable: true, payment_type: "card", date: "2025-09-12", time: "14:30", amount: "5.50" });
  let r;
  try {
    r = await ingestMessage(db, msg({ media: { kind: "image", mimetype: "image/jpeg", dataBase64: B64 } }), env);
  } finally {
    ai.restore();
  }

  assert.equal(r.receipt.readable, true);
  const row = await one(db, `SELECT payment_type, receipt_date, receipt_time, receipt_amount FROM customers WHERE id = '${r.customerId}'`);
  assert.equal(row.payment_type, "card");
  assert.equal(row.receipt_date, "2025-09-12");
  assert.equal(row.receipt_time, "14:30");
  assert.equal(row.receipt_amount, "5.50");

  // 图片本身哪里都不该出现
  const stored = await one(db, `SELECT body FROM messages WHERE customer_id = '${r.customerId}'`);
  assert.equal(stored.body.includes(B64), false);
  const note = await one(db, `SELECT body FROM notes WHERE customer_id = '${r.customerId}'`);
  assert.equal(note.body.includes(B64), false);
  assert.match(note.body, /系统从收据读到/);
});

test("没设 API key 时收讯照常，只留一条 note", async () => {
  const { db, env } = setup();
  const r = await ingestMessage(db, msg({ media: { kind: "image", mimetype: "image/jpeg", dataBase64: B64 } }), env);
  assert.equal(r.status, "stored", "读不成收据不该让讯息掉了");
  assert.equal(r.receipt.ok, false);
  const note = await one(db, `SELECT body FROM notes WHERE customer_id = '${r.customerId}'`);
  assert.match(note.body, /要人自己看/);
});

test("已经有值的收据栏位不会被模型读到的值盖掉", async () => {
  const { db, env } = setup({ ANTHROPIC_API_KEY: "sk-test" });
  const first = await ingestMessage(db, msg({ id: "m1", text: "Amount : 9.90" }));
  assert.equal((await one(db, `SELECT receipt_amount FROM customers WHERE id = '${first.customerId}'`)).receipt_amount, "9.90");

  const ai = stubGlobalAi({ readable: true, amount: "5.50", date: "2025-09-12" });
  try {
    await ingestMessage(db, msg({ id: "m2", media: { kind: "image", mimetype: "image/jpeg", dataBase64: B64 } }), env);
  } finally {
    ai.restore();
  }

  const row = await one(db, `SELECT receipt_amount, receipt_date FROM customers WHERE id = '${first.customerId}'`);
  assert.equal(row.receipt_amount, "9.90", "已有的值不该被覆盖");
  assert.equal(row.receipt_date, "2025-09-12", "空的还是要补上");

  const notes = db.prepare(`SELECT body FROM notes WHERE customer_id = ? ORDER BY seq`).bind(first.customerId);
  const all = (await notes.all()).results.map((n) => n.body).join("\n");
  assert.match(all, /receiptAmount=5\.50（未覆盖）/, "模型读到但没写进去的值，note 要标出来");
});

test("我们自己发出去的图片不会被读", async () => {
  const { db, env } = setup({ ANTHROPIC_API_KEY: "sk-test" });
  await ingestMessage(db, msg({ id: "seed", text: "hi" }));
  const ai = stubGlobalAi({ readable: true, amount: "5.50" });
  let r;
  try {
    r = await ingestMessage(db, msg({ id: "out", fromMe: true, media: { kind: "image", mimetype: "image/jpeg", dataBase64: B64 } }), env);
  } finally {
    ai.restore();
  }
  assert.equal(r.receipt, undefined);
  assert.equal(ai.seen.length, 0);
});

test("附件太大没下载成，讯息照收，原因留着", async () => {
  const { db, env } = setup({ ANTHROPIC_API_KEY: "sk-test" });
  const r = await ingestMessage(db, msg({ text: "收据在这", mediaSkipped: "附件超过 2097152 bytes 上限" }), env);
  assert.equal(r.status, "stored");
  assert.match(r.mediaSkipped, /上限/);
});
