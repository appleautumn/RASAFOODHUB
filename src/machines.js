/**
 * 机器清单：把顾客讲的地方，对回一台真实存在的机器。
 *
 * 为什么值得一个模组：Location 与 Machine ID 一直是顾客手打的自由文字，
 * 而打错的机号会一路带到 FINEXUS 核实才被发现 —— 那时候要重问、重等，
 * 顾客已经不在机器旁边了。
 *
 * 这里的比对刻意**保守**：只有很有把握的时候才自动填。
 * 拿不准就回候选清单，让 AI 问一句「你是说 X 吗？」——
 * 多问一句的成本，远低于填错一台机器。
 */

import { nowIso } from "./sql.js";

/** 比对时忽略的字。这些字每个点位都有，留着只会让分数虚高。 */
const STOPWORDS = new Set([
  "the", "di", "at", "in", "no", "lot", "jalan", "jln", "taman", "tmn",
  "bandar", "pusat", "blok", "block", "level", "lantai", "tingkat",
  "那台", "那边", "那里", "机器", "的",
]);

/** 正规化：压小写、去标点与空白，只留字母数字与中日韩字元 */
export function normalize(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "");
}

/** 切成可比对的词。中文没有空格，整串一起当一个词。 */
function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** 一台机器所有可以被讲到的名字：点位全名 + 别名 */
function namesOf(machine) {
  return [machine.locationName, ...String(machine.aliases || "").split(/\r?\n/)]
    .map((s) => String(s || "").trim())
    .filter(Boolean);
}

/**
 * 顾客这段话对到哪一台机器。
 *
 * 回传 {
 *   machine     很有把握的那一台，没有就是 null
 *   candidates  分数够高的几台（含 machine），让 AI 拿去问顾客
 *   by          "machine_id" | "location" | ""，事后要查得出是怎么对上的
 * }
 */
export function matchMachine(text, machines = []) {
  const raw = String(text || "");
  const none = { machine: null, candidates: [], by: "" };
  if (!raw.trim() || !machines.length) return none;

  const usable = machines.filter((m) => m.status !== "retired");

  // 一、机号直接对上。这是最强的讯号 —— 顾客照着萤幕念出来的。
  // 比对整串正规化后的文字，避免 "RFH1" 误中 "RFH12"。
  const flat = normalize(raw);
  const byId = usable.filter((m) => {
    const id = normalize(m.machineId);
    if (!id || id.length < 3) return false;
    const at = flat.indexOf(id);
    if (at === -1) return false;
    // 后面不能再接数字，不然 RFH1 会中 RFH12
    return !/[0-9]/.test(flat[at + id.length] || "");
  });
  if (byId.length === 1) return { machine: byId[0], candidates: byId, by: "machine_id" };
  if (byId.length > 1) return { machine: null, candidates: byId, by: "machine_id" };

  // 二、点位名字。逐台算「这台的名字有几个词出现在顾客那句话里」。
  const said = new Set(tokens(raw));
  if (!said.size) return none;

  const scored = usable
    .map((m) => ({ machine: m, score: bestScore(m, said) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return none;

  const top = scored[0];
  const second = scored[1];
  // 候选放宽一点：只要有一个有意义的词对上就列出来，最多三台。
  // 这些是拿去问顾客「你是说 X 吗」的，宁可多一个选项，不要问不出来。
  const candidates = scored.filter((s) => s.score >= 0.34).slice(0, 3).map((s) => s.machine);

  // 有把握 = 分数够高，而且**明显**比第二名好。
  // 两个点位名字很像的时候（SK / SMK Taman Melawati），宁可问一句。
  const confident = top.score >= 0.6 && (!second || top.score - second.score >= 0.25);

  return { machine: confident ? top.machine : null, candidates, by: "location" };
}

/** 这台机器的哪个名字最像顾客讲的，分数多少 */
function bestScore(machine, said) {
  let best = 0;
  for (const name of namesOf(machine)) {
    const want = tokens(name);
    if (!want.length) continue;
    const hit = want.filter((t) => said.has(t)).length;
    // 用「这台的名字被讲到几成」当分数：顾客讲 "selayang" 对上
    // "Hospital Selayang Lobby" 是 1/3，讲 "hospital selayang" 是 2/3。
    // 别名就是为了补这一段 —— 常用的简称写进别名，分数自然变高。
    best = Math.max(best, hit / want.length);
  }
  return best;
}

/* ----------------------------- 资料库 ----------------------------- */

const COLS = "id, machine_id, location_name, aliases, area, status, notes, created_at, updated_at, updated_by";

export function rowToMachine(row) {
  return {
    id: row.id,
    machineId: row.machine_id,
    locationName: row.location_name,
    aliases: row.aliases || "",
    area: row.area || "",
    status: row.status,
    notes: row.notes || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by || "",
  };
}

export async function listMachines(db) {
  const { results = [] } = await db
    .prepare(`SELECT ${COLS} FROM machines ORDER BY location_name`)
    .all();
  return results.map(rowToMachine);
}

export async function upsertMachine(db, input, actorEmail) {
  const machineId = String(input.machineId || "").trim().toUpperCase();
  const locationName = String(input.locationName || "").trim();
  if (!machineId) return { ok: false, status: 400, error: "machine_id_required" };
  if (!locationName) return { ok: false, status: 400, error: "location_required" };

  const status = ["active", "paused", "retired"].includes(input.status) ? input.status : "active";
  const now = nowIso();
  // id 由机号推出，所以同一台机重复汇入不会变成两列
  const id = `m-${normalize(machineId)}`;

  await db
    .prepare(
      `INSERT INTO machines (id, machine_id, location_name, aliases, area, status, notes, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         machine_id = excluded.machine_id,
         location_name = excluded.location_name,
         aliases = excluded.aliases,
         area = excluded.area,
         status = excluded.status,
         notes = excluded.notes,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    )
    .bind(
      id, machineId, locationName,
      String(input.aliases || "").trim(),
      String(input.area || "").trim(),
      status,
      String(input.notes || "").trim(),
      now, now, String(actorEmail || "")
    )
    .run();

  return { ok: true, id };
}

export async function deleteMachine(db, id) {
  await db.prepare("DELETE FROM machines WHERE id = ?").bind(id).run();
  return { ok: true };
}

/* ------------------------------ 汇入 ------------------------------ */

/** 看起来像机号：三码以上、字母数字，而且**含数字** */
const LOOKS_LIKE_ID = /^[A-Za-z0-9][A-Za-z0-9\-_]{1,19}$/;
const HAS_DIGIT = /\d/;

/**
 * 把一段贴上来的清单解析成机器。
 *
 * 每行一台，逗号 / 定位 / 分号分隔。哪一栏是机号自己认 ——
 * 「有数字、没有空白、比较短」的那一栏。因为实际贴上来的东西
 * 两种顺序都有，要求人先整理成固定格式，多半就不会有人整理了。
 */
export function parseMachineList(text) {
  const rows = [];
  const errors = [];

  for (const [i, line] of String(text || "").split(/\r?\n/).entries()) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#")) continue;

    const parts = clean.split(/\s*[,;\t|]\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) {
      errors.push({ line: i + 1, text: clean, reason: "这一行只有一栏，需要「点位」跟「机号」两栏" });
      continue;
    }

    const idIndex = parts.findIndex((p) => LOOKS_LIKE_ID.test(p) && HAS_DIGIT.test(p) && !/\s/.test(p));
    if (idIndex === -1) {
      errors.push({ line: i + 1, text: clean, reason: "认不出哪一栏是机号（机号要有数字）" });
      continue;
    }

    const machineId = parts[idIndex].toUpperCase();
    const rest = parts.filter((_, n) => n !== idIndex);
    const locationName = rest[0] || "";
    if (!locationName) {
      errors.push({ line: i + 1, text: clean, reason: "找不到点位名称" });
      continue;
    }

    rows.push({ machineId, locationName, area: rest[1] || "" });
  }

  // 同一个机号贴了两次：后面那笔覆盖前面，并且讲出来
  const seen = new Map();
  const duplicates = [];
  for (const row of rows) {
    if (seen.has(row.machineId)) duplicates.push(row.machineId);
    seen.set(row.machineId, row);
  }

  return { machines: [...seen.values()], errors, duplicates };
}
