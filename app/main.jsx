/**
 * 前端进入点。
 *
 * 原本的 CRM 用 window.storage 存资料 —— 那是 Claude Artifact 环境提供的 API，
 * 一般浏览器里不存在。搬到 Cloudflare Workers 上之后，这里补一个同样介面的实作。
 *
 * 介面刻意跟原本一模一样，所以 rasacrm.jsx 里的程式码一行都不用改。
 * 实作在 storage-client.js —— 从「整包 blob 读写」换成了资源导向的 REST，
 * 写入只送有改到的栏位并带乐观锁，两个人同时用不会互相覆盖。
 */

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./rasacrm.jsx";
import { createStorageClient } from "./storage-client.js";

window.storage = createStorageClient();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
