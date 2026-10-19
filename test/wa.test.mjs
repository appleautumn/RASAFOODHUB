import test from "node:test";
import assert from "node:assert/strict";
import { probeBridge } from "../src/wa.js";

const env = { WA_BRIDGE_URL: "https://bridge.example.com/health", WA_BRIDGE_SECRET: "s3cret" };

test("没设 URL -> 讲清楚，不要假装连过", async () => {
  const r = await probeBridge({});
  assert.equal(r.reachable, false);
  assert.equal(r.reason, "no_url");
  assert.equal(r.urlConfigured, false);
});

test("URL 乱填 -> bad_url", async () => {
  const r = await probeBridge({ WA_BRIDGE_URL: "不是网址" });
  assert.equal(r.reason, "bad_url");
});

test("主机有回应 -> 回报状态与内容片段", async () => {
  const fake = async () => new Response("baileys bridge ok, connected", { status: 200 });
  const r = await probeBridge(env, fake);
  assert.equal(r.reachable, true);
  assert.equal(r.httpStatus, 200);
  assert.ok(r.bodySnippet.includes("baileys"));
});

test("只露主机名，不外泄完整网址与路径", async () => {
  const fake = async () => new Response("ok");
  const r = await probeBridge(env, fake);
  assert.equal(r.target.host, "bridge.example.com");
  assert.equal(r.target.hasPath, true);
  const dump = JSON.stringify(r);
  assert.ok(!dump.includes("/health"), "路径不该出现在回报里");
  assert.ok(!dump.includes("s3cret"), "secret 绝对不能出现");
});

test("带著 secret 去敲（桥接端通常要验证）", async () => {
  let seen;
  const fake = async (_u, opts) => { seen = opts.headers; return new Response("ok"); };
    await probeBridge(env, fake);
  assert.equal(seen.authorization, "Bearer s3cret");
});

test("主机活著但回 500 -> 仍算 reachable，讲明状态码", async () => {
  const fake = async () => new Response("boom", { status: 500 });
  const r = await probeBridge(env, fake);
  assert.equal(r.reachable, true);
  assert.equal(r.httpStatus, 500);
  assert.ok(r.detail.includes("500"));
});

test("连不上 -> unreachable，带原始原因", async () => {
  const fake = async () => { throw new Error("ECONNREFUSED"); };
  const r = await probeBridge(env, fake);
  assert.equal(r.reachable, false);
  assert.equal(r.reason, "unreachable");
  assert.ok(r.detail.includes("ECONNREFUSED"));
});

test("逾时 -> 讲主机大概关了，而不是丢技术名词", async () => {
  const fake = async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
  const r = await probeBridge(env, fake);
  assert.equal(r.reason, "timeout");
  assert.ok(r.detail.includes("关了"));
});
