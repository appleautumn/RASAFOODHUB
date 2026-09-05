/**
 * 个案的状态机：从「收资料」走到「核实」，再走到「转真人远端出货」。
 *
 * 这条流程是真人在跑的，程式只做三件事：
 *   1. 说清楚**现在缺什么** —— 资料没齐就不该进核实
 *   2. 资料齐了就把个案推到核实，并留下一件事给人做
 *   3. 人把两个系统的状态填回来之后，说清楚**下一步该往哪走**
 *
 * 刻意不自动送讯息、不自动改 FINEXUS、不自动出货。
 * 出货是花钱的动作，永远由人按下去。
 */

import { REQUIRED_FIELDS } from "./intake.js";

/** 栏位在画面上叫什么。问顾客缺什么的时候用得到。 */
export const FIELD_LABELS = {
  name: "Name",
  locationName: "Location",
  machineId: "ID Machine",
  itemNo: "Item no",
  receiptDate: "收据日期",
  receiptTime: "收据时间",
  receiptAmount: "收据金额",
};

/** 顾客那边看到的表格用英文，问缺项时也用英文，跟表格对得上 */
export const FIELD_ASK = {
  name: "Name",
  locationName: "Location",
  machineId: "ID Machine (screen left side)",
  itemNo: "Item no",
};

/**
 * 收据算不算拿到了。
 *
 * 三项读到任何一项就算「有收据资讯」—— 收据多半是图片，
 * 图片里的字这里读不到，是人（或顾客自己打字）补上的。
 */
export function hasReceipt(c) {
  return Boolean(str(c.receiptDate) || str(c.receiptTime) || str(c.receiptAmount));
}

const str = (v) => String(v ?? "").trim();

/** 四项必填里还缺哪些 */
export function missingFields(c) {
  return REQUIRED_FIELDS.filter((f) => !str(c[f]));
}

/**
 * 个案现在卡在哪、下一步是谁的事。
 *
 * 回传 {
 *   state    机器可读的状态
 *   who      "customer" | "staff" | "none" —— 现在等谁
 *   missing  还缺的必填栏位
 *   summary  一句话给人看
 * }
 */
export function caseStatus(c) {
  const missing = missingFields(c);
  const receipt = hasReceipt(c);
  const machine = str(c.machineStatus) || "unknown";
  const finexus = str(c.finexusStatus) || "unknown";

  if (missing.length || !receipt) {
    return {
      state: "collecting",
      who: "customer",
      missing,
      needsReceipt: !receipt,
      summary: describeCollecting(missing, receipt),
    };
  }

  if (finexus === "unknown" || machine === "unknown") {
    return {
      state: "verifying",
      who: "staff",
      missing: [],
      needsReceipt: false,
      summary: `资料齐了。要查${finexus === "unknown" ? " FINEXUS" : ""}${finexus === "unknown" && machine === "unknown" ? " 与" : ""}${machine === "unknown" ? "机器系统" : ""}状态。`,
    };
  }

  const decision = verifyDecision({ machineStatus: machine, finexusStatus: finexus });
  return {
    state: decision.outcome,
    who: decision.who,
    missing: [],
    needsReceipt: false,
    summary: decision.summary,
  };
}

function describeCollecting(missing, receipt) {
  const parts = [];
  if (missing.length) parts.push(`还缺 ${missing.map((f) => FIELD_LABELS[f]).join("、")}`);
  if (!receipt) parts.push("还没收到 transaction receipt");
  return parts.join("；") + "。";
}

/**
 * 两个系统状态凑起来，个案该往哪走。
 *
 * FINEXUS 是钱有没有真的收到，机器系统是货有没有真的出去。
 * 只有「钱收到了、货没出去」才是我们欠顾客一件商品 —— 那才远端出货。
 *
 *   captured + pending/faulty  → 钱收了货没出：远端出货（要顾客在现场）
 *   captured + delivered       → 两边都说成功：请顾客再确认取货口，人接手
 *   void / reverse             → 钱没真的扣走：请顾客查银行自动退款
 *   refunded                   → 已经退了：说明并请顾客查帐
 */
export function verifyDecision({ machineStatus, finexusStatus, onSite }) {
  const machine = str(machineStatus) || "unknown";
  const finexus = str(finexusStatus) || "unknown";

  if (finexus === "unknown" || machine === "unknown") {
    return { outcome: "verifying", who: "staff", stage: "verifying", scenario: "verify_pending", summary: "还没查完两个系统。" };
  }

  if (finexus === "void" || finexus === "reverse") {
    return {
      outcome: "refund_check", who: "customer", stage: "refund_check", scenario: "void_reverse",
      summary: `FINEXUS ${finexus}：这笔没有成功扣款，请顾客查银行自动退款。`,
    };
  }

  if (finexus === "refunded") {
    return {
      outcome: "refund_check", who: "customer", stage: "refund_check", scenario: "already_refunded",
      summary: "FINEXUS refunded：款项已退，请顾客查帐户。",
    };
  }

  // 到这里 finexus === "captured"
  if (machine === "delivered") {
    return {
      outcome: "conflict", who: "staff", stage: "escalated", scenario: "both_success_conflict",
      summary: "两边都显示成功，机器却说已出货。要人看现场纪录，不要自动再出一次。",
    };
  }

  // pending / faulty：钱收了、货没出
  if (onSite === false) {
    return {
      outcome: "awaiting_visit", who: "customer", stage: "awaiting_next_visit", scenario: "captured_off_site",
      summary: "该出货，但顾客不在机器旁。等他到了再远端出货。",
    };
  }

  return {
    outcome: "ready_to_remote", who: "staff", stage: "pending_remote", scenario: "captured_on_site",
    summary: `FINEXUS captured、机器 ${machine}：确认顾客在现场后，由真人远端出货。`,
  };
}

/**
 * 个案摘要 —— 贴进人的待办、也喂给 AI 当上下文。
 *
 * 刻意每一行都写出来、缺的写「—」，不要省略。
 * 省掉的那一行就是最容易被当成「已经确认过」的那一行。
 */
export function caseSummary(c) {
  const line = (label, value) => `${label}：${str(value) || "—"}`;
  const status = caseStatus(c);
  return [
    line("Name", c.name),
    line("Location", c.locationName),
    line("ID Machine", c.machineId),
    line("Item no", c.itemNo),
    line("收据", [str(c.receiptDate), str(c.receiptTime), str(c.receiptAmount) && `RM ${c.receiptAmount}`].filter(Boolean).join(" ")),
    line("机器系统", c.machineStatus),
    line("FINEXUS", c.finexusStatus),
    `目前：${status.summary}`,
  ].join("\n");
}

/**
 * 把读到的栏位合进个案。
 *
 * 规则：**只填空的，不覆盖已有的**。
 *
 * 已有的值可能是同事查证过才填进去的，顾客后来手滑打错一个字
 * 不应该把它盖掉。真的要改，让人在顾客页上改 —— 那里有纪录。
 */
export function mergeIntake(current, fields) {
  const changes = {};
  for (const [key, value] of Object.entries(fields || {})) {
    const v = str(value);
    if (!v) continue;
    if (str(current?.[key])) continue;
    changes[key] = v;
  }
  return changes;
}
