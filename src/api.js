/**
 * 资源导向的 API。
 *
 * 取代原本的 /api/storage/:key —— 那是整包 JSON 读写，
 * 两个人同时用就是最后写入者全覆盖，而且什么都查不了。
 *
 * 这里的每一条路由都假设呼叫端已经通过 Cloudflare Access 验证（src/index.js 负责）。
 */

import {
  listCustomers, getCustomerRow, rowToCustomer, loadTags, stageCounts,
  createCustomer, patchCustomer, deleteCustomer, replaceTags, runBatch,
} from "./customers.js";
import {
  loadTimelines, loadTimeline, listMessages, listNotes,
  timelineInserts, recomputeMessageSummary,
} from "./timeline.js";
import {
  listOrders, createOrder, listTasks, createTask,
  listActivities, appendActivities, getSetting, getSettings, putSetting, deleteSetting,
} from "./records.js";
import { triage } from "./triage.js";
import { caseSummary, caseStatus, mergeIntake } from "./casefile.js";
import { PLAYBOOK_KEY, parsePlaybook, buildSystemPrompt, DEFAULT_SCENARIOS, withNewDefaults } from "./playbook.js";
import { draftReply } from "./ai.js";

/* ---------------------------- 回应小工具 ---------------------------- */

export function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const fail = (r) => json({ ok: false, error: r.error, detail: r.detail, current: r.current }, r.status);

const MAX_BODY_BYTES = 4 * 1024 * 1024;

async function readJson(request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: "too_large" };
  }
  try {
    return { ok: true, body: raw ? JSON.parse(raw) : {} };
  } catch {
    return { ok: false, status: 400, error: "bad_json" };
  }
}

/* ------------------------------ 路由 ------------------------------ */

const SETTINGS_PREFIX = "apps.";
const SETTINGS_KEY = /^[A-Za-z0-9:_\-.]{1,128}$/;
const ID_RE = /^[A-Za-z0-9:_\-.]{1,128}$/;

export async function handleApi(request, env, url, user) {
  if (!env.DB) return json({ ok: false, error: "db_not_bound" }, 500);
  const db = env.DB;
  const method = request.method;
  const path = url.pathname;
  const seg = path.split("/").filter(Boolean); // ["api", "customers", ":id", ...]

  /* ---------------------------- customers ---------------------------- */

  if (seg[1] === "customers") {
    // GET /api/customers?stage=&priority=&tag=&needsReply=&sort=&cursor=
    if (seg.length === 2 && method === "GET") {
      const withTimeline = url.searchParams.get("include") === "timeline";
      const result = await listCustomers(db, url.searchParams, {
        attach: async (ids) => ({
          tags: await loadTags(db, ids),
          // 一次把整页的时间轴捞回来，不是一位顾客一趟
          timeline: withTimeline ? await loadTimelines(db, ids) : new Map(),
        }),
      });
      return json({ ok: true, ...result });
    }

    // POST /api/customers
    if (seg.length === 2 && method === "POST") {
      const parsed = await readJson(request);
      if (!parsed.ok) return fail(parsed);
      const input = parsed.body?.customer || parsed.body;
      const created = await createCustomer(db, input, user.email);
      if (!created.ok) return fail(created);
      if (Array.isArray(input.timeline) && input.timeline.length) {
        await runBatch(db, timelineInserts(db, input.id, input.timeline));
        await recomputeMessageSummary(db, input.id);
      }
      const row = await getCustomerRow(db, input.id);
      return json({
        ok: true,
        customer: rowToCustomer(row, {
          tags: (await loadTags(db, [input.id])).get(input.id) || [],
          timeline: await loadTimeline(db, input.id),
        }),
      }, 201);
    }

    // DELETE /api/customers —— 整个清空（前端的 resetAll）
    if (seg.length === 2 && method === "DELETE") {
      await db.prepare("DELETE FROM customers").run();
      return json({ ok: true });
    }

    const id = seg[2] ? decodeURIComponent(seg[2]) : "";
    if (id && !ID_RE.test(id)) return json({ ok: false, error: "bad_id" }, 400);

    /* --------------------- /api/customers/:id --------------------- */

    if (seg.length === 3 && id) {
      if (method === "GET") {
        const row = await getCustomerRow(db, id);
        if (!row) return json({ ok: false, error: "not_found" }, 404);
        return json({
          ok: true,
          customer: rowToCustomer(row, {
            tags: (await loadTags(db, [id])).get(id) || [],
            timeline: await loadTimeline(db, id),
          }),
        });
      }

      // PATCH：只送有改到的栏位 + 乐观锁。对不上回 409，不默默覆盖。
      if (method === "PATCH") {
        const parsed = await readJson(request);
        if (!parsed.ok) return fail(parsed);
        const { patch = {}, updatedAt, timeline } = parsed.body || {};
        const result = await patchCustomer(db, id, patch, updatedAt, user.email);
        if (!result.ok) {
          if (result.status === 409 && result.current) {
            return json({
              ok: false, error: "conflict", detail: result.detail,
              current: rowToCustomer(result.current, {
                tags: (await loadTags(db, [id])).get(id) || [],
                timeline: await loadTimeline(db, id),
              }),
            }, 409);
          }
          return fail(result);
        }
        // 时间轴事件是新增，不是覆盖：不参与乐观锁，也不会互相盖掉
        if (Array.isArray(timeline) && timeline.length) {
          await runBatch(db, timelineInserts(db, id, timeline));
          await recomputeMessageSummary(db, id);
        }
        const row = await getCustomerRow(db, id);
        return json({
          ok: true,
          customer: rowToCustomer(row, {
            tags: (await loadTags(db, [id])).get(id) || [],
            timeline: await loadTimeline(db, id),
          }),
        });
      }

      if (method === "DELETE") {
        const gone = await deleteCustomer(db, id);
        return json({ ok: gone, error: gone ? undefined : "not_found" }, gone ? 200 : 404);
      }

      return json({ ok: false, error: "method_not_allowed" }, 405);
    }

    /* ------------------ /api/customers/:id/<子资源> ------------------ */

    if (seg.length === 4 && id) {
      const sub = seg[3];

      if (sub === "messages") {
        if (method === "GET") {
          return json({ ok: true, ...(await listMessages(db, id, {
            cursor: url.searchParams.get("cursor"),
            limit: url.searchParams.get("limit"),
          })) });
        }
        if (method === "POST") {
          const parsed = await readJson(request);
          if (!parsed.ok) return fail(parsed);
          const entries = (parsed.body?.messages || [parsed.body?.message]).filter(Boolean)
            .map((m) => ({ ...m, type: "message" }));
          await runBatch(db, timelineInserts(db, id, entries));
          await recomputeMessageSummary(db, id);
          return json({ ok: true, written: entries.length }, 201);
        }
      }

      if (sub === "timeline") {
        if (method === "GET") return json({ ok: true, timeline: await loadTimeline(db, id) });
        if (method === "POST") {
          const parsed = await readJson(request);
          if (!parsed.ok) return fail(parsed);
          const entries = parsed.body?.timeline || [];
          await runBatch(db, timelineInserts(db, id, entries));
          await recomputeMessageSummary(db, id);
          return json({ ok: true, written: entries.length }, 201);
        }
      }

      if (sub === "notes") {
        if (method === "GET") return json({ ok: true, notes: await listNotes(db, id) });
        if (method === "POST") {
          const parsed = await readJson(request);
          if (!parsed.ok) return fail(parsed);
          const entries = (parsed.body?.notes || [parsed.body?.note]).filter(Boolean);
          await runBatch(db, timelineInserts(db, id, entries.map((n) => ({ ...n, type: n.type || "note" }))));
          return json({ ok: true, written: entries.length }, 201);
        }
      }

      if (sub === "orders") {
        if (method === "GET") return json({ ok: true, orders: await listOrders(db, id) });
        if (method === "POST") {
          const parsed = await readJson(request);
          if (!parsed.ok) return fail(parsed);
          const r = await createOrder(db, id, parsed.body?.order || parsed.body || {});
          return r.ok ? json({ ok: true, order: r.order }, 201) : fail(r);
        }
      }

      if (sub === "tasks") {
        if (method === "GET") return json({ ok: true, tasks: await listTasks(db, id) });
        if (method === "POST") {
          const parsed = await readJson(request);
          if (!parsed.ok) return fail(parsed);
          const r = await createTask(db, id, parsed.body?.task || parsed.body || {});
          return r.ok ? json({ ok: true, task: r.task }, 201) : fail(r);
        }
      }

      if (sub === "tags" && method === "PUT") {
        const parsed = await readJson(request);
        if (!parsed.ok) return fail(parsed);
        await replaceTags(db, id, parsed.body?.tags || []);
        return json({ ok: true });
      }

      return json({ ok: false, error: "not_found" }, 404);
    }

    return json({ ok: false, error: "not_found" }, 404);
  }

  /* ------------------------- stage counts ------------------------- */

  // Dashboard 的每阶段人数：一次 GROUP BY，不是把整库捞回前端数
  if (seg[1] === "stage-counts" && method === "GET") {
    return json({ ok: true, counts: await stageCounts(db) });
  }

  /* -------------------------- activities -------------------------- */

  if (seg[1] === "activities") {
    if (method === "GET") {
      return json({ ok: true, ...(await listActivities(db, {
        cursor: url.searchParams.get("cursor"),
        limit: url.searchParams.get("limit"),
      })) });
    }
    if (method === "POST") {
      const parsed = await readJson(request);
      if (!parsed.ok) return fail(parsed);
      const written = await appendActivities(db, parsed.body?.activities || [], user.email);
      return json({ ok: true, written }, 201);
    }
    if (method === "DELETE") {
      await db.prepare("DELETE FROM activities").run();
      return json({ ok: true });
    }
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  /* --------------------------- settings --------------------------- */

  /* ------------------------------ 分诊 ------------------------------ */

  // POST /api/triage —— 一则讯息进来，属于哪种情况、还缺什么。
  // 纯计算，不写资料、不呼叫 AI，所以按几次都无所谓。
  if (seg[1] === "triage" && method === "POST") {
    const parsed = await readJson(request);
    if (!parsed.ok) return fail(parsed);
    const text = String(parsed.body?.text || "");
    const customerId = String(parsed.body?.customerId || "");

    let customer = null;
    if (customerId) {
      if (!ID_RE.test(customerId)) return json({ ok: false, error: "bad_id" }, 400);
      const row = await getCustomerRow(db, customerId);
      if (!row) return json({ ok: false, error: "not_found" }, 404);
      customer = rowToCustomer(row);
    }

    const result = triage({ text, customer });
    const merged = customer ? { ...customer, ...mergeIntake(customer, result.extracted) } : { ...result.extracted };
    return json({
      ok: true,
      ...result,
      status: caseStatus(merged),
      summary: caseSummary(merged),
    });
  }

  /* ------------------------------ 剧本 ------------------------------ */

  // GET /api/playbook —— 目前生效的剧本，外加预设里新增、存档里还没有的条目
  if (seg[1] === "playbook" && method === "GET") {
    const row = await getSetting(db, PLAYBOOK_KEY);
    const { scenarios, source } = parsePlaybook(row?.value);
    const { scenarios: full, added } = withNewDefaults(scenarios);
    return json({
      ok: true,
      source,
      scenarios: full,
      addedFromDefaults: added,
      defaultCount: DEFAULT_SCENARIOS.length,
      updatedAt: row?.updated_at || "",
      updatedBy: row?.updated_by || "",
    });
  }

  /* ---------------------------- AI 草稿 ---------------------------- */

  // POST /api/ai/draft —— 产草稿。只产，不送。
  if (seg[1] === "ai" && seg[2] === "draft" && method === "POST") {
    const parsed = await readJson(request);
    if (!parsed.ok) return fail(parsed);
    const text = String(parsed.body?.text || "").slice(0, 4000);
    if (!text.trim()) return json({ ok: false, error: "empty_text" }, 400);

    const customerId = String(parsed.body?.customerId || "");
    let customer = null;
    if (customerId) {
      if (!ID_RE.test(customerId)) return json({ ok: false, error: "bad_id" }, 400);
      const row = await getCustomerRow(db, customerId);
      if (!row) return json({ ok: false, error: "not_found" }, 404);
      customer = rowToCustomer(row);
    }

    const result = triage({ text, customer });
    const merged = customer ? { ...customer, ...mergeIntake(customer, result.extracted) } : { ...result.extracted };
    const summary = caseSummary(merged);

    // 要转真人的那几条，连问都不问模型。拦在这里才拦得住。
    if (result.escalate) {
      return json({
        ok: true, escalate: true, scenario: result.scenario, matched: result.matched,
        missing: result.missing, summary, draft: "",
      });
    }

    const [aiRow, pbRow] = await Promise.all([
      getSetting(db, "apps.ai"),
      getSetting(db, PLAYBOOK_KEY),
    ]);

    let ai = {};
    try {
      const parsedAi = JSON.parse(aiRow?.value || "{}");
      ai = parsedAi && typeof parsedAi === "object" ? (parsedAi.ai || parsedAi) : {};
    } catch {
      ai = {};
    }

    const { scenarios } = parsePlaybook(pbRow?.value);
    const system = buildSystemPrompt({
      ai,
      scenarios,
      caseSummary: summary,
      missing: result.missing,
      suggestedScenarioId: result.scenario,
    });

    const drafted = await draftReply(env, { system, userText: text });
    if (!drafted.ok) {
      return json({
        ok: false, error: drafted.error, detail: drafted.detail,
        scenario: result.scenario, missing: result.missing, summary,
      }, drafted.status);
    }

    return json({
      ok: true, escalate: false, draft: drafted.draft, model: drafted.model,
      scenario: result.scenario, matched: result.matched,
      missing: result.missing, extracted: result.extracted,
      afterHours: result.afterHours, summary,
    });
  }

  if (seg[1] === "settings") {
    // GET /api/settings?keys=apps.ai,apps.automation —— 一趟拿多个
    if (seg.length === 2 && method === "GET") {
      const keys = String(url.searchParams.get("keys") || "").split(",").map((s) => s.trim())
        .filter((k) => SETTINGS_KEY.test(k)).slice(0, 40);
      const rows = await getSettings(db, keys);
      return json({
        ok: true,
        settings: Object.fromEntries(rows.map((r) =>
          [r.key, { value: r.value, updatedAt: r.updated_at, updatedBy: r.updated_by }])),
      });
    }

    const key = seg[2] ? decodeURIComponent(seg[2]) : "";
    if (!SETTINGS_KEY.test(key)) return json({ ok: false, error: "bad_key" }, 400);

    if (method === "GET") {
      const row = await getSetting(db, key);
      if (!row) return json({ ok: false, error: "not_found" }, 404);
      return json({ ok: true, key: row.key, value: row.value, updatedAt: row.updated_at, updatedBy: row.updated_by });
    }
    if (method === "PUT") {
      const parsed = await readJson(request);
      if (!parsed.ok) return fail(parsed);
      const value = typeof parsed.body?.value === "string" ? parsed.body.value : null;
      if (value === null) return json({ ok: false, error: "value_must_be_string" }, 400);
      const r = await putSetting(db, key, value, parsed.body?.updatedAt, user.email);
      return r.ok ? json({ ok: true, key, updatedAt: r.updatedAt }) : fail(r);
    }
    if (method === "DELETE") {
      await deleteSetting(db, key);
      return json({ ok: true, key });
    }
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  return json({ ok: false, error: "not_found" }, 404);
}

export { SETTINGS_PREFIX };
