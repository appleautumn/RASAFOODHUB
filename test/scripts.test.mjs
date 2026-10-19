import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLocations, numberedLocations, fillTemplate,
  parseScripts, buildPickSystem, parsePick,
} from "../src/scripts.js";

/* ------------------------------ 地点 ------------------------------ */

test("一行一个，空行与前后空白都清掉", () => {
  assert.deepEqual(parseLocations("  A  \n\n B\n\n\nC \n"), ["A", "B", "C"]);
});

test("Windows 换行也要吃得下（使用者常从 Excel 贴过来）", () => {
  assert.deepEqual(parseLocations("A\r\nB\r\n"), ["A", "B"]);
});

test("带 tab 的真实资料原样保留（编号 + 名称）", () => {
  const real = "20312015\tLIVE VIBE\n25312001\tTRX LEVEL 58";
  assert.deepEqual(parseLocations(real), ["20312015\tLIVE VIBE", "25312001\tTRX LEVEL 58"]);
});

test("编号清单从 1 开始", () => {
  assert.equal(numberedLocations("A\nB"), "1. A\n2. B");
});

test("没有地点时不会炸", () => {
  assert.equal(numberedLocations(""), "");
  assert.deepEqual(parseLocations(null), []);
});

/* ---------------------------- 模板展开 ---------------------------- */

test("{{LOCATIONS}} 换成编号清单", () => {
  const out = fillTemplate("选一个：\n{{LOCATIONS}}\n谢谢", { locations: "A\nB" });
  assert.equal(out, "选一个：\n1. A\n2. B\n谢谢");
});

test("空白写法与多次出现都能换", () => {
  const out = fillTemplate("{{ LOCATIONS }} / {{LOCATIONS}}", { locations: "A" });
  assert.equal(out, "1. A / 1. A");
});

test("没有占位符就原样不动", () => {
  const t = "Hi, Thank you for your message ☺️";
  assert.equal(fillTemplate(t, { locations: "A" }), t);
});

/* ---------------------------- 话术解析 ---------------------------- */

const SAMPLE = `【情况】顾客说已付款但机器没出货
Hi, Thank you for your message ☺️

Name :
Item no :

【情况】个案处理完了，结尾道谢
Thank you for your supporting! ❤️`;

test("切成两条，内文完整保留（含空行与 emoji）", () => {
  const got = parseScripts(SAMPLE);
  assert.equal(got.length, 2);
  assert.equal(got[0].situation, "顾客说已付款但机器没出货");
  assert.equal(got[0].text, "Hi, Thank you for your message ☺️\n\nName :\nItem no :");
  assert.equal(got[1].text, "Thank you for your supporting! ❤️");
});

test("内文里出现「情况」两个字不会被误切", () => {
  const got = parseScripts("【情况】退款\n这个情况我们会处理，请稍等");
  assert.equal(got.length, 1);
  assert.equal(got[0].text, "这个情况我们会处理，请稍等");
});

test("只有标题没有内文的条目会被略过，不会送出空讯息", () => {
  const got = parseScripts("【情况】只有标题\n\n【情况】有内文\n实际文字");
  assert.equal(got.length, 1);
  assert.equal(got[0].situation, "有内文");
});

test("空设定回空阵列（呼叫端据此走自己写那条路）", () => {
  assert.deepEqual(parseScripts(""), []);
  assert.deepEqual(parseScripts(undefined), []);
});

test("Windows 换行的话术也解析得出来", () => {
  const got = parseScripts("【情况】甲\r\n第一行\r\n第二行");
  assert.equal(got.length, 1);
  assert.equal(got[0].text, "第一行\r\n第二行");
});

/* ---------------------------- 分流提示 ---------------------------- */

test("分流提示只列情况，不含话术内文（模型碰不到文字就改不了）", () => {
  const scripts = parseScripts(SAMPLE);
  const sys = buildPickSystem(scripts);
  assert.ok(sys.includes("1. 顾客说已付款但机器没出货"));
  assert.ok(sys.includes("2. 个案处理完了，结尾道谢"));
  assert.ok(!sys.includes("Thank you for your supporting"), "内文不该出现在分流提示里");
});

test("模型回数字就采用，回 0 或乱回就当没对上", () => {
  assert.equal(parsePick("2", 3), 2);
  assert.equal(parsePick(" 1 \n", 3), 1);
  assert.equal(parsePick("0", 3), 0);
  assert.equal(parsePick("第 2 条", 3), 2);
  assert.equal(parsePick("我觉得都不对", 3), 0);
  assert.equal(parsePick("", 3), 0);
  assert.equal(parsePick(null, 3), 0);
});

test("超出范围的数字不采用（宁可自己写，也不要送错话术）", () => {
  assert.equal(parsePick("9", 3), 0);
  assert.equal(parsePick("-1", 3), 0);
});

/* ------------------- 机器编号 → 地点（真实资料） ------------------- */

import { parseMachines, lookupLocation } from "../src/scripts.js";

const REAL = [
  "20312015\tLIVE VIBE",
  "25312001\tTRX LEVEL 58",
  "25312007\tSTANDARD CHARTERED (A)",
  "2309260006\tTRANSIT KL",
  "2509010184\tMAHSA UNIVERSITY",
].join("\n");

test("tab 分隔的真实清单切得出编号与名称", () => {
  const got = parseMachines(REAL);
  assert.equal(got.length, 5);
  assert.deepEqual(got[0], { id: "20312015", name: "LIVE VIBE" });
  assert.deepEqual(got[2], { id: "25312007", name: "STANDARD CHARTERED (A)" });
  assert.deepEqual(got[4], { id: "2509010184", name: "MAHSA UNIVERSITY" });
});

test("用两个以上空白分隔也可以（从 Excel 贴过来常是这样）", () => {
  assert.deepEqual(parseMachines("25312002    KLIA C"), [{ id: "25312002", name: "KLIA C" }]);
});

test("名称里的单一空白不会被当成分隔", () => {
  assert.deepEqual(parseMachines("25312011\tTRX TOWER"), [{ id: "25312011", name: "TRX TOWER" }]);
});

test("只有名称、没有编号的行仍可用", () => {
  assert.deepEqual(parseMachines("某个新地点"), [{ id: "", name: "某个新地点" }]);
});

test("顾客报编号就查得到地点", () => {
  assert.equal(lookupLocation(REAL, "25312001"), "TRX LEVEL 58");
  assert.equal(lookupLocation(REAL, "  2309260006  "), "TRANSIT KL");
});

test("查不到就回 null，不要瞎猜", () => {
  assert.equal(lookupLocation(REAL, "99999999"), null);
  assert.equal(lookupLocation(REAL, ""), null);
  assert.equal(lookupLocation(REAL, null), null);
});

test("没有编号的行不会被空字串比中", () => {
  assert.equal(lookupLocation("只有名称没编号", ""), null);
  assert.equal(lookupLocation("只有名称没编号", "123"), null);
});
