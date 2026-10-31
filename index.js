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
    .description("微信数据目录（需含 account_keys.json 与 databases/）。留空时依次尝试环境变量 WCHAT_DATA_DIR 与内置默认路径。"),
  coreDir: z
    .string()
    .default("")
    .description("wchat-core 项目目录（需含 wchat_core Python 包，推荐有 .venv）。留空时若默认路径存在则用之，否则回退插件内置源码。"),
  pythonExecutable: z
    .string()
    .default("")
    .description("Python 解释器路径。留空自动探测：coreDir 的 .venv → 自动运行时 venv（%LOCALAPPDATA%）→ 系统 python/python3/py（缺依赖自动建环境）。"),
  timeoutMs: z
    .number()
    .default(180000)
    .description("单次 wchat-core CLI 调用的超时毫秒数；首次解密大数据库可能耗时较长。工具调用的总预算会在此之上自动加 10 分钟首次环境准备（创建虚拟环境、安装依赖）余量。"),
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
  };
  for (const tool of createTools(settings)) {
    ctx.tools.register(tool);
  }
}
