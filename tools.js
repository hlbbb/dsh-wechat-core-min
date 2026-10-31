import { defineTool, TOOL_ABORTED } from "@deepseek-ai/dsh-tools";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { join } from "node:path";
import { parseCliResult, resolveDataDir, runWchatCore, runWchatMedia } from "./runner.js";

const DEFAULT_LIMIT = 200;

/** 与宿主一致的规范取消错误：取消是中止，不是工具执行失败。 */
function toolAborted(command) {
  const error = new HarnessError(`wchat-core ${command} 调用已取消`, TOOL_ABORTED);
  error.name = "AbortError";
  return error;
}

/** 工具的规范输出：CLI 返回的 JSON 原样透传；文本格式（md/txt）包装为 {format, content}。 */
const jsonOutput = {
  schema: { type: "json" },
  render: (_args, value) => [
    {
      type: "text",
      text:
        value && typeof value === "object" && typeof value.content === "string" && (value.format === "md" || value.format === "txt")
          ? value.content
          : JSON.stringify(value),
    },
  ],
};

function commonFlags(config, { account, refresh } = {}) {
  const flags = ["--data-dir", resolveDataDir(config), "--compact"];
  const wanted = String(account ?? "").trim();
  if (wanted) flags.push("--account", wanted);
  if (refresh) flags.push("--refresh");
  return flags;
}

async function callCli(config, command, flags, exec, { asText = false } = {}) {
  try {
    const result = await runWchatCore(config, command, flags, {
      signal: exec.signal,
      timeoutMs: config.timeoutMs,
    });
    return parseCliResult(result, command, { asText });
  } catch (error) {
    if (exec.signal?.aborted) throw toolAborted(command);
    throw error;
  }
}

/** 创建全部工具定义；插件在 apply 中逐个 ctx.tools.register。 */
export function createTools(config) {
  // 工具调用的总预算 = 常规 CLI 超时 + 首次自动准备环境（创建 venv、安装依赖）的余量；
  // 常规调用实际几秒内完成，上限只在首次部署或解密大库时起作用。
  const cliTimeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 180000;
  const timeoutMs = cliTimeoutMs + 600000;
  const tools = [];

  tools.push(
    defineTool({
      name: "wchat_accounts",
      description:
        "列出微信本地数据目录中的账号：账号名（wxid）、是否已配置解密密钥、源数据库位置、已解密数据库数量。只读操作，不访问网络。",
      parameters: {},
      output: jsonOutput,
      timeoutMs,
      async execute(_args, exec) {
        return callCli(config, "accounts", commonFlags(config), exec);
      },
    }),
  );

  tools.push(
    defineTool({
      name: "wchat_decrypt",
      description:
        "把微信 4.x 原始加密数据库解密为明文 SQLite 缓存（SQLCipher 4，含 WAL 合并），并返回缓存位置。密钥由 Python 端从数据目录的 account_keys.json 自行读取，本工具不接触密钥。",
      parameters: {
        account: { type: "string", description: "账号（wxid）。数据目录下有多个账号时必填；只有一个账号时缺省自动选择。" },
        refresh: { type: "boolean", description: "即使缓存看起来是最新的也强制重新解密。" },
      },
      output: jsonOutput,
      timeoutMs,
      async execute(args, exec) {
        const flags = commonFlags(config, { account: args.account, refresh: args.refresh });
        return callCli(config, "decrypt", flags, exec);
      },
    }),
  );

  tools.push(
    defineTool({
      name: "wchat_sessions",
      description: "列出 / 搜索微信会话（单聊与群聊），含最近消息摘要与时间，按最近排序。只读操作。",
      parameters: {
        query: { type: "string", description: "按会话名称 / 备注 / username 过滤的关键词；留空返回全部会话。" },
        limit: { type: "integer", description: `最多返回的会话数量，默认 ${DEFAULT_LIMIT}。` },
        account: { type: "string", description: "账号（wxid）；缺省自动选择。" },
      },
      output: jsonOutput,
      timeoutMs,
      async execute(args, exec) {
        const flags = commonFlags(config, { account: args.account });
        if (String(args.query ?? "").trim()) flags.push("--query", String(args.query).trim());
        // CLI 对 sessions 的 limit=0 会返回空列表，这里归一为默认值以免踩坑。
        flags.push("--limit", String(Number.isFinite(args.limit) && args.limit > 0 ? args.limit : DEFAULT_LIMIT));
        return callCli(config, "sessions", flags, exec);
      },
    }),
  );

  tools.push(
    defineTool({
      name: "wchat_messages",
      description:
        "读取某个微信聊天（单聊或群聊）的消息记录，解析文本、文件卡片、链接、视频号、引用等常见类型并标注发送人与群昵称。日期参数优先级：start/end > days > date。只读操作。",
      parameters: {
        chat: { type: "string", required: true, description: "聊天名称或 username（联系人昵称、群名、wxid、xxx@chatroom）。模糊匹配到多个候选时会返回候选列表。" },
        date: { type: "string", description: "读取哪一天：today（默认）/ YYYY-MM-DD / all（全部）。注意 date=all 优先级最高，会忽略 start/end/days。" },
        days: { type: "integer", description: "读取最近 N 天（含今天）；提供时优先于 date。" },
        start: { type: "string", description: "起始日期或时间（ISO 格式，如 2026-10-01 或 2026-10-01T09:00:00）。" },
        end: { type: "string", description: "结束日期或时间（ISO 格式）；与 start 搭配使用，start 单独使用时 end 不限。" },
        limit: { type: "integer", description: `最多返回的消息条数，默认 ${DEFAULT_LIMIT}；0 表示不限制。` },
        offset: { type: "integer", description: "跳过前面多少条，配合 limit 翻页，默认 0。" },
        format: { type: "string", enum: ["json", "md", "txt"], description: "输出格式：json（默认，结构化）/ md / txt（紧凑文本，大结果时更省 token）。" },
        refresh: { type: "boolean", description: "读取前强制重新解密数据库（微信刚收到新消息后使用）。" },
        account: { type: "string", description: "账号（wxid）；缺省自动选择。" },
      },
      output: jsonOutput,
      timeoutMs,
      async execute(args, exec) {
        const flags = commonFlags(config, { account: args.account, refresh: args.refresh });
        flags.push("--chat", String(args.chat));
        const hasRange = String(args.start ?? "").trim() || String(args.end ?? "").trim();
        if (hasRange) {
          if (String(args.start ?? "").trim()) flags.push("--start", String(args.start).trim());
          if (String(args.end ?? "").trim()) flags.push("--end", String(args.end).trim());
        } else if (Number.isFinite(args.days)) {
          flags.push("--days", String(args.days));
        } else if (String(args.date ?? "").trim()) {
          flags.push("--date", String(args.date).trim());
        }
        flags.push("--limit", String(Number.isFinite(args.limit) ? args.limit : DEFAULT_LIMIT));
        if (Number.isFinite(args.offset)) flags.push("--offset", String(args.offset));
        const format = args.format === "md" || args.format === "txt" ? args.format : "json";
        flags.push("--format", format);
        const value = await callCli(config, "messages", flags, exec, { asText: format !== "json" });
        if (format !== "json") {
          return { format, content: value };
        }
        return value;
      },
    }),
  );

  tools.push(
    defineTool({
      name: "wchat_contacts",
      description: "列出 / 搜索微信联系人（含备注、昵称、微信号、地区等字段）。只读操作。",
      parameters: {
        query: { type: "string", description: "按名称 / 备注 / username / 微信号过滤的关键词；留空返回全部联系人。" },
        limit: { type: "integer", description: `最多返回的联系人数量，默认 ${DEFAULT_LIMIT}。` },
        account: { type: "string", description: "账号（wxid）；缺省自动选择。" },
      },
      output: jsonOutput,
      timeoutMs,
      async execute(args, exec) {
        const flags = commonFlags(config, { account: args.account });
        if (String(args.query ?? "").trim()) flags.push("--query", String(args.query).trim());
        // 同 sessions：limit=0 在 CLI 里会返回空列表，归一为默认值。
        flags.push("--limit", String(Number.isFinite(args.limit) && args.limit > 0 ? args.limit : DEFAULT_LIMIT));
        return callCli(config, "contacts", flags, exec);
      },
    }),
  );

  tools.push(
    defineTool({
      name: "wchat_group_members",
      description: "列出某个微信群聊的成员及群内昵称。chat 参数需为群聊；传入非群聊会报错。只读操作。",
      parameters: {
        chat: { type: "string", required: true, description: "群聊名称或 username（xxx@chatroom）。" },
        account: { type: "string", description: "账号（wxid）；缺省自动选择。" },
      },
      output: jsonOutput,
      timeoutMs,
      async execute(args, exec) {
        const flags = commonFlags(config, { account: args.account });
        flags.push("--chat", String(args.chat));
        return callCli(config, "group-members", flags, exec);
      },
    }),
  );

  tools.push(
    defineTool({
      name: "wchat_export_media",
      description:
        "导出指定微信聊天的文件原件与图片到本地目录：文件按原件复制；图片用本机图片密钥自动解密为 png/jpg（微信已清理的原图会回退导出缩略图）。默认保存到当前会话工作目录下的 wechat-media/<聊天名>/，返回每个文件的本地路径。只读操作：仅复制/解密微信本地文件，不修改原始数据；需实时模式（本机微信运行中）。",
      parameters: {
        chat: { type: "string", required: true, description: "聊天名称或 username（联系人昵称、群名、wxid、xxx@chatroom）。" },
        types: {
          type: "array",
          items: { type: "string", enum: ["image", "file"] },
          description: "导出类型，默认图片+文件。",
        },
        date: { type: "string", description: "today（默认）/ YYYY-MM-DD / all；date=all 时忽略 start/end/days。" },
        days: { type: "integer", description: "最近 N 天（含今天）。" },
        start: { type: "string", description: "起始日期/时间（ISO 格式）。" },
        end: { type: "string", description: "结束日期/时间（ISO 格式）。" },
        limit: { type: "integer", description: "每种类型最多导出条数，默认 50。" },
        outDir: { type: "string", description: "输出目录；默认当前会话工作目录下的 wechat-media。" },
        account: { type: "string", description: "账号（wxid）；缺省自动选择。" },
      },
      output: jsonOutput,
      timeoutMs,
      async execute(args, exec) {
        const workspace = exec.agent?.session?.header?.cwd || process.cwd();
        const outDir = String(args.outDir ?? "").trim() || join(workspace, "wechat-media");
        const flags = commonFlags(config, { account: args.account });
        flags.push("--chat", String(args.chat));
        const types = Array.isArray(args.types) && args.types.length ? args.types.join(",") : "image,file";
        flags.push("--types", types);
        flags.push("--limit", String(Number.isFinite(args.limit) ? args.limit : 50));
        const hasRange = String(args.start ?? "").trim() || String(args.end ?? "").trim();
        if (hasRange) {
          if (String(args.start ?? "").trim()) flags.push("--start", String(args.start).trim());
          if (String(args.end ?? "").trim()) flags.push("--end", String(args.end).trim());
        } else if (Number.isFinite(args.days)) {
          flags.push("--days", String(args.days));
        } else if (String(args.date ?? "").trim()) {
          flags.push("--date", String(args.date).trim());
        }
        flags.push("--out", outDir);
        try {
          const result = await runWchatMedia(config, flags, {
            signal: exec.signal,
            timeoutMs: Math.max(Number(config.timeoutMs) || 0, 600000),
          });
          return parseCliResult(result, "wchat_media", { label: "wchat_media" });
        } catch (error) {
          if (exec.signal?.aborted) throw toolAborted("wchat_media");
          throw error;
        }
      },
    }),
  );

  return tools;
}
