import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 默认的 wchat-core 项目目录（按用户主目录推断，可用 Config.coreDir 覆盖）。 */
export const DEFAULT_CORE_DIR = join(homedir(), "Documents", "projects", "wechat-core-min");
/** 默认的微信数据目录（按用户主目录推断，可用 Config.dataDir 或环境变量 WCHAT_DATA_DIR 覆盖）。 */
export const DEFAULT_DATA_DIR = join(homedir(), "Documents", "projects", "WeChatDataAnalysis", "output");
/** 子进程输出上限，超出后停止收集并在结果中标记 truncated。 */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** 解析 wchat-core 项目目录：配置项优先，其次内置默认。 */
export function resolveCoreDir(config = {}) {
  const raw = String(config.coreDir ?? "").trim();
  return raw || DEFAULT_CORE_DIR;
}

/** 解析微信数据目录：配置项 → 环境变量 WCHAT_DATA_DIR → 内置默认。 */
export function resolveDataDir(config = {}) {
  const raw = String(config.dataDir ?? "").trim();
  if (raw) return raw;
  const env = String(process.env.WCHAT_DATA_DIR ?? "").trim();
  if (env) return env;
  return DEFAULT_DATA_DIR;
}

/** 解析 Python 解释器：配置项 → 环境变量 WCHAT_PYTHON → coreDir 下的 venv → PATH。 */
export function resolvePythonExecutable(config = {}, coreDir = resolveCoreDir(config)) {
  const raw = String(config.pythonExecutable ?? "").trim();
  if (raw) return raw;
  const env = String(process.env.WCHAT_PYTHON ?? "").trim();
  if (env) return env;
  const venvPython = join(coreDir, ".venv", "Scripts", "python.exe");
  if (existsSync(venvPython)) return venvPython;
  return "python";
}

function decode(chunks, totalBytes) {
  const buffer = Buffer.concat(chunks, totalBytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

/**
 * 运行一次 `python -m wchat_core <command>`。
 * 密钥不在此层出现：解密密钥始终由 Python 端从数据目录的 account_keys.json 自行读取。
 * @returns {Promise<{code: number|null, signal: string|null, timedOut: boolean, truncated: boolean, stdout: string, stderr: string}>}
 */
export function runWchatCore(config, command, flags, { signal, timeoutMs } = {}) {
  const coreDir = resolveCoreDir(config);
  const python = resolvePythonExecutable(config, coreDir);
  const args = ["-m", "wchat_core", command, ...flags];
  const child = spawn(python, args, {
    cwd: coreDir,
    // 完整透传宿主环境：若用户自设了 WCHAT_DB_KEY/WCHAT_DATA_DIR，属 CLI 设计内的合法来源；
    // 本插件自身绝不读取、设置或回显任何密钥。
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
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
      reject(new Error(`无法启动 Python（${python}）：${error.message}。请检查插件配置 pythonExecutable，或确认 ${coreDir}\\.venv 已创建。`));
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
