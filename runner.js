import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 插件自身目录；内置的 wchat_core 源码位于 <插件目录>/python。 */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
/** 插件内置的 wchat_core 源码目录（别的电脑无需单独 clone wchat-core 项目）。 */
export const BUNDLED_CORE_DIR = join(PLUGIN_DIR, "python");
/** 默认的 wchat-core 项目目录（按用户主目录推断，可用 Config.coreDir 覆盖）；不存在时安全回退插件内置源码。 */
export const DEFAULT_CORE_DIR = join(homedir(), "Documents", "projects", "wechat-core-min");
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

/**
 * 解析微信数据目录：插件配置 → 环境变量 WCHAT_DATA_DIR；均未设置时返回 ""。
 * 不提供编造的默认路径——数据目录由微信数据导出主程序生成、位置因机器而异，
 * 缺失时由 validateDataDir 给出可操作报错。
 */
export function resolveDataDir(config = {}) {
  const raw = String(config.dataDir ?? "").trim();
  if (raw) return raw;
  return String(process.env.WCHAT_DATA_DIR ?? "").trim();
}

/** 校验微信数据目录：目录须存在且含 account_keys.json（本插件不接触密钥，密钥文件是 CLI 的必需输入）。 */
export function validateDataDir(dataDir) {
  if (!existsSync(dataDir)) {
    throw new Error(
      `微信数据目录不存在：${dataDir}。请把插件配置 dataDir（或环境变量 WCHAT_DATA_DIR）指向包含 account_keys.json 与 databases/ 的微信数据导出目录；目录如何生成见插件 README「在其他电脑部署」。`,
    );
  }
  if (!existsSync(join(dataDir, "account_keys.json"))) {
    throw new Error(
      `微信数据目录缺少 account_keys.json：${dataDir}。请把 dataDir 指向微信数据导出主程序生成的目录（应包含 account_keys.json 与 databases/）。`,
    );
  }
}

function venvInterpreter(venvDir) {
  return process.platform === "win32"
    ? { command: join(venvDir, "Scripts", "python.exe"), baseArgs: [] }
    : { command: join(venvDir, "bin", "python"), baseArgs: [] };
}

/** 探测结果缓存：每个宿主进程只探测一次。 */
let interpreterProbe;

const PROBE_ALIVE_CODE = "import sys; print('PYOK', sys.version_info[:2])";
const PROBE_DEPS_CODE = "import cryptography, zstandard";
/** wchat_core 需要的最低 Python 版本（store.py 使用了 3.9+ 语法，并按上游声明取 3.11）。 */
const MIN_PYTHON_VERSION = { major: 3, minor: 11 };

/**
 * 探活要求 stdout 出现 PYOK 标记与版本号：Windows Store 的 python.exe stub 会以 exit 9009 静默失败、
 * 不产生输出，仅凭「能启动、退出码非 0」无法把它和真解释器区分开；版本号用于过滤 <3.11 的旧解释器。
 */
function probeOnce(command, baseArgs, code, { expectMark = false } = {}) {
  const result = spawnSync(command, [...baseArgs, "-c", code], {
    timeout: 30000,
    windowsHide: true,
    encoding: "utf-8",
  });
  const text = String(result.stdout ?? "");
  const marked = !result.error && result.status === 0 && text.includes("PYOK");
  const ok = marked && (!expectMark || meetsMinVersion(text));
  return { ok };
}

function meetsMinVersion(text) {
  const match = text.match(/PYOK\s*\((\d+),\s*(\d+)\)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > MIN_PYTHON_VERSION.major ||
    (major === MIN_PYTHON_VERSION.major && minor >= MIN_PYTHON_VERSION.minor);
}

/** Anaconda/Miniconda 的常见安装目录（注册表探测失败时的兜底）。 */
const COMMON_CONDA_DIRS = [
  join(homedir(), "anaconda3"),
  join(homedir(), "miniconda3"),
  join(process.env.ProgramData || "C:\\ProgramData", "Anaconda3"),
  join(process.env.ProgramData || "C:\\ProgramData", "miniconda3"),
  join(homedir(), "AppData", "Local", "Continuum", "anaconda3"),
];

/**
 * PEP 514 注册表探测：python.org 官方安装、Anaconda/Miniconda 等发行版都会在
 * HKCU/HKLM\Software\Python\<厂商>\<版本>\InstallPath 登记，即使没加入 PATH。
 * reg.exe 输出用系统代码页（中文系统 GBK），默认值名本地化为「(默认)」。
 * 返回去重且真实存在的 python.exe 绝对路径列表。
 */
function createConsoleDecoder() {
  try {
    const gbk = new TextDecoder("gbk");
    return (buffer) => gbk.decode(buffer);
  } catch {
    return (buffer) => new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

export function probeRegistryPythonPaths() {
  const paths = [];
  const decodeConsole = createConsoleDecoder();
  for (const hive of ["HKCU", "HKLM"]) {
    const query = spawnSync("reg", ["query", `${hive}\\Software\\Python`, "/s"], {
      timeout: 15000,
      windowsHide: true,
      encoding: "buffer",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (query.error || query.status !== 0 || !query.stdout) continue;
    let inInstallPath = false;
    let dir = "";
    let exe = "";
    const flush = () => {
      if (exe || dir) paths.push(exe || join(dir, "python.exe"));
      inInstallPath = false;
      dir = "";
      exe = "";
    };
    for (const line of decodeConsole(query.stdout).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (/^HKEY_/i.test(trimmed)) {
        flush();
        inInstallPath = /\\InstallPath$/i.test(trimmed);
        continue;
      }
      if (!inInstallPath) continue;
      const match = trimmed.match(/^(\(Default\)|\(默认\)|ExecutablePath)\s+REG_SZ\s+(.+)$/i);
      if (!match) continue;
      const value = match[2].trim();
      if (/^ExecutablePath$/i.test(match[1])) exe = value;
      else dir = value;
    }
    flush();
  }
  return [...new Set(paths)].filter((p) => p && existsSync(p));
}

/**
 * 探测 PATH 上的系统解释器；返回 {command, baseArgs, hasDeps} 或 null（一个可用解释器都没有）。
 * 候选顺序：PATH 上的 python/python3/py → PEP 514 注册表登记 → 常见 Anaconda/Miniconda 目录。
 */
export function probeSystemInterpreter() {
  if (interpreterProbe !== undefined) return interpreterProbe;
  const candidates = [
    { command: "python", baseArgs: [] },
    { command: "python3", baseArgs: [] },
    { command: "py", baseArgs: ["-3"] },
    ...probeRegistryPythonPaths().map((command) => ({ command, baseArgs: [] })),
    ...COMMON_CONDA_DIRS.filter((dir) => existsSync(join(dir, "python.exe"))).map((dir) => ({
      command: join(dir, "python.exe"),
      baseArgs: [],
    })),
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
    "未找到可用的 Python 解释器（已尝试 PATH 上的 python / python3 / py、注册表登记的解释器与常见 Anaconda/Miniconda 安装位置）。" +
      "本插件需要 Python 3.11+ 来运行 wchat-core：" +
      "① 安装 Python（winget install Python.Python.3.12，或从 https://www.python.org/downloads/ 安装并勾选 Add to PATH）；" +
      "② 若使用 Anaconda/Miniconda，可在插件配置 pythonExecutable 填其 python.exe 完整路径（如 C:\\Users\\<你>\\anaconda3\\python.exe）；" +
      "③ 首次调用会自动创建虚拟环境并安装 cryptography / zstandard（需联网一次）。",
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
  const dataDir = resolveDataDir(config);
  if (!dataDir) {
    throw new Error(
      "未配置微信数据目录。请把插件配置 dataDir 或环境变量 WCHAT_DATA_DIR 指向包含 account_keys.json 与 databases/ 的微信数据导出目录（生成方式见插件 README「在其他电脑部署」）。",
    );
  }
  validateDataDir(dataDir);
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
