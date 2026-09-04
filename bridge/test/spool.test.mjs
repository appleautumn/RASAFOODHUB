import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpool } from "../src/spool.js";
import { createQueue } from "../src/queue.js";

/**
 * 用真的档案系统测。这一层的价值就在「行程死掉之后还在不在」，
 * 用替身测只会验到我自己写的替身。
 */

function tmpSpool() {
  const dir = mkdtempSync(join(tmpdir(), "spool-"));
  return { dir, path: join(dir, "queue.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const msg = (id) => ({ id, from: "60123@s.whatsapp.net", text: "x", timestamp: 1712345678 });

const config = {
  workerUrl: "https://worker.test",
  queueMax: 100, drainBatch: 2, drainIntervalMs: 10,
  rssSoftLimitMb: 999, rssBackoffFactor: 2,
};

function makeQueue(spool, { ok = true } = {}) {
  return createQueue({
    config, spool,
    headers: () => ({}),
    rssBytes: () => 0,
    sleep: async () => {},
    fetchImpl: async () =>
      ok
        ? new Response(JSON.stringify({ ok: true, received: 2, stored: 2, duplicate: 0, skipped: 0, results: [] }), {
            status: 200, headers: { "content-type": "application/json" } })
        : new Response("", { status: 302, headers: { location: "https://x/login" } }),
  });
}

test("没设路径时是个不做事的替身，不会炸", () => {
  const s = createSpool(null);
  assert.equal(s.enabled, false);
  assert.deepEqual(s.load(), []);
  s.save([msg("A")]); // 不该丢例外
});

test("推进佇列的讯息会立刻落到磁碟上", () => {
  const t = tmpSpool();
  const q = makeQueue(createSpool(t.path));
  q.push(msg("A"));
  q.push(msg("B"));

  const lines = readFileSync(t.path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => JSON.parse(l).id), ["A", "B"]);
  t.cleanup();
});

test("重启之后接得回来 —— 这是整个模组存在的理由", async () => {
  const t = tmpSpool();

  // 第一个「行程」：收了三则，一则都还没送出去
  const q1 = makeQueue(createSpool(t.path), { ok: false });
  for (const id of ["A", "B", "C"]) q1.push(msg(id));
  await q1.drainOnce(); // 被挡下，留在佇列里
  assert.equal(q1.length, 3);

  // 行程死掉，换一个新的（同一个磁碟路径）
  const q2 = makeQueue(createSpool(t.path));
  assert.equal(q2.length, 3, "重启后应该接回三则，一则都不能少");
  assert.equal(q2.stats().spooled, true);

  // 而且顺序要对
  const calls = [];
  const q3 = createQueue({
    config, spool: createSpool(t.path),
    headers: () => ({}), rssBytes: () => 0, sleep: async () => {},
    fetchImpl: async (_u, init) => {
      calls.push(JSON.parse(init.body).messages.map((m) => m.id));
      return new Response(JSON.stringify({ ok: true, results: [] }), {
        status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await q3.drainOnce();
  await q3.drainOnce();
  assert.deepEqual(calls, [["A", "B"], ["C"]], "补送的顺序要跟收到时一样");
  t.cleanup();
});

test("送出成功之后，磁碟上就不该再留着", async () => {
  const t = tmpSpool();
  const q = makeQueue(createSpool(t.path));
  q.push(msg("A"));
  q.push(msg("B"));
  await q.drainOnce();

  assert.equal(q.length, 0);
  assert.equal(readFileSync(t.path, "utf8").trim(), "", "送出去的不该留在磁碟上，否则重启会重送");
  t.cleanup();
});

test("档案有坏行时，好的那些照样接回来", () => {
  const t = tmpSpool();
  writeFileSync(t.path, [
    JSON.stringify(msg("A")),
    "{ 这行坏了",
    JSON.stringify(msg("B")),
  ].join("\n") + "\n");

  const items = createSpool(t.path).load();
  assert.deepEqual(items.map((i) => i.id), ["A", "B"], "一行坏掉不该让整份都读不回来");
  t.cleanup();
});

test("写入用 rename，不会留下写到一半的暂存档", () => {
  const t = tmpSpool();
  const s = createSpool(t.path);
  s.save([msg("A")]);
  assert.equal(existsSync(`${t.path}.tmp`), false, "暂存档应该已经被 rename 掉");
  assert.equal(JSON.parse(readFileSync(t.path, "utf8").trim()).id, "A");
  t.cleanup();
});

test("磁碟写不进去时只记录，不让收讯这条路断掉", () => {
  // 指到一个不能建的位置：把一个既有档案当成目录用
  const t = tmpSpool();
  writeFileSync(join(t.dir, "afile"), "x");
  const s = createSpool(join(t.dir, "afile", "queue.jsonl"));
  s.save([msg("A")]); // 不该丢例外
  assert.deepEqual(s.load(), [], "读不到就当空的，服务照常跑");
  t.cleanup();
});
