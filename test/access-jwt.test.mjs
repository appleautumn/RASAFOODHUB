import test from "node:test";
import assert from "node:assert/strict";
import { verifyAccessJwt, clearJwksCache, readAccessToken } from "../src/access-jwt.js";

const TEAM = "rasafoodhub.cloudflareaccess.com";
const AUD = "aud-tag-for-tests";
const ISSUER = `https://${TEAM}`;
const KID = "test-kid-1";

/* --------------------------- 测试用签章工具 --------------------------- */

const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"]
);
const otherPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"]
);

const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
const jwks = { keys: [{ kty: "RSA", alg: "RS256", use: "sig", kid: KID, n: publicJwk.n, e: publicJwk.e }] };

let jwksRequests = 0;
const fetchImpl = async () => {
  jwksRequests++;
  return new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } });
};

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
function encodeSegment(obj) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function makeToken({ header = {}, claims = {}, signWith = keyPair.privateKey, tamperPayload = null } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const fullHeader = { alg: "RS256", kid: KID, typ: "JWT", ...header };
  const fullClaims = {
    iss: ISSUER,
    aud: [AUD],
    email: "Boss@RasaFoodhub.com",
    iat: now - 10,
    exp: now + 3600,
    ...claims,
  };
  const signingInput = `${encodeSegment(fullHeader)}.${encodeSegment(fullClaims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signWith,
    new TextEncoder().encode(signingInput)
  );
  const head = tamperPayload
    ? `${encodeSegment(fullHeader)}.${encodeSegment({ ...fullClaims, ...tamperPayload })}`
    : signingInput;
  return `${head}.${b64url(new Uint8Array(signature))}`;
}

const verify = (token, extra = {}) =>
  verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD, fetchImpl, ...extra });

test.beforeEach(() => clearJwksCache());

/* ------------------------------- 通过 ------------------------------- */

test("正常的 token 会通过，email 转成小写", async () => {
  const result = await verify(await makeToken());
  assert.equal(result.ok, true);
  assert.equal(result.email, "boss@rasafoodhub.com");
  assert.equal(result.claims.iss, ISSUER);
});

test("team domain 只填名字也能通", async () => {
  const result = await verify(await makeToken(), { teamDomain: "https://rasafoodhub/" });
  assert.equal(result.ok, true);
});

test("aud 可以填逗号分隔的多个值", async () => {
  const result = await verify(await makeToken(), { aud: `other-aud, ${AUD}` });
  assert.equal(result.ok, true);
});

test("公钥会被快取，不会每次请求都去抓 JWKS", async () => {
  jwksRequests = 0;
  await verify(await makeToken());
  await verify(await makeToken());
  assert.equal(jwksRequests, 1);
});

/* ------------------------------- 挡掉 ------------------------------- */

test("没有 token -> no_token", async () => {
  assert.equal((await verify("")).reason, "no_token");
});

test("乱填的字串 -> malformed_token", async () => {
  assert.equal((await verify("not.a.jwt")).reason, "malformed_token");
});

test("alg: none 的伪造 token 会被挡掉", async () => {
  const header = encodeSegment({ alg: "none", kid: KID });
  const payload = encodeSegment({ iss: ISSUER, aud: [AUD], email: "attacker@evil.com", exp: 9e9 });
  assert.equal((await verify(`${header}.${payload}.`)).reason, "unsupported_alg");
});

test("改成 HS256 拿公钥当密钥签的 token 会被挡掉", async () => {
  const header = encodeSegment({ alg: "HS256", kid: KID });
  const payload = encodeSegment({ iss: ISSUER, aud: [AUD], email: "attacker@evil.com", exp: 9e9 });
  assert.equal((await verify(`${header}.${payload}.c2ln`)).reason, "unsupported_alg");
});

test("别人的私钥签的 token -> bad_signature", async () => {
  const token = await makeToken({ signWith: otherPair.privateKey });
  assert.equal((await verify(token)).reason, "bad_signature");
});

test("签完之后偷改 email -> bad_signature", async () => {
  const token = await makeToken({ tamperPayload: { email: "attacker@evil.com" } });
  assert.equal((await verify(token)).reason, "bad_signature");
});

test("aud 不对 -> aud_mismatch", async () => {
  const token = await makeToken({ claims: { aud: ["someone-elses-app"] } });
  assert.equal((await verify(token)).reason, "aud_mismatch");
});

test("iss 不对 -> iss_mismatch", async () => {
  const token = await makeToken({ claims: { iss: "https://evil.cloudflareaccess.com" } });
  assert.equal((await verify(token)).reason, "iss_mismatch");
});

test("过期 -> expired", async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await makeToken({ claims: { iat: now - 7200, exp: now - 3600 } });
  assert.equal((await verify(token)).reason, "expired");
});

test("还没生效 -> not_yet_valid", async () => {
  const token = await makeToken({ claims: { nbf: Math.floor(Date.now() / 1000) + 3600 } });
  assert.equal((await verify(token)).reason, "not_yet_valid");
});

test("没看过的 kid -> unknown_kid", async () => {
  const token = await makeToken({ header: { kid: "kid-we-never-saw" } });
  assert.equal((await verify(token)).reason, "unknown_kid");
});

test("token 里没有 email -> no_email", async () => {
  const token = await makeToken({ claims: { email: "" } });
  assert.equal((await verify(token)).reason, "no_email");
});

test("没设定 ACCESS_AUD 时一律不放行", async () => {
  const result = await verify(await makeToken(), { aud: "" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "config_missing_aud");
});

test("抓不到 JWKS 时不放行", async () => {
  const failing = async () => new Response("nope", { status: 500 });
  const result = await verify(await makeToken(), { fetchImpl: failing });
  assert.equal(result.reason, "jwks_unavailable");
});

/* ---------------------------- token 来源 ---------------------------- */

test("标头优先于 cookie", () => {
  const request = new Request("https://crm.example.com/", {
    headers: { "Cf-Access-Jwt-Assertion": "from-header", Cookie: "CF_Authorization=from-cookie" },
  });
  assert.equal(readAccessToken(request), "from-header");
});

test("没有标头时读 CF_Authorization cookie", () => {
  const request = new Request("https://crm.example.com/", {
    headers: { Cookie: "other=1; CF_Authorization=from-cookie; x=2" },
  });
  assert.equal(readAccessToken(request), "from-cookie");
});

/* --------------------------- 设定值的判读 --------------------------- */

test("AUD 还留着占位说明文字时，当作没设定", async () => {
  for (const placeholder of ["把 AUD tag 贴在这里", "<your-aud>", "{{AUD}}", "   "]) {
    const result = await verify(await makeToken(), { aud: placeholder });
    assert.equal(result.reason, "config_missing_aud", `占位值未被挡下：${placeholder}`);
  }
});

test("长得像真 AUD tag 的值会被接受", async () => {
  const realish = "a".repeat(64);
  const token = await makeToken({ claims: { aud: [realish] } });
  assert.equal((await verify(token, { aud: realish })).ok, true);
});
