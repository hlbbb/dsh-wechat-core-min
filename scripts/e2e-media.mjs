/**
 * 媒体导出端到端验证（需本机微信已登录）：
 * 自动引导数据目录 → 选一个有内容的会话 → 导出图片/文件 → 断言至少导出一项。
 * 用法：node scripts/e2e-media.mjs（可用 WCHAT_PLUGIN_DATA_DIR 指定数据目录）
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliResult, runWchatCore, runWchatMedia } from "../runner.js";

const config = {};
const sessions = parseCliResult(
  await runWchatCore(config, "sessions", ["--compact", "--limit", "30"], { timeoutMs: 300000 }),
  "sessions",
);
const candidates = (sessions.sessions ?? []).filter((item) => item.last_timestamp > 0).slice(0, 10);
let done = false;
for (const chat of candidates) {
  const out = join(tmpdir(), "dsh-wchat-media-e2e", String(Date.now()));
  const result = parseCliResult(
    await runWchatMedia(config, ["--chat", String(chat.name), "--date", "all", "--limit", "3", "--out", out], {
      timeoutMs: 600000,
    }),
    "wchat_media",
  );
  const counts = result.counts ?? {};
  const total = (counts.image ?? 0) + (counts.file ?? 0);
  console.log(`chat=${chat.name} counts=${JSON.stringify(counts)}`);
  if (total > 0) {
    console.log("sample:", result.saved[0]?.path);
    done = true;
    break;
  }
}
if (!done) throw new Error("未导出到任何媒体（请确认微信运行且该账号有图片/文件消息）");
console.log("MEDIA E2E OK");
