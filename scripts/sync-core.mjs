/**
 * 发布/维护用：把 ../wechat-core-min 的 wchat_core 源码同步到插件内置 python/ 目录。
 * 只覆盖复制（过滤 __pycache__ 与 .pyc），不删除副本中多余的旧文件；若上游删除了文件，需手动处理。
 */
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(pluginDir, "..", "wechat-core-min", "wchat_core");
const target = join(pluginDir, "python", "wchat_core");

if (!existsSync(join(source, "__init__.py"))) {
  console.error(`源不存在：${source}`);
  process.exit(1);
}
cpSync(source, target, {
  recursive: true,
  filter: (src) => !src.includes("__pycache__") && !src.endsWith(".pyc"),
});
console.log(`synced: ${source} -> ${target}`);
