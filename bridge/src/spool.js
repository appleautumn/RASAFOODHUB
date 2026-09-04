/**
 * 佇列的落地存放。
 *
 * 为什么需要：佇列本来只在记忆体里，桥接机一重启就整个清空。今天就这样
 * 掉了 11 则已经收到、还没送出去的讯息 —— 而重启在这个系统里是家常便饭
 * （改一个环境变数、Railway 换机器、OOM）。
 *
 * WhatsApp 的登入状态已经存在 /data 那颗持久磁碟上了，佇列存同一个地方，
 * 重启就接得回来。
 *
 * 格式是一行一个 JSON（JSONL）。写入用「先写暂存档再 rename」——
 * rename 在同一个档案系统上是原子的，所以就算正好在写的时候断电，
 * 也只会读到「旧的完整档案」或「新的完整档案」，不会读到写到一半的。
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./log.js";

export function createSpool(path) {
  if (!path) {
    // 没设路径就用一个什么都不做的替身，程式其它地方不必到处判断
    return { load: () => [], save: () => {}, enabled: false, path: null };
  }

  // 建不出目录就退化成「不落地」，而不是让整个服务起不来。
  // 佇列在记忆体里还是能收讯，只是重启会掉 —— 那比完全不能收讯好。
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    log.error("spool_disabled", {
      path,
      error: String(err.message || err),
      detail: "建立佇列目录失败，改成只放记忆体。重启会掉未送出的讯息。",
    });
    return { load: () => [], save: () => {}, enabled: false, path: null };
  }

  return {
    enabled: true,
    path,

    /** 开机时把上次没送完的读回来。档案坏掉不该让服务起不来 —— 记下来然后继续。 */
    load() {
      if (!existsSync(path)) return [];
      try {
        const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
        const items = [];
        let broken = 0;
        for (const line of lines) {
          try {
            items.push(JSON.parse(line));
          } catch {
            broken += 1;
          }
        }
        log.info("spool_loaded", { path, restored: items.length, broken });
        return items;
      } catch (err) {
        log.error("spool_load_failed", { path, error: String(err.message || err) });
        return [];
      }
    },

    /**
     * 整份覆写成目前佇列的内容。
     *
     * 不用「附加 + 标记已送出」那种做法：佇列很小（上限几千笔），整份重写
     * 简单且不会有对不齐的状态。写失败只记录、不抛出 —— 磁碟满了不该让
     * 收讯这条路跟着断掉，讯息至少还在记忆体里。
     */
    save(items) {
      const tmp = `${path}.tmp`;
      try {
        writeFileSync(tmp, items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""));
        renameSync(tmp, path);
      } catch (err) {
        log.error("spool_save_failed", { path, error: String(err.message || err) });
        try {
          if (existsSync(tmp)) unlinkSync(tmp);
        } catch {
          /* 清不掉暂存档就算了，下次覆写会盖掉 */
        }
      }
    },
  };
}
