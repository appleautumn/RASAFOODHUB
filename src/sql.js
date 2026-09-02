/**
 * SQL 与分页的小工具。
 * 这里没有任何字串拼接会碰到使用者输入 —— 值一律走 bind 参数，
 * 只有栏位名与 IN (?,?,?) 的问号数量是程式产生的。
 */

/** IN (?,?,?)：只产生问号，值还是走 bind */
export const placeholders = (n) => Array.from({ length: n }, () => "?").join(", ");

/**
 * D1 一句 SQL 最多绑 100 个参数 —— 比 SQLite 自己的 999 低很多。
 * 「一次把整页顾客的标签捞回来」这种 IN (?,?,…) 一超过就整句失败，
 * 而且是资料量变大之后才会开始炸。列表页要拿几百笔，所以一定要切块。
 */
export const D1_MAX_BINDINGS = 100;
const CHUNK = 90; // 留点余裕给同一句里的其它参数

export function chunk(items, size = CHUNK) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const nowIso = () => new Date().toISOString();

/**
 * 乐观锁用的下一个 updated_at。
 *
 * 一定要严格大于呼叫端读到的那个值，否则同一毫秒内的两次写入会让
 * 「WHERE updated_at = 读到的值」这道锁失效 —— 第二个人的覆盖就沉默通过了。
 */
export function nextUpdatedAt(expected) {
  const now = nowIso();
  if (!expected || now > expected) return now;
  const t = Date.parse(expected);
  if (Number.isNaN(t)) return now;
  return new Date(t + 1).toISOString();
}

/**
 * 同一毫秒内写进来的多笔时间轴事件要能稳定排序。
 * 毫秒 × 1000 再加一个行程内的计数器，跨 isolate 时仍然照时间排。
 */
let seqCounter = 0;
export const nextSeq = () => Date.now() * 1000 + (seqCounter = (seqCounter + 1) % 1000);

/** cursor：把「上一页最后一列的排序值 + id」包起来，不是 offset。资料量大也不会越翻越慢。 */
export function encodeCursor(value, id) {
  const json = JSON.stringify({ v: value ?? "", id });
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(decodeURIComponent(escape(atob(b64))));
    if (typeof parsed?.id !== "string") return null;
    return { v: parsed.v ?? "", id: parsed.id };
  } catch {
    return null;
  }
}

/** 逗号分隔的多选筛选值：?stage=new,verifying */
export function csv(value, { max = 40 } = {}) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
}

/** LIKE 的萬用字元要跳脱，否则使用者打一个 % 就整库全中 */
export const likeEscape = (s) => String(s).replace(/[\\%_]/g, (m) => "\\" + m);

export const boolInt = (v) => (v === true || v === 1 || v === "1" || v === "true" ? 1 : 0);
