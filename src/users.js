/**
 * users 表：email / name / role / is_active
 *
 * 两层：
 *   Access Policy 决定「能不能进门」
 *   这张表决定「进来之后算不算数、能做什么」
 *
 * 光靠 Access 不够 —— 通过 Access 的人若没在这张表里、或 is_active = 0，
 * 一样进不来。停权不必动 Access 后台，改一个栏位就生效。
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
    "SELECT email, name, role, is_active FROM users WHERE email = ?1"
  )
    .bind(key)
    .first();
  if (!row) return null;
  return {
    email: normalizeEmail(row.email),
    name: row.name || key,
    role: normalizeRole(row.role),
    isActive: Number(row.is_active) === 1,
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
  if (row) {
    // 第二层：Access 决定能不能进门，这里决定进来还算不算数。
    // 停用一个人不必动 Access Policy，改这个栏位立刻生效。
    if (!row.isActive) return { ok: false, reason: "user_inactive" };
    return { ok: true, user: { ...row, knownUser: true } };
  }
  if (strict) return { ok: false, reason: "user_not_in_table" };
  return { ok: true, user: { email: key, name: key.split("@")[0], role: "staff", knownUser: false } };
}
