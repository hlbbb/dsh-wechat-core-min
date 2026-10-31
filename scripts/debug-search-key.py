"""诊断：在微信进程内存中直接搜索真实 db_key 字节（不打印任何密钥内容）。"""

import ctypes
import json
import sys
from ctypes import wintypes
from pathlib import Path

PROCESS_ALL_ACCESS = 0x1F0FFF
MEM_COMMIT = 0x1000
MEM_PRIVATE = 0x20000
TH32CS_SNAPPROCESS = 0x00000002
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p), ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", ctypes.c_ulong), ("RegionSize", ctypes.c_size_t),
        ("State", ctypes.c_ulong), ("Protect", ctypes.c_ulong), ("Type", ctypes.c_ulong),
    ]


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_void_p), ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]


def pids_of(name):
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    out = []
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
    ok = k32.Process32FirstW(snap, ctypes.byref(entry))
    while ok:
        if str(entry.szExeFile).casefold() == name.casefold():
            out.append(int(entry.th32ProcessID))
        ok = k32.Process32NextW(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)
    return out


def regions(handle):
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    mbi = MEMORY_BASIC_INFORMATION()
    addr = 0
    while True:
        if not k32.VirtualQueryEx(handle, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
            break
        size = int(mbi.RegionSize or 0)
        if mbi.State == MEM_COMMIT and mbi.Type == MEM_PRIVATE and size:
            yield int(mbi.BaseAddress or 0), size
        addr += size or 4096


def read(handle, address, size):
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    buf = ctypes.create_string_buffer(size)
    n = ctypes.c_size_t(0)
    if not k32.ReadProcessMemory(handle, ctypes.c_void_p(address), buf, size, ctypes.byref(n)):
        return None
    return buf.raw


def main():
    data_dir = Path(sys.argv[1])
    store = json.loads((data_dir / "account_keys.json").read_text(encoding="utf-8"))
    keys = {acct: bytes.fromhex(str((item or {}).get("db_key") or "")) for acct, item in store.items()}
    keys = {a: k for a, k in keys.items() if len(k) == 32}
    print("待搜索密钥数:", len(keys), "(内容保密)")
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    for pid in pids_of("Weixin.exe"):
        handle = k32.OpenProcess(PROCESS_ALL_ACCESS, False, pid)
        if not handle:
            print(f"pid={pid}: 无法打开进程")
            continue
        found = {a: 0 for a in keys}
        scanned = 0
        try:
            for base, size in regions(handle):
                mem = read(handle, base, size)
                if not mem:
                    continue
                scanned += len(mem)
                for acct, key in keys.items():
                    pos = mem.find(key)
                    while pos >= 0:
                        found[acct] += 1
                        pos = mem.find(key, pos + 1)
        finally:
            k32.CloseHandle(handle)
        print(f"pid={pid}: 扫描 {scanned/1024/1024:.0f} MB | 命中: " + ", ".join(f"{a}={n}" for a, n in found.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
