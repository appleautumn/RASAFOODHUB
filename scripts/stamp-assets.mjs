#!/usr/bin/env node
/**
 * 给 app.js / app.css 的引用加上内容杂凑。
 *
 * 这两个档名固定不变，浏览器与 Cloudflare 边缘都会快取 ——
 * 结果就是部署了新版，使用者打开看到的还是旧的。
 * 内容一变杂凑就变，网址跟着变，快取自然失效。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../public/", import.meta.url);
const short = (name) =>
  createHash("sha256").update(readFileSync(new URL(name, root))).digest("hex").slice(0, 8);

const js = short("app.js");
const css = short("app.css");

const indexPath = new URL("index.html", root);
let html = readFileSync(indexPath, "utf8");
html = html
  .replace(/\/app\.js(\?v=[a-f0-9]+)?/g, `/app.js?v=${js}`)
  .replace(/\/app\.css(\?v=[a-f0-9]+)?/g, `/app.css?v=${css}`);
writeFileSync(indexPath, html);

console.log(`  app.js?v=${js}  app.css?v=${css}`);
