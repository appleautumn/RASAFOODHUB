/**
 * users 表：email / name / role
 *
 * 谁能进来是 Cloudflare Access 的 Policy 决定的；
 * 这张表只决定「进来之后是什么角色」。
 */

const ROLES = new Set(["admin", "staff"]);

export function normalizeRole(raw) {
  const role = String(raw || "").trim().toLowerCase();
  return ROLES.has(role) ? role : "staff";
}

export function normalizeEmail(raw) {
  return String(raw || "").trim().toLowerCase();
}

/**
 * 查 users 表。
 * @returns {Promise<{email: string, name: string, role: string} | null>} 查无此人回 null
 */
export async function lookupUser(env, email) {
  const key = normalizeEmail(email);
  if (!key || !env.DB) return null;
  const row = await env.DB.prepare(
    "SELECT email, name, role FROM users WHERE email = ?1"
  )
    .bind(key)
    .first();
  if (!row) return null;
  return {
    email: normalizeEmail(row.email),
    name: row.name || key,
    role: normalizeRole(row.role),
  };
}

/**
 * 把 Access 带进来的 email 解析成这套系统里的使用者。
 *
 * 表里查得到 -> 用表里的 name/role。
 * 查不到     -> 预设当 staff（看不到「团队活动」）；
 *               若把 REQUIRE_USER_ROW 设成 "true"，则查不到就挡掉。
 */
export async function resolveUser(env, email) {
  const key = normalizeEmail(email);
  const strict = String(env.REQUIRE_USER_ROW || "").toLowerCase() === "true";

  if (!env.DB) {
    if (strict) return { ok: false, reason: "db_not_bound" };
    return { ok: true, user: { email: key, name: key.split("@")[0], role: "staff", knownUser: false } };
  }

  const row = await lookupUser(env, key);
  if (row) return { ok: true, user: { ...row, knownUser: true } };
  if (strict) return { ok: false, reason: "user_not_in_table" };
  return { ok: true, user: { email: key, name: key.split("@")[0], role: "staff", knownUser: false } };
}
