import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { clearJwksCache } from "../src/access-jwt.js";

const TEAM = "rasafoodhub.cloudflareaccess.com";
const AUD = "test-aud-tag";
const KID = "worker-test-kid";

/* ------------------------- 假的 Access 签章环境 ------------------------- */

const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"]
);
const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
const jwks = { keys: [{ kty: "RSA", alg: "RS256", use: "sig", kid: KID, n: jwk.n, e: jwk.e }] };

// worker 里的 verifyAccessJwt 会用全域 fetch 去抓 JWKS
globalThis.fetch = async () => new Response(JSON.stringify(jwks));

const seg = (o) => Buffer.from(new TextEncoder().encode(JSON.stringify(o))).toString("base64url");

async function tokenFor(email) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${seg({ alg: "RS256", kid: KID, typ: "JWT" })}.${seg({
    iss: `https://${TEAM}`,
    aud: [AUD],
    email,
    iat: now - 5,
    exp: now + 3600,
  })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(new Uint8Array(sig)).toString("base64url")}`;
}

/* ----------------------------- 假的 D1 ----------------------------- */

function fakeDb({ users = [], state = new Map() } = {}) {
  return {
    prepare(sql) {
      let args = [];
      const api = {
        bind(...a) {
          args = a;
          return api;
        },
        async first() {
          if (sql.includes("FROM users")) {
            return users.find((u) => u.email === args[0]) || null;
          }
          if (sql.includes("FROM app_state")) {
            const row = state.get(args[0]);
            return row ? { key: args[0], ...row } : null;
          }
          return null;
        },
        async run() {
          if (sql.includes("INSERT INTO app_state")) {
            state.set(args[0], { value: args[1], updated_at: "now", updated_by: args[2] });
          }
          if (sql.includes("DELETE FROM app_state")) state.delete(args[0]);
          return { success: true };
        },
      };
      return api;
    },
    _state: state,
  };
}

const baseEnv = (db) => ({
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  REQUIRE_USER_ROW: "true",
  DB: db,
  ASSETS: { fetch: async () => new Response("<html>CRM</html>", { headers: { "content-type": "text/html" } }) },
});

const req = (path, init = {}) => new Request(`https://crm.rasafoodhub.com${path}`, init);
const authed = async (path, email, init = {}) =>
  req(path, { ...init, headers: { "Cf-Access-Jwt-Assertion": await tokenFor(email), ...(init.headers || {}) } });

const ADMIN = "rasafoodhubplt@gmail.com";
const STAFF = "ahkit@example.com";
const users = [
  { email: ADMIN, name: "Rasa Admin", role: "admin" },
  { email: STAFF, name: "Ah Kit", role: "staff" },
];

test.beforeEach(() => clearJwksCache());

/* ------------------------------ 挡下来 ------------------------------ */

test("没登入打首页 -> 403，不会吐出 CRM", async () => {
  const res = await worker.fetch(req("/"), baseEnv(fakeDb({ users })));
  assert.equal(res.status, 403);
  assert.ok(!(await res.text()).includes("CRM</html>"));
});

test("没登入打 /api/me -> 401", async () => {
  const res = await worker.fetch(req("/api/me"), baseEnv(fakeDb({ users })));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).reason, "no_token");
});

test("只带纯文字 email 标头（伪造）-> 挡掉", async () => {
  const res = await worker.fetch(
    req("/api/me", { headers: { "Cf-Access-Authenticated-User-Email": ADMIN } }),
    baseEnv(fakeDb({ users }))
  );
  assert.equal(res.status, 401);
});

test("没登入也读不到 CRM 资料", async () => {
  const res = await worker.fetch(req("/api/storage/rasa-crm:main"), baseEnv(fakeDb({ users })));
  assert.equal(res.status, 401);
});

/* ------------------------------ 放行 ------------------------------ */

test("admin 登入 -> /api/me 回 admin", async () => {
  const res = await worker.fetch(await authed("/api/me", ADMIN), baseEnv(fakeDb({ users })));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.email, ADMIN);
  assert.equal(body.user.role, "admin");
  assert.equal(body.user.isAdmin, true);
});

test("staff 登入 -> isAdmin 是 false（前端据此藏起团队活动）", async () => {
  const res = await worker.fetch(await authed("/api/me", STAFF), baseEnv(fakeDb({ users })));
  const body = await res.json();
  assert.equal(body.user.role, "staff");
  assert.equal(body.user.isAdmin, false);
});

test("登入后拿得到 CRM 页面", async () => {
  const res = await worker.fetch(await authed("/", ADMIN), baseEnv(fakeDb({ users })));
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes("CRM"));
});

test("/api/admin/* 只有 admin 进得去", async () => {
  const env = baseEnv(fakeDb({ users }));
  assert.equal((await worker.fetch(await authed("/api/admin/anything", STAFF), env)).status, 403);
  // admin 会穿过这道检查，往下走到静态资源
  assert.equal((await worker.fetch(await authed("/api/admin/anything", ADMIN), env)).status, 200);
});

/* --------------------------- 资料存取 --------------------------- */

test("存进去再读出来，而且记得是谁改的", async () => {
  const env = baseEnv(fakeDb({ users }));
  const put = await worker.fetch(
    await authed("/api/storage/rasa-crm:main", ADMIN, {
      method: "PUT",
      body: JSON.stringify({ value: '{"customers":[]}' }),
    }),
    env
  );
  assert.equal(put.status, 200);

  const get = await worker.fetch(await authed("/api/storage/rasa-crm:main", ADMIN), env);
  const body = await get.json();
  assert.equal(body.value, '{"customers":[]}');
  assert.equal(body.updatedBy, ADMIN);
});

test("没存过的 key 回 404（前端当成「第一次使用」）", async () => {
  const res = await worker.fetch(await authed("/api/storage/rasa-crm:log", ADMIN), baseEnv(fakeDb({ users })));
  assert.equal(res.status, 404);
});

test("乱七八糟的 key 会被挡", async () => {
  const res = await worker.fetch(await authed("/api/storage/..%2Fetc%2Fpasswd", ADMIN), baseEnv(fakeDb({ users })));
  assert.equal(res.status, 400);
});

test("超过 1 MiB 的资料会被挡", async () => {
  const res = await worker.fetch(
    await authed("/api/storage/rasa-crm:main", ADMIN, {
      method: "PUT",
      body: JSON.stringify({ value: "x".repeat(1024 * 1024 + 1) }),
    }),
    baseEnv(fakeDb({ users }))
  );
  assert.equal(res.status, 413);
});

/* ------------------------- users 表与诊断 ------------------------- */

test("通过 Access 但不在 users 表里 -> 挡掉（REQUIRE_USER_ROW=true）", async () => {
  const res = await worker.fetch(await authed("/api/me", "stranger@example.com"), baseEnv(fakeDb({ users })));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).reason, "user_not_in_table");
});

test("REQUIRE_USER_ROW=false 时，表里没有的人当 staff", async () => {
  const env = { ...baseEnv(fakeDb({ users })), REQUIRE_USER_ROW: "false" };
  const res = await worker.fetch(await authed("/api/me", "stranger@example.com"), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.role, "staff");
  assert.equal(body.user.knownUser, false);
});

test("/api/authcheck 没登入也回 200，并说明原因", async () => {
  const res = await worker.fetch(req("/api/authcheck"), baseEnv(fakeDb({ users })));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, "no_token");
  assert.ok(body.hint.includes("workers.dev"));
});

test("/api/authcheck 登入后回验证细节，且不外泄完整 AUD", async () => {
  const res = await worker.fetch(await authed("/api/authcheck", ADMIN), baseEnv(fakeDb({ users })));
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.jwt.verified, true);
  assert.equal(body.user.role, "admin");
  assert.ok(!JSON.stringify(body).includes(AUD));
});
