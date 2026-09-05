/**
 * 从「讯息进来」到「草稿产出」的整条路。
 *
 * 这条路上有三个地方会静静地出错，所以都要验：
 *   1. 顾客填回来的资料没进个案 —— 人以为收到了，其实没有
 *   2. 该转真人的却呼叫了 AI —— 顾客拿到一句敷衍的机器人回覆
 *   3. 没设 API key 却装作正常 —— 那才是最难查的一种
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTestDb, testEnv, seedUsers } from "./helpers/d1.mjs";
import { handleApi } from "../src/api.js";
import { ingestMessage } from "../src/whatsapp.js";
import { PLAYBOOK_KEY, DEFAULT_SCENARIOS } from "../src/playbook.js";

const USER = { email: "rasafoodhubplt@gmail.com", name: "Rasa Admin", role: "admin" };

function setup(overrides = {}) {
  const db = createTestDb();
  seedUsers(db, [{ email: USER.email, name: USER.name, role: "admin", is_active: 1 }]);
  return { db, env: testEnv(db, overrides) };
}

const one = (db, sql) => db.prepare(sql).first();

async function call(env, method, path, body) {
  const url = new URL(`https://crm.rasafoodhub.com${path}`);
  const request = new Request(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  const res = await handleApi(request, env, url, USER);
  let json = null;
  try { json = JSON.parse(await res.text()); } catch { /* 没有 body */ }
  return { status: res.status, body: json };
}

const msg = (over = {}) => ({
  id: `wamid-${Math.random().toString(36).slice(2)}`,
  from: "60123456789@s.whatsapp.net",
  fromMe: false,
  text: "",
  timestamp: 1757462400,
  pushName: "Ali",
  ...over,
});

/* --------------------- 讯息进来自动填个案 --------------------- */

test("顾客回填的表格会进个案栏位", async () => {
  const { db } = setup();
  const r = await ingestMessage(db, msg({
    text: "Name : Ali bin Ahmad\nLocation : Hospital Serdang\nID Machine : RFH012\nItem no : 23",
  }));
  assert.equal(r.status, "stored");
  assert.deepEqual(r.filled.sort(), ["itemNo", "locationName", "machineId", "name"]);

  const row = await one(db, `SELECT name, location_name, machine_id, item_no, updated_by FROM customers WHERE id = '${r.customerId}'`);
  assert.equal(row.name, "Ali bin Ahmad");
  assert.equal(row.location_name, "Hospital Serdang");
  assert.equal(row.machine_id, "RFH012");
  assert.equal(row.item_no, "23");
  assert.equal(row.updated_by, "system:whatsapp");
});

test("填过的栏位不会被后来的讯息盖掉", async () => {
  const { db } = setup();
  const first = await ingestMessage(db, msg({ text: "Name : Ali\nItem no : 23" }));
  await ingestMessage(db, msg({ text: "Name : Ahmad\nItem no : 99\nLocation : KLCC" }));

  const row = await one(db, `SELECT name, item_no, location_name FROM customers WHERE id = '${first.customerId}'`);
  assert.equal(row.name, "Ali", "已有的值不该被覆盖");
  assert.equal(row.item_no, "23");
  assert.equal(row.location_name, "KLCC", "空的栏位还是要补上");
});

test("我们自己发出去的表格范本不会被当成顾客填的", async () => {
  const { db } = setup();
  await ingestMessage(db, msg({ text: "hi", id: "seed-1" }));
  const r = await ingestMessage(db, msg({
    id: "outgoing-1",
    fromMe: true,
    text: "Name :\nLocation :\nID Machine :\nItem no :",
  }));
  assert.deepEqual(r.filled, []);
});

test("每一次自动填都留一条 note", async () => {
  const { db } = setup();
  const r = await ingestMessage(db, msg({ text: "ID Machine : A7" }));
  const note = await one(db, `SELECT body, author FROM notes WHERE customer_id = '${r.customerId}'`);
  assert.match(note.body, /machineId=A7/);
  assert.equal(note.author, "system:whatsapp");
});

test("读不到东西就不写、不留 note", async () => {
  const { db } = setup();
  const r = await ingestMessage(db, msg({ text: "tak keluar barang saya" }));
  assert.deepEqual(r.filled, []);
  const note = await one(db, `SELECT COUNT(*) AS n FROM notes WHERE customer_id = '${r.customerId}'`);
  assert.equal(note.n, 0);
});

/* ---------------------------- /api/triage ---------------------------- */

test("分诊回情境、缺项与摘要", async () => {
  const { env } = setup();
  const r = await call(env, "POST", "/api/triage", { text: "Name : Ali\nItem no : 3" });
  assert.equal(r.status, 200);
  assert.equal(r.body.scenario, "form_partial");
  assert.deepEqual(r.body.missing, ["Location", "ID Machine (screen left side)"]);
  assert.match(r.body.summary, /Name：Ali/);
  assert.equal(r.body.status.who, "customer");
});

test("分诊会把顾客现有资料算进去", async () => {
  const { db, env } = setup();
  const ing = await ingestMessage(db, msg({ text: "Name : Ali\nLocation : KLCC" }));
  const r = await call(env, "POST", "/api/triage", { text: "ID Machine : A1\nItem no : 3", customerId: ing.customerId });
  assert.deepEqual(r.body.missing, []);
  assert.equal(r.body.scenario, "form_complete_no_receipt");
});

test("分诊不会写任何东西", async () => {
  const { db, env } = setup();
  const ing = await ingestMessage(db, msg({ text: "hi" }));
  const before = (await one(db, `SELECT updated_at FROM customers WHERE id = '${ing.customerId}'`)).updated_at;
  await call(env, "POST", "/api/triage", { text: "ID Machine : ZZZ", customerId: ing.customerId });
  const after = await one(db, `SELECT updated_at, machine_id FROM customers WHERE id = '${ing.customerId}'`);
  assert.equal(after.updated_at, before);
  assert.equal(after.machine_id, "");
});

test("顾客不存在回 404", async () => {
  const { env } = setup();
  assert.equal((await call(env, "POST", "/api/triage", { text: "hi", customerId: "nope" })).status, 404);
});

/* --------------------------- /api/playbook --------------------------- */

test("没设定过就拿到整份预设剧本", async () => {
  const { env } = setup();
  const r = await call(env, "GET", "/api/playbook");
  assert.equal(r.body.source, "default");
  assert.equal(r.body.scenarios.length, DEFAULT_SCENARIOS.length);
});

test("改过的剧本读得回来，新的预设条目会补上", async () => {
  const { env } = setup();
  const mine = JSON.stringify({ scenarios: [{ id: "refund_demand", label: "我改过的", when: "x", reply: "y" }] });
  const put = await call(env, "PUT", `/api/settings/${PLAYBOOK_KEY}`, { value: mine });
  assert.equal(put.status, 200);

  const r = await call(env, "GET", "/api/playbook");
  assert.equal(r.body.source, "stored");
  assert.equal(r.body.scenarios[0].label, "我改过的");
  assert.ok(r.body.addedFromDefaults.includes("greeting_only"));
});

/* --------------------------- /api/ai/draft --------------------------- */

function stubAi(reply) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ content: [{ type: "text", text: reply }] }), {
      headers: { "content-type": "application/json" },
    });
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}

test("没设 ANTHROPIC_API_KEY 就回 503，不是假装正常", async () => {
  const { env } = setup();
  const r = await call(env, "POST", "/api/ai/draft", { text: "dah bayar tapi tak keluar" });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, "ai_not_configured");
});

test("产草稿：剧本与个案摘要都进了 system prompt", async () => {
  const { db, env } = setup({ ANTHROPIC_API_KEY: "sk-test" });
  const ing = await ingestMessage(db, msg({ text: "Name : Ali\nLocation : KLCC" }));
  const ai = stubAi("Boleh, saya check dulu ya 🙏");
  try {
    const r = await call(env, "POST", "/api/ai/draft", { text: "ID Machine : A1", customerId: ing.customerId });
    assert.equal(r.status, 200);
    assert.equal(r.body.draft, "Boleh, saya check dulu ya 🙏");
    assert.equal(r.body.scenario, "form_partial");
    assert.deepEqual(r.body.missing, ["Item no"]);

    const sent = ai.seen[0];
    assert.equal(sent.url, "https://api.anthropic.com/v1/messages");
    assert.equal(sent.init.headers["x-api-key"], "sk-test");
    assert.match(sent.body.system, /form_partial/);
    assert.match(sent.body.system, /Name：Ali/);
    assert.equal(sent.body.messages[0].content, "ID Machine : A1");
  } finally {
    ai.restore();
  }
});

test("该转真人的连问都不问模型", async () => {
  const { env } = setup({ ANTHROPIC_API_KEY: "sk-test" });
  const ai = stubAi("不该被叫到");
  try {
    const r = await call(env, "POST", "/api/ai/draft", { text: "saya nak refund" });
    assert.equal(r.body.escalate, true);
    assert.equal(r.body.scenario, "refund_demand");
    assert.equal(r.body.draft, "");
    assert.equal(ai.seen.length, 0, "转真人的情况不该呼叫 AI");
  } finally {
    ai.restore();
  }
});

test("产草稿不会送出、也不会改个案", async () => {
  const { db, env } = setup({ ANTHROPIC_API_KEY: "sk-test" });
  const ing = await ingestMessage(db, msg({ text: "hi" }));
  const before = (await one(db, `SELECT updated_at FROM customers WHERE id = '${ing.customerId}'`)).updated_at;
  const ai = stubAi("草稿");
  try {
    await call(env, "POST", "/api/ai/draft", { text: "ID Machine : QQQ", customerId: ing.customerId });
  } finally {
    ai.restore();
  }
  const after = await one(db, `SELECT updated_at, machine_id FROM customers WHERE id = '${ing.customerId}'`);
  assert.equal(after.updated_at, before);
  assert.equal(after.machine_id, "");
  const out = await one(db, "SELECT COUNT(*) AS n FROM messages WHERE direction = 'out'");
  assert.equal(out.n, 0, "产草稿不该产生任何送出的讯息");
});

test("空讯息不呼叫 AI", async () => {
  const { env } = setup({ ANTHROPIC_API_KEY: "sk-test" });
  const r = await call(env, "POST", "/api/ai/draft", { text: "   " });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "empty_text");
});

test("模型那边坏掉，错误照实回，不会变成一句空草稿", async () => {
  const { env } = setup({ ANTHROPIC_API_KEY: "sk-test" });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("upstream boom", { status: 500 });
  try {
    const r = await call(env, "POST", "/api/ai/draft", { text: "dah bayar tapi tak keluar" });
    assert.equal(r.status, 502);
    assert.equal(r.body.error, "ai_error");
    assert.match(r.body.detail, /500/);
  } finally {
    globalThis.fetch = original;
  }
});
