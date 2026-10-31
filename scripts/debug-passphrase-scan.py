"""诊断：在微信进程内存中搜索 x'<96 hex>' 形态的 passphrase 片段并用页面 HMAC 校验（不打印密钥）。"""

import ctypes
import hashlib
import hmac
import re
import sys
from ctypes import wintypes
from pathlib import Path

PAGE_SIZE = 4096
SALT_SIZE = 16
IV_SIZE = 16
HMAC_SIZE = 64
RESERVE_SIZE = IV_SIZE + HMAC_SIZE
KEY_SIZE = 32
PROCESS_ALL_ACCESS = 0x1F0FFF
MEM_COMMIT = 0x1000
TH32CS_SNAPPROCESS = 2
INVALID = ctypes.c_void_p(-1).value


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_void_p), ("AllocationBase", ctypes.c_void_p),
                ("AllocationProtect", ctypes.c_ulong), ("RegionSize", ctypes.c_size_t),
                ("State", ctypes.c_ulong), ("Protect", ctypes.c_ulong), ("Type", ctypes.c_ulong)]


class PE32(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_void_p), ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260)]


def regions(h):
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    mbi = MBI(); addr = 0
    while k32.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
        size = int(mbi.RegionSize or 0)
        if mbi.State == MEM_COMMIT and size and int(mbi.Protect or 0) & 0xFF not in (0, 1):
            yield int(mbi.BaseAddress or 0), size
        addr += size or 4096


def verify(passphrase: bytes, page: bytes) -> bool:
    salt = page[:SALT_SIZE]
    enc = hashlib.pbkdf2_hmac("sha512", passphrase, salt, 256000, dklen=32)
    mac_key = hashlib.pbkdf2_hmac("sha512", enc, bytes(b ^ 0x3A for b in salt), 2, dklen=32)
    m = hmac.new(mac_key, digestmod=hashlib.sha512)
    m.update(page[SALT_SIZE:PAGE_SIZE - RESERVE_SIZE + IV_SIZE])
    m.update((1).to_bytes(4, "little"))
    return hmac.compare_digest(m.digest(), page[PAGE_SIZE - HMAC_SIZE:PAGE_SIZE])


def main():
    db = Path(sys.argv[1])
    page = db.read_bytes()[:PAGE_SIZE]
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    pids = []
    e = PE32(); e.dwSize = ctypes.sizeof(PE32)
    ok = k32.Process32FirstW(snap, ctypes.byref(e))
    while ok:
        if str(e.szExeFile).casefold() == "weixin.exe":
            pids.append(int(e.th32ProcessID))
        ok = k32.Process32NextW(snap, ctypes.byref(e))
    k32.CloseHandle(snap)
    print("pids:", pids)
    hexpat = re.compile(rb"^[0-9a-fA-F]{96}$")
    total_candidates = 0
    for pid in pids:
        h = k32.OpenProcess(PROCESS_ALL_ACCESS, False, pid)
        if not h:
            continue
        try:
            for base, size in regions(h):
                buf = ctypes.create_string_buffer(size); n = ctypes.c_size_t(0)
                if not k32.ReadProcessMemory(h, ctypes.c_void_p(base), buf, size, ctypes.byref(n)):
                    continue
                mem = buf.raw
                pos = mem.find(b"x'")
                cands = 0
                while pos >= 0:
                    seg = mem[pos + 2:pos + 2 + 96]
                    if len(seg) == 96 and hexpat.match(seg):
                        tail = mem[pos + 2 + 96:pos + 2 + 97]
                        if tail == b"'":
                            cands += 1
                            total_candidates += 1
                            try:
                                if verify(bytes.fromhex(seg[:64].decode()), page):
                                    print(f"*** MATCH pid={pid} base=0x{base:X} off=0x{pos:X}（值保密）")
                                    return 0
                            except Exception:
                                pass
                    pos = mem.find(b"x'", pos + 1)
                if cands:
                    print(f"pid={pid} base=0x{base:X}: 候选 {cands} 个（未通过校验）")
        finally:
            k32.CloseHandle(h)
    print("扫描完成，总候选:", total_candidates, "无匹配")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
