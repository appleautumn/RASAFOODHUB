import test from "node:test";
import assert from "node:assert/strict";
import { draftReply, AiError } from "../src/ai.js";

const env = { ANTHROPIC_API_KEY: "sk-ant-test" };
const good = { system: "你是 Rasa Foodhub 的售后客服。", userText: "我付了钱但机器没出货" };

/** 假的 SDK client，记录收到的参数 */
function fakeClient(response, onCreate) {
  return () => ({
    messages: {
      create: async (params) => {
        onCreate?.(params);
        if (response instanceof Error) throw response;
        return response;
      },
    },
  });
}

const reply = (text, extra = {}) => ({
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  model: "claude-opus-5-5",
  usage: { input_tokens: 120, output_tokens: 30 },
  ...extra,
});

/* ------------------------------ 正常 ------------------------------ */

test("回传模型产生的文字与用量", async () => {
  const out = await draftReply(good, env, fakeClient(reply("收到！马上帮你处理 🙏")));
  assert.equal(out.text, "收到！马上帮你处理 🙏");
  assert.equal(out.usage.inputTokens, 120);
  assert.equal(out.usage.model, "claude-opus-5-5");
});

test("用 claude-opus-5-5，effort 压低（回覆短、规则都在 system 里）", async () => {
  let params;
  await draftReply(good, env, fakeClient(reply("ok"), (p) => (params = p)));
  assert.equal(params.model, "claude-opus-5-5");
  assert.equal(params.output_config.effort, "low");
  assert.equal(params.system, good.system);
  assert.deepEqual(params.messages, [{ role: "user", content: good.userText }]);
});

test("多个 text block 会被接起来，非文字 block 略过", async () => {
  const out = await draftReply(
    good,
    env,
    fakeClient({ ...reply("第一句"), content: [{ type: "thinking", thinking: "" }, { type: "text", text: "第一句" }, { type: "text", text: "第二句" }] })
  );
  assert.equal(out.text, "第一句\n第二句");
});

/* ------------------------------ 挡下来 ------------------------------ */

test("worker 没设 API key -> 讲清楚要怎么设", async () => {
  const err = await draftReply(good, {}, fakeClient(reply("x"))).catch((e) => e);
  assert.ok(err instanceof AiError);
  assert.equal(err.code, "no_api_key");
  assert.ok(err.message.includes("wrangler secret put"));
});

test("system 或 userText 是空的 -> 400", async () => {
  for (const [input, code] of [
    [{ system: "", userText: "x" }, "no_system"],
    [{ system: "x", userText: "   " }, "no_user_text"],
    [{}, "no_system"],
  ]) {
    const err = await draftReply(input, env, fakeClient(reply("x"))).catch((e) => e);
    assert.equal(err.code, code);
    assert.equal(err.status, 400);
  }
});

test("输入过长 -> 413，不会送出去烧钱", async () => {
  let called = false;
  const client = fakeClient(reply("x"), () => (called = true));
  const err = await draftReply({ system: "a".repeat(20001), userText: "x" }, env, client).catch((e) => e);
  assert.equal(err.status, 413);
  assert.equal(called, false, "超长的输入不该真的送出去");
});

test("API key 无效 -> 讲是 key 的问题，不是别的", async () => {
  const e401 = Object.assign(new Error("Unauthorized"), { status: 401 });
  const err = await draftReply(good, env, fakeClient(e401)).catch((e) => e);
  assert.equal(err.code, "bad_api_key");
});

test("撞到额度限制 -> 429 原样回报", async () => {
  const e429 = Object.assign(new Error("Too many"), { status: 429 });
  const err = await draftReply(good, env, fakeClient(e429)).catch((e) => e);
  assert.equal(err.code, "rate_limited");
  assert.equal(err.status, 429);
});

test("模型拒答 -> 不当成空白，明讲要转真人", async () => {
  const refused = { ...reply(""), stop_reason: "refusal", content: [] };
  const err = await draftReply(good, env, fakeClient(refused)).catch((e) => e);
  assert.equal(err.code, "refused");
  assert.ok(err.message.includes("真人"));
});

test("回了空白内容 -> 502，不要把空字串塞给客服", async () => {
  const err = await draftReply(good, env, fakeClient({ ...reply(""), content: [] })).catch((e) => e);
  assert.equal(err.code, "empty_reply");
});

test("其它上游错误 -> 502，带原始讯息方便查", async () => {
  const err = await draftReply(good, env, fakeClient(new Error("socket hang up"))).catch((e) => e);
  assert.equal(err.code, "upstream_error");
  assert.ok(err.message.includes("socket hang up"));
});
