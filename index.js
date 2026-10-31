import z from "@deepseek-ai/schemastery";
import { createTools } from "./tools.js";

/** 插件名，与 cordis 补丁行的 id 一致。 */
export const name = "dsh-wechat-core-min";

/** 依赖的宿主服务：tools（工具注册表）。 */
export const inject = ["tools"];

/** 插件配置；cordis Loader 在激活时按此 schema 校验补丁行的 config 并填充默认值。 */
export const Config = z.object({
  dataDir: z
    .string()
    .default("")
    .description("微信数据目录（需含 account_keys.json 与 databases/，由微信数据导出主程序生成）。未配置且未设环境变量 WCHAT_DATA_DIR 时，工具会报可操作错误提示配置方法。"),
  coreDir: z
    .string()
    .default("")
    .description("（可选）外部 wchat-core 项目目录：仅用于探测其 .venv 解释器；wchat_core 代码固定使用插件内置版本（含微信 4.1+ 按库密钥等必要补丁），以保证行为一致。"),
  pythonExecutable: z
    .string()
    .default("")
    .description("Python 解释器路径。留空自动探测：coreDir 的 .venv → 自动运行时 venv（%LOCALAPPDATA%）→ 系统 python/python3/py（缺依赖自动建环境）。"),
  timeoutMs: z
    .number()
    .default(180000)
    .description("单次 wchat-core CLI 调用的超时毫秒数；首次解密大数据库可能耗时较长。工具调用的总预算会在此之上自动加 10 分钟首次环境准备（创建虚拟环境、安装依赖、微信数据自动引导）余量。"),
  autoBootstrap: z
    .boolean()
    .default(true)
    .description("为 true 时，未配置 dataDir 且本机装有运行中的微信 4.x 时，自动发现微信数据目录并从微信进程只读内存提取数据库密钥（仅 Windows），生成到 %LOCALAPPDATA%\\dsh-wechat-core-min\\data。关闭后未配置 dataDir 将直接报错。"),
});

/**
 * Host 半边：把 wechat-core-min 的只读 CLI 注册为 Agent 工具。
 * Python 子进程负责解密与查询，密钥始终留在数据目录，不经过本插件。
 */
export function apply(ctx, config = {}) {
  const settings = {
    dataDir: config.dataDir ?? "",
    coreDir: config.coreDir ?? "",
    pythonExecutable: config.pythonExecutable ?? "",
    timeoutMs: Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 180000,
    autoBootstrap: config.autoBootstrap !== false,
  };
  for (const tool of createTools(settings)) {
    ctx.tools.register(tool);
  }
}
