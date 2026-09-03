/**
 * 电话正规化。
 *
 * 汇入、找重复、跨平台合并、Inbox 搜寻全部比对同一个正规化结果。
 * 少了这一步，「+60 12-345 6789」「0123456789」「60123456789」会是三个不同的人。
 *
 * 规则：去掉所有非数字 → 开头 0 换成国码 → 没有国码就补上预设国码。
 * 结果只有数字，不含 + 号。
 *
 * ⚠️ 正规化的结果只用来比对，不拿来显示。
 *    员工输入什么，画面上就显示什么（customers.phone_raw）。
 */

// 马来西亚。之后要支援别的国家就改这里，或在呼叫端传进来。
export const DEFAULT_COUNTRY_CODE = "60";

export function normalizePhone(raw, countryCode = DEFAULT_COUNTRY_CODE) {
  const text = String(raw ?? "").trim();
  const digits = text.replace(/\D+/g, "");
  if (!digits) return "";

  // 开头有 + 就是已经写成国际格式了，原样收下，不要再补一次国码
  if (text.startsWith("+")) return digits;

  // 国际拨出前缀 00 —— 要排在「开头 0」前面，否则 00601… 会被当成本地号码再补一次国码
  if (digits.startsWith("00")) return digits.replace(/^00/, "");

  // 已经带国码
  if (digits.startsWith(countryCode) && digits.length > countryCode.length) return digits;

  // 本地格式 0xx…… → 去掉开头的 0 再补国码
  if (digits.startsWith("0")) return countryCode + digits.replace(/^0+/, "");

  return countryCode + digits;
}

/**
 * 搜寻用：把使用者打的字转成「可能的号码片段」。
 * 「0123456789」「+60 12-345 6789」「123456789」都要找得到同一个人。
 */
export function phoneSearchVariants(raw, countryCode = DEFAULT_COUNTRY_CODE) {
  const digits = String(raw ?? "").replace(/\D+/g, "");
  if (!digits) return [];
  const out = new Set([digits, normalizePhone(digits, countryCode)]);
  if (digits.startsWith(countryCode)) out.add(digits.slice(countryCode.length));
  if (digits.startsWith("0")) out.add(digits.replace(/^0+/, ""));
  return [...out].filter(Boolean);
}
