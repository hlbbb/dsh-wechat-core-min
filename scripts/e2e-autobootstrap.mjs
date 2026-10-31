/**
 * 端到端验证「开箱即用」全链路（需要本机微信已登录并运行）：
 * 1) 未配置 dataDir 且 autoBootstrap 开启 → 自动发现微信数据 + 只读提取密钥 + 生成数据目录；
 * 2) 用生成的数据目录读取 accounts / sessions / messages。
 * 用法：node scripts/e2e-autobootstrap.mjs
 * 说明：默认生成到 %LOCALAPPDATA%\dsh-wechat-core-min\data；可用 WCHAT_PLUGIN_DATA_DIR 指定其他目录。
 */
import { parseCliResult, runWchatCore, PLUGIN_DATA_DIR } from "../runner.js";

const config = { autoBootstrap: true };
console.log("插件数据目录:", PLUGIN_DATA_DIR);
const startedAt = Date.now();
const accounts = parseCliResult(await runWchatCore(config, "accounts", ["--compact"], { timeoutMs: 600000 }), "accounts");
console.log(`accounts ok in ${Math.round((Date.now() - startedAt) / 1000)}s（含自动引导）:`, JSON.stringify(accounts.accounts?.length), "个账号");

const sessions = parseCliResult(await runWchatCore(config, "sessions", ["--compact", "--limit", "3"], { timeoutMs: 120000 }), "sessions");
console.log("sessions total:", sessions.total);

const chatName = sessions.sessions?.find((item) => item.last_timestamp > 0)?.name;
if (chatName) {
  const messages = parseCliResult(
    await runWchatCore(config, "messages", ["--chat", String(chatName), "--date", "all", "--limit", "2", "--compact"], {
      timeoutMs: 120000,
    }),
    "messages",
  );
  console.log(`messages ok: chat=${chatName} total=${messages.total}`);
}

console.log("AUTO-BOOTSTRAP E2E OK");
