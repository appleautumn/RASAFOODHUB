/**
 * window.storage 的实作。
 *
 * 介面形状跟原本一模一样（get / set / delete，参数与回传都不变），
 * 所以 rasacrm.jsx 里的页面程式码一行都不用改。换掉的只有背后的实作：
 *
 *   之前：整包 JSON 读进来 → 前端改 → 整包写回去
 *         两个人同时开着系统，一个改 A 顾客、一个改 B 顾客，
 *         后存的那个会把前一个的改动整个盖掉，而且不会报错。
 *
 *   现在：读的时候打 REST 端点，写的时候先比对「哪些栏位真的改了」，
 *         只送那几个栏位的 PATCH，并带上读取时拿到的 updatedAt 当乐观锁。
 *         改不同顾客不会互相影响；改同一位顾客的话第二个人拿到 409，
 *         不会默默覆盖。
 *
 * 这一层刻意做成「转接层」：之后要逐页优化（例如列表页只拿列表栏位），
 * 可以一页一页来，不必一次到位，也不必动页面程式码。
 */

export const KEY_MAIN = "rasa-crm:main"; // { customers }
export const KEY_LOG = "rasa-crm:log"; // { activities }
export const KEY_APPS = "rasa-crm:apps"; // { ai, automation, campaigns }

// KEY_APPS 拆成三个设定 key，改 AI 知识库的人跟改群发名单的人才不会互相覆盖
const APP_SECTIONS = ["ai", "automation", "campaigns"];
const settingKey = (section) => `apps.${section}`;

// 一页拿多少顾客。cursor 分页，拿完为止。
const PAGE_SIZE = 500;

/** 会被送去 PATCH 的顾客栏位。timeline 与 tags 另外处理，其余伺服器自己管。 */
const PATCHABLE = [
  "name", "whatsapp", "platform", "stage", "priority", "language", "contactType",
  "locationName", "machineId", "itemNo", "receiptDate", "receiptTime", "receiptAmount", "paymentType",
  "machineStatus", "finexusStatus", "notes", "broadcastOptIn", "needsReply",
  "nextFollowUpDate", "followUpCount", "createdAt", "lastInteractionAt",
];

const sameTags = (a = [], b = []) =>
  a.length === b.length && [...a].sort().join(" ") === [...b].sort().join(" ");

/**
 * 冲突讯息里要出现的名字。
 * 顾客 id 是随机字串（fx0000、a3k9x2m1…），对员工来说没有任何意义 ——
 * 要让他一眼知道是哪一位顾客被别人改过，才知道该去看谁。
 */
const describe = (c) =>
  String(c && (c.name || c.whatsapp) || "").trim() || `顾客 ${c && c.id}`;

// 设定分区的中文名。同理，「automation」对员工也不是人话。
const SECTION_LABEL = {
  ai: "AI 知识库",
  automation: "自动化设定",
  campaigns: "群发名单",
};

export function createStorageClient({ fetch: fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  /**
   * 伺服器上「我最后一次看到的样子」。
   * 比对用的基准，也是乐观锁 updatedAt 的来源。
   */
  const snapshot = {
    customers: new Map(), // id -> { customer, updatedAt, timelineIds:Set }
    activityIds: new Set(),
    settings: new Map(), // section -> { value, updatedAt }
    conflicted: new Set(), // 撞到 409 的顾客，重新载入前不再尝试写入
  };

  async function api(path, init = {}) {
    const res = await fetchImpl(path, {
      credentials: "include",
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* 空回应或非 JSON，交给下面用状态码判断 */
    }
    return { status: res.status, ok: res.ok, body };
  }

  const remember = (customer) => {
    snapshot.customers.set(customer.id, {
      customer,
      updatedAt: customer.updatedAt,
      timelineIds: new Set((customer.timeline || []).map((e) => e.id)),
    });
  };

  /* ------------------------------ 读 ------------------------------ */

  async function loadCustomers() {
    const all = [];
    let cursor = null;
    do {
      // 排序刻意用 createdAt 由新到旧 —— 那就是原本整包 blob 里的顺序
      // （addCustomer / makeDemo 都是往阵列最前面塞）。
      //
      // 这件事看起来无关紧要，其实不是：页面自己会再排一次（Overview 按分数、
      // Pipeline 按 updatedAt），而 Array.sort 是稳定排序 —— 分数或时间一样的时候，
      // 最后呈现的先后就由这里给的顺序决定。给错顺序，画面上同分的几列就会换位置。
      const qs = new URLSearchParams({
        include: "timeline",
        limit: String(PAGE_SIZE),
        sort: "createdAt",
      });
      if (cursor) qs.set("cursor", cursor);
      const r = await api(`/api/customers?${qs}`);
      if (!r.ok) throw new Error(`读取顾客失败：HTTP ${r.status}`);
      all.push(...(r.body.customers || []));
      cursor = r.body.nextCursor || null;
    } while (cursor);

    snapshot.customers.clear();
    snapshot.conflicted.clear();
    for (const c of all) remember(c);
    return all;
  }

  async function loadActivities() {
    const r = await api("/api/activities?limit=800");
    if (!r.ok) throw new Error(`读取活动纪录失败：HTTP ${r.status}`);
    const activities = r.body.activities || [];
    snapshot.activityIds = new Set(activities.map((a) => a.id));
    return activities;
  }

  async function loadApps() {
    const r = await api(`/api/settings?keys=${APP_SECTIONS.map(settingKey).join(",")}`);
    if (!r.ok) throw new Error(`读取设定失败：HTTP ${r.status}`);
    const settings = r.body.settings || {};
    const apps = {};
    snapshot.settings.clear();
    let found = 0;
    for (const section of APP_SECTIONS) {
      const row = settings[settingKey(section)];
      if (!row) continue;
      found += 1;
      snapshot.settings.set(section, { value: row.value, updatedAt: row.updatedAt });
      try {
        apps[section] = JSON.parse(row.value);
      } catch {
        /* 存坏了就当没有，页面会用预设值 */
      }
    }
    return found ? apps : null;
  }

  /* ------------------------------ 写 ------------------------------ */

  /** 只挑真的改了的栏位 */
  function changedFields(next, prev) {
    const patch = {};
    for (const f of PATCHABLE) {
      const a = next[f];
      const b = prev[f];
      if (a === b) continue;
      // null / undefined / "" 之间的往返不算改动，
      // 否则每次存档都会送一堆没意义的栏位
      if ((a ?? "") === (b ?? "")) continue;
      patch[f] = a;
    }
    if (!sameTags(next.tags || [], prev.tags || [])) patch.tags = next.tags || [];
    return patch;
  }

  async function saveCustomers(customers) {
    const conflicts = [];
    const seen = new Set();

    for (const c of customers) {
      if (!c || !c.id) continue;
      seen.add(c.id);

      const prev = snapshot.customers.get(c.id);

      if (!prev) {
        const r = await api("/api/customers", {
          method: "POST",
          body: JSON.stringify({ customer: c }),
        });
        if (!r.ok) throw new Error(`新增顾客失败：HTTP ${r.status}`);
        remember(r.body.customer);
        continue;
      }

      // 撞过 409 的顾客不再尝试写入：那会用新的 updatedAt 把别人的改动盖掉，
      // 正是这次要修掉的行为。要恢复只能重新载入页面。
      if (snapshot.conflicted.has(c.id)) {
        conflicts.push({ id: c.id, name: describe(c) });
        continue;
      }

      const patch = changedFields(c, prev.customer);
      const newTimeline = (c.timeline || []).filter(
        (e) => e && e.id && !prev.timelineIds.has(e.id)
      );
      if (!Object.keys(patch).length && !newTimeline.length) continue;

      const r = await api(`/api/customers/${encodeURIComponent(c.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ patch, updatedAt: prev.updatedAt, timeline: newTimeline }),
      });

      if (r.status === 409) {
        // 别人在我读取之后改过这笔。把伺服器上的版本记下来，但不覆盖。
        conflicts.push({ id: c.id, name: describe(c) });
        snapshot.conflicted.add(c.id);
        if (r.body && r.body.current) remember(r.body.current);
        continue;
      }
      if (!r.ok) throw new Error(`更新顾客失败：HTTP ${r.status}`);
      remember(r.body.customer);
    }

    // 前端把顾客整个清空（resetAll）时走一次批次删除，不是几千次单笔删除
    const removed = [...snapshot.customers.keys()].filter((id) => !seen.has(id));
    if (removed.length && !customers.length) {
      await api("/api/customers", { method: "DELETE" });
      snapshot.customers.clear();
    } else {
      for (const id of removed) {
        await api(`/api/customers/${encodeURIComponent(id)}`, { method: "DELETE" });
        snapshot.customers.delete(id);
      }
    }

    if (conflicts.length) {
      // 讯息给人看，所以讲名字；err.conflicts 给程式用，所以是 id。
      const names = conflicts.slice(0, 3).map((c) => c.name).join("、");
      const more = conflicts.length > 3 ? ` 等 ${conflicts.length} 位` : "";
      const err = new Error(
        `${names}${more}已经被其他同事改过了，你刚才对${conflicts.length > 1 ? "他们" : "他"}的修改没有存进去。` +
          `请重新载入拿到最新资料，再改一次。`
      );
      err.code = "conflict";
      err.conflicts = conflicts.map((c) => c.id);
      err.conflictNames = conflicts.map((c) => c.name);
      throw err;
    }
  }

  /** 活动纪录只新增。前端阵列上限 800，旧的滚出画面，但资料库留着。 */
  async function saveActivities(activities) {
    const fresh = (activities || []).filter((a) => a && a.id && !snapshot.activityIds.has(a.id));
    if (!fresh.length) return;
    // 页面的阵列是新的在前面。倒过来送（由旧到新），伺服器配的 seq 才会跟着时间递增，
    // 同一毫秒内的几笔纪录读回来的先后才跟画面上原本的一样。
    const r = await api("/api/activities", {
      method: "POST",
      body: JSON.stringify({ activities: [...fresh].reverse() }),
    });
    if (!r.ok) throw new Error(`写入活动纪录失败：HTTP ${r.status}`);
    for (const a of fresh) snapshot.activityIds.add(a.id);
  }

  async function saveApps(apps) {
    for (const section of APP_SECTIONS) {
      if (!(section in (apps || {}))) continue;
      const value = JSON.stringify(apps[section]);
      const prev = snapshot.settings.get(section);
      if (prev && prev.value === value) continue; // 这一段没改，不用送

      const r = await api(`/api/settings/${encodeURIComponent(settingKey(section))}`, {
        method: "PUT",
        body: JSON.stringify({ value, updatedAt: prev && prev.updatedAt }),
      });
      if (r.status === 409) {
        if (r.body && r.body.current) {
          snapshot.settings.set(section, {
            value: r.body.current.value,
            updatedAt: r.body.current.updated_at,
          });
        }
        const err = new Error(
          `「${SECTION_LABEL[section] || section}」已经被其他同事改过了，你刚才的修改没有存进去。` +
            `请重新载入拿到最新资料，再改一次。`
        );
        err.code = "conflict";
        throw err;
      }
      if (!r.ok) throw new Error(`写入设定失败：HTTP ${r.status}`);
      snapshot.settings.set(section, { value, updatedAt: r.body.updatedAt });
    }
  }

  /* --------------------- 对外：跟原本一样的三个方法 --------------------- */

  return {
    async get(key) {
      if (key === KEY_MAIN) {
        const customers = await loadCustomers();
        return { key, value: JSON.stringify({ customers }) };
      }
      if (key === KEY_LOG) {
        const activities = await loadActivities();
        return { key, value: JSON.stringify({ activities }) };
      }
      if (key === KEY_APPS) {
        const apps = await loadApps();
        // 没存过就回 null —— 跟原本 404 的行为一样，页面会用预设值开场
        return apps ? { key, value: JSON.stringify(apps) } : null;
      }
      throw new Error(`storage.get 不认得这个 key：${key}`);
    },

    async set(key, value) {
      const data = JSON.parse(String(value));
      if (key === KEY_MAIN) {
        await saveCustomers(data.customers || []);
        return { ok: true, key };
      }
      if (key === KEY_LOG) {
        await saveActivities(data.activities || []);
        return { ok: true, key };
      }
      if (key === KEY_APPS) {
        await saveApps(data || {});
        return { ok: true, key };
      }
      throw new Error(`storage.set 不认得这个 key：${key}`);
    },

    async delete(key) {
      if (key === KEY_MAIN) {
        await api("/api/customers", { method: "DELETE" });
        snapshot.customers.clear();
        snapshot.conflicted.clear();
        return;
      }
      if (key === KEY_LOG) {
        await api("/api/activities", { method: "DELETE" });
        snapshot.activityIds.clear();
        return;
      }
      if (key === KEY_APPS) {
        for (const section of APP_SECTIONS) {
          await api(`/api/settings/${encodeURIComponent(settingKey(section))}`, {
            method: "DELETE",
          });
        }
        snapshot.settings.clear();
        return;
      }
      throw new Error(`storage.delete 不认得这个 key：${key}`);
    },

    /** 测试与除错用，页面不会碰 */
    _snapshot: snapshot,
  };
}
