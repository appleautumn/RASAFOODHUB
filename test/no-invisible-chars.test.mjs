import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * 挡不可见字元。
 *
 * 起因：写程式时为了让注解里的 `*\u200B/` 不要提早关掉区块注解，塞了一个零宽
 * 空白进去。它在编辑器、diff、code review 里全部看不见 —— 谁顺手清一下
 * 空白就会把它删掉，然后注解结构崩掉、错误讯息指向完全无关的地方。
 *
 * 这类字元没有任何正当理由出现在这个专案的原始码里，所以一律挡。
 * 需要在测试里放这类字元时一律用逃脱序列（\uXXXX）—— 那在 diff 里看得见，
 * 这个档案自己也因此通得过自己订的规则。
 */

/** 允许的：定位、换行、回车。其余控制字元与不可见空白一律不准。 */
function findInvisible(text) {
  const hits = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    for (let col = 0; col < lines[i].length; col++) {
      const ch = lines[i][col];
      const cp = ch.codePointAt(0);

      if (ch === "\t" || ch === "\r") continue;

      const bad =
        cp === 0xfeff || // BOM / 零宽不断空白
        cp === 0x00a0 || // 不断空白
        (cp >= 0x200b && cp <= 0x200f) || // 零宽空白、连接符、方向标记
        (cp >= 0x2028 && cp <= 0x202e) || // 行/段分隔、方向覆写
        (cp >= 0x2060 && cp <= 0x2064) || // 词连接符等
        (cp >= 0xfff9 && cp <= 0xfffb) || // 注释字元
        (cp < 0x20) || // 其余 C0 控制字元
        (cp >= 0x7f && cp <= 0x9f); // DEL 与 C1 控制字元

      if (bad) {
        hits.push(`第 ${i + 1} 行第 ${col + 1} 字：U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
      }
    }
  }
  return hits;
}

/** 只检查 git 追踪的文字档 —— node_modules 与产出物不算 */
function trackedTextFiles() {
  const out = execFileSync("git", ["ls-files"], { encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => /\.(js|jsx|mjs|ts|tsx|json|md|sql|toml|css|html|yml|yaml)$/.test(f))
    // public/ 是 build 产出，内容由打包工具决定，不是我们写的
    .filter((f) => !f.startsWith("public/"));
}

test("原始码里没有不可见字元", () => {
  const problems = [];

  for (const file of trackedTextFiles()) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // 二进位或读不到的跳过
    }
    const hits = findInvisible(text);
    if (hits.length) problems.push(`${file}\n    ${hits.slice(0, 5).join("\n    ")}`);
  }

  assert.deepEqual(
    problems,
    [],
    `发现不可见字元（编辑器和 diff 里看不到，但会造成极难查的问题）：\n  ${problems.join("\n  ")}`
  );
});

/* 检查函式本身要测 —— 不然它可能什么都抓不到而测试照样绿 */

test("抓得到零宽空白", () => {
  assert.equal(findInvisible("const a = 1;\u200B").length, 1);
});

test("抓得到不断空白与 BOM", () => {
  assert.equal(findInvisible("a\u00A0b").length, 1, "U+00A0 没抓到");
  assert.equal(findInvisible("\uFEFFconst").length, 1, "BOM 没抓到");
});

test("抓得到方向覆写字元（可以让程式码显示成另一个样子）", () => {
  assert.equal(findInvisible("x\u202Ey").length, 1);
});

test("定位、换行、一般空白不算", () => {
  assert.deepEqual(findInvisible("a\tb c\nd"), []);
});

test("中文与 emoji 不算", () => {
  assert.deepEqual(findInvisible("顾客名单 ✅ 已连线"), []);
});

test("回报的位置指得出行与字元", () => {
  const hits = findInvisible("line1\nab\u200Bcd");
  assert.equal(hits.length, 1);
  assert.match(hits[0], /第 2 行第 3 字/);
  assert.match(hits[0], /U\+200B/);
});
