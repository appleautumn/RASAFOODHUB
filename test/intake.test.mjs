/**
 * 表格解析。
 *
 * 这些测试的重点不是「读得到」，是「读不到的时候不要乱猜」——
 * 猜错的机号会一路带到 FINEXUS 核实，那时候才发现就晚了。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { extractIntake, looksLikeForm, REQUIRED_FIELDS } from "../src/intake.js";

test("照表格填回来的四项都读得到", () => {
  const { fields, missing } = extractIntake(
    "Name : Ali bin Ahmad\nLocation : Hospital Serdang\nID Machine ( Shown on the screen left side) : RFH012\nItem no : 23"
  );
  assert.equal(fields.name, "Ali bin Ahmad");
  assert.equal(fields.locationName, "Hospital Serdang");
  assert.equal(fields.machineId, "RFH012");
  assert.equal(fields.itemNo, "23");
  assert.deepEqual(missing, []);
});

test("标签的长写法不会被短写法抢走", () => {
  const { fields } = extractIntake("Location Name : KLCC\nID Machine : A9");
  assert.equal(fields.locationName, "KLCC");
  assert.equal(fields.machineId, "A9");
  assert.equal(fields.name, undefined, "location name 不该被当成 name");
});

test("马来文与中文标签都认得", () => {
  const { fields } = extractIntake("Nama : Siti\nLokasi : Mydin\nNo Mesin : B12\nBarang : 7");
  assert.equal(fields.name, "Siti");
  assert.equal(fields.locationName, "Mydin");
  assert.equal(fields.machineId, "B12");
  assert.equal(fields.itemNo, "7");

  const zh = extractIntake("姓名：陈大文\n地点：金河广场\n机器编号：C3\n商品编号：18").fields;
  assert.equal(zh.name, "陈大文");
  assert.equal(zh.locationName, "金河广场");
  assert.equal(zh.machineId, "C3");
  assert.equal(zh.itemNo, "18");
});

test("值在下一行也读得到，但不会把下一个标签吃掉", () => {
  const { fields } = extractIntake("Name :\nAli\nItem no :\n12");
  assert.equal(fields.name, "Ali");
  assert.equal(fields.itemNo, "12");
});

test("标签自己一行、值是空的，不会把下一个标签当成值", () => {
  const { fields } = extractIntake("Name :\nLocation : KLCC");
  assert.equal(fields.name, undefined);
  assert.equal(fields.locationName, "KLCC");
});

test("WhatsApp 的粗体星号与项目符号不会跟着进来", () => {
  const { fields } = extractIntake("*Name* : *Ali*\n- Item no : 5");
  assert.equal(fields.name, "Ali");
  assert.equal(fields.itemNo, "5");
});

test("顾客写 n/a、不知道，当成没填", () => {
  const { fields, missing } = extractIntake("Name : Ali\nLocation : -\nID Machine : 不知道\nItem no : n/a");
  assert.equal(fields.name, "Ali");
  assert.deepEqual(missing, ["locationName", "machineId", "itemNo"]);
});

test("机号大写、去掉中间空白", () => {
  assert.equal(extractIntake("ID Machine : rfh 012").fields.machineId, "RFH012");
});

test("零宽字元贴进来会被清掉", () => {
  const dirty = "ID Machine : RFH\u200B012";
  assert.equal(extractIntake(dirty).fields.machineId, "RFH012");
});

test("金额与日期从自由文字里也读得到", () => {
  const { fields } = extractIntake("Paid RM 5.50 on 12/09/2025 at the machine");
  assert.equal(fields.receiptAmount, "5.50");
  assert.equal(fields.receiptDate, "2025-09-12");
});

test("金额写法不一样，正规化成同一种", () => {
  assert.equal(extractIntake("Amount : rm5").fields.receiptAmount, "5.00");
  assert.equal(extractIntake("Jumlah : RM 12,90").fields.receiptAmount, "12.90");
});

test("时间正规化成 24 小时制", () => {
  assert.equal(extractIntake("Time : 2:30 pm").fields.receiptTime, "14:30");
  assert.equal(extractIntake("Masa : 09:05").fields.receiptTime, "09:05");
  assert.equal(extractIntake("Time : 12:10 am").fields.receiptTime, "00:10");
});

test("不合理的日期不收", () => {
  assert.equal(extractIntake("Date : 45/13/2025").fields.receiptDate, undefined);
});

test("没有标签的自由文字，机号与品项一律不猜", () => {
  const { fields, missing } = extractIntake("saya beli kat mesin nombor 12 kat klcc tapi tak keluar");
  assert.equal(fields.machineId, undefined);
  assert.equal(fields.itemNo, undefined);
  assert.deepEqual(missing, REQUIRED_FIELDS);
});

test("句子里刚好有冒号，不会被当成表格", () => {
  assert.equal(looksLikeForm("时间到了: 我等很久了"), false);
  assert.equal(looksLikeForm("Name : Ali\nItem no : 3"), true);
});

test("同一栏位填两次，第一次的赢", () => {
  const { fields } = extractIntake("Item no : 5\nItem no : 9");
  assert.equal(fields.itemNo, "5");
});

test("空讯息回四项全缺，不会炸", () => {
  const r = extractIntake("");
  assert.deepEqual(r.fields, {});
  assert.deepEqual(r.missing, REQUIRED_FIELDS);
  assert.equal(r.labelled, 0);
});
