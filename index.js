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
    .description("wchat-core 项目目录（需含 wchat_core Python 包，推荐同时有 .venv）。留空使用内置默认路径。"),
  pythonExecutable: z
    .string()
    .default("")
    .description("Python 解释器路径。留空时自动探测 coreDir 下的 .venv\\Scripts\\python.exe，再回退 PATH 中的 python。"),
  timeoutMs: z
    .number()
    .default(180000)
    .description("单次 wchat-core 调用的超时毫秒数；首次解密大数据库可能耗时较长。"),
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
