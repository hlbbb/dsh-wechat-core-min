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
const config = { dataDir: String(process.env.WCHAT_E2E_DATA_DIR ?? "").trim() };
const source = resolvePythonSource(config, null);
console.log("coreDir: null（内置回退）| source:", source);
if (!config.dataDir) {
  console.log("跳过数据链路：未设置 WCHAT_E2E_DATA_DIR（指向含 account_keys.json 的微信数据目录）；仅验证环境自举与无 Python 分支。");
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
