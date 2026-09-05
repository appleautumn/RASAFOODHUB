/**
 * 机器清单与比对。
 *
 * 比对这件事的两个方向代价差很多：
 *   - 多问一句「你是说 X 吗」= 顾客多打两个字
 *   - 自动填错一台机 = 拿错的机号去 FINEXUS 对帐，对不上，重问，
 *     而那时候顾客已经不在机器旁边了
 * 所以下面的门槛刻意偏保守，「拿不准就问」是设计，不是缺陷。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { matchMachine, parseMachineList, normalize } from "../src/machines.js";
import { createTestDb, testEnv, seedUsers } from "./helpers/d1.mjs";
import { handleApi } from "../src/api.js";

const M = (machineId, locationName, over = {}) =>
  ({ id: `m-${machineId.toLowerCase()}`, machineId, locationName, aliases: "", status: "active", ...over });

const fleet = [
  M("RFH012", "Hospital Selayang Lobby", { aliases: "selayang" }),
  M("RFH013", "Klinik Kesihatan Kepong", { aliases: "kepong" }),
  M("RFH021", "SMK Taman Melawati"),
  M("RFH022", "SK Taman Melawati"),
  M("RFH1", "Old Site", { status: "retired" }),
];

/* ------------------------------ 机号 ------------------------------ */

test("讲了机号就直接对上", () => {
  const r = matchMachine("RFH012 tak keluar", fleet);
  assert.equal(r.machine.machineId, "RFH012");
  assert.equal(r.by, "machine_id");
});

test("机号中间有空白、大小写不一样也认得", () => {
  assert.equal(matchMachine("mesin rfh 013", fleet).machine.machineId, "RFH013");
});

test("短机号不会误中长机号", () => {
  // RFH1 已撤机，但就算还在，"RFH012" 里的 RFH01 也不该配到 RFH1
  const live = [...fleet, M("RFH01", "Somewhere")];
  assert.equal(matchMachine("RFH012", live).machine.machineId, "RFH012");
});

test("已撤机的不会被配到", () => {
  assert.equal(matchMachine("RFH1", fleet).machine, null);
});

/* ------------------------------ 点位 ------------------------------ */

test("讲了地方就对回那台机", () => {
  const r = matchMachine("saya kat hospital selayang", fleet);
  assert.equal(r.machine.machineId, "RFH012");
  assert.equal(r.by, "location");
});

test("别名让简称也对得上", () => {
  assert.equal(matchMachine("selayang", fleet).machine.machineId, "RFH012");
  assert.equal(matchMachine("kepong", fleet).machine.machineId, "RFH013");
});

test("两个点位名字很像的时候不自动填，回候选让人问一句", () => {
  const r = matchMachine("taman melawati", fleet);
  assert.equal(r.machine, null, "分不出来就不要猜");
  assert.deepEqual(r.candidates.map((m) => m.machineId).sort(), ["RFH021", "RFH022"]);
});

test("讲清楚了就分得出来", () => {
  assert.equal(matchMachine("smk taman melawati", fleet).machine.machineId, "RFH021");
  assert.equal(matchMachine("sk taman melawati", fleet).machine.machineId, "RFH022");
});

test("完全没提到地方就什么都不给", () => {
  const r = matchMachine("dah bayar tapi barang tak keluar", fleet);
  assert.equal(r.machine, null);
  assert.deepEqual(r.candidates, []);
});

test("清单是空的不会炸", () => {
  assert.deepEqual(matchMachine("selayang", []), { machine: null, candidates: [], by: "" });
  assert.equal(matchMachine("", fleet).machine, null);
});

test("通用词不会让分数虚高", () => {
  // "taman" 是停用词，只讲这个不该配到任何一台
  assert.equal(matchMachine("taman", fleet).machine, null);
});

test("正规化只留字母数字与中文", () => {
  assert.equal(normalize("RFH-012 "), "rfh012");
  assert.equal(normalize("金河广场 A"), "金河广场a");
});

/* ------------------------------ 汇入 ------------------------------ */

test("两种栏位顺序都读得懂", () => {
  const { machines } = parseMachineList("Hospital Selayang Lobby, RFH012\nRFH013\tKlinik Kesihatan Kepong");
  assert.deepEqual(machines.map((m) => [m.machineId, m.locationName]), [
    ["RFH012", "Hospital Selayang Lobby"],
    ["RFH013", "Klinik Kesihatan Kepong"],
  ]);
});

test("空行与 # 注解跳过", () => {
  const { machines } = parseMachineList("# 我的清单\n\nA1, 地点一\n");
  assert.equal(machines.length, 1);
});

test("读不懂的行讲出来，不要默默吞掉", () => {
  const { machines, errors } = parseMachineList("只有一栏\nRFH012, Hospital\n没有数字的, 两栏");
  assert.equal(machines.length, 1);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].line, 1);
  assert.match(errors[1].reason, /机号/);
});

test("同一机号贴两次：后面的赢，而且会讲", () => {
  const { machines, duplicates } = parseMachineList("A1, 旧地点\nA1, 新地点");
  assert.equal(machines.length, 1);
  assert.equal(machines[0].locationName, "新地点");
  assert.deepEqual(duplicates, ["A1"]);
});

/* ------------------------------ API ------------------------------ */

const USER = { email: "rasafoodhubplt@gmail.com", name: "Rasa Admin", role: "admin" };

function setup() {
  const db = createTestDb();
  seedUsers(db, [{ email: USER.email, name: USER.name, role: "admin", is_active: 1 }]);
  return { db, env: testEnv(db) };
}

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

test("汇入一次建好，读得回来，照点位排序", async () => {
  const { env } = setup();
  const r = await call(env, "POST", "/api/machines/import", {
    text: "Pusat Bandar Puchong, RFH013\nHospital Selayang Lobby, RFH012",
  });
  assert.equal(r.body.saved, 2);
  const list = (await call(env, "GET", "/api/machines")).body.machines;
  assert.deepEqual(list.map((m) => m.machineId), ["RFH012", "RFH013"]);
});

test("同一台再汇入一次是更新，不是多一笔", async () => {
  const { env } = setup();
  await call(env, "POST", "/api/machines/import", { text: "旧名字, RFH012" });
  await call(env, "POST", "/api/machines/import", { text: "新名字, RFH012" });
  const list = (await call(env, "GET", "/api/machines")).body.machines;
  assert.equal(list.length, 1);
  assert.equal(list[0].locationName, "新名字");
});

test("机号会正规化成大写，前后空白去掉", async () => {
  const { env } = setup();
  await call(env, "POST", "/api/machines", { machine: { machineId: " rfh012 ", locationName: " KLCC " } });
  const list = (await call(env, "GET", "/api/machines")).body.machines;
  assert.equal(list[0].machineId, "RFH012");
  assert.equal(list[0].locationName, "KLCC");
});

test("缺机号或缺点位就拒绝", async () => {
  const { env } = setup();
  assert.equal((await call(env, "POST", "/api/machines", { machine: { locationName: "KLCC" } })).status, 400);
  assert.equal((await call(env, "POST", "/api/machines", { machine: { machineId: "A1" } })).status, 400);
});

test("删得掉", async () => {
  const { env } = setup();
  await call(env, "POST", "/api/machines", { machine: { machineId: "A1", locationName: "KLCC" } });
  const r = await call(env, "DELETE", "/api/machines/m-a1");
  assert.equal(r.status, 200);
  assert.equal(r.body.machines.length, 0);
});

test("认不得的状态退回 active，不会写进一个乱值", async () => {
  const { env } = setup();
  await call(env, "POST", "/api/machines", { machine: { machineId: "A1", locationName: "KLCC", status: "nonsense" } });
  const list = (await call(env, "GET", "/api/machines")).body.machines;
  assert.equal(list[0].status, "active");
});

/* --------------------------- 收讯时自动对机 --------------------------- */

import { ingestMessage } from "../src/whatsapp.js";

const wa = (over = {}) => ({
  id: `wamid-${Math.random().toString(36).slice(2)}`,
  from: "60123456789@s.whatsapp.net",
  fromMe: false,
  text: "",
  timestamp: 1757462400,
  pushName: "Ali",
  ...over,
});

const seedFleet = (db) => {
  for (const m of [
    ["RFH012", "Hospital Selayang Lobby", "selayang"],
    ["RFH021", "SMK Taman Melawati", ""],
    ["RFH022", "SK Taman Melawati", ""],
  ]) {
    db._exec(
      `INSERT INTO machines (id, machine_id, location_name, aliases, created_at, updated_at)
       VALUES ('m-${m[0].toLowerCase()}', '${m[0]}', '${m[1]}', '${m[2]}', '2026-01-01', '2026-01-01')`
    );
  }
};

const notesOf = async (db, id) =>
  (await db.prepare("SELECT body FROM notes WHERE customer_id = ? ORDER BY seq").bind(id).all())
    .results.map((n) => n.body).join("\n");

test("顾客讲了地方，机号与点位自动填上", async () => {
  const db = createTestDb();
  seedFleet(db);
  const r = await ingestMessage(db, wa({ text: "saya kat hospital selayang, barang tak keluar" }));
  const row = await db.prepare("SELECT machine_id, location_name FROM customers WHERE id = ?").bind(r.customerId).first();
  assert.equal(row.machine_id, "RFH012");
  assert.equal(row.location_name, "Hospital Selayang Lobby");
  assert.match(await notesOf(db, r.customerId), /对到机器：RFH012/);
});

test("对到不只一台就不填，留一条 note 提醒要问", async () => {
  const db = createTestDb();
  seedFleet(db);
  const r = await ingestMessage(db, wa({ text: "kat taman melawati" }));
  const row = await db.prepare("SELECT machine_id FROM customers WHERE id = ?").bind(r.customerId).first();
  assert.equal(row.machine_id, "");
  assert.match(await notesOf(db, r.customerId), /不只一台/);
});

test("顾客自己填的机号不在清单里，会被点出来", async () => {
  const db = createTestDb();
  seedFleet(db);
  const r = await ingestMessage(db, wa({ text: "ID Machine : RFH999\nItem no : 3" }));
  const row = await db.prepare("SELECT machine_id FROM customers WHERE id = ?").bind(r.customerId).first();
  assert.equal(row.machine_id, "RFH999", "顾客填的还是要留着，不能默默丢掉");
  assert.match(await notesOf(db, r.customerId), /不在机器清单里/);
});

test("顾客填的机号在清单里就不啰嗦", async () => {
  const db = createTestDb();
  seedFleet(db);
  const r = await ingestMessage(db, wa({ text: "ID Machine : rfh012" }));
  assert.doesNotMatch(await notesOf(db, r.customerId), /不在机器清单里/);
});

test("机器清单是空的时候，收讯完全不受影响", async () => {
  const db = createTestDb();
  const r = await ingestMessage(db, wa({ text: "hospital selayang" }));
  assert.equal(r.status, "stored");
  const row = await db.prepare("SELECT machine_id FROM customers WHERE id = ?").bind(r.customerId).first();
  assert.equal(row.machine_id, "");
});
