import test from "node:test";
import assert from "node:assert/strict";
import { createBridgeServer } from "../src/server.js";

const SECRET = "bridge-secret-for-tests";

const config = {
  port: 0,
  workerUrl: "https://worker.test",
  secret: SECRET,
  authDir: "/tmp/nope",
  rssSoftLimitMb: 320,
};

function harness({ waState = {}, qr = "2@abc/def+ghi", sendImpl } = {}) {
  const calls = { reset: 0, sends: [] };
  const wa = {
    status: () => ({ state: "waiting_qr", connected: false, phone: null, hasQr: true, lastError: null, ...waState }),
    qr: () => qr,
    send: async (to, body) => {
      calls.sends.push({ to, body });
      if (sendImpl) return sendImpl(to, body);
      return { id: "SENT-1", jid: `${to}@s.whatsapp.net` };
    },
    resetAuth: async () => {
      calls.reset += 1;
      return { state: "starting", connected: false, phone: null };
    },
  };
  const queue = { stats: () => ({ pushed: 0, sent: 0, dropped: 0, queueLength: 0 }), length: 0 };
  const server = createBridgeServer({ config, wa, queue });
  return { server, calls };
}

/** 起一个真的 HTTP server，用真的 fetch 打它 —— 不模拟 req/res */
async function withServer(opts, fn) {
  const { server, calls } = harness(opts);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base, calls);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const withSecret = (s = SECRET) => ({ "X-Bridge-Secret": s });

/* ---------------------------- /health ---------------------------- */

test("/health 不需要 secret，而且看得到 rss、佇列、连线状态", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const b = await res.json();
    assert.equal(b.ok, true);
    assert.equal(b.whatsapp.state, "waiting_qr");
    assert.equal(typeof b.memory.rssMb, "number");
    assert.equal(typeof b.queue.queueLength, "number");
    assert.equal(typeof b.uptimeSeconds, "number");
  });
});

test("/health 不会泄漏 secret 或 token", async () => {
  await withServer({}, async (base) => {
    const text = await (await fetch(`${base}/health`)).text();
    assert.ok(!text.includes(SECRET), "/health 回应里出现了 secret");
  });
});

/* ---------------------------- secret 把关 ---------------------------- */

test("没带 secret 的端点一律 401", async () => {
  await withServer({}, async (base) => {
    for (const [path, method] of [["/qr", "GET"], ["/status", "GET"], ["/send", "POST"], ["/reset-auth", "POST"]]) {
      const res = await fetch(`${base}${path}`, { method });
      assert.equal(res.status, 401, `${method} ${path} 应该 401`);
    }
  });
});

test("带错的 secret 也是 401，回应内容跟没带时一样", async () => {
  await withServer({}, async (base) => {
    const a = await fetch(`${base}/qr`);
    const b = await fetch(`${base}/qr`, { headers: withSecret("wrong") });
    assert.equal(b.status, 401);
    assert.deepEqual(await a.json(), await b.json(), "两者应该无法区分");
  });
});

test("secret 放在查询字串里没有用 —— 只从标头读", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/qr?secret=${encodeURIComponent(SECRET)}`);
    assert.equal(res.status, 401, "网址带 secret 不该被接受");
  });
});

/* ---------------------------- /qr ---------------------------- */

test("/qr 回真的 PNG", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/qr`, { headers: withSecret() });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");

    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNG 的魔术位元组
    assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "不是 PNG");
    assert.ok(bytes.length > 200, `PNG 太小：${bytes.length} bytes`);
  });
});

test("已经连线时 /qr 回 409，并附上号码", async () => {
  await withServer({ waState: { connected: true, state: "connected", phone: "60123456789" } }, async (base) => {
    const res = await fetch(`${base}/qr`, { headers: withSecret() });
    assert.equal(res.status, 409);
    const b = await res.json();
    assert.equal(b.error, "already_connected");
    assert.equal(b.phone, "60123456789");
  });
});

test("QR 还没产生时回 503，不要假装有图", async () => {
  await withServer({ qr: null, waState: { state: "connecting", hasQr: false } }, async (base) => {
    const res = await fetch(`${base}/qr`, { headers: withSecret() });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "qr_not_ready");
  });
});

/* ---------------------------- /send ---------------------------- */

test("/send 带对 secret 会真的呼叫送出", async () => {
  await withServer({}, async (base, calls) => {
    const res = await fetch(`${base}/send`, {
      method: "POST",
      headers: { ...withSecret(), "content-type": "application/json" },
      body: JSON.stringify({ to: "60123456789", body: "在吗" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).id, "SENT-1");
    assert.deepEqual(calls.sends, [{ to: "60123456789", body: "在吗" }]);
  });
});

test("/send 少了 to 或 body 回 400", async () => {
  await withServer({}, async (base) => {
    for (const payload of [{ body: "x" }, { to: "60123" }, {}]) {
      const res = await fetch(`${base}/send`, {
        method: "POST",
        headers: { ...withSecret(), "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 400, JSON.stringify(payload));
    }
  });
});

test("还没连线时 /send 回 503，不会假装送出去了", async () => {
  await withServer(
    { sendImpl: () => { throw new Error("还没连线（目前 waiting_qr）"); } },
    async (base) => {
      const res = await fetch(`${base}/send`, {
        method: "POST",
        headers: { ...withSecret(), "content-type": "application/json" },
        body: JSON.stringify({ to: "60123456789", body: "x" }),
      });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, "send_failed");
    }
  );
});

/* ---------------------------- /reset-auth ---------------------------- */

test("/reset-auth 没带确认参数不会执行", async () => {
  await withServer({}, async (base, calls) => {
    const res = await fetch(`${base}/reset-auth`, { method: "POST", headers: withSecret() });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "confirmation_required");
    assert.equal(calls.reset, 0, "不该被执行到");
  });
});

test("/reset-auth 带了确认参数才执行", async () => {
  await withServer({}, async (base, calls) => {
    const res = await fetch(`${base}/reset-auth`, {
      method: "POST",
      headers: { ...withSecret(), "content-type": "application/json" },
      body: JSON.stringify({ confirm: "i-mean-it" }),
    });
    assert.equal(res.status, 200);
    assert.equal(calls.reset, 1);
  });
});

test("不认识的路径回 404", async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/nope`, { headers: withSecret() })).status, 404);
  });
});
