/**
 * 前端进入点。
 *
 * 原本的 CRM 用 window.storage 存资料 —— 那是 Claude Artifact 环境提供的 API，
 * 一般浏览器里不存在。搬到 Cloudflare Workers 上之后，这里补一个同样介面的实作，
 * 背后改打 worker 的 /api/storage/*，资料存在 D1，全团队共用同一份。
 *
 * 介面刻意跟原本一模一样，所以 rasacrm.jsx 里的程式码一行都不用改。
 */

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./rasacrm.jsx";

const endpoint = (key) => `/api/storage/${encodeURIComponent(key)}`;

window.storage = {
  async get(key) {
    const res = await fetch(endpoint(key), { credentials: "include" });
    if (res.status === 404) return null; // 还没存过，正常
    if (!res.ok) throw new Error(`storage.get ${key} 失败：HTTP ${res.status}`);
    return res.json(); // { key, value, updatedAt, updatedBy }
  },

  async set(key, value) {
    const res = await fetch(endpoint(key), {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: String(value) }),
    });
    if (!res.ok) throw new Error(`storage.set ${key} 失败：HTTP ${res.status}`);
    return res.json();
  },

  async delete(key) {
    const res = await fetch(endpoint(key), { method: "DELETE", credentials: "include" });
    if (!res.ok && res.status !== 404) throw new Error(`storage.delete ${key} 失败：HTTP ${res.status}`);
  },
};

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
