import test from "node:test";
import assert from "node:assert/strict";
import { createQueue } from "../src/queue.js";

const baseConfig = {
  workerUrl: "https://worker.test",
  queueMax: 5,
  drainBatch: 2,
  drainIntervalMs: 100,
  rssSoftLimitMb: 300,
  rssBackoffFactor: 6,
};

function make({ config = {}, ok = true, rssMb = 100, onFetch } = {}) {
  const calls = [];
  const q = createQueue({
    config: { ...baseConfig, ...config },
    headers: () => ({ "X-Bridge-Secret": "s" }),
    rssBytes: () => rssMb * 1024 * 1024,
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (onFetch) return onFetch(calls.length);
      return ok
        ? new Response(JSON.stringify({ ok: true }), {
            status: 200, headers: { "content-type": "application/json" },
          })
        : new Response("boom", { status: 500 });
    },
  });
  return { q, calls };
}

const msg = (id) => ({ id, from: "60123@s.whatsapp.net", text: "x", timestamp: 1712345678 });

test("佇列满了会丢掉最新那则，并且计入 dropped", () => {
  const { q } = make();
  for (let i = 1; i <= 5; i++) assert.equal(q.push(msg(`M${i}`)), true, `第 ${i} 则应该收下`);
  assert.equal(q.push(msg("M6")), false, "第 6 则应该被拒绝");
  assert.equal(q.length, 5);
  assert.equal(q.stats().dropped, 1);
  assert.equal(q.stats().pushed, 5);
});

test("一批只送 drainBatch 笔，送掉的会离开佇列", async () => {
  const { q, calls } = make();
  for (const id of ["A", "B", "C"]) q.push(msg(id));

  const r = await q.drainOnce();
  assert.equal(r.sent, 2, "一批应该是 2 笔");
  assert.equal(q.length, 1, "剩下 1 笔");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.messages.map((m) => m.id), ["A", "B"]);
  assert.equal(calls[0].url, "https://worker.test/api/wa/webhook");
});

test("推不出去时放回队首，顺序不变，而且不算送出", async () => {
  const { q } = make({ ok: false });
  for (const id of ["A", "B", "C"]) q.push(msg(id));

  const r = await q.drainOnce();
  assert.equal(r.sent, 0);
  assert.equal(q.length, 3, "失败的要放回来");
  assert.equal(q.stats().sent, 0);
  assert.equal(q.stats().failed, 2);
  assert.match(q.stats().lastError, /worker 500/);

  // 顺序要保住：下一批还是 A、B
  const { q: q2, calls } = make({ onFetch: (n) => (n === 1
    ? new Response("boom", { status: 500 })
    : new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "content-type": "application/json" },
      })) });
  for (const id of ["A", "B", "C"]) q2.push(msg(id));
  await q2.drainOnce();
  await q2.drainOnce();
  assert.deepEqual(calls[1].body.messages.map((m) => m.id), ["A", "B"], "重试要从 A 开始");
});

test("推送失败会把间隔拉长", async () => {
  const { q } = make({ ok: false });
  q.push(msg("A"));
  const r = await q.drainOnce();
  assert.equal(r.waitMs, 100 * 6);
});

test("rss 超过软上限时把间隔拉长", async () => {
  const { q } = make({ rssMb: 400 });
  q.push(msg("A"));
  const r = await q.drainOnce();
  assert.equal(r.sent, 1);
  assert.equal(r.waitMs, 100 * 6, "应该退避");
});

test("rss 在软上限之下用正常间隔", async () => {
  const { q } = make({ rssMb: 100 });
  q.push(msg("A"));
  const r = await q.drainOnce();
  assert.equal(r.waitMs, 100);
});

test("佇列空的时候不打 Worker", async () => {
  const { q, calls } = make();
  const r = await q.drainOnce();
  assert.equal(r.sent, 0);
  assert.equal(calls.length, 0, "空佇列不该发出请求");
});

test("stats 看得到佇列长度，/health 要用", () => {
  const { q } = make();
  q.push(msg("A"));
  const s = q.stats();
  assert.equal(s.queueLength, 1);
  assert.equal(s.pushed, 1);
});

/* ============ 被 Cloudflare Access 拦下时不可以当成送达 ============ */

/**
 * 踩过的真实情况：Access 对没带 Service Token 的请求回 302，fetch 预设跟随
 * 转址并把 POST 降级成 GET，拿回一个 200 的登入页 HTML。只看 res.ok 的话
 * 会记成「送达成功」，讯息就无声消失了。
 */

test("不跟随转址 —— 送出时带 redirect: manual", async () => {
  let seen = null;
  const q2 = createQueue({
    config: baseConfig,
    headers: () => ({}),
    rssBytes: () => 0,
    sleep: async () => {},
    fetchImpl: async (_u, init) => {
      seen = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "content-type": "application/json" } });
    },
  });
  q2.push(msg("A"));
  await q2.drainOnce();
  assert.equal(seen.redirect, "manual", "没设 redirect:manual，302 会被跟随成 200 登入页");
});

test("302 转址算失败，讯息留在佇列里", async () => {
  const { q } = make({ onFetch: () => new Response("", {
    status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/x" } }) });
  q.push(msg("A"));
  const r = await q.drainOnce();

  assert.equal(r.sent, 0, "被挡下不可以算送出");
  assert.equal(q.length, 1, "讯息必须留着重试");
  assert.equal(q.stats().sent, 0);
  assert.match(q.stats().lastError, /Access|转址/, `错误讯息要指出原因：${q.stats().lastError}`);
});

test("200 但回的是 HTML（登入页）也算失败", async () => {
  const { q } = make({ onFetch: () => new Response("<html>Access login</html>", {
    status: 200, headers: { "content-type": "text/html" } }) });
  q.push(msg("A"));
  const r = await q.drainOnce();

  assert.equal(r.sent, 0, "HTML 不是 Worker 的回应，不可以算送达");
  assert.equal(q.length, 1);
  assert.match(q.stats().lastError, /JSON/);
});

test("200 JSON 但 ok 不是 true 也算失败", async () => {
  const { q } = make({ onFetch: () => new Response(JSON.stringify({ ok: false, error: "bad_bridge_secret" }), {
    status: 200, headers: { "content-type": "application/json" } }) });
  q.push(msg("A"));
  const r = await q.drainOnce();

  assert.equal(r.sent, 0);
  assert.equal(q.length, 1);
  assert.match(q.stats().lastError, /ok:true/);
});

test("Access 恢复之后，堆着的讯息会照原顺序补送", async () => {
  let blocked = true;
  const calls = [];
  const q = createQueue({
    config: { ...baseConfig, drainBatch: 2 },
    headers: () => ({}),
    rssBytes: () => 0,
    sleep: async () => {},
    fetchImpl: async (_u, init) => {
      if (blocked) return new Response("", { status: 302, headers: { location: "https://x/login" } });
      calls.push(JSON.parse(init.body).messages.map((m) => m.id));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "content-type": "application/json" } });
    },
  });

  for (const id of ["A", "B", "C"]) q.push(msg(id));
  await q.drainOnce();
  assert.equal(q.length, 3, "被挡期间一则都不能少");

  blocked = false;
  await q.drainOnce();
  await q.drainOnce();
  assert.deepEqual(calls, [["A", "B"], ["C"]], "补送要照原本的顺序");
  assert.equal(q.length, 0);
});
