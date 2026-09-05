/**
 * 分诊：一则讯息进来，决定「这属于哪一种情况、还缺什么、该不该让 AI 回」。
 *
 * 这一层刻意是**确定性的关键字与状态判断**，不是模型判断。
 * 理由：要转真人的那几条（退款、品质、情绪）不能等模型想清楚才拦，
 * 拦不住的成本是顾客把一句敷衍的机器人回覆截图出去。
 *
 * 模型负责的是「把话讲得像人」，不是「决定要不要回」。
 */

import { extractIntake } from "./intake.js";
import { caseStatus, hasReceipt, missingFields, FIELD_ASK } from "./casefile.js";

/**
 * 命中就直接转真人，不呼叫 AI。
 *
 * 关键字宁可宽一点 —— 误判成「要转真人」只是多一个人看一眼，
 * 漏判是让 AI 去回一件它不该回的事。两边的代价不对等。
 */
export const ESCALATIONS = [
  {
    scenario: "refund_demand",
    words: ["refund", "duit balik", "balik duit", "pulangkan", "chargeback", "退款", "退钱", "还钱", "还我钱"],
  },
  {
    scenario: "quality_expired",
    words: ["expired", "expiry", "basi", "busuk", "rosak", "moldy", "mould", "stale", "sakit perut",
      "food poison", "keracunan", "过期", "发霉", "变质", "坏了", "吃了不舒服", "肚子痛"],
  },
  {
    scenario: "not_returning",
    words: ["tak akan datang", "tak datang lagi", "not coming back", "won't be back", "wont be back",
      "last day", "dah pindah", "moved out", "不会再去", "不会再来", "已经离开"],
  },
  {
    scenario: "paid_twice",
    words: ["twice", "dua kali", "double charge", "charged twice", "两次", "两笔", "重复扣"],
  },
  {
    scenario: "wrong_item",
    words: ["wrong item", "salah barang", "bukan yang saya", "different item", "拿错", "出错", "不是我选"],
  },
  {
    scenario: "angry_threat",
    words: ["complaint", "complain", "lapor", "saman", "viral", "tiktok", "facebook post", "media",
      "consumer tribunal", "投诉", "曝光", "上网", "消协", "告你"],
  },
];

/** 知识库不准答的题目 */
export const UNKNOWN_TOPIC_WORDS = [
  "price", "harga", "berapa ringgit", "how much", "discount", "diskaun", "promo",
  "stock", "sold out", "habis", "restock", "halal", "sugar", "calorie", "kalori",
  "allergy", "alergi", "健康", "成分", "价格", "多少钱", "库存", "补货", "折扣",
];

const PAID_WORDS = ["paid", "payment", "dah bayar", "sudah bayar", "bayar", "byr", "dibayar",
  "tak keluar", "tidak keluar", "not come out", "didn't come out", "did not come out", "stuck",
  "tersangkut", "no item", "barang tak keluar", "付了", "付款", "已付", "没出货", "没出来", "卡住"];

const BACK_WORDS = ["back", "dah sampai", "sampai", "here", "im here", "i'm here", "arrived", "ready",
  "我来了", "我到了", "回来了", "在机器"];

const GREETING_WORDS = ["hi", "hello", "helo", "hai", "salam", "assalamualaikum", "morning", "afternoon",
  "evening", "你好", "哈咯", "在吗", "有人吗"];

const PROGRESS_WORDS = ["how long", "berapa lama", "any update", "update", "still waiting", "lagi",
  "macam mana", "进度", "多久", "还要等", "有消息吗", "怎么样了"];

const MEDIA_ONLY = ["[image]", "[audio]", "[sticker]", "[video]", "[document]"];

/** 工作时间：MON-FRI 8AM-6PM，马来西亚时间（UTC+8） */
export function isAfterHours(date = new Date()) {
  const my = new Date(date.getTime() + 8 * 3600 * 1000);
  const day = my.getUTCDay(); // 0 = 周日
  const hour = my.getUTCHours();
  if (day === 0 || day === 6) return true;
  return hour < 8 || hour >= 18;
}

const norm = (s) => String(s || "").toLowerCase();
const hit = (text, words) => words.find((w) => text.includes(w)) || "";

/**
 * 分诊一则进来的讯息。
 *
 * 参数
 *   text      顾客讲的话
 *   customer  目前的个案（可以是 null，表示新顾客）
 *   now       现在时间，测试可以喂固定值
 *
 * 回传
 *   scenario   建议套哪一条剧本（剧本 id）
 *   escalate   true = 不要让 AI 回，交给人
 *   matched    命中的关键字，方便事后查「为什么判成这样」
 *   extracted  从这一则读出来的栏位
 *   missing    读进去之后还缺的必填项（英文标签，直接可以贴给顾客）
 *   afterHours 现在是不是非工作时间
 */
export function triage({ text, customer = null, now = new Date() } = {}) {
  const raw = String(text || "");
  const t = norm(raw);
  const extract = extractIntake(raw);
  const afterHours = isAfterHours(now);

  // 读到的栏位先叠在个案上，再算缺什么 —— 缺项要算的是「这一则之后」的状态
  const merged = { ...(customer || {}), ...extract.fields };
  const missing = missingFields(merged).map((f) => FIELD_ASK[f] || f);
  const base = { extracted: extract.fields, missing, afterHours };

  // 一、要转真人的：最先拦，任何其他判断都不该盖过它
  for (const rule of ESCALATIONS) {
    const w = hit(t, rule.words);
    if (w) return { ...base, scenario: rule.scenario, escalate: true, matched: w };
  }

  // 二、不准答的题目
  const unknown = hit(t, UNKNOWN_TOPIC_WORDS);
  if (unknown) return { ...base, scenario: "price_stock_health", escalate: false, matched: unknown };

  // 三、只有附件没有文字
  if (!t.trim() || MEDIA_ONLY.some((m) => t.trim() === m)) {
    return { ...base, scenario: "media_only", escalate: false, matched: "" };
  }

  // 四、旧个案的人回来了
  const back = hit(t, BACK_WORDS);
  if (back && customer && ["awaiting_next_visit", "pending_remote", "verifying"].includes(String(customer.stage))) {
    return { ...base, scenario: "returning_old_case", escalate: false, matched: back };
  }

  // 五、顾客在回填表格。
  // 两个标签以上一定是；只有一个标签时，要个案本来就在收资料才算 ——
  // 不然一句「时间: 我等很久了」会被当成填表。
  const collecting = !customer || caseStatus(customer).state === "collecting";
  if (extract.labelled >= 2 || (extract.labelled === 1 && customer && collecting)) {
    const receipt = hasReceipt(merged);
    if (missing.length) return { ...base, scenario: "form_partial", escalate: false, matched: "form" };
    if (!receipt) return { ...base, scenario: "form_complete_no_receipt", escalate: false, matched: "form" };
    return { ...base, scenario: "intake_complete", escalate: false, matched: "form" };
  }

  // 六、只传了收据（读到金额或日期，但四项还没齐）
  if (!extract.labelled && (extract.fields.receiptAmount || extract.fields.receiptDate) && missing.length) {
    return { ...base, scenario: "receipt_only", escalate: false, matched: "receipt" };
  }

  // 七、主诉：付了钱没出货
  const paid = hit(t, PAID_WORDS);
  if (paid) return { ...base, scenario: "paid_not_dispensed", escalate: false, matched: paid };

  // 八、催进度
  const progress = hit(t, PROGRESS_WORDS);
  if (progress && customer && caseStatus(customer).state === "verifying") {
    return { ...base, scenario: "verify_pending", escalate: false, matched: progress };
  }

  // 九、只是打招呼（整句很短而且只有招呼语）
  const greet = hit(t, GREETING_WORDS);
  if (greet && t.trim().length <= 20) {
    return { ...base, scenario: "greeting_only", escalate: false, matched: greet };
  }

  // 十、判断不出来。不猜剧本，让 AI 照整份剧本自己找最近的一条。
  return { ...base, scenario: "", escalate: false, matched: "" };
}
