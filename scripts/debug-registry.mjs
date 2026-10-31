import { spawnSync } from "node:child_process";
import { probeRegistryPythonPaths, probeSystemInterpreter } from "../runner.js";

const raw = spawnSync("reg", ["query", "HKCU\\Software\\Python", "/s"], {
  timeout: 15000,
  windowsHide: true,
  encoding: "buffer",
});
console.log("reg status:", raw.status, "| error:", raw.error?.code ?? "none", "| bytes:", (raw.stdout ?? []).length);

let text;
try {
  text = new TextDecoder("gbk").decode(raw.stdout ?? Buffer.alloc(0));
  console.log("gbk decode: ok");
} catch (error) {
  console.log("gbk decode unavailable:", error.message);
  text = new TextDecoder("utf-8", { fatal: false }).decode(raw.stdout ?? Buffer.alloc(0));
}
console.log("InstallPath 键数:", (text.match(/\\InstallPath/gi) ?? []).length);

const paths = probeRegistryPythonPaths();
console.log("probeRegistryPythonPaths():", JSON.stringify(paths, null, 1));

// 完全复刻 runner.js 的调用方式（encoding: "utf-8"）逐步插桩
const q = spawnSync("reg", ["query", "HKCU\\Software\\Python", "/s"], {
  timeout: 15000,
  windowsHide: true,
  encoding: "utf-8",
});
console.log("runner-style status:", q.status, "| stdout len:", (q.stdout ?? "").length);
let inInstallPath = false;
for (const line of String(q.stdout ?? "").split(/\r?\n/)) {
  const t = line.trim();
  if (/^HKEY_/i.test(t)) {
    inInstallPath = /\\InstallPath$/i.test(t);
    console.log(`[KEY] install=${inInstallPath ? 1 : 0}`, JSON.stringify(t.slice(0, 80)));
    continue;
  }
  if (!inInstallPath) continue;
  const m = t.match(/^(?:\(Default\)|ExecutablePath)\s+REG_SZ\s+(.+)$/i);
  console.log(`  val=${m ? 1 : 0}`, JSON.stringify(t.slice(0, 80)));
}

const probe = probeSystemInterpreter();
console.log("probeSystemInterpreter():", probe ? `${probe.command} hasDeps=${probe.hasDeps}` : "null");
