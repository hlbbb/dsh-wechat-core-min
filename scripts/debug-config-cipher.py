"""诊断：按 Config.Cipher 只读扫描算法提取候选，检查其与已知 passphrase 的关系（全部脱敏输出）。"""

import ctypes
import hashlib
import hmac
import json
import re
import struct
import sys
from ctypes import wintypes
from pathlib import Path

PAGE_SZ, KEY_SZ, SALT_SZ, IV_SZ, HMAC_SZ = 4096, 32, 16, 16, 64
RESERVE_SZ = 80
PROCESS_ALL_ACCESS = 0x1F0FFF
MEM_COMMIT = 0x1000
TH32CS_SNAPPROCESS = 2
INVALID = ctypes.c_void_p(-1).value
MAX_USER = 0x0000_8000_0000_0000
NEEDLE = b"com.Tencent.WCDB.Config.Cipher"
XOR_MASK = bytes.fromhex("d2c7442458020000004889442450488b450048844c2448488944254048584c24")
BLOB_MAX = 1024
LITERAL_RE = re.compile(rb"[xX]'([0-9a-fA-F]{64,192})'")


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_void_p), ("AllocationBase", ctypes.c_void_p),
                ("AllocationProtect", ctypes.c_ulong), ("RegionSize", ctypes.c_size_t),
                ("State", ctypes.c_ulong), ("Protect", ctypes.c_ulong), ("Type", ctypes.c_ulong)]


class PE32(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_void_p), ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260)]


def k32():
    return ctypes.WinDLL("kernel32", use_last_error=True)


def pids_of(name="Weixin.exe"):
    k = k32(); snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    out, e = [], PE32(); e.dwSize = ctypes.sizeof(PE32)
    ok = k.Process32FirstW(snap, ctypes.byref(e))
    while ok:
        if str(e.szExeFile).casefold() == name.casefold():
            out.append(int(e.th32ProcessID))
        ok = k.Process32NextW(snap, ctypes.byref(e))
    k.CloseHandle(snap)
    return out


def regions(h):
    k = k32(); mbi = MBI(); addr = 0
    while k.VirtualQueryEx(h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
        size = int(mbi.RegionSize or 0)
        # 仅可读且非 noaccess
        if mbi.State == MEM_COMMIT and size and (int(mbi.Protect or 0) & 0xFF) not in (0, 1):
            yield int(mbi.BaseAddress or 0), size
        addr += size or 4096


def read_mem(h, addr, size):
    if size <= 0 or addr <= 0:
        return b""
    buf = ctypes.create_string_buffer(size); n = ctypes.c_size_t(0)
    if not k32().ReadProcessMemory(h, ctypes.c_void_p(addr), buf, size, ctypes.byref(n)):
        return b""
    return buf.raw


def u64(data, off):
    if off < 0 or off + 8 > len(data):
        return 0
    return struct.unpack_from("<Q", data, off)[0]


def xor_repeat(data, mask):
    return bytes(v ^ mask[i % len(mask)] for i, v in enumerate(data))


def verify_direct(enc_key, page):
    salt = page[:SALT_SZ]
    mac_key = hashlib.pbkdf2_hmac("sha512", enc_key, bytes(b ^ 0x3A for b in salt), 2, dklen=KEY_SZ)
    m = hmac.new(mac_key, digestmod=hashlib.sha512)
    m.update(page[SALT_SZ:PAGE_SZ - RESERVE_SZ + IV_SZ]); m.update((1).to_bytes(4, "little"))
    return hmac.compare_digest(m.digest(), page[PAGE_SZ - HMAC_SZ:PAGE_SZ])


def main():
    data_dir = Path(sys.argv[1]); db = Path(sys.argv[2])
    page = db.read_bytes()[:PAGE_SZ]
    store = json.loads((data_dir / "account_keys.json").read_text(encoding="utf-8"))
    known = [str((it or {}).get("db_key") or "").lower() for it in store.values()]
    print("known passphrase hex 数量:", len(known))

    candidates = []
    stats = {}
    for pid in pids_of():
        h = k32().OpenProcess(PROCESS_ALL_ACCESS, False, pid)
        if not h:
            continue
        try:
            # 1) 找 needle 地址
            needle_addrs = []
            for base, size in regions(h):
                mem = read_mem(h, base, size)
                pos = mem.find(NEEDLE)
                while pos >= 0:
                    needle_addrs.append(base + pos)
                    pos = mem.find(NEEDLE, pos + 1)
            stats[pid] = len(needle_addrs)
            if not needle_addrs:
                continue
            patterns = [struct.pack("<Q", a) + struct.pack("<Q", len(NEEDLE)) for a in needle_addrs]
            for base, size in regions(h):
                chunk = read_mem(h, base, size)
                for pat in patterns:
                    pos = chunk.find(pat)
                    while pos >= 0:
                        qaddr = base + pos
                        node = read_mem(h, qaddr - 0x10, 0x50)
                        if len(node) >= 0x40 and u64(node, 0x10) in needle_addrs and u64(node, 0x18) == len(NEEDLE):
                            cfg = u64(node, 0x28)
                            if 0x10000 <= cfg < MAX_USER:
                                obj = read_mem(h, cfg + 0x88, 0x28)
                                if len(obj) >= 0x18:
                                    dptr, dlen = u64(obj, 0x8), u64(obj, 0x10)
                                    if 0 < dlen <= BLOB_MAX and 0x10000 <= dptr < MAX_USER:
                                        blob = read_mem(h, dptr, int(dlen))
                                        if blob and len(blob) == dlen:
                                            decoded = xor_repeat(blob, XOR_MASK)
                                            for m in LITERAL_RE.finditer(decoded):
                                                run = m.group(1).decode("ascii").lower()
                                                candidates.append((len(run), run))
                        pos = chunk.find(pat, pos + 1)
        finally:
            k32().CloseHandle(h)

    print("needle 命中进程:", stats)
    print("候选数量:", len(candidates), "| 长度分布:", sorted({c[0] for c in candidates}))
    for length, run in candidates[:60]:
        flags = []
        if run in known:
            flags.append("==已知passphrase")
        if len(run) == 64:
            key = bytes.fromhex(run)
            if verify_direct(key, page):
                flags.append("直接验证通过(本库enc_key)")
        if len(run) >= 96:
            salthex = run[64:96]
            try:
                salt = bytes.fromhex(salthex)
                if salt == page[:SALT_SZ]:
                    flags.append("嵌入salt=本库salt")
            except ValueError:
                pass
        print(f"  len={length} flags={flags or ['无']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
