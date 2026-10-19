/**
 * 标准话术与地点清单的解析。
 *
 * 这几个函式决定「顾客会收到哪一段文字」，解析错就送错话 ——
 * 所以独立成模组并加测试，而不是埋在元件里。
 */

/** 设定里一行一个地点，空行略过 */
export function parseLocations(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** 展开成给顾客挑的编号清单 */
export function numberedLocations(text) {
  return parseLocations(text)
    .map((l, i) => `${i + 1}. ${l}`)
    .join("\n");
}

/** 文案里的 {{LOCATIONS}} 换成编号清单 */
export function fillTemplate(text, ai) {
  return String(text ?? "").replace(/\{\{\s*LOCATIONS\s*\}\}/g, numberedLocations(ai?.locations));
}

/**
 * 把「标准话术」切成一条一条。
 *
 * 格式：`【情况】什么时候用` 独占一行，下一行起到下一个【情况】为止，
 * 都是要原样送给顾客的文字。
 */
export function parseScripts(text) {
  const out = [];
  for (const part of String(text || "").split(/^【情况】/m)) {
    if (!part.trim()) continue;
    const nl = part.search(/\r?\n/);
    if (nl === -1) continue; // 只有情况描述、没有内文，略过
    const situation = part.slice(0, nl).trim();
    const body = part.slice(nl).replace(/^\r?\n/, "").trim();
    if (situation && body) out.push({ situation, text: body });
  }
  return out;
}

/**
 * 分流用的系统提示：只让模型回一个数字。
 * 模型碰不到话术内文，就不可能改写它。
 */
export function buildPickSystem(scripts) {
  return `你是客服分流助手。下面是几种常见情况，判断顾客这则讯息属于哪一种。

${scripts.map((s, i) => `${i + 1}. ${s.situation}`).join("\n")}

规则：
- 对得上其中一种，只输出那个数字（例如：2）。
- 都对不上，输出 0。
- 不要输出数字以外的任何文字、标点或说明。`;
}

/** 从模型回覆里取出选项编号；取不到或超出范围都算「没对上」 */
export function parsePick(reply, count) {
  // 要连负号一起抓；只抓 \d+ 的话 "-1" 会变成 1，等於送出第 1 条话术
  const n = parseInt(String(reply ?? "").trim().match(/-?\d+/)?.[0] ?? "0", 10);
  return n >= 1 && n <= count ? n : 0;
}

/**
 * 把地点清单解析成「机器编号 → 地点名称」。
 *
 * 一行一台，编号与名称之间用 tab 或两个以上空白隔开：
 *   20312015	LIVE VIBE
 *   25312001   TRX LEVEL 58
 * 没有编号的行（只有名称）会保留名称、编号为空 —— 仍可当地点选项用。
 */
export function parseMachines(text) {
  return parseLocations(text).map((line) => {
    const m = line.match(/^(\S+)(?:\t|\s{2,})(.+)$/);
    return m ? { id: m[1].trim(), name: m[2].trim() } : { id: "", name: line };
  });
}

/**
 * 用顾客报的机器编号查地点。查不到回 null —— 呼叫端不要自己瞎猜。
 * 比对时忽略前後空白与大小写，因为顾客是用手打的。
 */
export function lookupLocation(text, machineId) {
  const key = String(machineId ?? "").trim().toLowerCase();
  if (!key) return null;
  const hit = parseMachines(text).find((m) => m.id && m.id.toLowerCase() === key);
  return hit ? hit.name : null;
}
