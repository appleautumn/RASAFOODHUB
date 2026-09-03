import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { clearJwksCache } from "../src/access-jwt.js";
import { createTestDb, seedUsers } from "./helpers/d1.mjs";

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

const baseEnv = (db, overrides = {}) => ({
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD,
  REQUIRE_USER_ROW: "true",
  DB: db,
  ASSETS: { fetch: async () => new Response("<html>CRM</html>", { headers: { "content-type": "text/html" } }) },
  ...overrides,
});

const req = (path, init = {}) => new Request(`https://crm.rasafoodhub.com${path}`, init);
const authed = async (path, email, init = {}) =>
  req(path, { ...init, headers: { "Cf-Access-Jwt-Assertion": await tokenFor(email), ...(init.headers || {}) } });

const ADMIN = "rasafoodhubplt@gmail.com";
const STAFF = "ahkit@example.com";
const SUSPENDED = "leaver@example.com";
const users = [
  { email: ADMIN, name: "Rasa Admin", role: "admin", is_active: 1 },
  { email: STAFF, name: "Ah Kit", role: "staff", is_active: 1 },
  { email: SUSPENDED, name: "已离职", role: "admin", is_active: 0 },
];

// 正式部署时这个编译期常数固定是 false，本机开发身分整段不存在
globalThis.__ALLOW_DEV_IDENTITY__ = false;

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
  const res = await worker.fetch(req("/api/customers"), baseEnv(fakeDb({ users })));
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
  // admin 穿得过这道角色检查。底下还没有这条 admin 端点，所以是 404 ——
  // 重点是「不是 403」：他没有被角色挡下来。
  const asAdmin = await worker.fetch(await authed("/api/admin/anything", ADMIN), env);
  assert.notEqual(asAdmin.status, 403);
  assert.equal(asAdmin.status, 404);
});

/* --------------------------- 资料存取 --------------------------- */

/** 真的 SQLite + 真的验证：整条路径一起验，不是只验路由 */
function realEnv() {
  const db = createTestDb();
  seedUsers(db, users);
  return baseEnv(db);
}

test("存进去再读出来，而且记得是谁改的", async () => {
  const env = realEnv();
  const post = await worker.fetch(
    await authed("/api/customers", ADMIN, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customer: { id: "c1", name: "Nurul", stage: "new", updatedAt: "2026-09-01T00:00:00.000Z" },
      }),
    }),
    env
  );
  assert.equal(post.status, 201);

  const get = await worker.fetch(await authed("/api/customers/c1", ADMIN), env);
  const body = await get.json();
  assert.equal(body.customer.name, "Nurul");
  assert.equal(body.customer.updatedBy, ADMIN);
});

test("没存过的设定回 404（前端当成「第一次使用」）", async () => {
  const res = await worker.fetch(await authed("/api/settings/apps.ai", ADMIN), realEnv());
  assert.equal(res.status, 404);
});

test("乱七八糟的 id 会被挡", async () => {
  const res = await worker.fetch(await authed("/api/customers/..%2Fetc%2Fpasswd", ADMIN), realEnv());
  assert.equal(res.status, 400);
});

test("超大的请求内容会被挡，而不是让 D1 报怪错", async () => {
  const res = await worker.fetch(
    await authed("/api/settings/apps.ai", ADMIN, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(4 * 1024 * 1024 + 1) }),
    }),
    realEnv()
  );
  assert.equal(res.status, 413);
});

/* --------------------- 观察模式（ACCESS_ENFORCE） --------------------- */

const observing = (db) => baseEnv(db, { ACCESS_ENFORCE: "false" });

test("观察模式：设定填错（AUD 对不上）但有经过 Access -> 放行", async () => {
  const env = observing(fakeDb({ users }));
  env.ACCESS_AUD = "贴错的-aud";
  const res = await worker.fetch(await authed("/api/me", ADMIN), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.user.name, "观察模式");
});

test("观察模式：完全没经过 Access 的请求，一样挡", async () => {
  const env = observing(fakeDb({ users }));
  // 这一条是整个开关最重要的性质 —— 忘记改回 true 也不会把 CRM 公开在网路上
  assert.equal((await worker.fetch(req("/api/me"), env)).status, 401);
  assert.equal((await worker.fetch(req("/"), env)).status, 403);
  assert.equal((await worker.fetch(req("/api/customers"), env)).status, 401);
});

test("观察模式：伪造的纯文字 email 标头不算「经过 Access」", async () => {
  const env = observing(fakeDb({ users }));
  const res = await worker.fetch(
    req("/api/me", { headers: { "Cf-Access-Authenticated-User-Email": ADMIN } }),
    env
  );
  assert.equal(res.status, 401);
});

test("观察模式：不在 users 表里的人也放行，但只有 staff 权限", async () => {
  const env = observing(fakeDb({ users }));
  const res = await worker.fetch(await authed("/api/me", "stranger@example.com"), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.role, "staff");
  // 观察模式不是万能钥匙：admin 专属的东西还是进不去
  assert.equal(
    (await worker.fetch(await authed("/api/admin/x", "stranger@example.com"), env)).status,
    403
  );
});

test("观察模式：authcheck 会大声讲开关开着，并说明本来会失败在哪", async () => {
  const env = observing(fakeDb({ users }));
  env.ACCESS_AUD = "贴错的-aud";
  const body = await (await worker.fetch(await authed("/api/authcheck", ADMIN), env)).json();
  assert.equal(body.config.enforce, false);
  assert.match(body.config.enforceWarning, /观察模式/);
  assert.equal(body.reason, "aud_mismatch");
});

test("预设是强制：没设 ACCESS_ENFORCE 就等于 true", async () => {
  const env = baseEnv(fakeDb({ users }));
  delete env.ACCESS_ENFORCE;
  env.ACCESS_AUD = "贴错的-aud";
  assert.equal((await worker.fetch(await authed("/api/me", ADMIN), env)).status, 401);
  const body = await (await worker.fetch(req("/api/authcheck"), env)).json();
  assert.equal(body.config.enforce, true);
  assert.equal(body.config.enforceWarning, null);
});

test("强制模式下，停权的人不会因为观察模式的程式码而漏进来", async () => {
  const env = observing(fakeDb({ users }));
  // 停权是授权层的决定，观察模式只放宽「验证」那一层 ——
  // 但停权的人在观察模式下会被当成未知使用者放行成 staff，
  // 所以这个模式绝对不能长期开着。这一条把行为钉住，免得日后有人以为它安全。
  const res = await worker.fetch(await authed("/api/me", SUSPENDED), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.role, "staff");

  // 改回强制就挡住
  const strict = baseEnv(fakeDb({ users }));
  assert.equal((await worker.fetch(await authed("/api/me", SUSPENDED), strict)).status, 401);
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

/* ------------------------- 停权（第二层） ------------------------- */

test("is_active = 0 的人，通过 Access 也进不来", async () => {
  const res = await worker.fetch(await authed("/api/me", SUSPENDED), baseEnv(fakeDb({ users })));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).reason, "user_inactive");
});

test("停权的人连首页都拿不到", async () => {
  const res = await worker.fetch(await authed("/", SUSPENDED), baseEnv(fakeDb({ users })));
  assert.equal(res.status, 403);
});

test("停权的人读不到 CRM 资料", async () => {
  const res = await worker.fetch(
    await authed("/api/customers", SUSPENDED),
    baseEnv(fakeDb({ users }))
  );
  assert.equal(res.status, 401);
});

test("停权盖过角色：他在表里是 admin，一样挡", async () => {
  const res = await worker.fetch(await authed("/api/admin/x", SUSPENDED), baseEnv(fakeDb({ users })));
  assert.equal(res.status, 401);
});

test("/api/authcheck 会说是停权，不是没登入", async () => {
  const body = await (await worker.fetch(await authed("/api/authcheck", SUSPENDED), baseEnv(fakeDb({ users })))).json();
  assert.equal(body.ok, false);
  assert.equal(body.reason, "user_inactive");
  assert.ok(body.hint.includes("is_active"));
});

/* --------------------- 本机开发身分（编译期开关） --------------------- */

test("正式产物里（常数为 false）本机身分完全不存在", async () => {
  globalThis.__ALLOW_DEV_IDENTITY__ = false;
  const env = { ...baseEnv(fakeDb({ users })), DEV_BYPASS_EMAIL: ADMIN };
  assert.equal((await worker.fetch(req("/api/me"), env)).status, 401);
  assert.equal((await worker.fetch(req("/"), env)).status, 403);
  assert.equal((await worker.fetch(req("/app.js"), env)).status, 403);
});

test("常数为 false 时，改 hostname 或标头都撬不开", async () => {
  globalThis.__ALLOW_DEV_IDENTITY__ = false;
  const env = { ...baseEnv(fakeDb({ users })), DEV_BYPASS_EMAIL: ADMIN };
  const tries = [
    new Request("http://localhost:8787/api/me"),
    new Request("http://127.0.0.1:8787/api/me"),
    new Request("http://localhost:8787/api/me", { headers: { "cf-ray": "" } }),
    req("/api/me", { headers: { "Cf-Access-Authenticated-User-Email": ADMIN } }),
  ];
  for (const r of tries) assert.equal((await worker.fetch(r, env)).status, 401);
});

test("npm run dev（常数为 true）+ 有设 email -> 放行", async () => {
  globalThis.__ALLOW_DEV_IDENTITY__ = true;
  const env = { ...baseEnv(fakeDb({ users })), DEV_BYPASS_EMAIL: ADMIN };
  const res = await worker.fetch(req("/api/me"), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.role, "admin");
  globalThis.__ALLOW_DEV_IDENTITY__ = false;
});

test("常数为 true 但没设 email -> 还是要验证", async () => {
  globalThis.__ALLOW_DEV_IDENTITY__ = true;
  const res = await worker.fetch(req("/api/me"), baseEnv(fakeDb({ users })));
  assert.equal(res.status, 401);
  globalThis.__ALLOW_DEV_IDENTITY__ = false;
});

test("本机身分不能绕过停权", async () => {
  globalThis.__ALLOW_DEV_IDENTITY__ = true;
  const env = { ...baseEnv(fakeDb({ users })), DEV_BYPASS_EMAIL: SUSPENDED };
  assert.equal((await worker.fetch(req("/api/me"), env)).status, 401);
  globalThis.__ALLOW_DEV_IDENTITY__ = false;
});

test("authcheck 报告本机身分的两个条件", async () => {
  globalThis.__ALLOW_DEV_IDENTITY__ = false;
  const env = { ...baseEnv(fakeDb({ users })), DEV_BYPASS_EMAIL: ADMIN };
  const body = await (await worker.fetch(req("/api/authcheck"), env)).json();
  assert.equal(body.config.devIdentityCompiledIn, false);
  assert.equal(body.config.devIdentityConfigured, true);
});
