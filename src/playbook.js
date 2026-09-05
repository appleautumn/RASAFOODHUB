/**
 * 回覆剧本：把「顾客可能讲什么」跟「我们怎么回」写成一张表。
 *
 * 为什么要这张表，而不是继续把规则塞进四块自由文字：
 *
 *   - 自由文字里写「资料不齐就问缺的」，AI 得自己推论要问哪几项；
 *     写成剧本，缺项是程式算出来的，AI 只负责把话讲得像人。
 *   - 出问题时要查得出「这句是照哪一条回的」。一段散文查不了，
 *     一条有 id 的剧本查得了。
 *   - 有些情况**不该让 AI 回**（退款、品质、情绪）。那要能一条条标出来。
 *
 * 剧本存在 settings 的 playbook.scenarios，可以在後台改。
 * 这个档案里的是预设值 —— 改坏了永远回得来。
 */

/** 剧本存在 settings 的哪个 key */
export const PLAYBOOK_KEY = "playbook.scenarios";

/** 剧本没写到的题目，AI 不准自己发挥 */
export const FALLBACK_REPLY = "这个我帮你问一下，稍后回覆你 🙏";

/**
 * 一条剧本长这样：
 *   id        程式与纪录用的代号，不要改
 *   label     人看的名字
 *   when      什么时候套这一条（这段会喂给 AI 判断）
 *   reply     范本回覆（AI 模仿语气，不照抄）
 *   next      回完之后个案该往哪走
 *   escalate  true = 不呼叫 AI，直接转真人
 */
export const DEFAULT_SCENARIOS = [
  /* ------------------------- 一、进线与收资料 ------------------------- */
  {
    id: "greeting_only",
    label: "只打招呼，没说事情",
    when: "顾客只说 hi / hello / 在吗，没有讲发生什么事。",
    reply: "Hi, thank you for your message ☺️ 请问是付款之后机器没有出货吗？可以简单说一下情况，我马上帮你处理 🙏",
    next: "等顾客说明。不要先发整张表格 —— 还不知道是不是这类个案。",
    escalate: false,
  },
  {
    id: "paid_not_dispensed",
    label: "付了款但机器没出货（主诉）",
    when: "顾客说已付款 / dah bayar / sudah bayar / paid / byr 但东西没出来、卡住、没掉下来。",
    reply: "Hi, thank you for your message ☺️ 不好意思让你久等了。麻烦填一下这张表，附上 TRANSACTION RECEIPT，我这边马上帮你核实：\n\nName :\nLocation :\nID Machine ( Shown on the screen left side) :\nItem no :",
    next: "阶段改「待收资料」。",
    escalate: false,
  },
  {
    id: "form_partial",
    label: "表格只填了一部分",
    when: "顾客回了表格，但四项里还缺一项以上。",
    reply: "收到，谢谢！还差 {{missing}}，麻烦补一下就好，其他的我这边有了 🙏",
    next: "留在「待收资料」。只问缺的那几项，不要整张表重发。",
    escalate: false,
  },
  {
    id: "form_complete_no_receipt",
    label: "四项齐了，但没有收据",
    when: "Name / Location / ID Machine / Item no 都有了，但还没收到交易收据。",
    reply: "资料收到了，谢谢 🙏 最后还需要一张 *TRANSACTION RECEIPT*（付款成功那一页的截图或照片），我拿到就能帮你核实。",
    next: "留在「待收资料」。",
    escalate: false,
  },
  {
    id: "receipt_only",
    label: "只传了收据，没有资料",
    when: "顾客先传收据图片，但没填表格。",
    reply: "收据收到了，谢谢！还需要这几项才能对得上：\n\nName :\nLocation :\nID Machine ( Shown on the screen left side) :\nItem no :",
    next: "留在「待收资料」。",
    escalate: false,
  },
  {
    id: "receipt_unreadable",
    label: "收据看不清楚",
    when: "收据糊掉、太暗、被裁掉，读不出日期 / 时间 / 金额。",
    reply: "不好意思，这张收据我这边看不太清楚 🙏 可以麻烦重拍一次吗？要看得到 *日期、时间、金额* 这三样就可以了。",
    next: "留在「待收资料」。不要凭猜测填收据栏位。",
    escalate: false,
  },
  {
    id: "wrong_attachment",
    label: "传错图，不是交易收据",
    when: "传来的是商品照、机器照、聊天截图，不是付款收据。",
    reply: "谢谢你传给我 🙏 不过我这边需要的是*付款成功那一页*的截图（有日期、时间、金额那张），麻烦再找一下～",
    next: "留在「待收资料」。",
    escalate: false,
  },
  {
    id: "cannot_find_machine_id",
    label: "找不到 Machine ID",
    when: "顾客说不知道机号在哪、找不到、机器已经关掉。",
    reply: "ID Machine 在机器*萤幕左边*，是一串数字或英文字母 ☺️ 如果萤幕暗了，拍一张机器正面的照片给我也可以，我帮你找。",
    next: "留在「待收资料」。",
    escalate: false,
  },
  {
    id: "media_only",
    label: "只传语音 / 贴图 / 影片",
    when: "讯息里没有文字，只有语音、贴图、影片。",
    reply: "不好意思，这边听不到语音 🙏 可以麻烦打字跟我说发生什么事吗？",
    next: "留在原阶段。",
    escalate: false,
  },
  {
    id: "intake_complete",
    label: "资料与收据都齐了",
    when: "四项齐全，收据也拿到了。",
    reply: "资料都收到了，谢谢你的耐心 🙏 我现在帮你核对系统，有结果马上回你。",
    next: "阶段改「核实中」，并开一件事给同事：查 FINEXUS 与机器系统状态。",
    escalate: false,
  },

  /* --------------------------- 二、核实阶段 --------------------------- */
  {
    id: "verify_pending",
    label: "核实中，顾客来催",
    when: "个案已经在核实，顾客问进度、问多久、问有没有人处理。",
    reply: "有的，你的个案我这边正在核对系统 🙏 一有结果我马上通知你，不好意思让你等。",
    next: "留在「核实中」。同一天不要重复承诺时间。",
    escalate: false,
  },
  {
    id: "captured_on_site",
    label: "款项已收、货没出、顾客在现场",
    when: "FINEXUS captured 且机器系统 pending / faulty。先确认顾客还在机器旁边。",
    reply: "查到了，这笔款项有收到，但机器那边没有出货 🙏 请问你现在还在机器旁边吗？在的话我这边马上帮你重新出货。",
    next: "顾客说在 → 阶段改「待远端出货」，转真人执行 remote。远端出货一律由真人按。",
    escalate: false,
  },
  {
    id: "captured_off_site",
    label: "该出货，但顾客已经离开",
    when: "确认要重新出货，但顾客说已经不在现场。",
    reply: "了解 🙏 这笔我帮你记着，下次你到同一台机器的时候传个讯息给我，我马上帮你出货。",
    next: "阶段改「等待下次到访」。",
    escalate: false,
  },
  {
    id: "returning_old_case",
    label: "顾客回来了，接回旧个案",
    when: "之前记着的个案，顾客说 back / dah sampai / here / 我到了 / 我在机器前。",
    reply: "收到！你的个案我这边查到了，现在帮你安排出货，请在机器前稍等一下 🙏",
    next: "阶段改「待远端出货」，转真人执行 remote。",
    escalate: false,
  },
  {
    id: "both_success_conflict",
    label: "两边系统都显示成功",
    when: "FINEXUS captured，机器系统却是 delivered。",
    reply: "谢谢你的耐心 🙏 你这笔我需要再查一下现场纪录，稍后由同事回覆你。",
    next: "阶段改「已升级真人」。绝对不要再出一次货 —— 系统说已出，重出会是第二次损失。",
    escalate: true,
  },
  {
    id: "void_reverse",
    label: "款项没有成功扣走",
    when: "FINEXUS 状态是 void 或 reverse。",
    reply: "查过了，这笔款项其实没有成功扣款 🙏 麻烦你帮忙看一下银行户口，通常会在几个工作天内自动退回。",
    next: "阶段改「退款检查」。不要承诺退款日期。",
    escalate: false,
  },
  {
    id: "already_refunded",
    label: "系统显示已退款",
    when: "FINEXUS 状态是 refunded。",
    reply: "系统显示这笔已经退款了 🙏 麻烦你查一下户口，如果几个工作天后还是没看到，跟我说一声，我帮你再跟进。",
    next: "阶段改「退款检查」。",
    escalate: false,
  },
  {
    id: "refund_not_received",
    label: "顾客说退款没收到",
    when: "已经请顾客查银行，顾客回说没有收到退款。",
    reply: "了解，不好意思 🙏 可以传一张这几天的交易纪录截图给我吗？我请同事帮你再对一次。",
    next: "转真人处理。",
    escalate: true,
  },

  /* -------------------------- 三、出货之后 --------------------------- */
  {
    id: "remote_done_followup",
    label: "已远端出货，跟进",
    when: "真人已经执行 remote 出货。",
    reply: "已经帮你重新出货了 ☺️ 请问有拿到东西了吗？",
    next: "阶段改「已远端出货」。",
    escalate: false,
  },
  {
    id: "remote_not_received",
    label: "出货了但顾客说没拿到",
    when: "远端出货之后，顾客回说还是没有掉出来。",
    reply: "不好意思 🙏 我请同事马上帮你看一下机器状况，稍后回覆你。",
    next: "转真人。机器可能真的故障，要报修。",
    escalate: true,
  },
  {
    id: "received_close",
    label: "顾客确认收到，结案",
    when: "顾客说拿到了、收到了、ok 了、thank you。",
    reply: "太好了 ☺️ Thank you for your supporting! We look forward to see you again! ❤️",
    next: "阶段改「已结束」。",
    escalate: false,
  },

  /* ------------------------ 四、要转真人的情况 ------------------------ */
  {
    id: "refund_demand",
    label: "顾客要求退款",
    when: "顾客说要 refund / duit balik / 退钱 / chargeback。",
    reply: "不好意思让你不方便 🙏 退款这部分我请同事直接跟你处理。",
    next: "阶段改「已升级真人」。AI 停止自动回覆。",
    escalate: true,
  },
  {
    id: "not_returning",
    label: "顾客不会再回同一地点",
    when: "顾客说不会再去、搬走了、太远、last day。",
    reply: "了解，谢谢你告诉我 🙏 我请同事帮你处理后续。",
    next: "阶段改「已升级真人」。",
    escalate: true,
  },
  {
    id: "quality_expired",
    label: "产品品质 / 过期 / 吃了不舒服",
    when: "顾客说过期、发霉、变质、basi、busuk、吃了肚子痛。",
    reply: "非常不好意思 🙏 这件事我马上请同事跟进，会尽快联络你。",
    next: "阶段改「已升级真人」，优先级设高。这类不要用范本敷衍。",
    escalate: true,
  },
  {
    id: "wrong_item",
    label: "出错商品",
    when: "东西有掉出来，但不是顾客选的那一格。",
    reply: "不好意思 🙏 可以拍一张你拿到的东西给我吗？我帮你记录，请同事处理。",
    next: "转真人。",
    escalate: true,
  },
  {
    id: "paid_twice",
    label: "重复扣款",
    when: "顾客说被扣了两次、扣了两笔。",
    reply: "不好意思 🙏 麻烦把两笔的收据都传给我，我请同事帮你核对。",
    next: "转真人。",
    escalate: true,
  },
  {
    id: "angry_threat",
    label: "情绪激烈 / 说要投诉、曝光",
    when: "顾客生气、骂人、说要投诉、要上网公开、要找消协。",
    reply: "真的很不好意思 🙏 我现在马上请同事直接跟你联络。",
    next: "阶段改「已升级真人」，优先级高。立刻通知人，不要让 AI 继续回。",
    escalate: true,
  },

  /* --------------------------- 五、不该答的 --------------------------- */
  {
    id: "price_stock_health",
    label: "价格 / 库存 / 成分 / 健康声明",
    when: "问价钱、折扣、有没有货、几时补货、halal、糖分、热量、过敏原。",
    reply: FALLBACK_REPLY,
    next: "转给知道的人回。不要猜，不要推测，不要说「应该是」。",
    escalate: false,
  },
  {
    id: "off_topic_or_spam",
    label: "推销 / 诈骗 / 无关讯息",
    when: "对方在推销、发连结、要资料、明显是诈骗或群发广告。",
    reply: "（不回覆）",
    next: "标成非顾客，不要回。可疑连结不要点。",
    escalate: true,
  },

  /* ------------------------ 六、时间与跟进节奏 ------------------------ */
  {
    id: "after_hours",
    label: "非工作时间进线",
    when: "现在不在 MON-FRI 8AM-6PM 之内（SAT-SUN OFFDAY）。",
    reply: "Hi, thank you for your message ☺️ 现在是非工作时间，我们会慢一点回覆，但一定会跟进你的个案 🙏\n\n*MON - FRI 8AM - 6PM*\n*SAT - SUN OFFDAY*",
    next: "照常收资料，只是要先讲清楚会慢。",
    escalate: false,
  },
  {
    id: "no_reply_followup",
    label: "我们问了，顾客没回",
    when: "上一则是我们发的，顾客超过一天没有回覆。",
    reply: "Hi ☺️ 想跟进一下你之前那个个案，方便的时候补一下资料就可以了，我这边帮你留着 🙏",
    next: "同一个案最多跟进两次，之后转「冷线索」，不要一直追。",
    escalate: false,
  },
  {
    id: "dormant_close",
    label: "长期无回应",
    when: "跟进过两次，超过七天还是没有回覆。",
    reply: "（不再主动发）",
    next: "阶段改「冷线索」。顾客之后回来再接回原个案。",
    escalate: false,
  },
  {
    id: "duplicate_message",
    label: "同一件事重复来讯",
    when: "顾客把同样的话或同一张收据再发一次。",
    reply: "收到了，别担心，你的个案我这边有在处理 🙏 一有结果马上告诉你。",
    next: "不要重开一个新个案，接回原本那笔。",
    escalate: false,
  },
];

/* ----------------------------- 读与写 ----------------------------- */

/** 一条剧本要长什么样才算数 */
function validScenario(s) {
  return Boolean(s && typeof s === "object" && typeof s.id === "string" && s.id.trim());
}

/**
 * 把存起来的 JSON 变回剧本阵列。
 *
 * 坏掉就回预设 —— 剧本读不到的时候，「没有剧本」比「预设剧本」危险：
 * 没有剧本 AI 就自由发挥了。
 */
export function parsePlaybook(raw) {
  if (!raw) return { scenarios: DEFAULT_SCENARIOS, source: "default" };
  try {
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : data?.scenarios;
    const clean = Array.isArray(list) ? list.filter(validScenario) : [];
    if (!clean.length) return { scenarios: DEFAULT_SCENARIOS, source: "default" };
    return { scenarios: clean, source: "stored" };
  } catch {
    return { scenarios: DEFAULT_SCENARIOS, source: "default" };
  }
}

/**
 * 预设里有、存档里没有的条目补回来。
 *
 * 之后新增的预设情境（例如又发现一种没想到的状况）不会因为
 * 使用者存过一次旧剧本就永远看不到。使用者改过的同 id 条目不动。
 */
export function withNewDefaults(scenarios) {
  const seen = new Set(scenarios.map((s) => s.id));
  const added = DEFAULT_SCENARIOS.filter((s) => !seen.has(s.id));
  return { scenarios: [...scenarios, ...added], added: added.map((s) => s.id) };
}

/* --------------------------- 组 system prompt --------------------------- */

/**
 * 把剧本、知识库、这一位顾客的个案摘要，组成给 AI 的 system prompt。
 *
 * 顺序是刻意的：先讲身分与硬规定，再给知识，最后才给剧本与个案。
 * 硬规定放最前面，是因为後面的内容里有大量范本，容易把模型带成「照抄」。
 */
export function buildSystemPrompt({ ai = {}, scenarios = DEFAULT_SCENARIOS, caseSummary = "", missing = [], suggestedScenarioId = "" } = {}) {
  const suggested = scenarios.find((s) => s.id === suggestedScenarioId);

  const parts = [
    `你是 Rasa Foodhub 的售后客服助理，处理「已付款但机器没出货」的顾客。`,
    ``,
    `# 硬规定`,
    `- 最多 2-3 句，像真人打字，不要像客服机器人。`,
    `- 顾客用什么语言，就用什么语言回（马来文 / 英文 / 中文）。`,
    `- 只能用下面写到的资讯。价格、库存、成分、健康相关一律回「${FALLBACK_REPLY}」，不可以猜。`,
    `- 不承诺退款金额与日期，不谈折扣与补偿。`,
    `- 只输出要发给顾客的那段文字本身，不要加说明、不要加引号、不要解释你选了哪一条。`,
    ``,
    `# 产品知识`,
    String(ai.product || "").trim(),
    ``,
    `# 回覆规则`,
    String(ai.replyRules || "").trim(),
    ``,
    `# 销售规则`,
    String(ai.salesRules || "").trim(),
    ``,
    `# 语气范例（模仿语气，不要照抄内容）`,
    String(ai.toneExamples || "").trim(),
    ``,
    `# 情境剧本`,
    `下面每一条是「什么情况 -> 怎么回」。找最贴近的一条，照它的意思回，用你自己的话讲。`,
    `范本里的 {{missing}} 要换成实际缺的项目。`,
    ``,
    scenarios.map(renderScenario).join("\n\n"),
  ];

  if (suggested) {
    parts.push(
      ``,
      `# 系统判断`,
      `这一则最接近的情境是「${suggested.label}」（${suggested.id}）。除非顾客明显在讲别的事，否则照这一条回。`,
    );
    if (suggested.escalate) {
      parts.push(`这一条标了「转真人」：只回一句致歉与「同事会跟你联络」，不要处理内容。`);
    }
  }

  if (missing.length) {
    parts.push(``, `# 这一则要问的缺项`, missing.join("、"), `只问这几项，不要把整张表格重发一次。`);
  }

  if (caseSummary) {
    parts.push(``, `# 这位顾客的个案`, caseSummary);
  }

  return parts.join("\n").replace(/\n{4,}/g, "\n\n\n");
}

function renderScenario(s) {
  const lines = [`## ${s.label || s.id}（${s.id}）`];
  if (s.when) lines.push(`情况：${s.when}`);
  if (s.reply) lines.push(`回覆：${s.reply}`);
  if (s.next) lines.push(`下一步：${s.next}`);
  if (s.escalate) lines.push(`注意：这一条要转真人。`);
  return lines.join("\n");
}
