import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  LayoutDashboard,
  Users,
  Zap,
  Bot,
  Send,
  History,
  QrCode,
  RefreshCw,
  Search,
  X,
  Plus,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  AlertTriangle,
  Loader2,
  Trash2,
  Pencil,
  Check,
  Play,
  Pause,
  FastForward,
  ShieldAlert,
  ChevronRight,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Storage keys — everything merged into three keys, never one per row */
/* ------------------------------------------------------------------ */
const KEY_MAIN = "rasa-crm:main"; // { customers }
const KEY_LOG = "rasa-crm:log"; // { activities }
const KEY_APPS = "rasa-crm:apps"; // { ai, automation, campaigns }

/* ------------------------------- model ---------------------------- */

const STAGES = [
  { id: "new", label: "新进线", hint: "刚进线，还没开始收资料" },
  { id: "awaiting_data", label: "待收资料", hint: "已发表格，等顾客填" },
  { id: "verifying", label: "核实中", hint: "对机器系统 + FINEXUS" },
  { id: "pending_remote", label: "待远端出货", hint: "已转真人，等 remote" },
  { id: "remote_done", label: "已远端出货", hint: "跟进顾客收到没" },
  { id: "awaiting_next_visit", label: "等待下次到访", hint: "顾客不在现场，会再来" },
  { id: "refund_check", label: "退款检查", hint: "请顾客查 auto refund" },
  { id: "escalated", label: "已升级真人", hint: "AI 停止自动回覆" },
  { id: "dormant", label: "冷线索", hint: "7 天无回覆，暂停追问" },
  { id: "closed", label: "已结束", hint: "已完成或已退款" },
];
const STAGE_MAP = Object.fromEntries(STAGES.map((s) => [s.id, s]));
const QUIET_STAGES = ["dormant", "closed"]; // 不进逾期名单

const PRIORITIES = [
  { id: "high", label: "高" },
  { id: "medium", label: "中" },
  { id: "low", label: "低" },
];

const MACHINE_STATUS = [
  { id: "unknown", label: "未查" },
  { id: "delivered", label: "Delivered" },
  { id: "pending", label: "Pending" },
  { id: "faulty", label: "Faulty" },
];

const FINEXUS_STATUS = [
  { id: "unknown", label: "未查" },
  { id: "captured", label: "Captured" },
  { id: "void", label: "Void" },
  { id: "reverse", label: "Reverse" },
  { id: "refunded", label: "Refunded" },
];

const CONTACT_TYPES = [
  { id: "customer", label: "Customer" },
  { id: "supplier", label: "Supplier" },
  { id: "wholesale", label: "Wholesale" },
];

const BULK_LIMIT = 200;
const PAGE_SIZE = 50;

/* ------------------------------ helpers --------------------------- */

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function todayStr(d = new Date()) {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
}
function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return todayStr(d);
}
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${todayStr(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const isOverdue = (c) =>
  !!c.nextFollowUpDate && c.nextFollowUpDate <= todayStr() && !QUIET_STAGES.includes(c.stage);
const isDueToday = (c) =>
  c.nextFollowUpDate === todayStr() && !QUIET_STAGES.includes(c.stage);

const VIEWS = {
  needs_reply: { label: "需要回覆", test: (c) => c.needsReply && !QUIET_STAGES.includes(c.stage) },
  awaiting_payment: {
    label: "待付款核实",
    test: (c) => c.finexusStatus === "unknown" && !QUIET_STAGES.includes(c.stage),
  },
  overdue: { label: "跟进逾期", test: isOverdue },
  due_today: { label: "今天到期", test: isDueToday },
  aftercare: { label: "售后关怀", test: (c) => c.stage === "remote_done" },
  high_priority: {
    label: "高优先",
    test: (c) => c.priority === "high" && !QUIET_STAGES.includes(c.stage),
  },
};

/* --------------------------- demo data ---------------------------- */

const DEMO_NAMES = [
  "Nurul Aisyah", "Tan Wei Ming", "Muhammad Faiz", "Priya Devi", "Lim Siew Ling",
  "Ahmad Zulkifli", "Chong Kah Yee", "Siti Nurhaliza", "Ravi Kumar", "Wong Jia Hui",
  "Amirul Hakim", "Ong Mei Chen", "Hafiz Rahman", "Kavitha Rajan", "Lee Chun Kit",
  "Farah Adilah", "Goh Wen Xuan", "Syafiq Danial", "Tang Li Wen", "Nadia Izzati",
];
const DEMO_LOCATIONS = [
  "Kolej Vokasional Setapak", "Hospital Selayang Lobby", "Pusat Bandar Puchong",
  "UiTM Shah Alam Blok C", "Stesen LRT Kelana Jaya", "Kilang Sunway Damansara",
  "SMK Taman Melawati", "Klinik Kesihatan Kepong",
];
const DEMO_TAGS = ["回头客", "机器常故障", "员工餐厅", "夜班", "首次投诉"];

function makeDemo(n = 20) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const stage = STAGES[Math.floor(Math.random() * STAGES.length)].id;
    const quiet = QUIET_STAGES.includes(stage);
    const amount = (Math.floor(Math.random() * 12) + 2) * 0.5 + 1;
    out.push({
      id: uid(),
      name: DEMO_NAMES[i % DEMO_NAMES.length],
      whatsapp: "+601" + (Math.floor(Math.random() * 9) + 1) + String(Math.floor(Math.random() * 9000000) + 1000000),
      locationName: DEMO_LOCATIONS[Math.floor(Math.random() * DEMO_LOCATIONS.length)],
      machineId: "RFH-" + String(Math.floor(Math.random() * 400) + 100),
      itemNo: String(Math.floor(Math.random() * 40) + 11),
      receiptDate: addDays(-Math.floor(Math.random() * 9)),
      receiptTime: `${String(Math.floor(Math.random() * 13) + 8).padStart(2, "0")}:${String(Math.floor(Math.random() * 60)).padStart(2, "0")}`,
      receiptAmount: amount.toFixed(2),
      machineStatus: MACHINE_STATUS[Math.floor(Math.random() * MACHINE_STATUS.length)].id,
      finexusStatus: FINEXUS_STATUS[Math.floor(Math.random() * FINEXUS_STATUS.length)].id,
      stage,
      priority: quiet ? "low" : PRIORITIES[Math.floor(Math.random() * PRIORITIES.length)].id,
      tags: Math.random() > 0.55 ? [DEMO_TAGS[Math.floor(Math.random() * DEMO_TAGS.length)]] : [],
      notes: "",
      contactType: Math.random() > 0.92 ? "supplier" : "customer",
      broadcastOptIn: false,
      needsReply: !quiet && Math.random() > 0.55,
      nextFollowUpDate: quiet ? "" : addDays(Math.floor(Math.random() * 7) - 3),
      followUpCount: Math.floor(Math.random() * 3),
      lastInteractionAt: new Date(Date.now() - Math.random() * 9 * 864e5).toISOString(),
      createdAt: new Date(Date.now() - Math.random() * 20 * 864e5).toISOString(),
      updatedAt: new Date().toISOString(),
      timeline: [
        {
          id: uid(),
          at: new Date(Date.now() - Math.random() * 9 * 864e5).toISOString(),
          by: "系统",
          type: "message",
          text: "顾客来讯：saya dah bayar tapi barang tak keluar",
        },
      ],
    });
  }
  return out;
}

function blankCustomer() {
  return {
    id: uid(),
    name: "",
    whatsapp: "",
    locationName: DEMO_LOCATIONS[0],
    machineId: "",
    itemNo: "",
    receiptDate: "",
    receiptTime: "",
    receiptAmount: "",
    machineStatus: "unknown",
    finexusStatus: "unknown",
    stage: "new",
    priority: "medium",
    tags: [],
    notes: "",
    contactType: "customer",
    broadcastOptIn: false,
    needsReply: true,
    nextFollowUpDate: addDays(1),
    followUpCount: 0,
    lastInteractionAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timeline: [],
  };
}

/* ------------------- AI 知识 / 自动化 / 群发 预设 ------------------ */

const DEFAULT_AI = {
  product: `Rasa Foodhub — Malaysia NO 1 Malaysia delight vending machine brand.
售后服务对象：已付款但机器没出货的顾客。

处理资料：Name、Location Name、Machine ID（萤幕左侧）、Item no、Transaction receipt。
机器系统状态：delivered / pending / faulty。
FINEXUS 付款闸道状态：captured / void / reverse / refunded。

工作时间 MON–FRI 8AM–6PM，SAT–SUN OFFDAY。`,
  replyRules: `语气亲切、中英夹夹、少量 emoji，最多 2–3 句。
先谢谢顾客联络，不解释系统内部细节。
资料不齐时，只问缺的那几项，不要整张表重发。
收到 payment / paid / byr / bayar 之类的字，就发收集资料的表格。
非工作时间要说明回覆会慢，但一定会跟进。`,
  salesRules: `售后为主，不主动推销。
个案结束时才用一句感谢 + 欢迎再来。
不谈折扣、不谈补偿金额、不承诺退款时间。
价格、库存、健康或成分声明一律不自己回答。`,
  toneExamples: `a-Hi, Thank you for your message ☺️

*Please fill in the form if you have make payment but item failed to disburse*

Name :
Location :
ID Machine ( Shown on the screen left side) :
Item no :

Send us your *TRANSACTION RECEIPT*

We may response slower after *WORKING HOUR* but we promise never leave you behind. TQ for your patient 🙏❤️

*MON - FRI 8AM - 6PM*
*SAT - SUN OFFDAY*

b-You may give me a call if you need my immediately response.

c-Thank you for your supporting! We look forward to see you again! ❤️`,
};

const AI_BLOCKS = [
  { key: "product", label: "产品知识" },
  { key: "replyRules", label: "回覆规则" },
  { key: "salesRules", label: "销售规则" },
  { key: "toneExamples", label: "语气范例" },
];

/** 命中就不呼叫 AI，直接转真人 */
const ESCALATION_RULES = [
  {
    id: "refund_again",
    label: "顾客再次要求 refund",
    words: ["refund", "duit balik", "balik duit", "pulangkan", "退款", "退钱", "还钱", "chargeback"],
  },
  {
    id: "not_returning",
    label: "顾客不会再回同一地点",
    words: ["tak akan datang", "tak datang lagi", "not coming back", "won't be back", "wont be back",
      "last day", "dah pindah", "pindah", "moved out", "不会再去", "不会再来", "已经离开", "太远"],
  },
  {
    id: "quality",
    label: "产品品质有问题 / 过期",
    words: ["expired", "expiry", "basi", "busuk", "rosak", "moldy", "mould", "mold", "stale",
      "sakit perut", "food poison", "过期", "发霉", "坏了", "变质", "吃了不舒服"],
  },
];

/** 知识库没写的题目，AI 不准猜 */
const UNKNOWN_TOPICS = {
  id: "unknown_topic",
  label: "产品知识没写的问题（价格 / 库存 / 健康声明）",
  words: ["price", "harga", "berapa ringgit", "how much", "discount", "diskaun", "promo",
    "stock", "sold out", "habis", "restock", "halal", "sugar", "calorie", "kalori",
    "allergy", "alergi", "健康", "成分", "价格", "多少钱", "库存", "补货", "折扣"],
};
const UNKNOWN_REPLY = "这个我帮你问一下，稍后回覆你 🙏";

function checkEscalation(text) {
  const t = (text || "").toLowerCase();
  for (const r of ESCALATION_RULES) {
    const w = r.words.find((x) => t.includes(x));
    if (w) return { hit: true, kind: "human", rule: r, matched: w };
  }
  const u = UNKNOWN_TOPICS.words.find((x) => t.includes(x));
  if (u) return { hit: true, kind: "unknown", rule: UNKNOWN_TOPICS, matched: u };
  return { hit: false };
}

const DEFAULT_FLOWS = [
  {
    id: "flow_main",
    name: "Customer Services 主流程",
    status: "enabled",
    steps: [
      { id: "s1", title: "Intake 进线", message: "Hi, Thank you for your message ☺️", options: ["顾客来讯", "顾客来电"] },
      { id: "s2", title: "Collect Data 收资料", message: "请提供 Name / Location / Machine ID / Item no，并附上 TRANSACTION RECEIPT。", options: ["资料齐全", "资料不齐 → Follow Up"] },
      { id: "s3", title: "Summaries 摘要", message: "扫描收据，读出 date / time / amount，整理成个案摘要。", options: ["读得到", "看不清 → 请重拍"] },
      { id: "s4", title: "Verification 核实", message: "对机器系统（delivered / pending / faulty）与 FINEXUS 状态。", options: ["captured", "void / reverse / refunded"] },
      { id: "s5", title: "Captured → 顾客在现场？", message: "请问你现在还在机器旁边吗？", options: ["在现场 → 转真人 remote", "不在但会再来 → 等待下次到访", "不会再来 → 转真人处理退款"] },
      { id: "s6", title: "Remote Done 跟进", message: "已帮你重新出货，请问有拿到东西了吗？", options: ["收到 → 结案", "没收到 → 转真人"] },
      { id: "s7", title: "Greeting 结案", message: "Thank you for your supporting! We look forward to see you again! ❤️", options: ["END"] },
    ],
  },
  {
    id: "flow_refund",
    name: "Void / Refund 检查流程",
    status: "draft",
    steps: [
      { id: "r1", title: "请顾客查 auto refund", message: "系统显示这笔款项没有成功扣款，请帮忙查看银行有没有自动退款 🙏", options: ["已退款", "还没退款"] },
      { id: "r2", title: "认退款截图", message: "可以传退款的截图给我们核对吗？", options: ["截图正确 → 结案", "截图看不清 → 请重传"] },
      { id: "r3", title: "Greeting 结案", message: "Thank you for your supporting! We look forward to see you again! ❤️", options: ["END"] },
    ],
  },
];

const DEFAULT_KEYWORD_RULES = [
  {
    id: "kw_payment",
    name: "付款关键字 → 发收集表格",
    keywords: ["payment", "paid", "byr", "bayar"],
    reply: DEFAULT_AI.toneExamples.split("b-You may")[0].replace(/^a-/, "").trim(),
    enabled: true,
    delayMinutes: 2,
    dailyCap: 200,
    lastRunAt: "",
    runsToday: 0,
  },
  {
    id: "kw_back",
    name: "回来了关键字 → 接回旧个案",
    keywords: ["back", "sampai", "here", "ready", "dah sampai", "arrived", "到了", "我来了"],
    reply: "收到！我们查到你之前的个案了，马上帮你安排出货，请在机器前稍等一下 🙏",
    enabled: true,
    delayMinutes: 0,
    dailyCap: 200,
    lastRunAt: "",
    runsToday: 0,
  },
];

const DEFAULT_APPS = {
  ai: { ...DEFAULT_AI, draftStats: { used: 0, edited: 0, rejected: 0 } },
  automation: {
    masterEnabled: false,
    flows: DEFAULT_FLOWS,
    keywordRules: DEFAULT_KEYWORD_RULES,
    runLog: [],
  },
  campaigns: [],
};

/* --------------------------- Claude 呼叫 -------------------------- */

async function callClaude(system, userText) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("回覆是空的");
  return text;
}

function buildSystem(ai, customer) {
  return `你是 Rasa Foodhub 的售后客服助理，负责处理「已付款但机器没出货」的顾客。

# 产品知识
${ai.product}

# 回覆规则
${ai.replyRules}

# 销售规则
${ai.salesRules}

# 语气范例（模仿这些的语气，不要照抄）
${ai.toneExamples}

# 硬规定
- 最多 2–3 句。
- 只能用上面「产品知识」里写到的资讯。价格、库存、健康或成分声明一律回「${UNKNOWN_REPLY}」，绝对不可以自己猜或推测。
- 遇到再次要求退款、顾客不会再回同一地点、产品品质或过期，只回一句感谢，然后交给真人。
${customer ? `\n# 这位顾客的个案\n姓名：${customer.name}\n地点：${customer.locationName}\nMachine ID：${customer.machineId}\nItem no：${customer.itemNo}\n目前阶段：${STAGE_MAP[customer.stage]?.label}\n机器系统：${customer.machineStatus}\nFINEXUS：${customer.finexusStatus}` : ""}

只输出要发给顾客的讯息本身，不要加任何说明或引号。`;
}

/* ---------------------------- UI atoms ---------------------------- */

const cx = (...a) => a.filter(Boolean).join(" ");

function Pill({ children, tone = "slate" }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700",
    green: "bg-emerald-100 text-emerald-800",
    amber: "bg-amber-100 text-amber-800",
    red: "bg-red-100 text-red-700",
    teal: "bg-teal-100 text-teal-800",
  };
  return (
    <span className={cx("inline-block rounded px-2 py-0.5 text-xs font-medium", tones[tone])}>
      {children}
    </span>
  );
}

function stageTone(id) {
  if (id === "escalated") return "red";
  if (["pending_remote", "refund_check"].includes(id)) return "amber";
  if (id === "closed") return "green";
  if (QUIET_STAGES.includes(id)) return "slate";
  return "teal";
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600";

function Btn({ children, onClick, variant = "default", disabled, className }) {
  const v = {
    default: "bg-white border border-slate-300 text-slate-700 hover:bg-slate-50",
    primary: "bg-teal-700 text-white hover:bg-teal-800",
    ghost: "text-slate-600 hover:bg-slate-100",
    danger: "border border-red-300 text-red-700 hover:bg-red-50",
  }[variant];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "rounded px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40",
        v,
        className
      )}
    >
      {children}
    </button>
  );
}

/* =================================================================== */

export default function App() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [customers, setCustomers] = useState([]);
  const [activities, setActivities] = useState([]);
  // 身分与角色一律来自伺服器（/api/me），不再由前端自己选
  const [identity, setIdentity] = useState(null);
  const [authError, setAuthError] = useState("");
  const [apps, setApps] = useState(DEFAULT_APPS);
  const [page, setPage] = useState("overview");
  const [pipelineStage, setPipelineStage] = useState("all");
  const [pipelineView, setPipelineView] = useState("all");
  const [toast, setToast] = useState("");

  const actorRef = useRef(identity);
  actorRef.current = identity || { email: "", name: "unknown", role: "staff" };

  /* ---------------------------- load ---------------------------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      // 先确认身分。Cloudflare Access 的 JWT 由 worker 验证，前端只收结果。
      try {
        const r = await fetch("/api/me", { credentials: "include" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const data = await r.json();
        if (!data.ok || !data.user) throw new Error("回应里没有 user");
        if (!alive) return;
        setIdentity({ ...data.user, isAdmin: data.user.role === "admin" });
      } catch (e) {
        if (!alive) return;
        setAuthError("拿不到登入身分。重新整理页面会跳回 Cloudflare Access 重新登入；若一直失败，打开 /api/authcheck 看原因。");
        setLoading(false);
        return;
      }

      let main = null;
      let log = null;
      try {
        const r = await window.storage.get(KEY_MAIN);
        main = r ? JSON.parse(r.value) : null;
      } catch (e) {
        main = null; // 第一次使用，没有资料是正常的
      }
      try {
        const r = await window.storage.get(KEY_LOG);
        log = r ? JSON.parse(r.value) : null;
      } catch (e) {
        log = null;
      }
      let appData = null;
      try {
        const r = await window.storage.get(KEY_APPS);
        appData = r ? JSON.parse(r.value) : null;
      } catch (e) {
        appData = null;
      }
      if (!alive) return;
      if (main) {
        setCustomers(main.customers || []);
      }
      if (log) setActivities(log.activities || []);
      if (appData) {
        setApps({
          ai: { ...DEFAULT_APPS.ai, ...(appData.ai || {}) },
          automation: { ...DEFAULT_APPS.automation, ...(appData.automation || {}) },
          campaigns: appData.campaigns || [],
        });
      }
      setLoading(false);
    })().catch((e) => {
      if (!alive) return;
      setLoadError("读取资料失败，画面显示的是空白资料。重新整理再试一次。");
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  /* ---------------------------- save ---------------------------- */
  const saveTimer = useRef(null);
  useEffect(() => {
    if (loading) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await window.storage.set(KEY_MAIN, JSON.stringify({ customers }));
      } catch (e) {
        // 冲突不是「重试一下就好」的错误 —— 别人已经改过这笔，
        // 你手上的版本是旧的，只能重新载入。所以讯息要讲清楚是谁、
        // 而且不能两秒就消失，要留着直到他处理。
        setToast(
          e && e.code === "conflict"
            ? { text: e.message, tone: "conflict", sticky: true }
            : "储存失败，刚才的改动可能没存下来。"
        );
      }
    }, 400);
    return () => clearTimeout(saveTimer.current);
  }, [customers, loading]);

  const appsTimer = useRef(null);
  useEffect(() => {
    if (loading) return;
    clearTimeout(appsTimer.current);
    appsTimer.current = setTimeout(async () => {
      try {
        await window.storage.set(KEY_APPS, JSON.stringify(apps));
      } catch (e) {
        setToast(
          e && e.code === "conflict"
            ? { text: e.message, tone: "conflict", sticky: true }
            : "设定储存失败，刚才的改动可能没存下来。"
        );
      }
    }, 400);
    return () => clearTimeout(appsTimer.current);
  }, [apps, loading]);

  const logTimer = useRef(null);
  useEffect(() => {
    if (loading) return;
    clearTimeout(logTimer.current);
    logTimer.current = setTimeout(async () => {
      try {
        await window.storage.set(KEY_LOG, JSON.stringify({ activities }));
      } catch (e) {
        /* 活动纪录存不下不挡使用 */
      }
    }, 400);
    return () => clearTimeout(logTimer.current);
  }, [activities, loading]);

  // toast 可以是一个字串（大部分呼叫端都这样用），
  // 也可以是 { text, tone, sticky } —— sticky 的不会自己消失。
  const toastInfo = toast
    ? typeof toast === "string"
      ? { text: toast, tone: "info", sticky: false }
      : toast
    : null;

  useEffect(() => {
    if (!toastInfo || toastInfo.sticky) return;
    const t = setTimeout(() => setToast(""), 2600);
    return () => clearTimeout(t);
  }, [toast, toastInfo]);

  /* ------------------- 唯一的活动纪录写入点 -------------------- */
  const logActivity = useCallback((action, target, description) => {
    const a = actorRef.current;
    setActivities((prev) =>
      [
        {
          id: uid(),
          at: new Date().toISOString(),
          actor: a.name,
          role: a.role,
          action,
          target,
          description,
        },
        ...prev,
      ].slice(0, 800)
    );
  }, []);

  /* ------------------------- 资料操作 --------------------------- */

  const touch = (c) => ({ ...c, updatedAt: new Date().toISOString() });

  const pushTimeline = (c, type, text) => ({
    ...c,
    timeline: [
      { id: uid(), at: new Date().toISOString(), by: actorRef.current.name, type, text },
      ...(c.timeline || []),
    ],
  });

  /** 阶段变更的唯一入口：写时间轴 + 冷线索/已结束时清掉跟进 */
  const applyStage = (c, nextStage) => {
    if (c.stage === nextStage) return c;
    const from = STAGE_MAP[c.stage]?.label || c.stage;
    const to = STAGE_MAP[nextStage]?.label || nextStage;
    let next = pushTimeline(
      { ...c, stage: nextStage },
      "stage",
      `阶段从「${from}」改为「${to}」`
    );
    if (QUIET_STAGES.includes(nextStage)) {
      next = { ...next, nextFollowUpDate: "", priority: "low", needsReply: false };
    }
    return touch(next);
  };

  const addCustomer = (data) => {
    const c = touch({ ...blankCustomer(), ...data });
    setCustomers((p) => [c, ...p]);
    logActivity("新增客户", c.name || c.whatsapp || "未命名", `建立个案，阶段「${STAGE_MAP[c.stage].label}」`);
    return c;
  };

  const updateCustomer = (id, patch, logDesc) => {
    setCustomers((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        let next = { ...c, ...patch };
        if (patch.stage && patch.stage !== c.stage) next = applyStage(c, patch.stage);
        else next = touch(next);
        return next;
      })
    );
    const c = customers.find((x) => x.id === id);
    if (patch.stage && c && patch.stage !== c.stage) {
      logActivity(
        "换阶段",
        c.name || c.whatsapp,
        `阶段从「${STAGE_MAP[c.stage]?.label}」改为「${STAGE_MAP[patch.stage]?.label}」`
      );
    } else if (logDesc) {
      logActivity("编辑客户", c?.name || "客户", logDesc);
    }
  };

  const addTimelineNote = (id, text) => {
    setCustomers((prev) =>
      prev.map((c) => (c.id === id ? touch(pushTimeline(c, "note", text)) : c))
    );
    const c = customers.find((x) => x.id === id);
    logActivity("加纪录", c?.name || "客户", text.slice(0, 60));
  };

  /** 群发模拟写纪录，不重复灌爆团队活动 */
  const silentTimeline = (id, text) => {
    setCustomers((prev) =>
      prev.map((c) => (c.id === id ? touch(pushTimeline(c, "campaign", text)) : c))
    );
  };

  /** 自动化执行纪录：success 绿 / fail 红 / shadow 灰 */
  const pushRun = (entry) => {
    setApps((a) => ({
      ...a,
      automation: {
        ...a.automation,
        runLog: [
          { id: uid(), at: new Date().toISOString(), ...entry },
          ...a.automation.runLog,
        ].slice(0, 50),
      },
    }));
  };

  const bulkApply = (ids, patch, label) => {
    const capped = ids.slice(0, BULK_LIMIT);
    setCustomers((prev) =>
      prev.map((c) => {
        if (!capped.includes(c.id)) return c;
        if (patch.stage) return applyStage(c, patch.stage);
        if (patch.addTag) {
          const tags = Array.from(new Set([...(c.tags || []), patch.addTag]));
          return touch(pushTimeline({ ...c, tags }, "system", `批量加标签「${patch.addTag}」`));
        }
        return touch(pushTimeline({ ...c, ...patch }, "system", `批量${label}`));
      })
    );
    logActivity("批量操作", `${capped.length} 位顾客`, label);
  };

  const seedDemo = () => {
    const demo = makeDemo(20);
    setCustomers((p) => [...demo, ...p]);
    logActivity("新增客户", "示范资料", "产生 20 笔示范个案");
    setToast("已加入 20 笔示范资料");
  };

  const resetAll = async () => {
    if (!window.confirm("清空所有顾客、纪录与设定？这个动作无法复原。")) return;
    setCustomers([]);
    setActivities([]);
    setApps(DEFAULT_APPS);
    try {
      await window.storage.delete(KEY_MAIN);
      await window.storage.delete(KEY_LOG);
      await window.storage.delete(KEY_APPS);
      setToast("已清空，可以重新开始");
    } catch (e) {
      setToast("清空画面成功，但储存清除失败。");
    }
  };

  const gotoPipeline = (view) => {
    setPipelineView(view);
    setPipelineStage("all");
    setPage("pipeline");
  };

  /* ------------------------- 导航与权限 ------------------------- */
  const isAdmin = identity?.role === "admin";
  const NAV = [
    { id: "overview", label: "Overview", icon: LayoutDashboard },
    { id: "pipeline", label: "Lead Pipeline", icon: Users },
    { id: "automation", label: "自动化与测试", icon: Zap },
    { id: "ai", label: "AI 助理", icon: Bot },
    { id: "campaign", label: "群发 Campaign", icon: Send },
    { id: "activity", label: "团队活动", icon: History, adminOnly: true },
    { id: "wa", label: "WhatsApp 连接", icon: QrCode, adminOnly: true },
  ];
  const visibleNav = NAV.filter((n) => !n.adminOnly || isAdmin);

  useEffect(() => {
    if ((page === "activity" || page === "wa") && !isAdmin) setPage("overview");
  }, [page, isAdmin]);

  if (authError) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 p-6">
        <div className="max-w-md rounded border border-amber-200 bg-amber-50 p-6 text-center">
          <ShieldAlert className="mx-auto mb-2 h-6 w-6 text-amber-600" />
          <div className="font-medium text-amber-900">无法确认登入身分</div>
          <p className="mt-1 text-sm text-amber-800">{authError}</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="flex items-center gap-3 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">正在读取资料…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      {/* 身分列 */}
      <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-teal-700 text-xs font-bold text-white">
            R
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold">Rasa Foodhub</div>
            <div className="text-[11px] text-slate-500">After-Sale CRM</div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-slate-500">已登入：</span>
          <span className="text-sm font-medium">{identity?.name}</span>
          <span className="font-mono text-xs text-slate-400">{identity?.email}</span>
          {/* 角色由 users 表决定，画面上不能改 */}
          <span
            className={cx(
              "rounded px-2 py-0.5 text-xs font-medium",
              isAdmin ? "bg-teal-50 text-teal-700" : "bg-slate-100 text-slate-600"
            )}
            title="角色由 users 表决定，无法在这里更改"
          >
            {identity?.role}
          </span>
        </div>
      </header>

      {loadError && (
        <div className="flex items-center gap-2 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          <AlertTriangle className="h-4 w-4" /> {loadError}
        </div>
      )}

      <div className="flex flex-1 flex-col md:flex-row">
        {/* 导航 */}
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-white p-2 md:w-56 md:flex-col md:overflow-visible md:border-b-0 md:border-r">
          {visibleNav.map((n) => {
            const Icon = n.icon;
            const active = page === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setPage(n.id)}
                className={cx(
                  "flex shrink-0 items-center gap-2 rounded px-3 py-2 text-sm font-medium transition",
                  active ? "bg-teal-700 text-white" : "text-slate-600 hover:bg-slate-100"
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="whitespace-nowrap">{n.label}</span>
              </button>
            );
          })}
        </nav>

        {/* 主内容 */}
        <main className="min-w-0 flex-1 p-4">
          {page === "overview" && (
            <Overview customers={customers} onJump={gotoPipeline} onSeed={seedDemo} />
          )}
          {page === "pipeline" && (
            <Pipeline
              customers={customers}
              stage={pipelineStage}
              setStage={setPipelineStage}
              view={pipelineView}
              setView={setPipelineView}
              addCustomer={addCustomer}
              updateCustomer={updateCustomer}
              addTimelineNote={addTimelineNote}
              bulkApply={bulkApply}
              seedDemo={seedDemo}
              setToast={setToast}
            />
          )}
          {page === "automation" && (
            <Automation
              apps={apps}
              setApps={setApps}
              customers={customers}
              logActivity={logActivity}
              pushRun={pushRun}
              setToast={setToast}
            />
          )}
          {page === "ai" && (
            <AiAssistant
              apps={apps}
              setApps={setApps}
              customers={customers}
              logActivity={logActivity}
              addTimelineNote={addTimelineNote}
              setToast={setToast}
            />
          )}
          {page === "campaign" && (
            <Campaigns
              apps={apps}
              setApps={setApps}
              customers={customers}
              logActivity={logActivity}
              silentTimeline={silentTimeline}
              setToast={setToast}
            />
          )}
          {page === "activity" &&
            (isAdmin ? (
              <Activity activities={activities} />
            ) : (
              <Blocked />
            ))}
          {page === "wa" && (isAdmin ? <WhatsAppLink /> : <Blocked />)}
        </main>
      </div>

      {/* 底部 */}
      <footer className="flex items-center justify-between border-t border-slate-200 bg-white px-4 py-2 text-[11px] text-slate-400">
        <span className="font-mono">
          {customers.length} 位顾客 · {activities.length} 条纪录
        </span>
        <button
          onClick={resetAll}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-slate-400 hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 className="h-3 w-3" /> resetAll
        </button>
      </footer>

      {toastInfo && (
        <div
          className={cx(
            "fixed bottom-14 left-1/2 z-50 -translate-x-1/2 rounded px-4 py-2 text-sm shadow-lg",
            toastInfo.tone === "conflict"
              ? "flex max-w-xl items-start gap-3 border border-red-300 bg-red-50 text-red-900"
              : "bg-slate-900 text-white"
          )}
        >
          {toastInfo.tone === "conflict" && (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          )}
          <span>{toastInfo.text}</span>
          {toastInfo.sticky && (
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded bg-red-700 px-2 py-1 text-xs font-medium text-white hover:bg-red-800"
              >
                重新载入
              </button>
              <button
                type="button"
                onClick={() => setToast("")}
                className="rounded p-1 text-red-700 hover:bg-red-100"
                aria-label="关闭"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================== Overview =========================== */

function Overview({ customers, onJump, onSeed }) {
  const counts = useMemo(() => {
    const o = {};
    Object.entries(VIEWS).forEach(([k, v]) => {
      o[k] = customers.filter(v.test).length;
    });
    return o;
  }, [customers]);

  const worklist = useMemo(() => {
    const score = (c) => {
      let s = 0;
      if (isOverdue(c)) s += 40;
      if (isDueToday(c)) s += 25;
      if (c.needsReply) s += 30;
      if (c.priority === "high") s += 20;
      if (c.stage === "escalated") s += 35;
      if (c.stage === "pending_remote") s += 15;
      if (c.stage === "remote_done") s += 10;
      return s;
    };
    return customers
      .filter((c) => !QUIET_STAGES.includes(c.stage))
      .map((c) => ({ c, s: score(c) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 15);
  }, [customers]);

  const tones = {
    needs_reply: "border-l-teal-600",
    awaiting_payment: "border-l-sky-600",
    overdue: "border-l-red-600",
    due_today: "border-l-amber-600",
    aftercare: "border-l-emerald-600",
    high_priority: "border-l-violet-600",
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">今天需要处理什么</h1>
        <p className="text-sm text-slate-500">点任何一张卡片，直接跳到 Pipeline 的对应名单。</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {Object.entries(VIEWS).map(([k, v]) => (
          <button
            key={k}
            onClick={() => onJump(k)}
            className={cx(
              "rounded border border-l-4 border-slate-200 bg-white p-4 text-left transition hover:border-slate-300 hover:shadow-sm",
              tones[k]
            )}
          >
            <div className="font-mono text-2xl font-semibold tabular-nums">{counts[k]}</div>
            <div className="mt-1 text-sm text-slate-600">{v.label}</div>
          </button>
        ))}
      </div>

      <section className="rounded border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold">今天的优先工作清单</h2>
          <span className="font-mono text-xs text-slate-400">{worklist.length} 项</span>
        </div>
        {worklist.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            <p>今天没有待处理的个案。</p>
            <button onClick={onSeed} className="mt-3 text-teal-700 underline">
              产生 20 笔示范资料试试
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {worklist.map(({ c }) => (
              <li key={c.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
                <span className="font-medium">{c.name || "未命名"}</span>
                <span className="font-mono text-xs text-slate-400">{c.machineId}</span>
                <Pill tone={stageTone(c.stage)}>{STAGE_MAP[c.stage]?.label}</Pill>
                {c.needsReply && <Pill tone="teal">需要回覆</Pill>}
                {isOverdue(c) && <Pill tone="red">逾期 {c.nextFollowUpDate}</Pill>}
                {c.priority === "high" && <Pill tone="amber">高优先</Pill>}
                <span className="ml-auto font-mono text-xs text-slate-400">{c.locationName}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ============================== Pipeline =========================== */

function Pipeline({
  customers, stage, setStage, view, setView,
  addCustomer, updateCustomer, addTimelineNote, bulkApply, seedDemo, setToast,
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ key: "updatedAt", dir: "desc" });
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [showNew, setShowNew] = useState(false);

  const stageCounts = useMemo(() => {
    const o = { all: customers.length };
    STAGES.forEach((s) => (o[s.id] = 0));
    customers.forEach((c) => (o[c.stage] = (o[c.stage] || 0) + 1));
    return o;
  }, [customers]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let rows = customers;
    if (stage !== "all") rows = rows.filter((c) => c.stage === stage);
    if (view !== "all" && VIEWS[view]) rows = rows.filter(VIEWS[view].test);
    if (needle) {
      rows = rows.filter((c) =>
        [c.name, c.whatsapp, c.machineId, c.locationName, c.itemNo, (c.tags || []).join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(needle)
      );
    }
    const dir = sort.dir === "asc" ? 1 : -1;
    const pOrder = { high: 0, medium: 1, low: 2 };
    return [...rows].sort((a, b) => {
      let av, bv;
      if (sort.key === "priority") {
        av = pOrder[a.priority] ?? 9;
        bv = pOrder[b.priority] ?? 9;
      } else if (sort.key === "stage") {
        av = STAGES.findIndex((s) => s.id === a.stage);
        bv = STAGES.findIndex((s) => s.id === b.stage);
      } else if (sort.key === "receiptAmount") {
        av = Number(a.receiptAmount) || -1;
        bv = Number(b.receiptAmount) || -1;
      } else {
        av = (a[sort.key] || "").toString().toLowerCase();
        bv = (b[sort.key] || "").toString().toLowerCase();
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [customers, stage, view, q, sort]);

  useEffect(() => setLimit(PAGE_SIZE), [stage, view, q, sort]);

  const shown = filtered.slice(0, limit);
  const open = customers.find((c) => c.id === openId) || null;

  const toggle = (id) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= BULK_LIMIT ? (setToast(`一次最多选 ${BULK_LIMIT} 位`), s) : [...s, id]));

  const selectAllShown = () => {
    const ids = shown.map((c) => c.id).slice(0, BULK_LIMIT);
    if (shown.length > BULK_LIMIT) setToast(`只选取前 ${BULK_LIMIT} 位，这是批量上限`);
    setSelected(ids);
  };

  const sortBtn = (key, label) => (
    <button
      onClick={() =>
        setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }))
      }
      className="flex items-center gap-1 hover:text-slate-900"
    >
      {label}
      {sort.key === key &&
        (sort.dir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="text-lg font-semibold">Lead Pipeline</h1>
          <p className="text-sm text-slate-500">点阶段卡片筛选下方名单。</p>
        </div>
        <div className="ml-auto flex gap-2">
          <Btn onClick={seedDemo}>产生 20 笔示范资料</Btn>
          <Btn variant="primary" onClick={() => setShowNew(true)}>
            <Plus className="mr-1 inline h-4 w-4" />新增客户
          </Btn>
        </div>
      </div>

      {/* 阶段卡片 */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StageCard
          label="全部"
          count={stageCounts.all}
          active={stage === "all"}
          onClick={() => setStage("all")}
        />
        {STAGES.map((s) => (
          <StageCard
            key={s.id}
            label={s.label}
            hint={s.hint}
            count={stageCounts[s.id] || 0}
            active={stage === s.id}
            onClick={() => setStage(stage === s.id ? "all" : s.id)}
          />
        ))}
      </div>

      {/* 工具列 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜寻姓名、号码、Machine ID、地点、Item no…"
            className={cx(inputCls, "pl-8")}
          />
        </div>
        <select value={view} onChange={(e) => setView(e.target.value)} className={cx(inputCls, "w-auto")}>
          <option value="all">全部名单</option>
          {Object.entries(VIEWS).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <span className="font-mono text-xs text-slate-400">
          {filtered.length} 笔
        </span>
      </div>

      {selected.length > 0 && (
        <BulkBar
          count={selected.length}
          onClear={() => setSelected([])}
          onApply={(patch, label) => {
            bulkApply(selected, patch, label);
            setSelected([]);
            setToast(`已对 ${Math.min(selected.length, BULK_LIMIT)} 位顾客${label}`);
          }}
        />
      )}

      {/* 名单 */}
      <div className="overflow-x-auto rounded border border-slate-200 bg-white">
        <table className="w-full min-w-[1120px] text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  checked={shown.length > 0 && selected.length >= Math.min(shown.length, BULK_LIMIT)}
                  onChange={(e) => (e.target.checked ? selectAllShown() : setSelected([]))}
                />
              </th>
              <th className="px-3 py-2">{sortBtn("name", "顾客")}</th>
              <th className="px-3 py-2">{sortBtn("machineId", "Machine")}</th>
              <th className="px-3 py-2">{sortBtn("locationName", "机器名称")}</th>
              <th className="px-3 py-2">{sortBtn("receiptDate", "交易时间")}</th>
              <th className="px-3 py-2 text-right">{sortBtn("receiptAmount", "交易金额")}</th>
              <th className="px-3 py-2">{sortBtn("stage", "阶段")}</th>
              <th className="px-3 py-2">{sortBtn("priority", "优先")}</th>
              <th className="px-3 py-2">{sortBtn("nextFollowUpDate", "下次跟进")}</th>
              <th className="px-3 py-2">{sortBtn("updatedAt", "最后更新")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((c) => (
              <tr
                key={c.id}
                onClick={() => setOpenId(c.id)}
                className={cx(
                  "cursor-pointer hover:bg-slate-50",
                  selected.includes(c.id) && "bg-teal-50"
                )}
              >
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.includes(c.id)}
                    onChange={() => toggle(c.id)}
                  />
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium">{c.name || "未命名"}</div>
                  <div className="font-mono text-xs text-slate-400">{c.whatsapp}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {c.needsReply && <Pill tone="teal">需要回覆</Pill>}
                    {(c.tags || []).map((t) => (
                      <Pill key={t}>{t}</Pill>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="font-mono text-xs">{c.machineId || "—"}</div>
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">
                  {c.locationName || <span className="text-slate-300">—</span>}
                </td>
                <td className="px-3 py-2">
                  {c.receiptDate || c.receiptTime ? (
                    <div className="font-mono text-xs text-slate-600">
                      <div>{c.receiptDate || "—"}</div>
                      <div className="text-slate-400">{c.receiptTime || "--:--"}</div>
                    </div>
                  ) : (
                    <span className="text-xs text-slate-300">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  {c.receiptAmount ? (
                    <span className="font-mono text-xs tabular-nums text-slate-700">
                      RM {Number(c.receiptAmount).toFixed(2)}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-300">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Pill tone={stageTone(c.stage)}>{STAGE_MAP[c.stage]?.label}</Pill>
                </td>
                <td className="px-3 py-2 text-xs">
                  {PRIORITIES.find((p) => p.id === c.priority)?.label}
                </td>
                <td className="px-3 py-2">
                  {c.nextFollowUpDate ? (
                    <span
                      className={cx(
                        "font-mono text-xs",
                        isOverdue(c) ? "font-semibold text-red-600" : "text-slate-600"
                      )}
                    >
                      {c.nextFollowUpDate}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-300">—</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-slate-400">
                  {fmtTime(c.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <div className="p-10 text-center text-sm text-slate-500">
            没有符合条件的顾客。换个筛选，或新增一位。
          </div>
        )}
      </div>

      {limit < filtered.length && (
        <div className="text-center">
          <Btn onClick={() => setLimit((l) => l + PAGE_SIZE)}>
            载入更多（还有 {filtered.length - limit} 笔）
          </Btn>
        </div>
      )}

      {open && (
        <Drawer
          customer={open}
          onClose={() => setOpenId(null)}
          onUpdate={updateCustomer}
          onNote={addTimelineNote}
          setToast={setToast}
        />
      )}
      {showNew && (
        <NewCustomer
          onClose={() => setShowNew(false)}
          onSave={(d) => {
            addCustomer(d);
            setShowNew(false);
            setToast("已新增顾客");
          }}
        />
      )}
    </div>
  );
}

function StageCard({ label, hint, count, active, onClick }) {
  return (
    <button
      onClick={onClick}
      title={hint}
      className={cx(
        "rounded border p-3 text-left transition",
        active
          ? "border-teal-700 bg-teal-700 text-white"
          : "border-slate-200 bg-white hover:border-slate-400"
      )}
    >
      <div className="font-mono text-xl font-semibold tabular-nums">{count}</div>
      <div className={cx("text-xs", active ? "text-teal-50" : "text-slate-600")}>{label}</div>
    </button>
  );
}

function BulkBar({ count, onClear, onApply }) {
  const [tag, setTag] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-teal-300 bg-teal-50 px-3 py-2">
      <span className="text-sm font-medium text-teal-900">已选 {count} 位</span>
      <select
        defaultValue=""
        onChange={(e) => {
          if (!e.target.value) return;
          onApply({ stage: e.target.value }, `改阶段为「${STAGE_MAP[e.target.value].label}」`);
          e.target.value = "";
        }}
        className={cx(inputCls, "w-auto")}
      >
        <option value="">改阶段…</option>
        {STAGES.map((s) => (
          <option key={s.id} value={s.id}>{s.label}</option>
        ))}
      </select>
      <select
        defaultValue=""
        onChange={(e) => {
          if (!e.target.value) return;
          onApply(
            { priority: e.target.value },
            `改优先级为「${PRIORITIES.find((p) => p.id === e.target.value).label}」`
          );
          e.target.value = "";
        }}
        className={cx(inputCls, "w-auto")}
      >
        <option value="">改优先级…</option>
        {PRIORITIES.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>
      <input
        value={tag}
        onChange={(e) => setTag(e.target.value)}
        placeholder="加标签…"
        className={cx(inputCls, "w-28")}
      />
      <Btn
        disabled={!tag.trim()}
        onClick={() => {
          onApply({ addTag: tag.trim() }, `加标签「${tag.trim()}」`);
          setTag("");
        }}
      >
        加上
      </Btn>
      <Btn variant="ghost" onClick={onClear} className="ml-auto">取消选取</Btn>
    </div>
  );
}

/* ------------------------------ Drawer ---------------------------- */

function Drawer({ customer: c, onClose, onUpdate, onNote, setToast }) {
  const [note, setNote] = useState("");
  const [tagInput, setTagInput] = useState("");

  const set = (patch, desc) => onUpdate(c.id, patch, desc);

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="flex-1 bg-slate-900/30" onClick={onClose} />
      <aside className="flex w-full max-w-md flex-col overflow-y-auto border-l border-slate-200 bg-white">
        <div className="sticky top-0 flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
          <div className="min-w-0">
            <div className="truncate font-semibold">{c.name || "未命名顾客"}</div>
            <div className="font-mono text-xs text-slate-400">{c.whatsapp}</div>
          </div>
          <button onClick={onClose} className="ml-auto rounded p-1 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <Btn
            variant="primary"
            className="w-full"
            onClick={() => setToast("发讯息功能会在阶段 2 接上 WhatsApp API")}
          >
            <MessageSquare className="mr-1 inline h-4 w-4" />发讯息
          </Btn>

          <div className="grid grid-cols-2 gap-3">
            <Field label="姓名">
              <input value={c.name} onChange={(e) => set({ name: e.target.value }, "改姓名")} className={inputCls} />
            </Field>
            <Field label="WhatsApp">
              <input value={c.whatsapp} onChange={(e) => set({ whatsapp: e.target.value }, "改号码")} className={inputCls} />
            </Field>
            <Field label="Location Name">
              <select value={c.locationName} onChange={(e) => set({ locationName: e.target.value }, "改地点")} className={inputCls}>
                {DEMO_LOCATIONS.map((l) => <option key={l}>{l}</option>)}
              </select>
            </Field>
            <Field label="Machine ID">
              <input value={c.machineId} onChange={(e) => set({ machineId: e.target.value }, "改 Machine ID")} className={inputCls} />
            </Field>
            <Field label="Item No">
              <input value={c.itemNo} onChange={(e) => set({ itemNo: e.target.value }, "改 Item no")} className={inputCls} />
            </Field>
            <Field label="联络人类型">
              <select value={c.contactType} onChange={(e) => set({ contactType: e.target.value }, "改联络人类型")} className={inputCls}>
                {CONTACT_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </Field>
          </div>

          <div className="rounded border border-slate-200 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">收据摘要</div>
            <div className="grid grid-cols-3 gap-2">
              <Field label="日期">
                <input type="date" value={c.receiptDate} onChange={(e) => set({ receiptDate: e.target.value }, "改收据日期")} className={inputCls} />
              </Field>
              <Field label="时间">
                <input value={c.receiptTime} onChange={(e) => set({ receiptTime: e.target.value }, "改收据时间")} placeholder="14:32" className={inputCls} />
              </Field>
              <Field label="金额 RM">
                <input value={c.receiptAmount} onChange={(e) => set({ receiptAmount: e.target.value }, "改金额")} className={inputCls} />
              </Field>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="机器系统">
              <select value={c.machineStatus} onChange={(e) => set({ machineStatus: e.target.value }, "改机器状态")} className={inputCls}>
                {MACHINE_STATUS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="FINEXUS">
              <select value={c.finexusStatus} onChange={(e) => set({ finexusStatus: e.target.value }, "改 FINEXUS 状态")} className={inputCls}>
                {FINEXUS_STATUS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="阶段">
              <select value={c.stage} onChange={(e) => set({ stage: e.target.value })} className={inputCls}>
                {STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="优先级">
              <select value={c.priority} onChange={(e) => set({ priority: e.target.value }, "改优先级")} className={inputCls}>
                {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </Field>
            <Field label="下次跟进日期">
              <input type="date" value={c.nextFollowUpDate || ""} onChange={(e) => set({ nextFollowUpDate: e.target.value }, "改跟进日期")} className={inputCls} />
            </Field>
            <div className="flex items-end gap-4 pb-1">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={c.needsReply} onChange={(e) => set({ needsReply: e.target.checked }, "改需要回覆")} />
                需要回覆
              </label>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={c.broadcastOptIn} onChange={(e) => set({ broadcastOptIn: e.target.checked }, "改群发同意")} />
            Broadcast 允许（预设 No）
          </label>

          {QUIET_STAGES.includes(c.stage) && (
            <div className="rounded bg-slate-100 px-3 py-2 text-xs text-slate-600">
              这个阶段不会出现在逾期名单，跟进日期已清空、优先级设为低。
            </div>
          )}

          <Field label="标签">
            <div className="mb-2 flex flex-wrap gap-1">
              {(c.tags || []).map((t) => (
                <button
                  key={t}
                  onClick={() => set({ tags: c.tags.filter((x) => x !== t) }, `移除标签「${t}」`)}
                  className="rounded bg-slate-100 px-2 py-0.5 text-xs hover:bg-red-100"
                >
                  {t} ×
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder="新标签" className={inputCls} />
              <Btn
                disabled={!tagInput.trim()}
                onClick={() => {
                  set({ tags: Array.from(new Set([...(c.tags || []), tagInput.trim()])) }, `加标签「${tagInput.trim()}」`);
                  setTagInput("");
                }}
              >
                加
              </Btn>
            </div>
          </Field>

          <Field label="备注">
            <textarea value={c.notes} onChange={(e) => set({ notes: e.target.value }, "改备注")} rows={3} className={inputCls} />
          </Field>

          <div className="border-t border-slate-200 pt-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              对话与跟进纪录
            </div>
            <div className="mb-3 flex gap-2">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && note.trim()) {
                    onNote(c.id, note.trim());
                    setNote("");
                  }
                }}
                placeholder="加一条纪录…"
                className={inputCls}
              />
              <Btn
                variant="primary"
                disabled={!note.trim()}
                onClick={() => {
                  onNote(c.id, note.trim());
                  setNote("");
                }}
              >
                加入
              </Btn>
            </div>
            <ol className="space-y-3">
              {(c.timeline || []).map((t) => (
                <li key={t.id} className="border-l-2 border-slate-200 pl-3">
                  <div className="font-mono text-[11px] text-slate-400">
                    {fmtTime(t.at)} · {t.by}
                  </div>
                  <div className="text-sm text-slate-700">{t.text}</div>
                </li>
              ))}
              {(c.timeline || []).length === 0 && (
                <li className="text-sm text-slate-400">还没有纪录。</li>
              )}
            </ol>
          </div>
        </div>
      </aside>
    </div>
  );
}

function NewCustomer({ onClose, onSave }) {
  const [d, setD] = useState({ name: "", whatsapp: "", machineId: "", itemNo: "", locationName: DEMO_LOCATIONS[0] });
  const ok = d.name.trim() || d.whatsapp.trim();
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/30 p-4">
      <div className="w-full max-w-md rounded border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center">
          <h2 className="font-semibold">新增客户</h2>
          <button onClick={onClose} className="ml-auto rounded p-1 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3">
          <Field label="姓名">
            <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} className={inputCls} />
          </Field>
          <Field label="WhatsApp">
            <input value={d.whatsapp} onChange={(e) => setD({ ...d, whatsapp: e.target.value })} placeholder="+60…" className={inputCls} />
          </Field>
          <Field label="Location Name">
            <select value={d.locationName} onChange={(e) => setD({ ...d, locationName: e.target.value })} className={inputCls}>
              {DEMO_LOCATIONS.map((l) => <option key={l}>{l}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Machine ID">
              <input value={d.machineId} onChange={(e) => setD({ ...d, machineId: e.target.value })} placeholder="RFH-142" className={inputCls} />
            </Field>
            <Field label="Item No">
              <input value={d.itemNo} onChange={(e) => setD({ ...d, itemNo: e.target.value })} className={inputCls} />
            </Field>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Btn onClick={onClose}>取消</Btn>
          <Btn variant="primary" disabled={!ok} onClick={() => onSave(d)}>建立个案</Btn>
        </div>
      </div>
    </div>
  );
}

/* ============================== Activity =========================== */

/* ========================= WhatsApp 连接 ========================= */

/**
 * 扫码页。只有 admin 看得到（导航已经过滤，后端也会再挡一次）。
 *
 * secret 不经过浏览器：这里只打自己家的 /api/wa/qr，Worker 拿着 secret
 * 去跟桥接机要，我们只拿到结果 —— QR 图片或状态 JSON。
 */
function WhatsAppLink() {
  const [state, setState] = useState({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const objectUrl = useRef(null);

  /** 换掉旧的 blob URL，顺手释放，不然每 20 秒漏一个 */
  const setQrBlob = useCallback((blob) => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = URL.createObjectURL(blob);
    setState({ kind: "qr", src: objectUrl.current });
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/wa/qr", { cache: "no-store" });
      const type = res.headers.get("content-type") || "";

      if (res.ok && type.startsWith("image/")) {
        setQrBlob(await res.blob());
        return;
      }

      const body = await res.json().catch(() => ({}));
      if (body.connected) {
        setState({ kind: "connected", phone: body.phone });
      } else if (body.waiting) {
        setState({ kind: "waiting", detail: body.detail, state: body.state });
      } else {
        setState({
          kind: "error",
          detail: body.detail || body.error || `HTTP ${res.status}`,
          error: body.error,
        });
      }
    } catch (e) {
      setState({ kind: "error", detail: String(e.message || e) });
    }
  }, [setQrBlob]);

  // QR 会过期，桥接机会一直换新的 —— 所以要定期重抓
  useEffect(() => {
    poll();
    const t = setInterval(poll, 20000);
    return () => {
      clearInterval(t);
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, [poll]);

  async function reconnect() {
    setBusy(true);
    setConfirming(false);
    try {
      const res = await fetch("/api/wa/reconnect", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({ kind: "error", detail: body.detail || body.error || `HTTP ${res.status}` });
      } else {
        setState({ kind: "waiting", detail: "已要求重新连结，等待新的 QR…" });
        setTimeout(poll, 2000);
      }
    } catch (e) {
      setState({ kind: "error", detail: String(e.message || e) });
    } finally {
      setBusy(false);
    }
  }

  const badge = {
    loading: ["读取中…", "bg-slate-100 text-slate-600"],
    connected: ["已连线", "bg-emerald-100 text-emerald-800"],
    qr: ["等待扫码", "bg-amber-100 text-amber-800"],
    waiting: ["等待扫码", "bg-amber-100 text-amber-800"],
    error: ["未连线", "bg-rose-100 text-rose-800"],
  }[state.kind] || ["未连线", "bg-rose-100 text-rose-800"];

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">WhatsApp 连接</h1>
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${badge[1]}`}>{badge[0]}</span>
      </div>

      <div className="rounded border border-slate-200 bg-white p-6">
        {state.kind === "loading" && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" /> 正在向桥接机确认状态…
          </div>
        )}

        {state.kind === "connected" && (
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
              <Check className="h-6 w-6 text-emerald-700" />
            </div>
            <div className="font-medium text-slate-900">已连线</div>
            <div className="mt-1 font-mono text-sm text-slate-600">{state.phone || "（号码未回报）"}</div>
            <p className="mt-3 text-xs text-slate-500">
              进来的讯息会自动写进 CRM。重启桥接机不需要重新扫码。
            </p>
          </div>
        )}

        {state.kind === "qr" && (
          <div className="text-center">
            <img
              src={state.src}
              alt="WhatsApp 登入 QR"
              width={320}
              height={320}
              className="mx-auto rounded border border-slate-200"
            />
            <p className="mt-3 text-sm text-slate-600">
              手机 WhatsApp → 设定 → 已连结的装置 → 连结装置，扫这个码
            </p>
            <p className="mt-1 text-xs text-slate-400">QR 会过期，这一页每 20 秒自动换新的</p>
          </div>
        )}

        {state.kind === "waiting" && (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            {state.detail || "桥接机还没产生 QR，稍等…"}
          </div>
        )}

        {state.kind === "error" && (
          <div className="rounded border border-rose-200 bg-rose-50 p-4">
            <div className="flex items-center gap-2 font-medium text-rose-900">
              <AlertTriangle className="h-4 w-4" /> 连不上桥接机
            </div>
            <p className="mt-1 break-words text-sm text-rose-800">{state.detail}</p>
            {state.error === "bridge_not_configured" && (
              <p className="mt-2 text-xs text-rose-700">
                Worker 还没设定 WA_BRIDGE_URL / WA_BRIDGE_SECRET。
              </p>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 rounded border border-slate-200 bg-white p-4">
        <div className="text-sm font-medium text-slate-900">重新连结</div>
        <p className="mt-1 text-xs text-slate-500">
          会中断目前的连线并要求重新扫码。手机不在手边就先不要按。
        </p>

        {!confirming ? (
          <button
            onClick={() => setConfirming(true)}
            disabled={busy}
            className="mt-3 inline-flex items-center gap-1.5 rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" /> 重新连结
          </button>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-sm text-rose-700">确定要断线并重新扫码？</span>
            <button
              onClick={reconnect}
              disabled={busy}
              className="rounded bg-rose-600 px-3 py-1.5 text-sm text-white hover:bg-rose-700 disabled:opacity-50"
            >
              {busy ? "处理中…" : "确定，断线重扫"}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              取消
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Activity({ activities }) {
  const [actor, setActor] = useState("all");
  const [action, setAction] = useState("all");
  const [date, setDate] = useState("");

  const actors = useMemo(() => Array.from(new Set(activities.map((a) => a.actor))), [activities]);
  const actions = useMemo(() => Array.from(new Set(activities.map((a) => a.action))), [activities]);

  const rows = activities.filter(
    (a) =>
      (actor === "all" || a.actor === actor) &&
      (action === "all" || a.action === action) &&
      (!date || a.at.slice(0, 10) === date)
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">团队活动</h1>
        <p className="text-sm text-slate-500">谁做了什么，最新在上。仅 admin 可见。</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <select value={actor} onChange={(e) => setActor(e.target.value)} className={cx(inputCls, "w-auto")}>
          <option value="all">全部成员</option>
          {actors.map((a) => <option key={a}>{a}</option>)}
        </select>
        <select value={action} onChange={(e) => setAction(e.target.value)} className={cx(inputCls, "w-auto")}>
          <option value="all">全部动作</option>
          {actions.map((a) => <option key={a}>{a}</option>)}
        </select>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={cx(inputCls, "w-auto")} />
        {date && <Btn variant="ghost" onClick={() => setDate("")}>清除日期</Btn>}
        <span className="ml-auto self-center font-mono text-xs text-slate-400">{rows.length} 条</span>
      </div>

      <ol className="rounded border border-slate-200 bg-white">
        {rows.map((a) => (
          <li key={a.id} className="flex flex-wrap items-baseline gap-2 border-b border-slate-100 px-4 py-3 text-sm last:border-b-0">
            <span className="font-mono text-xs text-slate-400">{fmtTime(a.at)}</span>
            <span className="font-medium">{a.actor}</span>
            <Pill tone="teal">{a.action}</Pill>
            <span className="text-slate-600">{a.target}</span>
            <span className="w-full text-xs text-slate-500 sm:w-auto">{a.description}</span>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="p-10 text-center text-sm text-slate-500">目前没有符合条件的纪录。</li>
        )}
      </ol>
    </div>
  );
}

function Blocked() {
  return (
    <div className="rounded border border-amber-200 bg-amber-50 p-8 text-center">
      <AlertTriangle className="mx-auto mb-2 h-6 w-6 text-amber-600" />
      <div className="font-medium text-amber-900">这一页只有 admin 可以开启</div>
      <p className="mt-1 text-sm text-amber-800">
        你目前的角色是 staff。要开这一页，请管理员把 users 表里你的 role 改成 admin，再重新整理。
      </p>
    </div>
  );
}

/* ============================= AI 助理 ============================= */

function AiAssistant({ apps, setApps, customers, logActivity, addTimelineNote, setToast }) {
  const ai = apps.ai;
  const setAi = (patch) => setApps((a) => ({ ...a, ai: { ...a.ai, ...patch } }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">AI 助理</h1>
        <p className="text-sm text-slate-500">知识与规矩、快速测试、草稿审核。</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-700">知识与规矩</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          {AI_BLOCKS.map((b) => (
            <KnowledgeBlock
              key={b.key}
              label={b.label}
              value={ai[b.key]}
              onSave={(v) => {
                setAi({ [b.key]: v });
                logActivity("改 AI 设定", b.label, "更新内容并保存");
                setToast(`已保存「${b.label}」，测试立刻生效`);
              }}
            />
          ))}
        </div>
      </section>

      <TestAi ai={ai} />

      <DraftReview
        ai={ai}
        customers={customers}
        setAi={setAi}
        logActivity={logActivity}
        addTimelineNote={addTimelineNote}
        setToast={setToast}
      />
    </div>
  );
}

function KnowledgeBlock({ label, value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  return (
    <div className="rounded border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
        <span className="text-sm font-medium">{label}</span>
        {!editing ? (
          <button
            onClick={() => setEditing(true)}
            className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
          >
            <Pencil className="h-3 w-3" /> 编辑
          </button>
        ) : (
          <div className="ml-auto flex gap-1">
            <Btn variant="ghost" onClick={() => { setDraft(value); setEditing(false); }} className="px-2 py-1 text-xs">
              取消
            </Btn>
            <Btn variant="primary" className="px-2 py-1 text-xs" onClick={() => { onSave(draft); setEditing(false); }}>
              <Check className="mr-1 inline h-3 w-3" />保存
            </Btn>
          </div>
        )}
      </div>
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={10}
          className="w-full resize-y border-0 p-3 font-mono text-xs focus:outline-none"
        />
      ) : (
        <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap p-3 font-sans text-xs leading-relaxed text-slate-600">
          {value || "（空白）"}
        </pre>
      )}
    </div>
  );
}

function TestAi({ ai }) {
  const [msg, setMsg] = useState("Saya dah bayar tapi barang tak keluar");
  const [out, setOut] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setErr("");
    setOut("");
    try {
      const guard = checkEscalation(msg);
      if (guard.hit && guard.kind === "human") {
        setOut(`【规则先拦下】命中「${guard.rule.label}」（关键字：${guard.matched}），实际运作时不会呼叫 AI，直接转真人。`);
        return;
      }
      const text = await callClaude(buildSystem(ai, null), msg);
      setOut(text);
    } catch (e) {
      setErr("AI 没有回应，稍后再试一次。（" + e.message + "）");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold">Test AI</h2>
        <p className="text-xs text-slate-500">这里不写进任何资料。改规则 → 保存 → 马上再测一次。</p>
      </div>
      <div className="space-y-3 p-4">
        <textarea
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          rows={2}
          placeholder="输入一句假的顾客讯息…"
          className={inputCls}
        />
        <Btn variant="primary" onClick={run} disabled={busy || !msg.trim()}>
          {busy ? <><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />测试中…</> : "测试"}
        </Btn>
        {err && (
          <div className="flex gap-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 shrink-0" />{err}
          </div>
        )}
        {out && (
          <div className="whitespace-pre-wrap rounded bg-slate-50 p-3 text-sm text-slate-800">{out}</div>
        )}
      </div>
    </section>
  );
}

function DraftReview({ ai, customers, setAi, logActivity, addTimelineNote, setToast }) {
  const [custId, setCustId] = useState("");
  const [msg, setMsg] = useState("");
  const [state, setState] = useState(null); // {kind:'human'|'draft', text, rule}
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState("");
  const [editing, setEditing] = useState(false);

  const cust = customers.find((c) => c.id === custId) || null;
  const stats = ai.draftStats || { used: 0, edited: 0, rejected: 0 };
  const total = stats.used + stats.edited + stats.rejected;
  const rate = total ? Math.round(((stats.used + stats.edited) / total) * 100) : 0;

  const generate = async () => {
    setBusy(true);
    setErr("");
    setState(null);
    setEditing(false);
    const guard = checkEscalation(msg);
    if (guard.hit && guard.kind === "human") {
      setState({ kind: "human", rule: guard.rule, matched: guard.matched });
      setBusy(false);
      return;
    }
    if (guard.hit && guard.kind === "unknown") {
      setState({ kind: "draft", text: UNKNOWN_REPLY, forcedUnknown: true, matched: guard.matched });
      setEdit(UNKNOWN_REPLY);
      setBusy(false);
      return;
    }
    try {
      const text = await callClaude(buildSystem(ai, cust), msg);
      setState({ kind: "draft", text });
      setEdit(text);
    } catch (e) {
      setErr("产生草稿失败，稍后再试一次。（" + e.message + "）");
    } finally {
      setBusy(false);
    }
  };

  const record = (key, label, finalText) => {
    setAi({ draftStats: { ...stats, [key]: (stats[key] || 0) + 1 } });
    if (cust && finalText) addTimelineNote(cust.id, `AI 草稿（${label}）：${finalText}`);
    logActivity("改 AI 设定", cust?.name || "草稿审核", `草稿${label}`);
    setToast(`已记录：${label}`);
    setState(null);
    setMsg("");
  };

  return (
    <section className="rounded border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">草稿审核</h2>
          <p className="text-xs text-slate-500">AI 只产草稿，预设不发送，等你决定。</p>
        </div>
        <div className="ml-auto text-right">
          <div className="font-mono text-lg font-semibold tabular-nums">{rate}%</div>
          <div className="text-[11px] text-slate-500">
            采纳率 · 照用 {stats.used} / 修改 {stats.edited} / 不用 {stats.rejected}
          </div>
        </div>
      </div>

      <div className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="选一位顾客">
            <select value={custId} onChange={(e) => setCustId(e.target.value)} className={inputCls}>
              <option value="">— 未选择 —</option>
              {customers.slice(0, 300).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || c.whatsapp} · {STAGE_MAP[c.stage]?.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="顾客讯息">
            <input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="例：dah bayar tapi tak keluar" className={inputCls} />
          </Field>
        </div>
        <Btn variant="primary" onClick={generate} disabled={busy || !msg.trim()}>
          {busy ? <><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />产生中…</> : "产生草稿"}
        </Btn>

        {err && (
          <div className="flex gap-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 shrink-0" />{err}
          </div>
        )}

        {state?.kind === "human" && (
          <div className="rounded border-2 border-red-300 bg-red-50 p-4">
            <div className="flex items-center gap-2 font-semibold text-red-700">
              <ShieldAlert className="h-5 w-5" />需转真人
            </div>
            <p className="mt-1 text-sm text-red-800">
              命中「{state.rule.label}」（关键字：{state.matched}）。没有呼叫 AI，请由真人接手。
            </p>
          </div>
        )}

        {state?.kind === "draft" && (
          <div className="rounded border border-slate-200 bg-slate-50 p-4">
            {state.forcedUnknown && (
              <div className="mb-2 rounded bg-amber-100 px-2 py-1 text-xs text-amber-900">
                产品知识里没有这题（关键字：{state.matched}）。AI 不猜，改回固定说法并标记转真人。
              </div>
            )}
            {editing ? (
              <textarea value={edit} onChange={(e) => setEdit(e.target.value)} rows={4} className={inputCls} />
            ) : (
              <div className="whitespace-pre-wrap text-sm text-slate-800">{state.text}</div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {!editing ? (
                <>
                  <Btn variant="primary" onClick={() => record("used", "照用", state.text)}>照用</Btn>
                  <Btn onClick={() => setEditing(true)}>修改后用</Btn>
                  <Btn variant="danger" onClick={() => record("rejected", "不采用", "")}>不采用</Btn>
                </>
              ) : (
                <>
                  <Btn variant="primary" disabled={!edit.trim()} onClick={() => record("edited", "修改后送出", edit.trim())}>
                    送出修改版
                  </Btn>
                  <Btn variant="ghost" onClick={() => setEditing(false)}>取消修改</Btn>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/* ========================== 自动化与测试 =========================== */

function Automation({ apps, setApps, customers, logActivity, pushRun, setToast }) {
  const au = apps.automation;
  const setAu = (patch) =>
    setApps((a) => ({ ...a, automation: { ...a.automation, ...patch } }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">自动化与测试</h1>
        <p className="text-sm text-slate-500">总开关、对话流程、关键字规则、测试台。</p>
      </div>

      {/* 第一区 总开关 */}
      <section
        className={cx(
          "rounded border-2 p-4",
          au.masterEnabled ? "border-emerald-400 bg-emerald-50" : "border-slate-400 bg-slate-100"
        )}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <div className="text-sm font-semibold">自动发送总开关</div>
            <div className="text-xs text-slate-600">
              {au.masterEnabled ? "已开启：符合条件的讯息会真的送出。" : "目前为影子模式：所有规则照样比对并记录，但不会真的送出任何讯息。"}
            </div>
          </div>
          <button
            onClick={() => {
              const next = !au.masterEnabled;
              setAu({ masterEnabled: next });
              logActivity("启停自动化规则", "总开关", next ? "开启自动发送" : "关闭自动发送，回到影子模式");
              setToast(next ? "自动发送已开启" : "已切回影子模式");
            }}
            className={cx(
              "ml-auto rounded px-4 py-2 text-sm font-medium text-white",
              au.masterEnabled ? "bg-emerald-600 hover:bg-emerald-700" : "bg-slate-600 hover:bg-slate-700"
            )}
          >
            {au.masterEnabled ? "关闭自动发送" : "开启自动发送"}
          </button>
        </div>
      </section>

      {/* 第二区 Flow */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-700">对话流程 Flow</h2>
        {au.flows.map((f) => (
          <FlowEditor
            key={f.id}
            flow={f}
            onChange={(next) => setAu({ flows: au.flows.map((x) => (x.id === f.id ? next : x)) })}
            logActivity={logActivity}
            setToast={setToast}
          />
        ))}
      </section>

      {/* 第三区 关键字规则 */}
      <KeywordRules au={au} setAu={setAu} logActivity={logActivity} setToast={setToast} />

      {/* 第四区 测试台 */}
      <TestBench
        apps={apps}
        au={au}
        setAu={setAu}
        customers={customers}
        pushRun={pushRun}
        logActivity={logActivity}
      />
    </div>
  );
}

function FlowEditor({ flow, onChange, logActivity, setToast }) {
  const [openStep, setOpenStep] = useState(null);
  const [dirty, setDirty] = useState(false);

  const patchStep = (id, patch) => {
    onChange({ ...flow, steps: flow.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)), status: "draft" });
    setDirty(true);
  };

  return (
    <div className="rounded border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <span className="text-sm font-medium">{flow.name}</span>
        <Pill tone={flow.status === "enabled" ? "green" : "slate"}>
          {flow.status === "enabled" ? "启用中" : "草稿"}
        </Pill>
        {dirty && <span className="text-xs text-amber-700">已改，尚未启用</span>}
        <div className="ml-auto flex gap-2">
          {flow.status === "enabled" ? (
            <Btn
              onClick={() => {
                onChange({ ...flow, status: "draft" });
                logActivity("启停自动化规则", flow.name, "改回草稿，停止执行");
              }}
            >
              停用
            </Btn>
          ) : (
            <Btn
              variant="primary"
              onClick={() => {
                onChange({ ...flow, status: "enabled" });
                setDirty(false);
                logActivity("启停自动化规则", flow.name, "启用流程");
                setToast(`「${flow.name}」已启用`);
              }}
            >
              启用
            </Btn>
          )}
        </div>
      </div>

      <ol className="p-4">
        {flow.steps.map((s, i) => {
          const open = openStep === s.id;
          return (
            <li key={s.id} className="relative pl-8 pb-4 last:pb-0">
              {i < flow.steps.length - 1 && (
                <span className="absolute left-3 top-7 h-full w-px bg-slate-200" />
              )}
              <span className="absolute left-0 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 font-mono text-[11px] text-slate-600">
                {i + 1}
              </span>
              <button
                onClick={() => setOpenStep(open ? null : s.id)}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-slate-50"
              >
                <span className="text-sm font-medium">{s.title}</span>
                <ChevronRight className={cx("ml-auto h-4 w-4 text-slate-400 transition", open && "rotate-90")} />
              </button>
              {!open && (
                <p className="px-2 text-xs text-slate-500 line-clamp-2">{s.message}</p>
              )}
              {open && (
                <div className="mt-2 space-y-3 rounded border border-slate-200 bg-slate-50 p-3">
                  <Field label="步骤名称">
                    <input value={s.title} onChange={(e) => patchStep(s.id, { title: e.target.value })} className={inputCls} />
                  </Field>
                  <Field label="文案">
                    <textarea value={s.message} onChange={(e) => patchStep(s.id, { message: e.target.value })} rows={3} className={inputCls} />
                  </Field>
                  <Field label="选项（一行一个）">
                    <textarea
                      value={(s.options || []).join("\n")}
                      onChange={(e) => patchStep(s.id, { options: e.target.value.split("\n").filter(Boolean) })}
                      rows={3}
                      className={inputCls}
                    />
                  </Field>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function KeywordRules({ au, setAu, logActivity, setToast }) {
  const [openId, setOpenId] = useState(null);

  const patch = (id, p) =>
    setAu({ keywordRules: au.keywordRules.map((r) => (r.id === id ? { ...r, ...p } : r)) });

  const addRule = () => {
    const r = {
      id: uid(),
      name: "新规则",
      keywords: [],
      reply: "",
      enabled: false,
      delayMinutes: 2,
      dailyCap: 100,
      lastRunAt: "",
      runsToday: 0,
    };
    setAu({ keywordRules: [...au.keywordRules, r] });
    setOpenId(r.id);
    logActivity("启停自动化规则", "关键字规则", "新增一条规则");
  };

  return (
    <section className="rounded border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold">关键字自动回覆规则</h2>
        <Btn className="ml-auto" onClick={addRule}>
          <Plus className="mr-1 inline h-4 w-4" />新增规则
        </Btn>
      </div>
      <ul className="divide-y divide-slate-100">
        {au.keywordRules.map((r) => (
          <li key={r.id} className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => setOpenId(openId === r.id ? null : r.id)} className="text-sm font-medium hover:underline">
                {r.name}
              </button>
              <div className="flex flex-wrap gap-1">
                {r.keywords.map((k) => (
                  <span key={k} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px]">{k}</span>
                ))}
              </div>
              <span className="font-mono text-[11px] text-slate-400">
                延迟 {r.delayMinutes} 分 · 每日上限 {r.dailyCap} · 最后执行 {r.lastRunAt ? fmtTime(r.lastRunAt) : "—"}
              </span>
              <button
                onClick={() => {
                  patch(r.id, { enabled: !r.enabled });
                  logActivity("启停自动化规则", r.name, r.enabled ? "停用" : "启用");
                }}
                className={cx(
                  "ml-auto rounded px-3 py-1 text-xs font-medium",
                  r.enabled ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-600"
                )}
              >
                {r.enabled ? "已启用" : "已停用"}
              </button>
            </div>
            {!au.masterEnabled && r.enabled && (
              <p className="mt-1 text-xs text-slate-500">总开关关着，这条只会比对与记录，不会送出。</p>
            )}
            {openId === r.id && (
              <div className="mt-3 space-y-3 rounded border border-slate-200 bg-slate-50 p-3">
                <Field label="规则名称">
                  <input value={r.name} onChange={(e) => patch(r.id, { name: e.target.value })} className={inputCls} />
                </Field>
                <Field label="关键字（逗号分隔）">
                  <input
                    value={r.keywords.join(", ")}
                    onChange={(e) => patch(r.id, { keywords: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })}
                    className={inputCls}
                  />
                </Field>
                <Field label="回覆内容">
                  <textarea value={r.reply} onChange={(e) => patch(r.id, { reply: e.target.value })} rows={6} className={inputCls} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="延迟几分钟才送（员工先回就取消）">
                    <input type="number" min="0" value={r.delayMinutes} onChange={(e) => patch(r.id, { delayMinutes: Number(e.target.value) })} className={inputCls} />
                  </Field>
                  <Field label="每日上限（次）">
                    <input type="number" min="1" value={r.dailyCap} onChange={(e) => patch(r.id, { dailyCap: Number(e.target.value) })} className={inputCls} />
                  </Field>
                </div>
                <Btn
                  variant="primary"
                  onClick={() => {
                    logActivity("改 AI 设定", r.name, "更新关键字规则");
                    setOpenId(null);
                    setToast("规则已保存");
                  }}
                >
                  保存
                </Btn>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TestBench({ apps, au, setAu, customers, pushRun, logActivity }) {
  const [custId, setCustId] = useState("");
  const [msg, setMsg] = useState("Dah bayar tapi barang tak keluar");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(3);
  const [ttCustId, setTtCustId] = useState("");
  const [ttResult, setTtResult] = useState(null);

  const cust = customers.find((c) => c.id === custId) || null;

  const simulate = async () => {
    setBusy(true);
    setResult(null);
    const text = msg.toLowerCase();
    const rule = au.keywordRules.find(
      (r) => r.enabled && r.keywords.some((k) => text.includes(k.toLowerCase()))
    );
    const guard = checkEscalation(msg);
    const flow = au.flows.find((f) => f.status === "enabled");
    let draft = "";
    let draftNote = "";

    if (guard.hit && guard.kind === "human") {
      draftNote = `命中「${guard.rule.label}」→ 不呼叫 AI，直接转真人`;
    } else if (rule) {
      draft = rule.reply;
      draftNote = `套用规则文案，延迟 ${rule.delayMinutes} 分钟送出`;
    } else {
      try {
        draft = await callClaude(buildSystem(apps.ai, cust), msg);
        draftNote = "没有关键字命中，改由 AI 产草稿";
      } catch (e) {
        draftNote = "AI 草稿产生失败：" + e.message;
      }
    }

    const shadow = !au.masterEnabled;
    const res = {
      rule,
      guard,
      flow: rule ? flow : null,
      draft,
      draftNote,
      shadow,
    };
    setResult(res);

    if (rule) {
      setAu({
        keywordRules: au.keywordRules.map((r) =>
          r.id === rule.id ? { ...r, lastRunAt: new Date().toISOString(), runsToday: (r.runsToday || 0) + 1 } : r
        ),
      });
    }

    pushRun({
      type: guard.hit && guard.kind === "human" ? "fail" : shadow ? "shadow" : "success",
      title: `模拟收讯 · ${cust ? cust.name : "未指定顾客"}`,
      detail:
        (rule ? `命中规则「${rule.name}」` : guard.hit && guard.kind === "human" ? `转真人：${guard.rule.label}` : "交给 AI 草稿") +
        (shadow ? "｜已比对，未送出（影子模式）" : "｜已送出"),
    });
    logActivity("启停自动化规则", "测试台", `模拟收讯：${msg.slice(0, 40)}`);
    setBusy(false);
  };

  const timeTravel = () => {
    const c = customers.find((x) => x.id === ttCustId);
    if (!c) return;
    const hits = [];
    if (c.stage === "awaiting_data" && days >= 1)
      hits.push("停在「待收资料」超过 1 天 → 触发 Follow Up，只问缺的资料");
    if (c.stage === "awaiting_next_visit" && days >= 6 && days < 7)
      hits.push("第 6 天 → 发一次温馨提醒");
    if (c.stage === "awaiting_next_visit" && days >= 7)
      hits.push("停在「等待下次到访」满 7 天无回覆 → 转「冷线索」，停止追问");
    if (c.nextFollowUpDate && addDays(days) >= c.nextFollowUpDate && !QUIET_STAGES.includes(c.stage))
      hits.push(`下次跟进日期 ${c.nextFollowUpDate} 已到 → 进入逾期名单`);
    if (hits.length === 0) hits.push("这段时间内没有时间型规则会触发。");

    setTtResult({ name: c.name, stage: STAGE_MAP[c.stage]?.label, hits });
    pushRun({
      type: au.masterEnabled ? "success" : "shadow",
      title: `时间快转 ${days} 天 · ${c.name}`,
      detail: hits.join("；") + (au.masterEnabled ? "" : "｜已比对，未送出（影子模式）"),
    });
    logActivity("启停自动化规则", "测试台", `时间快转 ${days} 天：${c.name}`);
  };

  const logTone = { success: "text-emerald-700 bg-emerald-50", fail: "text-red-700 bg-red-50", shadow: "text-slate-500 bg-slate-100" };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-slate-700">测试台</h2>

      <div className="rounded border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-medium">1 · 模拟收到讯息</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="选客户">
            <select value={custId} onChange={(e) => setCustId(e.target.value)} className={inputCls}>
              <option value="">— 未选择 —</option>
              {customers.slice(0, 300).map((c) => (
                <option key={c.id} value={c.id}>{c.name || c.whatsapp}</option>
              ))}
            </select>
          </Field>
          <Field label="讯息内容">
            <input value={msg} onChange={(e) => setMsg(e.target.value)} className={inputCls} />
          </Field>
        </div>
        <Btn variant="primary" className="mt-3" onClick={simulate} disabled={busy || !msg.trim()}>
          {busy ? <><Loader2 className="mr-1 inline h-4 w-4 animate-spin" />跑流程中…</> : "跑一次收讯流程"}
        </Btn>

        {result && (
          <div className="mt-3 space-y-2 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
            <div
              className={cx(
                "inline-block rounded px-2 py-1 text-xs font-medium",
                result.shadow ? "bg-slate-300 text-slate-800" : "bg-emerald-600 text-white"
              )}
            >
              {result.shadow ? "已比对，未送出（影子模式）" : "已送出"}
            </div>
            <div>
              <span className="text-slate-500">命中：</span>
              {result.guard.hit && result.guard.kind === "human"
                ? <span className="font-medium text-red-700">转真人 — {result.guard.rule.label}</span>
                : result.rule
                ? <span className="font-medium">规则「{result.rule.name}」</span>
                : <span className="text-slate-600">没有关键字规则命中</span>}
            </div>
            {result.flow && (
              <div><span className="text-slate-500">进入流程：</span>{result.flow.name} → {result.flow.steps[1]?.title}</div>
            )}
            <div className="text-xs text-slate-500">{result.draftNote}</div>
            {result.draft && (
              <pre className="whitespace-pre-wrap rounded bg-white p-2 text-xs text-slate-800">{result.draft}</pre>
            )}
          </div>
        )}
      </div>

      <div className="rounded border border-slate-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-medium">2 · 时间快转</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[180px] flex-1">
            <Field label="选客户">
              <select value={ttCustId} onChange={(e) => setTtCustId(e.target.value)} className={inputCls}>
                <option value="">— 未选择 —</option>
                {customers.slice(0, 300).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || c.whatsapp} · {STAGE_MAP[c.stage]?.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="w-32">
            <Field label="假装过了几天">
              <input type="number" min="1" value={days} onChange={(e) => setDays(Number(e.target.value))} className={inputCls} />
            </Field>
          </div>
          <Btn variant="primary" onClick={timeTravel} disabled={!ttCustId}>
            <FastForward className="mr-1 inline h-4 w-4" />快转
          </Btn>
        </div>
        {ttResult && (
          <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
            <div className="mb-1 text-xs text-slate-500">
              {ttResult.name} · 目前在「{ttResult.stage}」
            </div>
            <ul className="list-disc space-y-1 pl-4">
              {ttResult.hits.map((h, i) => <li key={i}>{h}</li>)}
            </ul>
          </div>
        )}
      </div>

      <div className="rounded border border-slate-200 bg-white">
        <div className="flex items-center border-b border-slate-200 px-4 py-3">
          <h3 className="text-sm font-medium">3 · 执行纪录</h3>
          <span className="ml-auto font-mono text-xs text-slate-400">最近 {au.runLog.length} / 50 笔</span>
        </div>
        <ul className="divide-y divide-slate-100">
          {au.runLog.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline gap-2 px-4 py-2 text-sm">
              <span className={cx("rounded px-1.5 py-0.5 text-[11px] font-medium", logTone[r.type])}>
                {r.type === "success" ? "成功" : r.type === "fail" ? "转真人" : "影子"}
              </span>
              <span className="font-mono text-xs text-slate-400">{fmtTime(r.at)}</span>
              <span className="font-medium">{r.title}</span>
              <span className="w-full text-xs text-slate-500 sm:w-auto">{r.detail}</span>
            </li>
          ))}
          {au.runLog.length === 0 && (
            <li className="p-8 text-center text-sm text-slate-500">还没有执行纪录。跑一次模拟就会出现。</li>
          )}
        </ul>
      </div>
    </section>
  );
}

/* ========================= 群发 Campaign =========================== */

const CAMPAIGN_STATUS = {
  draft: { label: "草稿", tone: "slate" },
  sending: { label: "发送中", tone: "teal" },
  paused: { label: "暂停", tone: "amber" },
  done: { label: "完成", tone: "green" },
  cancelled: { label: "已取消", tone: "red" },
};

function Campaigns({ apps, setApps, customers, logActivity, silentTimeline, setToast }) {
  const [building, setBuilding] = useState(false);
  const list = apps.campaigns;

  const setList = (next) => setApps((a) => ({ ...a, campaigns: next }));

  return (
    <div className="space-y-5">
      <div className="rounded border border-amber-300 bg-amber-100 px-4 py-3 text-sm font-medium text-amber-900">
        目前为模拟发送，尚未连接讯息平台。
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h1 className="text-lg font-semibold">群发 Campaign</h1>
          <p className="text-sm text-slate-500">建名单 → 写内容 → 微调 → 节流确认。</p>
        </div>
        <Btn variant="primary" className="ml-auto" onClick={() => setBuilding(true)}>
          <Plus className="mr-1 inline h-4 w-4" />建立群发
        </Btn>
      </div>

      {building && (
        <CampaignWizard
          customers={customers}
          existing={list}
          onCancel={() => setBuilding(false)}
          onCreate={(c) => {
            setList([c, ...list]);
            setBuilding(false);
            logActivity("建立群发", c.name, `名单 ${c.recipients.length} 人，预计分 ${c.days} 天发完`);
            setToast("群发已建立，状态是草稿");
          }}
        />
      )}

      {list.map((c) => (
        <CampaignCard
          key={c.id}
          campaign={c}
          customers={customers}
          onChange={(next) => setList(list.map((x) => (x.id === c.id ? next : x)))}
          logActivity={logActivity}
          silentTimeline={silentTimeline}
          setToast={setToast}
        />
      ))}

      {list.length === 0 && !building && (
        <div className="rounded border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
          还没有群发。最常发的是 New Product Listed，从「建立群发」开始。
        </div>
      )}
    </div>
  );
}

function CampaignWizard({ customers, existing, onCancel, onCreate }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("New Product Listed");
  const [f, setF] = useState({
    stages: [],
    lastContactDays: 90,
    channels: ["customer"],
    tags: [],
    purchase: "any",
  });
  const [ex, setEx] = useState({ tags: [], inOtherCampaign: true, needsReply: true });
  const [body, setBody] = useState(
    "Hi {{name}}, 我们上新品啦 ☺️ 欢迎到 Rasa Foodhub 机器试试看！\nThank you for your supporting ❤️"
  );
  const [removed, setRemoved] = useState([]);
  const [throttle, setThrottle] = useState({ secondsPer: 20, dailyCap: 200 });
  const [confirmed, setConfirmed] = useState(false);
  const [q, setQ] = useState("");
  const [pageNo, setPageNo] = useState(0);

  const allTags = useMemo(
    () => Array.from(new Set(customers.flatMap((c) => c.tags || []))),
    [customers]
  );
  const inOther = useMemo(() => {
    const s = new Set();
    existing.forEach((c) =>
      c.recipients.forEach((r) => {
        if (r.status !== "removed") s.add(r.id);
      })
    );
    return s;
  }, [existing]);

  /* 先算符合条件的，再逐条套排除，好交代 0 人是谁挡的 */
  const analysis = useMemo(() => {
    const cutoff = addDays(-f.lastContactDays);
    const base = customers.filter((c) => {
      if (f.stages.length && !f.stages.includes(c.stage)) return false;
      if (!f.channels.includes(c.contactType)) return false;
      if (f.tags.length && !(c.tags || []).some((t) => f.tags.includes(t))) return false;
      if (f.lastContactDays && (c.lastInteractionAt || "").slice(0, 10) < cutoff) return false;
      if (f.purchase === "yes" && !c.receiptAmount) return false;
      if (f.purchase === "no" && c.receiptAmount) return false;
      return true;
    });
    const reasons = [];
    let pool = base;
    const drop = (fn, label) => {
      const before = pool.length;
      pool = pool.filter((c) => !fn(c));
      const n = before - pool.length;
      if (n > 0) reasons.push({ label, n });
    };
    drop((c) => c.contactType === "supplier", "是 supplier list");
    if (ex.tags.length) drop((c) => (c.tags || []).some((t) => ex.tags.includes(t)), `带有排除标签 ${ex.tags.join(" / ")}`);
    if (ex.inOtherCampaign) drop((c) => inOther.has(c.id), "已在其他群发名单里");
    if (ex.needsReply) drop((c) => c.needsReply || c.stage === "escalated", "正在处理中或需要回覆");
    drop((c) => c.stage === "closed", "个案已结束");
    return { base: base.length, pool, reasons };
  }, [customers, f, ex, inOther]);

  const pool = analysis.pool;
  const active = pool.filter((c) => !removed.includes(c.id));
  const first = active[0];

  const render = (text, c) => text.replace(/\{\{name\}\}/g, c?.name || "亲");

  const schedule = useMemo(() => {
    const perDay = Math.max(1, throttle.dailyCap);
    const days = Math.max(1, Math.ceil(active.length / perDay));
    return { days, perDay };
  }, [active.length, throttle]);

  const filteredList = active.filter((c) =>
    (c.name + c.whatsapp).toLowerCase().includes(q.trim().toLowerCase())
  );
  const PER = 25;
  const pageRows = filteredList.slice(pageNo * PER, pageNo * PER + PER);

  const create = () => {
    const start = Date.now();
    const recipients = pool.map((c, i) => {
      const isRemoved = removed.includes(c.id);
      const idx = pool.slice(0, i).filter((x) => !removed.includes(x.id)).length;
      const dayOffset = Math.floor(idx / schedule.perDay);
      const withinDay = idx % schedule.perDay;
      return {
        id: c.id,
        name: c.name,
        whatsapp: c.whatsapp,
        status: isRemoved ? "removed" : "pending",
        scheduledAt: new Date(start + dayOffset * 864e5 + withinDay * throttle.secondsPer * 1000).toISOString(),
      };
    });
    onCreate({
      id: uid(),
      name,
      body,
      status: "draft",
      throttle,
      days: schedule.days,
      createdAt: new Date().toISOString(),
      recipients,
      summary: null,
    });
  };

  const Toggle = ({ on, onClick, children }) => (
    <button
      onClick={onClick}
      className={cx(
        "rounded border px-2 py-1 text-xs",
        on ? "border-teal-700 bg-teal-700 text-white" : "border-slate-300 bg-white text-slate-600"
      )}
    >
      {children}
    </button>
  );

  return (
    <div className="rounded border-2 border-teal-300 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <span className="text-sm font-semibold">建立群发</span>
        <div className="flex gap-1">
          {["建名单", "写内容", "名单微调", "节流与确认"].map((s, i) => (
            <span
              key={s}
              className={cx(
                "rounded px-2 py-0.5 text-xs",
                step === i + 1 ? "bg-teal-700 text-white" : "bg-slate-100 text-slate-500"
              )}
            >
              {i + 1} {s}
            </span>
          ))}
        </div>
        <button onClick={onCancel} className="ml-auto rounded p-1 hover:bg-slate-100">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-4 p-4">
        {step === 1 && (
          <>
            <Field label="群发名称">
              <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
            </Field>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-3 rounded border border-slate-200 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">筛选条件</div>
                <div>
                  <div className="mb-1 text-xs text-slate-500">阶段（不选＝全部）</div>
                  <div className="flex flex-wrap gap-1">
                    {STAGES.map((s) => (
                      <Toggle
                        key={s.id}
                        on={f.stages.includes(s.id)}
                        onClick={() =>
                          setF((v) => ({
                            ...v,
                            stages: v.stages.includes(s.id) ? v.stages.filter((x) => x !== s.id) : [...v.stages, s.id],
                          }))
                        }
                      >
                        {s.label}
                      </Toggle>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-xs text-slate-500">来源渠道</div>
                  <div className="flex flex-wrap gap-1">
                    {CONTACT_TYPES.map((t) => (
                      <Toggle
                        key={t.id}
                        on={f.channels.includes(t.id)}
                        onClick={() =>
                          setF((v) => ({
                            ...v,
                            channels: v.channels.includes(t.id) ? v.channels.filter((x) => x !== t.id) : [...v.channels, t.id],
                          }))
                        }
                      >
                        {t.label}
                      </Toggle>
                    ))}
                  </div>
                </div>
                <Field label="最后联络在几天内">
                  <input type="number" min="1" value={f.lastContactDays} onChange={(e) => setF({ ...f, lastContactDays: Number(e.target.value) })} className={inputCls} />
                </Field>
                <div>
                  <div className="mb-1 text-xs text-slate-500">标签（不选＝不限）</div>
                  <div className="flex flex-wrap gap-1">
                    {allTags.length === 0 && <span className="text-xs text-slate-400">目前没有标签</span>}
                    {allTags.map((t) => (
                      <Toggle
                        key={t}
                        on={f.tags.includes(t)}
                        onClick={() => setF((v) => ({ ...v, tags: v.tags.includes(t) ? v.tags.filter((x) => x !== t) : [...v.tags, t] }))}
                      >
                        {t}
                      </Toggle>
                    ))}
                  </div>
                </div>
                <Field label="买过 / 没买过">
                  <select value={f.purchase} onChange={(e) => setF({ ...f, purchase: e.target.value })} className={inputCls}>
                    <option value="any">不限</option>
                    <option value="yes">买过（有收据金额）</option>
                    <option value="no">没买过</option>
                  </select>
                </Field>
              </div>

              <div className="space-y-3 rounded border border-red-200 bg-red-50 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-red-700">不要发给这些顾客</div>
                <p className="text-xs text-red-800">Supplier list 永远排除，不可关闭。</p>
                <div>
                  <div className="mb-1 text-xs text-red-700">排除标签</div>
                  <div className="flex flex-wrap gap-1">
                    {allTags.map((t) => (
                      <Toggle
                        key={t}
                        on={ex.tags.includes(t)}
                        onClick={() => setEx((v) => ({ ...v, tags: v.tags.includes(t) ? v.tags.filter((x) => x !== t) : [...v.tags, t] }))}
                      >
                        {t}
                      </Toggle>
                    ))}
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm text-red-900">
                  <input type="checkbox" checked={ex.inOtherCampaign} onChange={(e) => setEx({ ...ex, inOtherCampaign: e.target.checked })} />
                  排除已在其他群发名单的人
                </label>
                <label className="flex items-center gap-2 text-sm text-red-900">
                  <input type="checkbox" checked={ex.needsReply} onChange={(e) => setEx({ ...ex, needsReply: e.target.checked })} />
                  排除正在客诉／需要回覆的人
                </label>
              </div>
            </div>

            <div className="rounded border border-slate-200 bg-slate-50 p-3">
              <div className="text-sm font-medium">符合 {pool.length} 人</div>
              {pool.length === 0 && (
                <div className="mt-1 space-y-1 text-sm font-medium text-red-600">
                  <div>有 {analysis.base} 人符合筛选条件，但全部被排除了：</div>
                  <ul className="list-disc pl-5 font-normal">
                    {analysis.reasons.map((r, i) => (
                      <li key={i}>{r.n} 人 — {r.label}</li>
                    ))}
                    {analysis.reasons.length === 0 && <li>筛选条件本身就没有人符合，请放宽阶段或最后联络天数。</li>}
                  </ul>
                </div>
              )}
              {pool.length > 0 && (
                <>
                  <div className="mt-1 text-xs text-slate-500">
                    {analysis.base} 人符合筛选
                    {analysis.reasons.map((r) => `，扣掉 ${r.n} 人（${r.label}）`).join("")}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {pool.slice(0, 8).map((c) => (
                      <span key={c.id} className="rounded bg-white px-2 py-0.5 text-xs">{c.name}</span>
                    ))}
                    {pool.length > 8 && <span className="text-xs text-slate-400">…还有 {pool.length - 8} 人</span>}
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {step === 2 && (
          <div className="grid gap-4 lg:grid-cols-2">
            <Field label="内容（可用 {{name}} 变数）">
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} className={inputCls} />
            </Field>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
                预览 · {first ? first.name : "没有收件人"}
              </div>
              <div className="whitespace-pre-wrap rounded border border-slate-200 bg-emerald-50 p-3 text-sm">
                {render(body, first)}
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[180px] flex-1">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-slate-400" />
                <input value={q} onChange={(e) => { setQ(e.target.value); setPageNo(0); }} placeholder="搜寻收件人" className={cx(inputCls, "pl-8")} />
              </div>
              <span className="font-mono text-xs text-slate-400">
                名单 {active.length} 人 · 已移出 {removed.length} 人
              </span>
            </div>
            <ul className="divide-y divide-slate-100 rounded border border-slate-200">
              {pool
                .filter((c) => (c.name + c.whatsapp).toLowerCase().includes(q.trim().toLowerCase()))
                .slice(pageNo * PER, pageNo * PER + PER)
                .map((c) => {
                  const out = removed.includes(c.id);
                  return (
                    <li key={c.id} className={cx("flex items-center gap-2 px-3 py-2 text-sm", out && "bg-slate-50 text-slate-400")}>
                      <span className={cx("font-medium", out && "line-through")}>{c.name}</span>
                      <span className="font-mono text-xs text-slate-400">{c.whatsapp}</span>
                      {out && <Pill>已移出</Pill>}
                      <Btn
                        className="ml-auto px-2 py-1 text-xs"
                        variant={out ? "default" : "danger"}
                        onClick={() =>
                          setRemoved((r) => (out ? r.filter((x) => x !== c.id) : [...r, c.id]))
                        }
                      >
                        {out ? "放回名单" : "移出名单"}
                      </Btn>
                    </li>
                  );
                })}
            </ul>
            <div className="flex items-center justify-center gap-2">
              <Btn disabled={pageNo === 0} onClick={() => setPageNo((p) => p - 1)}>上一页</Btn>
              <span className="text-xs text-slate-500">第 {pageNo + 1} 页</span>
              <Btn disabled={(pageNo + 1) * PER >= pool.length} onClick={() => setPageNo((p) => p + 1)}>下一页</Btn>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="每几秒发一封">
                <input type="number" min="1" value={throttle.secondsPer} onChange={(e) => setThrottle({ ...throttle, secondsPer: Number(e.target.value) })} className={inputCls} />
              </Field>
              <Field label="每日上限（封）">
                <input type="number" min="1" value={throttle.dailyCap} onChange={(e) => setThrottle({ ...throttle, dailyCap: Number(e.target.value) })} className={inputCls} />
              </Field>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm">
              <div className="font-medium">
                {active.length} 人 · 每天最多 {schedule.perDay} 封 · 这批会分 {schedule.days} 天发完
              </div>
              <div className="mt-1 text-xs text-slate-500">
                每个人的预定发送时间在建立名单时就算好，之后不会再变动。
              </div>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1" />
              我确认名单与节流设定，建立这个群发（建立后仍是草稿，要另外按「开始发送」）
            </label>
          </>
        )}

        <div className="flex justify-between border-t border-slate-200 pt-3">
          <Btn onClick={step === 1 ? onCancel : () => setStep(step - 1)}>
            {step === 1 ? "取消" : "上一步"}
          </Btn>
          {step < 4 ? (
            <Btn variant="primary" disabled={step === 1 && pool.length === 0} onClick={() => setStep(step + 1)}>
              下一步
            </Btn>
          ) : (
            <Btn variant="primary" disabled={!confirmed || active.length === 0} onClick={create}>
              建立群发
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function CampaignCard({ campaign: cp, customers, onChange, logActivity, silentTimeline, setToast }) {
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  const stRef = useRef(cp);
  stRef.current = cp;

  const total = cp.recipients.filter((r) => r.status !== "removed").length;
  const sent = cp.recipients.filter((r) => r.status === "sent").length;
  const skipped = cp.recipients.filter((r) => r.status === "skipped").length;
  const pct = total ? Math.round(((sent + skipped) / total) * 100) : 0;

  /* 模拟发送：加速跑，逐一送出前再检查一次状态 */
  useEffect(() => {
    if (cp.status !== "sending") {
      clearInterval(timer.current);
      return;
    }
    timer.current = setInterval(() => {
      const cur = stRef.current;
      const next = cur.recipients.find((r) => r.status === "pending");
      if (!next) {
        clearInterval(timer.current);
        const s = {
          sent: cur.recipients.filter((r) => r.status === "sent").length,
          skipped: cur.recipients.filter((r) => r.status === "skipped").length,
          removed: cur.recipients.filter((r) => r.status === "removed").length,
        };
        onChange({ ...cur, status: "done", summary: s });
        logActivity("发送群发", cur.name, `完成：送出 ${s.sent}、跳过 ${s.skipped}、移出 ${s.removed}`);
        setToast(`「${cur.name}」发送完成`);
        return;
      }
      const c = customers.find((x) => x.id === next.id);
      const skip =
        !c || c.needsReply || c.stage === "closed" || c.stage === "escalated" || c.contactType === "supplier";
      if (!skip) {
        silentTimeline(c.id, `收到群发：${cur.name}（模拟）`);
      }
      onChange({
        ...cur,
        recipients: cur.recipients.map((r) =>
          r.id === next.id ? { ...r, status: skip ? "skipped" : "sent", doneAt: new Date().toISOString() } : r
        ),
      });
    }, 420);
    return () => clearInterval(timer.current);
  }, [cp.status, customers]);

  const st = CAMPAIGN_STATUS[cp.status];

  return (
    <div className="rounded border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <button onClick={() => setOpen(!open)} className="text-sm font-semibold hover:underline">
          {cp.name}
        </button>
        <Pill tone={st.tone}>{st.label}</Pill>
        <span className="font-mono text-xs text-slate-400">
          {total} 人 · 分 {cp.days} 天 · 每 {cp.throttle.secondsPer} 秒 1 封
        </span>
        <div className="ml-auto flex gap-2">
          {cp.status === "draft" && (
            <Btn
              variant="primary"
              onClick={() => {
                onChange({ ...cp, status: "sending" });
                logActivity("发送群发", cp.name, `开始发送（模拟），名单 ${total} 人`);
              }}
            >
              <Play className="mr-1 inline h-4 w-4" />开始发送
            </Btn>
          )}
          {cp.status === "sending" && (
            <Btn onClick={() => { onChange({ ...cp, status: "paused" }); logActivity("发送群发", cp.name, "暂停发送"); }}>
              <Pause className="mr-1 inline h-4 w-4" />暂停
            </Btn>
          )}
          {cp.status === "paused" && (
            <>
              <Btn variant="primary" onClick={() => { onChange({ ...cp, status: "sending" }); logActivity("发送群发", cp.name, "继续发送"); }}>
                继续
              </Btn>
              <Btn variant="danger" onClick={() => { onChange({ ...cp, status: "cancelled" }); logActivity("发送群发", cp.name, "取消群发"); }}>
                取消
              </Btn>
            </>
          )}
        </div>
      </div>

      {(cp.status === "sending" || cp.status === "paused" || cp.status === "done") && (
        <div className="px-4 py-3">
          <div className="h-2 w-full overflow-hidden rounded bg-slate-200">
            <div className="h-full bg-teal-600 transition-all" style={{ width: pct + "%" }} />
          </div>
          <div className="mt-1 font-mono text-xs text-slate-500">
            {sent + skipped} / {total} · 送出 {sent} · 跳过 {skipped}
          </div>
        </div>
      )}

      {cp.summary && (
        <div className="mx-4 mb-3 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          发送完成（模拟）：送出 {cp.summary.sent} 人，跳过 {cp.summary.skipped} 人（送出前状态已变成需回覆 / 已结束 / 已升级），建立时移出 {cp.summary.removed} 人。
        </div>
      )}

      {open && (
        <div className="border-t border-slate-200 p-4">
          <div className="mb-3 whitespace-pre-wrap rounded bg-slate-50 p-3 text-sm">{cp.body}</div>
          <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200">
            {cp.recipients.slice(0, 200).map((r) => (
              <li key={r.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <span className="font-medium">{r.name}</span>
                <span className="font-mono text-slate-400">{r.whatsapp}</span>
                <span className="ml-auto font-mono text-slate-400">
                  预定 {fmtTime(r.scheduledAt)}
                </span>
                <Pill tone={r.status === "sent" ? "green" : r.status === "skipped" ? "amber" : "slate"}>
                  {({ pending: "待发", sent: "已送出", skipped: "跳过", removed: "已移出" })[r.status]}
                </Pill>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
