/**
 * 回覆剧本：读、写、组 prompt。
 *
 * 「剧本读不到就回预设」是刻意的：没有剧本比预设剧本危险得多，
 * 因为没有剧本的时候 AI 是自由发挥的。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SCENARIOS, PLAYBOOK_KEY, FALLBACK_REPLY,
  parsePlaybook, withNewDefaults, buildSystemPrompt,
} from "../src/playbook.js";

test("预设剧本每一条都有 id，而且不重复", () => {
  const ids = DEFAULT_SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of DEFAULT_SCENARIOS) {
    assert.ok(s.id && s.label && s.when, `${s.id} 少了栏位`);
  }
});

test("该转真人的几条都标了 escalate", () => {
  const must = ["refund_demand", "quality_expired", "angry_threat", "not_returning", "both_success_conflict"];
  for (const id of must) {
    const s = DEFAULT_SCENARIOS.find((x) => x.id === id);
    assert.ok(s, `少了 ${id}`);
    assert.equal(s.escalate, true, `${id} 应该转真人`);
  }
});

test("价格库存那条的范本就是「我帮你问一下」", () => {
  const s = DEFAULT_SCENARIOS.find((x) => x.id === "price_stock_health");
  assert.equal(s.reply, FALLBACK_REPLY);
});

test("没存过就回预设", () => {
  const r = parsePlaybook("");
  assert.equal(r.source, "default");
  assert.equal(r.scenarios.length, DEFAULT_SCENARIOS.length);
});

test("存档坏掉也回预设，不会回空阵列", () => {
  for (const bad of ["{{{", "null", "[]", '{"scenarios":[]}', '{"scenarios":"nope"}', '[{"label":"没有 id"}]']) {
    const r = parsePlaybook(bad);
    assert.equal(r.source, "default", bad);
    assert.ok(r.scenarios.length > 0, bad);
  }
});

test("存过的剧本会照用", () => {
  const raw = JSON.stringify({ scenarios: [{ id: "mine", label: "自订", when: "x", reply: "y" }] });
  const r = parsePlaybook(raw);
  assert.equal(r.source, "stored");
  assert.equal(r.scenarios.length, 1);
});

test("之后新增的预设条目会补进旧存档，改过的同 id 不动", () => {
  const stored = [{ id: "refund_demand", label: "我改过的", when: "x", reply: "y" }];
  const { scenarios, added } = withNewDefaults(stored);
  assert.equal(scenarios[0].label, "我改过的");
  assert.ok(added.includes("greeting_only"));
  assert.equal(scenarios.length, DEFAULT_SCENARIOS.length);
});

test("prompt 里有硬规定、剧本、个案摘要", () => {
  const p = buildSystemPrompt({
    ai: { product: "产品知识内容", replyRules: "回覆规则内容", salesRules: "销售规则内容", toneExamples: "语气范例内容" },
    caseSummary: "Name：Ali",
    missing: ["Location"],
    suggestedScenarioId: "form_partial",
  });
  assert.match(p, /产品知识内容/);
  assert.match(p, /语气范例内容/);
  assert.match(p, /form_partial/);
  assert.match(p, /Name：Ali/);
  assert.match(p, /Location/);
  assert.match(p, /只输出要发给顾客的那段文字本身/);
});

test("建议的是转真人那条时，prompt 会讲明只回一句致歉", () => {
  const p = buildSystemPrompt({ suggestedScenarioId: "refund_demand" });
  assert.match(p, /转真人/);
});

test("没有个案也组得出 prompt", () => {
  const p = buildSystemPrompt();
  assert.ok(p.length > 500);
  assert.doesNotMatch(p, /# 这位顾客的个案/);
});

test("剧本 key 没被改掉", () => {
  assert.equal(PLAYBOOK_KEY, "playbook.scenarios");
});
