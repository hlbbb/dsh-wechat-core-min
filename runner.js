import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 插件自身目录；内置的 wchat_core 源码位于 <插件目录>/python。 */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
/** 插件内置的 wchat_core 源码目录（别的电脑无需单独 clone wchat-core 项目）。 */
export const BUNDLED_CORE_DIR = join(PLUGIN_DIR, "python");
/** 默认的 wchat-core 项目目录（按用户主目录推断，可用 Config.coreDir 覆盖）。 */
export const DEFAULT_CORE_DIR = join(homedir(), "Documents", "projects", "wechat-core-min");
/** 默认的微信数据目录（按用户主目录推断，可用 Config.dataDir 或环境变量 WCHAT_DATA_DIR 覆盖）。 */
export const DEFAULT_DATA_DIR = join(homedir(), "Documents", "projects", "WeChatDataAnalysis", "output");
/** 自动创建的运行时虚拟环境位置（可用环境变量 WCHAT_RUNTIME_DIR 覆盖）。 */
export const DEFAULT_RUNTIME_DIR = join(
  String(process.env.LOCALAPPDATA || "").trim() || join(homedir(), "AppData", "Local"),
  "dsh-wechat-core-min",
  "runtime",
);
/** 首次自动准备环境（创建 venv + 安装依赖）允许的最长时间。 */
const ENV_SETUP_TIMEOUT_MS = 600000;
/** 依赖最小集：装好这些，wchat_core 即可运行。 */
const REQUIRED_PACKAGES = ["cryptography", "zstandard"];

/**
 * 解析 wchat-core 源码目录：显式配置（信任不校验）→ 环境变量 WCHAT_CORE_DIR（须实际存在，失效则忽略）→
 * 默认路径（须实际存在）。都不可用时返回 null，回退到插件内置源码。
 */
export function resolveCoreDir(config = {}) {
  const explicit = String(config.coreDir ?? "").trim();
  if (explicit) return explicit;
  const env = String(process.env.WCHAT_CORE_DIR ?? "").trim();
  if (env && existsSync(join(env, "wchat_core", "__init__.py"))) return env;
  if (existsSync(join(DEFAULT_CORE_DIR, "wchat_core", "__init__.py"))) return DEFAULT_CORE_DIR;
  return null;
}

/** 解析 Python 源码所在目录（cwd 与 PYTHONPATH）：外部项目优先，回退插件内置。 */
export function resolvePythonSource(config, coreDir = resolveCoreDir(config)) {
  return coreDir ?? BUNDLED_CORE_DIR;
}

/** 解析微信数据目录：配置项 → 环境变量 WCHAT_DATA_DIR → 内置默认。 */
export function resolveDataDir(config = {}) {
  const raw = String(config.dataDir ?? "").trim();
  if (raw) return raw;
  const env = String(process.env.WCHAT_DATA_DIR ?? "").trim();
  if (env) return env;
  return DEFAULT_DATA_DIR;
}

function venvInterpreter(venvDir) {
  return process.platform === "win32"
    ? { command: join(venvDir, "Scripts", "python.exe"), baseArgs: [] }
    : { command: join(venvDir, "bin", "python"), baseArgs: [] };
}

/** 探测结果缓存：每个宿主进程只探测一次。 */
let interpreterProbe;

const PROBE_ALIVE_CODE = "import sys; print('PYOK')";
const PROBE_DEPS_CODE = "import cryptography, zstandard";

/**
 * 探活要求 stdout 出现 PYOK 标记：Windows Store 的 python.exe stub 会以 exit 9009 静默失败、
 * 不产生输出，仅凭「能启动、退出码非 0」无法把它和真解释器区分开。
 */
function probeOnce(command, baseArgs, code, { expectMark = false } = {}) {
  const result = spawnSync(command, [...baseArgs, "-c", code], {
    timeout: 30000,
    windowsHide: true,
    encoding: "utf-8",
  });
  const ok = !result.error && result.status === 0 && (!expectMark || String(result.stdout ?? "").includes("PYOK"));
  return { ok };
}

/** 探测 PATH 上的系统解释器；返回 {command, baseArgs, hasDeps} 或 null（一个可用解释器都没有）。 */
export function probeSystemInterpreter() {
  if (interpreterProbe !== undefined) return interpreterProbe;
  const candidates = [
    { command: "python", baseArgs: [] },
    { command: "python3", baseArgs: [] },
    { command: "py", baseArgs: ["-3"] },
  ];
  let found;
  for (const candidate of candidates) {
    const alive = probeOnce(candidate.command, candidate.baseArgs, PROBE_ALIVE_CODE, { expectMark: true });
    if (!alive.ok) continue;
    const deps = probeOnce(candidate.command, candidate.baseArgs, PROBE_DEPS_CODE);
    found = { ...candidate, hasDeps: deps.ok };
    break;
  }
  interpreterProbe = found ?? null;
  return interpreterProbe;
}

function missingInterpreterError() {
  return new Error(
    "未找到可用的 Python 解释器（尝试过 python / python3 / py）。本插件需要 Python 3.11+ 来运行 wchat-core：" +
      "① 安装 Python（winget install Python.Python.3.12，或从 https://www.python.org/downloads/ 安装并勾选 Add to PATH）；" +
      "② 或在插件配置 pythonExecutable 中指定解释器路径。" +
      "首次调用会自动创建虚拟环境并安装 cryptography / zstandard（需联网一次）。",
  );
}

/** 运行一次环境准备命令（venv 创建 / pip 安装），失败时抛出带 stderr 的可读错误；响应取消信号。 */
function runEnvStep(command, baseArgs, args, label, signal = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...baseArgs, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr = [];
    let stderrBytes = 0;
    child.stderr.on("data", (chunk) => {
      if (stderrBytes < 1024 * 1024) {
        stderrBytes += chunk.length;
        stderr.push(chunk);
      }
    });
    const kill = () => {
      try {
        child.kill();
      } catch {
        // 进程可能已经退出
      }
    };
    const deadline = setTimeout(kill, ENV_SETUP_TIMEOUT_MS);
    const onAbort = () => kill();
    if (signal) {
      if (signal.aborted) kill();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const settle = (fn, value) => {
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    child.on("error", (error) => settle(reject, new Error(`环境准备（${label}）无法启动 ${command}：${error.message}`)));
    child.on("close", (code) => {
      if (code === 0) {
        settle(resolve);
        return;
      }
      const detail = Buffer.concat(stderr, stderrBytes).toString("utf-8").trim();
      settle(reject, new Error(`环境准备（${label}）失败（exit=${code}）：${detail.slice(0, 600) || "(无输出)"}`));
    });
  });
}

/**
 * 确保运行时虚拟环境可用：不存在则用 base 解释器创建并安装依赖；已存在但依赖不完整（如上次
 * 安装中断的半装状态）则幂等补装。调用方保证工具互斥，同一宿主进程内不会并发创建。
 */
export async function ensureRuntimeVenv(base, runtimeDir = DEFAULT_RUNTIME_DIR, signal = undefined) {
  const venvPython = venvInterpreter(runtimeDir);
  if (existsSync(venvPython.command)) {
    const deps = probeOnce(venvPython.command, [], PROBE_DEPS_CODE);
    if (deps.ok) return venvPython;
    await runEnvStep(venvPython.command, [], ["-m", "pip", "install", "--quiet", ...REQUIRED_PACKAGES], "补装依赖", signal);
    return venvPython;
  }
  await runEnvStep(base.command, base.baseArgs, ["-m", "venv", runtimeDir], "创建虚拟环境", signal);
  if (!existsSync(venvPython.command)) {
    throw new Error(`环境准备（创建虚拟环境）失败：${venvPython.command} 未生成。`);
  }
  await runEnvStep(venvPython.command, [], ["-m", "pip", "install", "--quiet", ...REQUIRED_PACKAGES], "安装依赖", signal);
  return venvPython;
}

/**
 * 解析可用解释器：显式配置 → 外部项目 venv → 自动运行时 venv → 系统解释器（缺依赖时自动建 venv）。
 * @returns {Promise<{command: string, baseArgs: string[]}>}
 */
export async function resolveInterpreter(config = {}, coreDir = resolveCoreDir(config), signal = undefined) {
  const explicit = String(config.pythonExecutable ?? "").trim() || String(process.env.WCHAT_PYTHON ?? "").trim();
  if (explicit) return { command: explicit, baseArgs: [] };
  if (coreDir) {
    const projectVenv = venvInterpreter(join(coreDir, ".venv"));
    if (existsSync(projectVenv.command)) return projectVenv;
  }
  const runtimeDir = String(process.env.WCHAT_RUNTIME_DIR ?? "").trim() || DEFAULT_RUNTIME_DIR;
  const runtimeVenv = venvInterpreter(runtimeDir);
  if (existsSync(runtimeVenv.command)) return ensureRuntimeVenv({ command: runtimeVenv.command, baseArgs: [] }, runtimeDir, signal);

  if (signal?.aborted) throw new Error("Python 环境准备已取消。");
  const system = probeSystemInterpreter();
  if (!system) throw missingInterpreterError();
  if (system.hasDeps) return { command: system.command, baseArgs: system.baseArgs };
  return ensureRuntimeVenv(system, runtimeDir, signal);
}

function decode(chunks, totalBytes) {
  const buffer = Buffer.concat(chunks, totalBytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

/**
 * 运行一次 `python -m wchat_core <command>`（必要时先自动准备 Python 环境）。
 * 密钥不在此层出现：解密密钥始终由 Python 端从数据目录的 account_keys.json 自行读取。
 * @returns {Promise<{code: number|null, signal: string|null, timedOut: boolean, truncated: boolean, stdout: string, stderr: string}>}
 */
export async function runWchatCore(config, command, flags, { signal, timeoutMs } = {}) {
  const coreDir = resolveCoreDir(config);
  const source = resolvePythonSource(config, coreDir);
  const python = await resolveInterpreter(config, coreDir, signal);
  const args = [...python.baseArgs, "-m", "wchat_core", command, ...flags];
  const child = spawn(python.command, args, {
    cwd: source,
    // 完整透传宿主环境：若用户自设了 WCHAT_DB_KEY/WCHAT_DATA_DIR，属 CLI 设计内的合法来源；
    // 本插件自身绝不读取、设置或回显任何密钥。PYTHONPATH 保证内置/外部源码均可被 -m 导入。
    env: { ...process.env, PYTHONPATH: source, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let truncated = false;
  child.stdout.on("data", (chunk) => {
    if (stdoutBytes >= MAX_OUTPUT_BYTES) {
      truncated = true;
      return;
    }
    stdoutBytes += chunk.length;
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    if (stderrBytes >= MAX_OUTPUT_BYTES) return;
    stderrBytes += chunk.length;
    stderr.push(chunk);
  });

  let timedOut = false;
  const kill = () => {
    try {
      child.kill();
    } catch {
      // 进程可能已经退出
    }
  };
  if (signal) {
    if (signal.aborted) kill();
    else signal.addEventListener("abort", kill, { once: true });
  }
  const deadline = Number(timeoutMs) > 0
    ? setTimeout(() => {
        timedOut = true;
        kill();
      }, Number(timeoutMs))
    : undefined;

  return new Promise((resolve, reject) => {
    child.on("error", (error) => {
      reject(new Error(`无法启动 Python（${python.command}）：${error.message}。请检查插件配置 pythonExecutable 与 coreDir 是否有效（无效的 coreDir 会导致工作目录不可用）；若尚未安装 Python，见报错指引或 README 的部署章节。`));
    });
    child.on("close", (code, closeSignal) => {
      resolve({
        code,
        signal: closeSignal,
        timedOut,
        truncated,
        stdout: decode(stdout, stdoutBytes),
        stderr: decode(stderr, stderrBytes),
      });
    });
  }).finally(() => {
    if (deadline) clearTimeout(deadline);
    signal?.removeEventListener("abort", kill);
  });
}

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function extractCliError(stdout) {
  try {
    const payload = JSON.parse(stdout);
    if (payload && typeof payload === "object" && typeof payload.error === "string" && payload.error) {
      return payload.error;
    }
  } catch {
    // stdout 不是 JSON，走通用错误分支
  }
  return undefined;
}

/**
 * 把一次 CLI 运行解析成结果；JSON 命令解析为对象，文本命令（md/txt）原样返回字符串。
 * 失败时抛出带原因的中文错误。
 */
export function parseCliResult(result, command, { asText = false } = {}) {
  if (result.timedOut) {
    throw new Error(`wchat-core ${command} 超时被终止。首次调用某账号时需要解密数据库，可能耗时较长；可加大插件配置 timeoutMs 后重试。`);
  }
  if (result.code === 0) {
    if (asText) {
      return result.truncated
        ? result.stdout.replace(/\r?\n$/, "") + "\n[输出已截断：超过 32MB 上限，请用 limit/offset 分页或改用 txt 格式]"
        : result.stdout.replace(/\r?\n$/, "");
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `wchat-core ${command} 退出码为 0，但输出无法按 JSON 解析${result.truncated ? "（输出超过 32MB 上限已被截断，请用 limit/offset 分页）" : ""}：${result.stdout.slice(0, 400)}`,
      );
    }
  }
  const cliError = extractCliError(result.stdout);
  if (cliError) {
    // argparse 校验失败时 CLI 把退出码数字写进 {"error":"2"}，真正的原因在 stderr。
    const trimmed = cliError.trim();
    if (/^\d+$/.test(trimmed) || trimmed.length <= 8) {
      const detail = (result.stderr || "").trim();
      throw new Error(
        `wchat-core ${command} 失败（code=${trimmed}）${detail ? `：${detail.slice(0, 600)}` : "，且无更多错误输出。"}`,
      );
    }
    throw new Error(`wchat-core ${command} 失败：${cliError}`);
  }
  const detail = (result.stderr || result.stdout || "(无输出)").trim();
  throw new Error(`wchat-core ${command} 异常退出（code=${result.code}${result.signal ? `, signal=${result.signal}` : ""}）：${detail.slice(0, 600)}`);
}
