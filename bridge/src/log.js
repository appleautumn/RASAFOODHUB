/**
 * 一行一个 JSON 的日志。Railway 的 log 检视器能直接筛栏位，
 * 比多行的漂亮输出好查。
 *
 * ⚠️ 绝对不要把 secret、token、或讯息内文写进日志。内文是顾客资料，
 *    日志会被保存、会被贴到对话里。只记 id 与长度。
 */

const emit = (level, event, fields = {}) => {
  const line = { ts: new Date().toISOString(), level, event, ...fields };
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

export const log = {
  info: (event, fields) => emit("info", event, fields),
  warn: (event, fields) => emit("warn", event, fields),
  error: (event, fields) => emit("error", event, fields),
};
