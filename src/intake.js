/**
 * 从顾客的讯息里读出个案资料。
 *
 * 顾客收到的是一张固定表格：
 *
 *   Name :
 *   Location :
 *   ID Machine ( Shown on the screen left side) :
 *   Item no :
 *
 * 大部分人会照着填回来，所以这里**只做确定性的解析**，不猜。
 * 有标签就取标签后面的值；没有标签就当作没提供 —— 宁可再问一次，
 * 也不要把一句「我在 KLCC 那台」里的字硬塞进 machine_id。
 * 填错的资料会一路带到付款闸道核实，那时候错的成本比多问一句高太多。
 *
 * 这个档案是纯函式，不碰资料库、不碰 env，所以 whatsapp.js 引它
 * 不会破坏「整包搬走」的性质。
 */

/** 个案要凑齐的四项。少一项就不能进核实。 */
export const REQUIRED_FIELDS = ["name", "locationName", "machineId", "itemNo"];

/** 收据上读出来的三项。图片要人（或之后的视觉模型）看，文字里有就顺手收下。 */
export const RECEIPT_FIELDS = ["receiptDate", "receiptTime", "receiptAmount"];

/**
 * 标签对照表。同一栏位的写法照长度排序后比对，长的先赢 ——
 * 不然 "location name" 会被 "name" 抢走，"id machine" 会被 "machine" 抢走。
 */
const LABELS = [
  ["name", ["name", "nama", "customer name", "your name", "姓名", "名字", "大名"]],
  ["locationName", ["location name", "location", "lokasi", "tempat", "place", "site", "地点", "位置", "地址", "机器地点"]],
  ["machineId", ["id machine", "machine id", "machine no", "no machine", "machine number", "id mesin", "no mesin", "mesin", "machine", "机器编号", "机器号码", "机器 id", "机号", "机台"]],
  ["itemNo", ["item no", "item number", "no item", "item code", "selection", "item", "barang", "商品编号", "货号", "品项", "选项"]],
  ["receiptDate", ["transaction date", "date", "tarikh", "日期"]],
  ["receiptTime", ["transaction time", "time", "masa", "时间"]],
  ["receiptAmount", ["amount", "total", "jumlah", "harga", "price", "金额", "价钱", "总额"]],
];

/** 展平成 [{ field, label }]，长的排前面 */
const LABEL_INDEX = LABELS
  .flatMap(([field, words]) => words.map((label) => ({ field, label })))
  .sort((a, b) => b.label.length - a.label.length);

/** 冒号、全形冒号、等号。刻意不收 "-"：日期里就有。 */
const SEPARATORS = [":", "：", "=", "｜", "|"];

/** 顾客写这些等于没写。当成没提供，继续问。 */
const BLANK_VALUES = new Set([
  "", "-", "--", "?", "??", "x", "xx", "n/a", "na", "nil", "none", "no", "tiada",
  "tak tahu", "tak ingat", "tidak tahu", "不知道", "不记得", "没有", "无", "空",
]);

/** 值最长收多少字。再长的多半是顾客把整段话贴进来了。 */
const MAX_VALUE = 120;

/* --------------------------- 文字清理 --------------------------- */

/**
 * 去掉不可见字元。
 *
 * 这是**输入**的清理，不是原始码规则那条 —— 顾客从别处复制贴上时
 * 常常带着零宽字元，留着会让两串看起来一样的机号比不相等。
 */
function stripInvisible(s) {
  return String(s).replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, "");
}

/** 去掉 WhatsApp 的 * _ ~ 标记、项目符号、行号 */
function cleanLine(line) {
  return stripInvisible(line)
    .replace(/[*_~`]/g, "")
    .replace(/^\s*(?:[-•·>]+|\d+[.)])\s*/, "")
    .replace(/\u00A0/g, " ")
    .trim();
}

/** 标签部分：拿掉括号说明，压小写，只留字母数字与中日韩字元 */
function normalizeLabel(s) {
  return s
    .replace(/[（(][^）)]*[）)]/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, " ")
    .trim();
}

/** 一段文字的结尾是不是某个已知标签 */
function matchLabelAtEnd(text) {
  const head = normalizeLabel(text);
  if (!head || head.length > 40) return null;
  return LABEL_INDEX.find(({ label }) => head === label || head.endsWith(" " + label)) || null;
}

/**
 * 这个标签在原始字串里从哪个字开始。
 *
 * 用标签的**第一个字**往回找，而不是数最后几个字 —— 因为
 * "ID Machine ( Shown on the screen left side)" 正规化之后只剩 "id machine"，
 * 数字数会数到括号里去。
 */
function labelStartIndex(segment, label) {
  const first = label.split(" ")[0];
  const re = new RegExp(`(^|[^a-z0-9一-鿿])(${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  let last = -1;
  let m;
  while ((m = re.exec(segment)) !== null) last = m.index + m[1].length;
  return last;
}

/**
 * 一行里所有的「标签 : 值」。
 *
 * 为什么要扫整行、不是找到第一个冒号就收工：顾客常常把整张表打成一行
 * （`Name : Ali Location : habitat Item no : 23`）。只看第一个冒号的话，
 * 姓名会把后面整串吞掉，地点与品项直接消失 —— 而且不会报错，
 * 画面上只会出现一个很长的名字。这种安静的失败最难发现。
 */
function scanLine(line) {
  const found = [];
  let pos = 0;

  while (pos < line.length) {
    // 下一个分隔符
    let cut = -1;
    for (const sep of SEPARATORS) {
      const i = line.indexOf(sep, pos);
      if (i > pos && (cut === -1 || i < cut)) cut = i;
    }
    if (cut === -1) break;

    const hit = matchLabelAtEnd(line.slice(pos, cut));
    if (!hit) {
      pos = cut + 1;
      continue;
    }

    // 值从分隔符后面开始，到**下一个标签开头**为止
    const valueStart = cut + 1;
    let valueEnd = line.length;
    let scanFrom = valueStart;
    while (scanFrom < line.length) {
      let nextSep = -1;
      for (const sep of SEPARATORS) {
        const i = line.indexOf(sep, scanFrom);
        if (i > scanFrom && (nextSep === -1 || i < nextSep)) nextSep = i;
      }
      if (nextSep === -1) break;
      const nextHit = matchLabelAtEnd(line.slice(valueStart, nextSep));
      if (nextHit) {
        const at = labelStartIndex(line.slice(valueStart, nextSep), nextHit.label);
        if (at > 0) {
          valueEnd = valueStart + at;
          break;
        }
      }
      scanFrom = nextSep + 1;
    }

    found.push({ field: hit.field, value: line.slice(valueStart, valueEnd).trim() });
    pos = valueEnd;
  }

  return found;
}

/* --------------------------- 值的整理 --------------------------- */

function tidy(value) {
  const v = stripInvisible(value)
    .replace(/[*_~`]/g, "")
    .replace(/^["'「『]+|["'」』]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_VALUE);
  return BLANK_VALUES.has(v.toLowerCase()) ? "" : v;
}

/** 机号：大写、去掉中间空白与常见分隔，让 "rfh 001" 跟 "RFH-001" 对得上 */
function tidyMachineId(value) {
  const v = tidy(value);
  if (!v) return "";
  return v.toUpperCase().replace(/[\s\u3000]+/g, "");
}

/** 品项号：多半是 "12" 或 "A5"。只在整串就是号码时才收紧格式。 */
function tidyItemNo(value) {
  const v = tidy(value);
  if (!v) return "";
  const compact = v.replace(/\s+/g, "");
  return /^[A-Za-z]?\d{1,4}[A-Za-z]?$/.test(compact) ? compact.toUpperCase() : v;
}

/** 金额：RM 5.00 / rm5 / 5.00 一律变成 "5.00" */
function tidyAmount(value) {
  const v = tidy(value);
  if (!v) return "";
  const m = v.match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!m) return "";
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? n.toFixed(2) : "";
}

/** 时间：14:30 / 2:30pm / 2.30 PM 一律变成 24 小时制 "14:30" */
function tidyTime(value) {
  const v = tidy(value).toLowerCase();
  const m = v.match(/(\d{1,2})[:.](\d{2})\s*(am|pm)?/);
  if (!m) return "";
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return "";
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * 日期：dd/mm/yyyy、yyyy-mm-dd 都收，一律变成 "YYYY-MM-DD"。
 *
 * 两位数在前一律当日、月在中 —— 马来西亚写法。美式 mm/dd 会读错，
 * 但那不是这里的顾客群，而且读错的日期核实时对不上，会被人看见。
 */
function tidyDate(value) {
  const v = tidy(value);
  let m = v.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return isoDate(m[1], m[2], m[3]);
  m = v.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return isoDate(year, m[2], m[1]);
  }
  return "";
}

function isoDate(y, m, d) {
  const year = Number(y), month = Number(m), day = Number(d);
  if (!(year >= 2000 && year <= 2100) || month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const TIDY = {
  name: tidy,
  locationName: tidy,
  machineId: tidyMachineId,
  itemNo: tidyItemNo,
  receiptDate: tidyDate,
  receiptTime: tidyTime,
  receiptAmount: tidyAmount,
};

/* ------------------------------ 主体 ------------------------------ */

/**
 * 读一段顾客文字，回传读到的栏位。
 *
 * 回传：
 *   fields   只包含真的读到值的栏位
 *   found    读到的栏位名
 *   missing  四项必填里还缺的
 *   labelled 看到几个标签 —— 用来判断「这是回填表格」还是「一句闲聊」
 */
export function extractIntake(text) {
  const lines = String(text || "").split(/\r?\n/).map(cleanLine);
  const fields = {};
  let labelled = 0;

  for (let i = 0; i < lines.length; i++) {
    const segments = scanLine(lines[i]);
    if (!segments.length) continue;
    labelled += segments.length;

    for (const [n, parsed] of segments.entries()) {
      let raw = parsed.value;
      // 标签自己一行、值在下一行。只有这一行最后一个标签才往下看，
      // 而且下一行本身是标签的话就不吃。
      if (!raw && n === segments.length - 1) {
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j]) continue;
          if (scanLine(lines[j]).length) break;
          raw = lines[j];
          i = j;
          break;
        }
      }

      const value = TIDY[parsed.field](raw);
      // 先到先赢：顾客重发时，第一次填的通常才是原始那笔
      if (value && !fields[parsed.field]) fields[parsed.field] = value;
    }
  }

  // 没有标签也能确定的两种形状：RM 金额、完整日期。
  // 这两个的样子够特别，误读的机会低。机号与品项**绝对不从自由文字猜**。
  const flat = stripInvisible(String(text || ""));
  if (!fields.receiptAmount) {
    const m = flat.match(/\bRM\s*(\d+(?:[.,]\d{1,2})?)/i);
    if (m) fields.receiptAmount = tidyAmount(m[1]);
  }
  if (!fields.receiptDate) {
    const m = flat.match(/\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/]\d{1,2}[/]\d{2,4})\b/);
    if (m) fields.receiptDate = tidyDate(m[1]);
  }
  for (const k of Object.keys(fields)) if (!fields[k]) delete fields[k];

  return {
    fields,
    found: Object.keys(fields),
    missing: REQUIRED_FIELDS.filter((f) => !fields[f]),
    labelled,
  };
}

/** 至少两个标签才算「顾客在回填表格」，一个可能只是句子里有冒号 */
export function looksLikeForm(text) {
  return extractIntake(text).labelled >= 2;
}
