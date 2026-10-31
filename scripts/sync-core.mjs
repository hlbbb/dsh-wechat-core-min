/**
 * 发布/维护用：把 ../wechat-core-min 的 wchat_core 源码同步到插件内置 python/ 目录。
 * 注意：python/wchat_core/store.py 含插件补丁（微信 4.1+ 按库密钥 db_keys 支持），
 * 同步时跳过它，保留本地补丁；上游 store.py 有变化时需手动合并补丁（见 README）。
 * 只覆盖复制（过滤 __pycache__ 与 .pyc），不删除副本中多余的旧文件。
 */
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(pluginDir, "..", "wechat-core-min", "wchat_core");
const target = join(pluginDir, "python", "wchat_core");
const PROTECTED = new Set(["store.py"]);

if (!existsSync(join(source, "__init__.py"))) {
  console.error(`源不存在：${source}`);
  process.exit(1);
}
cpSync(source, target, {
  recursive: true,
  filter: (src) => {
    const base = src.split(/[\\/]/).pop();
    if (PROTECTED.has(base)) return false;
    return !src.includes("__pycache__") && !src.endsWith(".pyc");
  },
});
console.log(`synced: ${source} -> ${target}（已跳过 store.py：本地含插件补丁）`);
