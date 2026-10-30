/**
 * 开发自测：不经过 DSH，直接验证 runner 的命令拼装、Python 解析与解析层。
 * 覆盖核心路径（accounts / sessions / messages）与异常分支（不存在的会话）。
 */
import {
  parseCliResult,
  resolveCoreDir,
  resolveDataDir,
  resolvePythonExecutable,
  runWchatCore,
} from "../runner.js";

const config = {};

console.log("coreDir :", resolveCoreDir(config));
console.log("python  :", resolvePythonExecutable(config));
console.log("dataDir :", resolveDataDir(config));

const common = ["--data-dir", resolveDataDir(config), "--compact"];

const accounts = parseCliResult(
  await runWchatCore(config, "accounts", common, { timeoutMs: 120000 }),
  "accounts",
);
console.log("accounts:", JSON.stringify(accounts).slice(0, 300));
if (!Array.isArray(accounts.accounts) || accounts.accounts.length === 0) {
  throw new Error("accounts 应至少返回一个账号");
}

const sessions = parseCliResult(
  await runWchatCore(config, "sessions", [...common, "--limit", "50"], { timeoutMs: 120000 }),
  "sessions",
);
console.log("sessions total:", sessions.total, "| sample:", sessions.sessions[0]?.name);
if (!Array.isArray(sessions.sessions)) throw new Error("sessions 应返回数组");

// 公众号（gh_ 开头 / mphelper 等）的消息不在 message_*.db，CLI 边界内读不到，优先选群聊验证。
const recent = sessions.sessions.filter((item) => item.last_timestamp > 0);
const picked = recent.find((item) => item.is_group) ?? recent.find((item) => !item.username.startsWith("gh_"));
const chatName = picked?.name;
if (chatName) {
  const messages = parseCliResult(
    await runWchatCore(
      config,
      "messages",
      [...common, "--chat", chatName, "--date", "all", "--limit", "3"],
      { timeoutMs: 120000 },
    ),
    "messages",
  );
  const first = messages.messages?.[0];
  if (!first) throw new Error(`会话 "${chatName}" (${picked.username}) 最近有消息但读到了 0 条`);
  console.log(
    `messages chat="${chatName}" total:`,
    messages.total,
    "| first:",
    `${first.time} ${first.kind} ${first.sender}`,
  );
} else {
  throw new Error("没有任何可验证消息读取的会话");
}

const md = parseCliResult(
  await runWchatCore(
    config,
    "messages",
    [...common, "--chat", chatName, "--date", "all", "--limit", "2", "--format", "md"],
    { timeoutMs: 120000 },
  ),
  "messages",
  { asText: true },
);
console.log("md 长度:", md.length, "| 首行:", md.split("\n")[0]);

const contacts = parseCliResult(
  await runWchatCore(config, "contacts", [...common, "--limit", "5"], { timeoutMs: 120000 }),
  "contacts",
);
console.log("contacts total:", contacts.total, "| 返回条数:", contacts.contacts?.length);
if (!Array.isArray(contacts.contacts)) throw new Error("contacts 应返回数组");

if (picked?.is_group) {
  const members = parseCliResult(
    await runWchatCore(config, "group-members", [...common, "--chat", picked.name], { timeoutMs: 120000 }),
    "group-members",
  );
  console.log("group-members:", members.chat?.name, "| 成员数:", members.total);
  if (!Array.isArray(members.members) || members.members.length === 0) {
    throw new Error("群成员应至少有一人");
  }
} else {
  console.log("group-members: 跳过（抽到的会话不是群聊）");
}

try {
  parseCliResult(
    await runWchatCore(config, "messages", [...common, "--chat", "不存在的会话__e2e__", "--date", "all"], {
      timeoutMs: 120000,
    }),
    "messages",
  );
  throw new Error("错误分支未生效：不存在的会话应当抛错");
} catch (error) {
  if (!String(error.message).includes("Chat not found")) {
    throw new Error(`错误分支抛出了意外错误：${error.message}`);
  }
  console.log("error branch ok:", error.message.slice(0, 160));
}

console.log("E2E OK");
