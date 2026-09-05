/**
 * 个案状态机。
 *
 * 这里断言的是「什么时候可以远端出货」。出货是花钱的动作，
 * 判断错的方向只有一个可以接受：宁可停下来问人。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { caseStatus, verifyDecision, missingFields, hasReceipt, mergeIntake, caseSummary } from "../src/casefile.js";

const full = {
  name: "Ali", locationName: "KLCC", machineId: "RFH012", itemNo: "23",
  receiptAmount: "5.50", machineStatus: "pending", finexusStatus: "captured",
};

test("四项没齐就是在收资料，等的是顾客", () => {
  const s = caseStatus({ name: "Ali" });
  assert.equal(s.state, "collecting");
  assert.equal(s.who, "customer");
  assert.deepEqual(s.missing, ["locationName", "machineId", "itemNo"]);
  assert.equal(s.needsReceipt, true);
});

test("四项齐了但没收据，还是在收资料", () => {
  const s = caseStatus({ name: "Ali", locationName: "KLCC", machineId: "A1", itemNo: "3" });
  assert.equal(s.state, "collecting");
  assert.deepEqual(s.missing, []);
  assert.equal(s.needsReceipt, true);
});

test("资料齐、收据有，但系统还没查 —— 等的是同事", () => {
  const s = caseStatus({ ...full, machineStatus: "unknown", finexusStatus: "unknown" });
  assert.equal(s.state, "verifying");
  assert.equal(s.who, "staff");
});

test("收据三项任何一项有值就算拿到收据", () => {
  assert.equal(hasReceipt({ receiptTime: "14:30" }), true);
  assert.equal(hasReceipt({ receiptDate: "", receiptTime: "", receiptAmount: "" }), false);
});

test("captured + pending = 该远端出货", () => {
  const d = verifyDecision({ machineStatus: "pending", finexusStatus: "captured" });
  assert.equal(d.outcome, "ready_to_remote");
  assert.equal(d.stage, "pending_remote");
});

test("captured + faulty 也一样该出货", () => {
  assert.equal(verifyDecision({ machineStatus: "faulty", finexusStatus: "captured" }).outcome, "ready_to_remote");
});

test("顾客不在现场就不出货，等他下次来", () => {
  const d = verifyDecision({ machineStatus: "pending", finexusStatus: "captured", onSite: false });
  assert.equal(d.outcome, "awaiting_visit");
  assert.equal(d.stage, "awaiting_next_visit");
});

test("两边都说成功 —— 交给人，绝对不再出一次", () => {
  const d = verifyDecision({ machineStatus: "delivered", finexusStatus: "captured" });
  assert.equal(d.outcome, "conflict");
  assert.equal(d.who, "staff");
  assert.notEqual(d.stage, "pending_remote");
});

test("void / reverse 是钱没扣走，请顾客查银行", () => {
  for (const s of ["void", "reverse"]) {
    const d = verifyDecision({ machineStatus: "pending", finexusStatus: s });
    assert.equal(d.outcome, "refund_check");
    assert.equal(d.scenario, "void_reverse");
  }
});

test("refunded 走已退款那条", () => {
  assert.equal(verifyDecision({ machineStatus: "pending", finexusStatus: "refunded" }).scenario, "already_refunded");
});

test("任何一边还是 unknown 就不下结论", () => {
  assert.equal(verifyDecision({ machineStatus: "unknown", finexusStatus: "captured" }).outcome, "verifying");
  assert.equal(verifyDecision({ machineStatus: "pending", finexusStatus: "unknown" }).outcome, "verifying");
});

test("合并只填空的栏位，不覆盖已有的值", () => {
  const changes = mergeIntake({ name: "Ali", itemNo: "" }, { name: "Ahmad", itemNo: "5", machineId: "A1" });
  assert.deepEqual(changes, { itemNo: "5", machineId: "A1" });
});

test("空字串与空白不算值", () => {
  assert.deepEqual(mergeIntake({ name: "  " }, { name: "Ali" }), { name: "Ali" });
  assert.deepEqual(mergeIntake({}, { name: "   " }), {});
});

test("摘要每一行都在，缺的写破折号", () => {
  const text = caseSummary({ name: "Ali" });
  assert.match(text, /Name：Ali/);
  assert.match(text, /ID Machine：—/);
  assert.match(text, /FINEXUS：—/);
  assert.match(text, /目前：/);
});

test("missingFields 只看四项必填，不管收据", () => {
  assert.deepEqual(missingFields(full), []);
});
