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

/* ============ Worker 说「略过」时不可以静静吞掉 ============ */

/**
 * Worker 就算把讯息略过（时间戳判读不出、JID 不合法）仍然回 ok:true 加上
 * skipped 计数。只看 ok 的话，这些讯息会从佇列消失而没人知道 ——
 * 跟先前把 Access 登入页当成送达是同一类错误。
 */

const workerReply = (body) =>
  new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  });

test("Worker 略过的则数会计入 skippedByWorker", async () => {
  const { q } = make({ onFetch: () => workerReply({
    ok: true, received: 2, stored: 1, duplicate: 0, skipped: 1,
    results: [
      { status: "stored", id: "A" },
      { status: "skipped", id: "B", reason: "bad_timestamp" },
    ],
  }) });
  q.push(msg("A")); q.push(msg("B"));
  await q.drainOnce();

  const s = q.stats();
  assert.equal(s.skippedByWorker, 1, "被略过的则数要看得见");
  assert.equal(s.sent, 2, "请求本身是成功的");
});

test("lastWorkerReply 记下 stored / skipped，/health 才看得出真相", async () => {
  const { q } = make({ onFetch: () => workerReply({
    ok: true, received: 1, stored: 0, duplicate: 0, skipped: 1,
    results: [{ status: "skipped", id: "A", reason: "bad_jid" }],
  }) });
  q.push(msg("A"));
  await q.drainOnce();

  const r = q.stats().lastWorkerReply;
  assert.equal(r.received, 1);
  assert.equal(r.stored, 0);
  assert.equal(r.skipped, 1);
});

test("全部收录时 skippedByWorker 保持 0", async () => {
  const { q } = make({ onFetch: () => workerReply({
    ok: true, received: 1, stored: 1, duplicate: 0, skipped: 0,
    results: [{ status: "stored", id: "A" }],
  }) });
  q.push(msg("A"));
  await q.drainOnce();
  assert.equal(q.stats().skippedByWorker, 0);
  assert.equal(q.stats().lastWorkerReply.stored, 1);
});

/* ============ 略过的原因要留在 stats 里，不能只写日志 ============ */

/**
 * Railway 的日志 API 会丢行 —— 曾经发生「知道有一则被拒收，却查不到原因」。
 * 所以原因要留在 /health 读得到的地方。
 */

test("被略过的明细会留在 lastSkips 里，带 id 与原因", async () => {
  const { q } = make({ onFetch: () => workerReply({
    ok: true, received: 2, stored: 0, duplicate: 0, skipped: 2,
    results: [
      { status: "skipped", id: "A", reason: "bad_timestamp" },
      { status: "skipped", id: "B", reason: "bad_jid" },
    ],
  }) });
  q.push(msg("A")); q.push(msg("B"));
  await q.drainOnce();

  const skips = q.stats().lastSkips;
  assert.equal(skips.length, 2);
  assert.deepEqual(skips.map((s) => `${s.id}:${s.reason}`), ["A:bad_timestamp", "B:bad_jid"]);
  assert.ok(skips[0].at, "要记时间，不然不知道是什么时候的事");
});

test("只留最近 10 笔，新的在前面", async () => {
  const { q } = make({ onFetch: () => workerReply({
    ok: true, results: [{ status: "skipped", id: `M${Date.now()}`, reason: "bad_timestamp" }],
  }) });

  for (let i = 0; i < 14; i++) {
    q.push(msg(`M${i}`));
    await q.drainOnce();
  }
  assert.equal(q.stats().lastSkips.length, 10, "超过上限要挤掉旧的");
});

test("全部收录时 lastSkips 保持空的", async () => {
  const { q } = make({ onFetch: () => workerReply({
    ok: true, received: 1, stored: 1, skipped: 0, results: [{ status: "stored", id: "A" }],
  }) });
  q.push(msg("A"));
  await q.drainOnce();
  assert.deepEqual(q.stats().lastSkips, []);
});
