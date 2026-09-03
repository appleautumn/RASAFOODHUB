/**
 * window.storage 转接层。
 *
 * 这一层的合约是「页面完全不用动」：方法名、参数、回传的资料形状都跟原本一样。
 * 下面同时验两件事：
 *   1. 形状没变 —— 存进去什么，读出来还是什么
 *   2. 写入真的只送有改到的栏位，而且撞到 409 不会硬盖
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createTestDb, testEnv, seedUsers } from "./helpers/d1.mjs";
import { handleApi } from "../src/api.js";
import { createStorageClient, KEY_MAIN, KEY_LOG, KEY_APPS } from "../app/storage-client.js";

const USER = { email: "rasafoodhubplt@gmail.com", name: "Rasa Admin", role: "admin" };
const OTHER = { email: "ahkit@example.com", name: "Ah Kit", role: "staff" };

/**
 * 把 fetch 接到 worker 上，中间不经过网路。
 * requests 阵列会记下每一趟，测试就能断言「只送了一个 PATCH，而且只带一个栏位」。
 */
function wire(env, user = USER) {
  const requests = [];
  const fetchImpl = async (path, init = {}) => {
    const url = new URL(`https://crm.rasafoodhub.com${path}`);
    const request = new Request(url, {
      method: init.method || "GET",
      ...(init.body ? { body: init.body, headers: init.headers } : {}),
    });
    requests.push({
      method: init.method || "GET",
      path,
      body: init.body ? JSON.parse(init.body) : null,
    });
    return handleApi(request, env, url, user);
  };
  return { storage: createStorageClient({ fetch: fetchImpl }), requests };
}

function setup() {
  const db = createTestDb();
  seedUsers(db, [
    { email: USER.email, name: USER.name, role: "admin", is_active: 1 },
    { email: OTHER.email, name: OTHER.name, role: "staff", is_active: 1 },
  ]);
  return { db, env: testEnv(db) };
}

/** 前端 blankCustomer() 的形状 */
const uiCustomer = (over = {}) => ({
  id: "c1",
  name: "Nurul Aisyah",
  whatsapp: "+60 12-345 6789",
  locationName: "Hospital Selayang Lobby",
  machineId: "RFH-204",
  itemNo: "23",
  receiptDate: "2026-08-30",
  receiptTime: "14:20",
  receiptAmount: "4.50",
  machineStatus: "pending",
  finexusStatus: "captured",
  stage: "new",
  priority: "medium",
  tags: ["回头客"],
  notes: "只能传讯息",
  contactType: "customer",
  broadcastOptIn: false,
  needsReply: true,
  nextFollowUpDate: "2026-09-03",
  followUpCount: 1,
  lastInteractionAt: "2026-08-30T06:20:00.000Z",
  createdAt: "2026-08-20T01:00:00.000Z",
  updatedAt: "2026-08-30T06:20:00.000Z",
  timeline: [
    { id: "t1", at: "2026-08-30T06:20:00.000Z", by: "系统", type: "message", text: "顾客来讯" },
  ],
  ...over,
});

/* ------------------------- 介面形状不能变 ------------------------- */

test("get / set / delete 三个方法都还在，签名没变", () => {
  const { env } = setup();
  const { storage } = wire(env);
  assert.equal(typeof storage.get, "function");
  assert.equal(typeof storage.set, "function");
  assert.equal(typeof storage.delete, "function");
});

test("存进去再读出来，前端拿到的顾客物件跟原本一模一样", async () => {
  const { env } = setup();
  const { storage } = wire(env);
  const original = uiCustomer();

  await storage.set(KEY_MAIN, JSON.stringify({ customers: [original] }));

  // 换一个新的 client 读，确保读到的是资料库里的东西，不是记忆体里的快取
  const { storage: fresh } = wire(env);
  const r = await fresh.get(KEY_MAIN);
  const [got] = JSON.parse(r.value).customers;

  for (const key of Object.keys(original)) {
    if (key === "updatedAt") continue; // 伺服器会给新的
    assert.deepEqual(got[key], original[key], `栏位 ${key} 变了`);
  }
});

test("没存过任何设定时 get 回 null —— 跟原本 404 的行为一样", async () => {
  const { env } = setup();
  const { storage } = wire(env);
  assert.equal(await storage.get(KEY_APPS), null);
});

test("活动纪录来回一趟形状不变", async () => {
  const { env } = setup();
  const { storage } = wire(env);
  const activities = [
    { id: "a1", at: "2026-09-01T10:00:00.000Z", actor: "Rasa Admin", role: "admin",
      action: "换阶段", target: "Nurul", description: "从「新进线」改为「核实中」" },
  ];
  await storage.set(KEY_LOG, JSON.stringify({ activities }));

  const { storage: fresh } = wire(env);
  const got = JSON.parse((await fresh.get(KEY_LOG)).value).activities;
  assert.equal(got.length, 1);
  for (const key of Object.keys(activities[0])) {
    assert.equal(got[0][key], activities[0][key], `栏位 ${key} 变了`);
  }
});

test("设定来回一趟形状不变", async () => {
  const { env } = setup();
  const { storage } = wire(env);
  const apps = {
    ai: { product: "Rasa Foodhub", draftStats: { used: 3, edited: 1, rejected: 0 } },
    automation: { masterEnabled: false, flows: [{ id: "flow_main", steps: [] }], runLog: [] },
    campaigns: [{ id: "cp1", name: "八月回访", recipients: ["c1"] }],
  };
  await storage.set(KEY_APPS, JSON.stringify(apps));

  const { storage: fresh } = wire(env);
  assert.deepEqual(JSON.parse((await fresh.get(KEY_APPS)).value), apps);
});

/* -------------------- 写入真的是栏位级的 -------------------- */

test("只改一个栏位，就只送一个 PATCH，而且只带那一个栏位", async () => {
  const { env } = setup();
  const { storage } = wire(env);
  await storage.set(KEY_MAIN, JSON.stringify({ customers: [uiCustomer()] }));

  const loaded = JSON.parse((await storage.get(KEY_MAIN)).value).customers;
  const { requests } = wire(env); // 只是为了拿一个乾净的记录器
  const tracked = wire(env);
  await tracked.storage.get(KEY_MAIN);
  tracked.requests.length = 0;

  const next = loaded.map((c) => ({ ...c, stage: "verifying" }));
  await tracked.storage.set(KEY_MAIN, JSON.stringify({ customers: next }));

  const patches = tracked.requests.filter((r) => r.method === "PATCH");
  assert.equal(patches.length, 1, "应该只送一个 PATCH");
  assert.deepEqual(Object.keys(patches[0].body.patch), ["stage"], "多送了没改的栏位");
  assert.ok(patches[0].body.updatedAt, "PATCH 一定要带乐观锁用的 updatedAt");
  assert.equal(requests.length >= 0, true);
});

test("什么都没改就不送任何写入请求", async () => {
  const { env } = setup();
  const { storage } = wire(env);
  await storage.set(KEY_MAIN, JSON.stringify({ customers: [uiCustomer()] }));

  const tracked = wire(env);
  const loaded = JSON.parse((await tracked.storage.get(KEY_MAIN)).value).customers;
  tracked.requests.length = 0;

  await tracked.storage.set(KEY_MAIN, JSON.stringify({ customers: loaded }));
  const writes = tracked.requests.filter((r) => r.method !== "GET");
  assert.deepEqual(writes, [], "没改动却送了请求：" + JSON.stringify(writes));
});

test("改 20 位顾客里的 1 位，另外 19 位完全没被碰到", async () => {
  const { db, env } = setup();
  const { storage } = wire(env);
  const many = Array.from({ length: 20 }, (_, i) =>
    uiCustomer({ id: `c${i}`, name: `顾客 ${i}`, timeline: [] })
  );
  await storage.set(KEY_MAIN, JSON.stringify({ customers: many }));

  const tracked = wire(env);
  const loaded = JSON.parse((await tracked.storage.get(KEY_MAIN)).value).customers;
  const beforeStamps = Object.fromEntries(loaded.map((c) => [c.id, c.updatedAt]));
  tracked.requests.length = 0;

  const next = loaded.map((c) => (c.id === "c7" ? { ...c, priority: "high" } : c));
  await tracked.storage.set(KEY_MAIN, JSON.stringify({ customers: next }));

  assert.equal(tracked.requests.filter((r) => r.method === "PATCH").length, 1);
  for (const row of db._rows("SELECT id, updated_at FROM customers")) {
    if (row.id === "c7") continue;
    assert.equal(row.updated_at, beforeStamps[row.id], `${row.id} 被无谓地改写了`);
  }
});

test("新增顾客走 POST，不是把整包重写", async () => {
  const { env } = setup();
  const tracked = wire(env);
  await tracked.storage.set(KEY_MAIN, JSON.stringify({ customers: [uiCustomer()] }));
  tracked.requests.length = 0;

  const loaded = JSON.parse((await tracked.storage.get(KEY_MAIN)).value).customers;
  tracked.requests.length = 0;
  await tracked.storage.set(
    KEY_MAIN,
    JSON.stringify({ customers: [uiCustomer({ id: "c2", name: "新顾客" }), ...loaded] })
  );

  assert.equal(tracked.requests.filter((r) => r.method === "POST").length, 1);
  assert.equal(tracked.requests.filter((r) => r.method === "PATCH").length, 0);
});

test("新增的时间轴事件只送新的那几则", async () => {
  const { env } = setup();
  const tracked = wire(env);
  await tracked.storage.set(KEY_MAIN, JSON.stringify({ customers: [uiCustomer()] }));

  const loaded = JSON.parse((await tracked.storage.get(KEY_MAIN)).value).customers;
  tracked.requests.length = 0;

  const next = loaded.map((c) => ({
    ...c,
    timeline: [
      { id: "t2", at: "2026-09-01T00:00:00.000Z", by: "Rasa Admin", type: "note", text: "已回电" },
      ...c.timeline,
    ],
  }));
  await tracked.storage.set(KEY_MAIN, JSON.stringify({ customers: next }));

  const patch = tracked.requests.find((r) => r.method === "PATCH");
  assert.equal(patch.body.timeline.length, 1);
  assert.equal(patch.body.timeline[0].id, "t2");
});

/* -------------------- 两个分页同时用 -------------------- */

test("两个分页各改各的顾客，两边的改动都还在", async () => {
  const { env } = setup();
  const seed = wire(env);
  await seed.storage.set(
    KEY_MAIN,
    JSON.stringify({ customers: [uiCustomer({ id: "A" }), uiCustomer({ id: "B" })] })
  );

  // 两个分页各自开着系统，各自读了一份
  const tab1 = wire(env, USER);
  const tab2 = wire(env, OTHER);
  const list1 = JSON.parse((await tab1.storage.get(KEY_MAIN)).value).customers;
  const list2 = JSON.parse((await tab2.storage.get(KEY_MAIN)).value).customers;

  await tab1.storage.set(
    KEY_MAIN,
    JSON.stringify({ customers: list1.map((c) => (c.id === "A" ? { ...c, stage: "verifying" } : c)) })
  );
  await tab2.storage.set(
    KEY_MAIN,
    JSON.stringify({ customers: list2.map((c) => (c.id === "B" ? { ...c, priority: "high" } : c)) })
  );

  const final = JSON.parse((await wire(env).storage.get(KEY_MAIN)).value).customers;
  const a = final.find((c) => c.id === "A");
  const b = final.find((c) => c.id === "B");
  assert.equal(a.stage, "verifying", "分页 1 的改动不见了");
  assert.equal(b.priority, "high", "分页 2 的改动不见了");
});

test("两个分页改同一位顾客，第二个存档的丢出冲突错误，第一个人的改动留着", async () => {
  const { env } = setup();
  await wire(env).storage.set(KEY_MAIN, JSON.stringify({ customers: [uiCustomer()] }));

  const tab1 = wire(env, USER);
  const tab2 = wire(env, OTHER);
  const list1 = JSON.parse((await tab1.storage.get(KEY_MAIN)).value).customers;
  const list2 = JSON.parse((await tab2.storage.get(KEY_MAIN)).value).customers;

  await tab1.storage.set(
    KEY_MAIN,
    JSON.stringify({ customers: list1.map((c) => ({ ...c, stage: "verifying" })) })
  );

  await assert.rejects(
    () =>
      tab2.storage.set(
        KEY_MAIN,
        JSON.stringify({ customers: list2.map((c) => ({ ...c, stage: "closed" })) })
      ),
    (err) => {
      assert.equal(err.code, "conflict");
      assert.deepEqual(err.conflicts, ["c1"]);
      return true;
    }
  );

  const final = JSON.parse((await wire(env).storage.get(KEY_MAIN)).value).customers;
  assert.equal(final[0].stage, "verifying", "第一个人的改动被盖掉了");
});

test("冲突讯息讲的是顾客名字与该怎么办，不是 id", async () => {
  const { env } = setup();
  await wire(env).storage.set(
    KEY_MAIN,
    JSON.stringify({ customers: [uiCustomer({ id: "c1", name: "Nurul Aisyah" })] })
  );

  const tab1 = wire(env, USER);
  const tab2 = wire(env, OTHER);
  const list1 = JSON.parse((await tab1.storage.get(KEY_MAIN)).value).customers;
  const list2 = JSON.parse((await tab2.storage.get(KEY_MAIN)).value).customers;

  await tab1.storage.set(KEY_MAIN,
    JSON.stringify({ customers: list1.map((c) => ({ ...c, stage: "verifying" })) }));

  await assert.rejects(
    () => tab2.storage.set(KEY_MAIN,
      JSON.stringify({ customers: list2.map((c) => ({ ...c, stage: "closed" })) })),
    (err) => {
      // 员工看得懂的：谁被改了、该怎么办
      assert.match(err.message, /Nurul Aisyah/, "讯息里要有顾客的名字");
      assert.match(err.message, /重新载入/, "讯息要告诉他该怎么办");
      assert.doesNotMatch(err.message, /\bc1\b/, "讯息里不该出现内部 id");
      // 给程式用的：id
      assert.deepEqual(err.conflicts, ["c1"]);
      assert.deepEqual(err.conflictNames, ["Nurul Aisyah"]);
      return true;
    }
  );
});

test("没有名字的顾客，冲突讯息退而用电话，不会露出 id", async () => {
  const { env } = setup();
  await wire(env).storage.set(
    KEY_MAIN,
    JSON.stringify({ customers: [uiCustomer({ id: "c1", name: "", whatsapp: "+60 12-345 6789" })] })
  );

  const tab1 = wire(env, USER);
  const tab2 = wire(env, OTHER);
  const list1 = JSON.parse((await tab1.storage.get(KEY_MAIN)).value).customers;
  const list2 = JSON.parse((await tab2.storage.get(KEY_MAIN)).value).customers;

  await tab1.storage.set(KEY_MAIN,
    JSON.stringify({ customers: list1.map((c) => ({ ...c, stage: "verifying" })) }));

  await assert.rejects(
    () => tab2.storage.set(KEY_MAIN,
      JSON.stringify({ customers: list2.map((c) => ({ ...c, stage: "closed" })) })),
    (err) => {
      assert.match(err.message, /\+60 12-345 6789/);
      return true;
    }
  );
});

test("设定冲突的讯息也讲人话，不是「automation」", async () => {
  const { env } = setup();
  await wire(env).storage.set(KEY_APPS, JSON.stringify({ automation: { masterEnabled: false } }));

  const tab1 = wire(env, USER);
  const tab2 = wire(env, OTHER);
  await tab1.storage.get(KEY_APPS);
  await tab2.storage.get(KEY_APPS);

  await tab1.storage.set(KEY_APPS, JSON.stringify({ automation: { masterEnabled: true } }));
  await assert.rejects(
    () => tab2.storage.set(KEY_APPS, JSON.stringify({ automation: { masterEnabled: false, x: 1 } })),
    (err) => {
      assert.equal(err.code, "conflict");
      assert.match(err.message, /自动化设定/);
      assert.match(err.message, /重新载入/);
      return true;
    }
  );
});

test("撞过冲突之后不会自己重试把别人的改动盖掉", async () => {
  const { env } = setup();
  await wire(env).storage.set(KEY_MAIN, JSON.stringify({ customers: [uiCustomer()] }));

  const tab1 = wire(env, USER);
  const tab2 = wire(env, OTHER);
  const list1 = JSON.parse((await tab1.storage.get(KEY_MAIN)).value).customers;
  const list2 = JSON.parse((await tab2.storage.get(KEY_MAIN)).value).customers;

  await tab1.storage.set(
    KEY_MAIN,
    JSON.stringify({ customers: list1.map((c) => ({ ...c, stage: "verifying" })) })
  );

  const stale = list2.map((c) => ({ ...c, stage: "closed" }));
  await assert.rejects(() => tab2.storage.set(KEY_MAIN, JSON.stringify({ customers: stale })));

  // 使用者没重新整理就又改了别的东西，再存一次 —— 一样要被挡
  const again = stale.map((c) => ({ ...c, notes: "又改了一次" }));
  await assert.rejects(() => tab2.storage.set(KEY_MAIN, JSON.stringify({ customers: again })));

  const final = JSON.parse((await wire(env).storage.get(KEY_MAIN)).value).customers;
  assert.equal(final[0].stage, "verifying", "冲突之后自己重试，把别人的改动盖掉了");
});

test("重新载入之后冲突状态清掉，可以正常再改一次", async () => {
  const { env } = setup();
  await wire(env).storage.set(KEY_MAIN, JSON.stringify({ customers: [uiCustomer()] }));

  const tab1 = wire(env, USER);
  const tab2 = wire(env, OTHER);
  const list1 = JSON.parse((await tab1.storage.get(KEY_MAIN)).value).customers;
  const list2 = JSON.parse((await tab2.storage.get(KEY_MAIN)).value).customers;

  await tab1.storage.set(KEY_MAIN,
    JSON.stringify({ customers: list1.map((c) => ({ ...c, stage: "verifying" })) }));
  await assert.rejects(() =>
    tab2.storage.set(KEY_MAIN, JSON.stringify({ customers: list2.map((c) => ({ ...c, stage: "closed" })) })));

  // 重新载入（就是使用者按 F5 之后会发生的事）
  const reloaded = JSON.parse((await tab2.storage.get(KEY_MAIN)).value).customers;
  assert.equal(reloaded[0].stage, "verifying");
  await tab2.storage.set(KEY_MAIN,
    JSON.stringify({ customers: reloaded.map((c) => ({ ...c, priority: "high" })) }));

  const final = JSON.parse((await wire(env).storage.get(KEY_MAIN)).value).customers;
  assert.equal(final[0].priority, "high");
  assert.equal(final[0].stage, "verifying");
});

/* ---------------------------- 清空 ---------------------------- */

test("resetAll：清空之后三个 key 都是空的", async () => {
  const { db, env } = setup();
  const { storage } = wire(env);
  await storage.set(KEY_MAIN, JSON.stringify({ customers: [uiCustomer()] }));
  await storage.set(KEY_LOG, JSON.stringify({ activities: [{ id: "a1", at: "2026-09-01T00:00:00.000Z" }] }));
  await storage.set(KEY_APPS, JSON.stringify({ ai: { product: "x" } }));

  await storage.delete(KEY_MAIN);
  await storage.delete(KEY_LOG);
  await storage.delete(KEY_APPS);

  assert.equal(db._rows("SELECT * FROM customers").length, 0);
  assert.equal(db._rows("SELECT * FROM activities").length, 0);
  assert.equal(db._rows("SELECT * FROM settings").length, 0);
  // 顾客没了，他的讯息也该跟着走
  assert.equal(db._rows("SELECT * FROM messages").length, 0);
});

test("清空整份名单只送一次批次删除，不是几千次单笔删除", async () => {
  const { env } = setup();
  const tracked = wire(env);
  const many = Array.from({ length: 30 }, (_, i) => uiCustomer({ id: `c${i}`, timeline: [] }));
  await tracked.storage.set(KEY_MAIN, JSON.stringify({ customers: many }));
  await tracked.storage.get(KEY_MAIN);
  tracked.requests.length = 0;

  await tracked.storage.set(KEY_MAIN, JSON.stringify({ customers: [] }));
  const deletes = tracked.requests.filter((r) => r.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].path, "/api/customers");
});

/* ---------------------------- 分页读取 ---------------------------- */

test("顾客超过一页时，转接层自己翻完所有页", async () => {
  const { env } = setup();
  const { storage } = wire(env);
  // PAGE_SIZE 是 500，塞 520 笔就一定会分成两页
  const many = Array.from({ length: 520 }, (_, i) =>
    uiCustomer({ id: `c${String(i).padStart(4, "0")}`, timeline: [], tags: [] })
  );
  await storage.set(KEY_MAIN, JSON.stringify({ customers: many }));

  const fresh = wire(env);
  const loaded = JSON.parse((await fresh.storage.get(KEY_MAIN)).value).customers;
  assert.equal(loaded.length, 520);
  assert.equal(new Set(loaded.map((c) => c.id)).size, 520);
  assert.ok(
    fresh.requests.filter((r) => r.path.startsWith("/api/customers?")).length >= 2,
    "应该翻了不只一页"
  );
});
