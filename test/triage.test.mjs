/**
 * 分诊。
 *
 * 最重要的一组断言是「该转真人的一定转」—— 那几条排在所有判断的最前面，
 * 任何其他规则都不该盖过它。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { triage, isAfterHours } from "../src/triage.js";

const at = (iso) => new Date(iso);
const officeHours = at("2025-09-10T02:00:00Z"); // 周三，马来西亚 10:00

const run = (text, customer = null) => triage({ text, customer, now: officeHours });

test("要退款一律转真人", () => {
  for (const t of ["I want refund", "saya nak duit balik", "我要退款"]) {
    const r = run(t);
    assert.equal(r.escalate, true, t);
    assert.equal(r.scenario, "refund_demand");
  }
});

test("品质与过期转真人", () => {
  assert.equal(run("barang dah expired").scenario, "quality_expired");
  assert.equal(run("吃了肚子痛").escalate, true);
});

test("情绪与投诉转真人", () => {
  assert.equal(run("saya nak buat complaint").escalate, true);
  assert.equal(run("我要上网曝光你们").scenario, "angry_threat");
});

test("转真人排在表格解析前面 —— 表格里夹一句要退款，还是转真人", () => {
  const r = run("Name : Ali\nLocation : KLCC\nID Machine : A1\nItem no : 3\nI want refund");
  assert.equal(r.escalate, true);
  assert.equal(r.scenario, "refund_demand");
  // 该读的还是读到了，人接手时资料是齐的
  assert.equal(r.extracted.machineId, "A1");
});

test("价格与库存不准答", () => {
  assert.equal(run("berapa harga?").scenario, "price_stock_health");
  assert.equal(run("halal ke?").scenario, "price_stock_health");
  assert.equal(run("berapa harga?").escalate, false);
});

test("付了钱没出货 = 发表格", () => {
  assert.equal(run("Saya dah bayar tapi barang tak keluar").scenario, "paid_not_dispensed");
  assert.equal(run("已付款但没出货").scenario, "paid_not_dispensed");
});

test("表格填一半 = 只问缺的", () => {
  const r = run("Name : Ali\nItem no : 5");
  assert.equal(r.scenario, "form_partial");
  assert.deepEqual(r.missing, ["Location", "ID Machine (screen left side)"]);
});

test("四项齐了没收据 = 要收据", () => {
  assert.equal(run("Name : Ali\nLocation : KLCC\nID Machine : A1\nItem no : 3").scenario, "form_complete_no_receipt");
});

test("四项加收据齐了 = 进核实", () => {
  const r = run("Name : Ali\nLocation : KLCC\nID Machine : A1\nItem no : 3\nRM 5.50");
  assert.equal(r.scenario, "intake_complete");
  assert.deepEqual(r.missing, []);
});

test("缺项是照「这一则读完之后」算的，不是照旧资料", () => {
  const customer = { name: "Ali", locationName: "KLCC", machineId: "", itemNo: "" };
  const r = run("ID Machine : A1\nItem no : 3", customer);
  assert.deepEqual(r.missing, []);
  assert.equal(r.scenario, "form_complete_no_receipt");
});

test("只传收据，四项还没齐 = 请顾客填资料", () => {
  assert.equal(run("RM 4.50").scenario, "receipt_only");
});

test("旧个案的人回来了，接回原案", () => {
  assert.equal(run("dah sampai", { stage: "awaiting_next_visit" }).scenario, "returning_old_case");
  // 没有旧个案的人讲同一句，不该接到这条
  assert.notEqual(run("dah sampai").scenario, "returning_old_case");
});

test("只打招呼不发整张表格", () => {
  assert.equal(run("hi").scenario, "greeting_only");
  assert.equal(run("你好").scenario, "greeting_only");
});

test("招呼语后面接了正事，就不是打招呼", () => {
  assert.equal(run("hi saya dah bayar tapi tak keluar").scenario, "paid_not_dispensed");
});

test("只有附件没有文字", () => {
  assert.equal(run("[image]").scenario, "media_only");
  assert.equal(run("").scenario, "media_only");
});

test("核实中来催进度", () => {
  const c = { name: "A", locationName: "B", machineId: "C", itemNo: "1", receiptAmount: "5.00", machineStatus: "unknown", finexusStatus: "unknown", stage: "verifying" };
  assert.equal(run("any update?", c).scenario, "verify_pending");
});

test("判断不出来就不硬套剧本", () => {
  const r = run("ok noted terima kasih");
  assert.equal(r.scenario, "");
  assert.equal(r.escalate, false);
});

test("工作时间：周三上午不是非工作时间，周六是", () => {
  assert.equal(isAfterHours(at("2025-09-10T02:00:00Z")), false); // 周三 10:00 MY
  assert.equal(isAfterHours(at("2025-09-10T13:00:00Z")), true);  // 周三 21:00 MY
  assert.equal(isAfterHours(at("2025-09-10T23:30:00Z")), true);  // 周四 07:30 MY
  assert.equal(isAfterHours(at("2025-09-13T04:00:00Z")), true);  // 周六
  assert.equal(isAfterHours(at("2025-09-14T04:00:00Z")), true);  // 周日
});
