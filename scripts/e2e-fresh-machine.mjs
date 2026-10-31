/**
 * 模拟「另一台电脑」的首次部署：没有 wechat-core 项目（WCHAT_CORE_DIR 指向不存在路径）、
 * 没有 venv（WCHAT_RUNTIME_DIR 指向全新临时目录）→ 应回退插件内置源码、
 * 用系统 Python 自动创建虚拟环境并安装依赖，然后成功读取账号。
 * 另外验证「完全无 Python」分支的可操作报错。
 */
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 模拟「另一台电脑」：没有 wechat-core 项目、没有默认目录布局。
// 先改环境再动态 import，让 runner 的模块级默认常量按新环境求值。
process.env.WCHAT_CORE_DIR = join(tmpdir(), "dsh-wchat-nonexistent-core");
process.env.WCHAT_RUNTIME_DIR = join(tmpdir(), "dsh-wchat-runtime-test");
process.env.USERPROFILE = join(tmpdir(), "dsh-wchat-fake-home");

const { parseCliResult, resolveCoreDir, resolvePythonSource, runWchatCore } = await import("../runner.js");

const coreDir = resolveCoreDir({});
if (coreDir !== null) {
  throw new Error(`应回退内置源码（resolveCoreDir=null），实际返回：${coreDir}`);
}
const source = resolvePythonSource({}, null);
console.log("coreDir: null（内置回退）| source:", source);

// 数据目录三个异常分支：未配置 / 目录不存在 / 缺 account_keys.json，都必须给可操作错误。
const missingDir = join(tmpdir(), "dsh-wchat-nonexistent-data");
const emptyDir = join(tmpdir(), "dsh-wchat-empty-data");
const { mkdirSync } = await import("node:fs");
mkdirSync(emptyDir, { recursive: true });

async function expectError(label, config, needle) {
  try {
    await runWchatCore(config, "accounts", ["--compact"], { timeoutMs: 30000 });
    throw new Error(`${label}：应当抛错却没有`);
  } catch (error) {
    if (!String(error.message).includes(needle)) {
      throw new Error(`${label}：错误文案不含「${needle}」，实际：${error.message}`);
    }
    console.log(`${label} ok:`, String(error.message).slice(0, 60), "…");
  }
}

await expectError("未配置 dataDir（关闭自动引导）", { autoBootstrap: false }, "未配置微信数据目录");
await expectError("目录不存在", { dataDir: missingDir }, "微信数据目录不存在");
await expectError("缺 account_keys.json", { dataDir: emptyDir }, "缺少 account_keys.json");

const config = { dataDir: String(process.env.WCHAT_E2E_DATA_DIR ?? "").trim() };
if (!config.dataDir) {
  console.log("跳过数据链路：未设置 WCHAT_E2E_DATA_DIR（指向含 account_keys.json 的微信数据目录）；仅验证环境自举与异常分支。");
}

if (config.dataDir) {
  const startedAt = Date.now();
  const accounts = parseCliResult(
    await runWchatCore(config, "accounts", ["--data-dir", config.dataDir, "--compact"], { timeoutMs: 600000 }),
    "accounts",
  );
  console.log(`accounts ok in ${Math.round((Date.now() - startedAt) / 1000)}s（含自动建环境）:`, JSON.stringify(accounts.accounts?.length), "个账号");

  const sessions = parseCliResult(
    await runWchatCore(config, "sessions", ["--data-dir", config.dataDir, "--compact", "--limit", "3"], { timeoutMs: 120000 }),
    "sessions",
  );
  console.log("sessions ok, total:", sessions.total);
}

// 完全无 Python 的兜底报错：清空 PATH 的子进程里探测应失败并给出安装指引。
const child = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    [
      "process.env.PATH = '';",
      "const m = await import('./runner.js');",
      "const probe = m.probeSystemInterpreter();",
      "if (probe !== null) { console.error('probe should be null, got', probe.command); process.exit(1); }",
      "try { await m.resolveInterpreter({ coreDir: 'C:\\\\__no_such__' }); console.error('should have thrown'); process.exit(1); }",
      "catch (e) { if (!String(e.message).includes('未找到可用的 Python')) { console.error('unexpected:', e.message); process.exit(1); }",
      "console.log('no-python branch ok'); }",
    ].join("\n"),
  ],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      SystemRoot: process.env.SystemRoot,
      USERPROFILE: process.env.USERPROFILE,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    },
    encoding: "utf-8",
  },
);
console.log(child.stdout.trim());
if (child.status !== 0 || !child.stdout.includes("no-python branch ok")) {
  console.error(child.stderr);
  throw new Error("无 Python 分支验证失败");
}

console.log("FRESH-MACHINE E2E OK");
