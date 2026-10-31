"""插件自举：发现本机微信 4.x 数据目录、从微信进程提取数据库密钥并生成数据目录。

供 DSH 插件 dsh-wechat-core-min 在「开箱即用」场景下调用：用户在装有微信 4.x 且已登录的
电脑上首次使用插件时，由本模块完成原本需要主程序做的三件事：
1. 发现微信数据根目录（%APPDATA% 配置记录的自定义位置 / Documents 默认位置 / 环境变量）；
2. 从运行中的微信进程只读内存提取数据库密钥；
3. 生成 <data-dir>/account_keys.json 与 <data-dir>/databases/<wxid>/_source.json。

密钥安全：密钥只写入数据目录的 account_keys.json，stdout/stderr 与任何日志都不回显密钥值。
实现来源：移植自 WeChatDataAnalysis（作者自有代码）的 key_v4.py 思路，去除 pymem / yara-python /
pycryptodome 三个第三方依赖——进程枚举用 ctypes Toolhelp32，特征匹配用 bytes.find，
PBKDF2 用 Python 内置 hashlib.pbkdf2_hmac。

用法：python -m wchat_bootstrap --data-dir <目录> [--process-name Weixin.exe]
输出：stdout 单行 JSON（成功 {"data_dir":..., "accounts":[...]}；失败 {"error": "..."} 且 exit 1），
     进度信息走 stderr。
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import hmac
import json
import os
import re
import struct
import sys
from concurrent.futures import ThreadPoolExecutor
from ctypes import wintypes
from pathlib import Path

KEY_SIZE = 32
ROUND_COUNT = 256000
PAGE_SIZE = 4096
SALT_SIZE = 16
IV_SIZE = 16
HMAC_SHA512_SIZE = 64
HMAC_SIZE = HMAC_SHA512_SIZE
RESERVE_SIZE = IV_SIZE + HMAC_SIZE
AES_BLOCK_SIZE = 16

MEM_COMMIT = 0x1000
MEM_PRIVATE = 0x20000
# 只读所需的最小权限（不必 PROCESS_ALL_ACCESS，降低安全软件误报概率）
PROCESS_READ_ACCESS = 0x0010 | 0x0400  # PROCESS_VM_READ | PROCESS_QUERY_INFORMATION
TH32CS_SNAPPROCESS = 0x00000002
CSIDL_PERSONAL = 0x0005
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
XWECHAT_CONFIG_KEY_NAME = "KEY_LAST_XWEACHAT_FILE_DIR"

# ---- 微信 4.1+ Windows 运行时 Config.Cipher 只读扫描（参照 MIT 许可的 wcdb-key-tool 思路）----
CONFIG_CIPHER_NAME = b"com.Tencent.WCDB.Config.Cipher"
CONFIG_XOR_MASK = bytes.fromhex(
    "d2c7442458020000004889442450488b450048844c2448488944254048584c24"
)
CONFIG_BLOB_MAX = 1024
CONFIG_LITERAL_RE = re.compile(rb"[xX]'([0-9a-fA-F]{64,192})'")
MAX_USER_ADDRESS = 0x0000_8000_0000_0000
REGION_CHUNK_SIZE = 2 * 1024 * 1024

# 密钥槽位特征（来自上游 yara 规则）：6 个任意字节 + 10 个 0x00 + u64(0x20) + u64(0x2f)。
# 匹配起点落在 32 字节地址字段的第 7 个字节处，因此候选地址 = 匹配起点 - 6。
_KEY_SLOT_TAIL = b"\x00" * 10 + struct.pack("<Q", 0x20) + struct.pack("<Q", 0x2F)


class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", ctypes.c_ulong),
        ("RegionSize", ctypes.c_size_t),
        ("State", ctypes.c_ulong),
        ("Protect", ctypes.c_ulong),
        ("Type", ctypes.c_ulong),
    ]


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_void_p),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]


def _kernel32():
    return ctypes.WinDLL("kernel32", use_last_error=True)


def _log(message: str) -> None:
    print(message, file=sys.stderr)


def find_process_pids(process_name: str) -> list[int]:
    """按可执行文件名（不区分大小写）枚举进程 PID。"""
    k32 = _kernel32()
    try:
        snapshot = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    except Exception:
        return []
    if not snapshot or snapshot == INVALID_HANDLE_VALUE:
        return []
    pids: list[int] = []
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
    try:
        ok = k32.Process32FirstW(snapshot, ctypes.byref(entry))
        while ok:
            if str(entry.szExeFile).casefold() == process_name.casefold():
                pids.append(int(entry.th32ProcessID))
            ok = k32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snapshot)
    return pids


def open_process(pid: int):
    return _kernel32().OpenProcess(PROCESS_READ_ACCESS, False, pid)


def read_process_memory(handle, address: int, size: int) -> bytes | None:
    if not handle or not address or size <= 0:
        return None
    buffer = ctypes.create_string_buffer(size)
    read = ctypes.c_size_t(0)
    ok = _kernel32().ReadProcessMemory(
        handle, ctypes.c_void_p(address), buffer, size, ctypes.byref(read)
    )
    if not ok:
        return None
    return buffer.raw


def iter_private_regions(handle):
    """枚举 MEM_COMMIT | MEM_PRIVATE 的内存区域（微信密钥所在页的属性）。"""
    mbi = MEMORY_BASIC_INFORMATION()
    address = 0
    while True:
        written = _kernel32().VirtualQueryEx(
            handle, ctypes.c_void_p(address), ctypes.byref(mbi), ctypes.sizeof(mbi)
        )
        if not written:
            break
        size = int(mbi.RegionSize or 0)
        if mbi.State == MEM_COMMIT and mbi.Type == MEM_PRIVATE and size:
            yield int(mbi.BaseAddress or 0), size
        address += size or PAGE_SIZE


def collect_key_candidates(handle) -> list[bytes]:
    """扫描进程内存，按特征定位 32 字节密钥槽位并读取候选密钥。"""
    candidates: list[bytes] = []
    seen: set[bytes] = set()
    for base, size in iter_private_regions(handle):
        memory = read_process_memory(handle, base, size)
        if not memory:
            continue
        cursor = 0
        while True:
            index = memory.find(_KEY_SLOT_TAIL, cursor)
            if index < 0:
                break
            cursor = index + 1
            addr_offset = index - 6
            if addr_offset < 0:
                continue
            pointer = struct.unpack_from("<Q", memory, addr_offset)[0]
            if pointer < 0x10000:
                continue
            key = read_process_memory(handle, pointer, KEY_SIZE)
            if not key or len(key) != KEY_SIZE or key in seen:
                continue
            seen.add(key)
            candidates.append(key)
    return candidates


def is_potential_key(key: bytes) -> bool:
    """熵与字符分布快速过滤：过滤普通文本，只留下密码学随机候选。"""
    if len(key) != KEY_SIZE:
        return False
    if len(set(key)) < 15:
        return False
    if sum(32 <= b <= 126 for b in key) > 24:
        return False
    return True


def _derive_mac_key(enc_key: bytes, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha512", enc_key, bytes(b ^ 0x3A for b in salt), 2, dklen=KEY_SIZE)


def _derive_enc_key(key_material: bytes, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha512", key_material, salt, ROUND_COUNT, dklen=KEY_SIZE)


def _page1_hmac(mac_key: bytes, page: bytes) -> bytes:
    mac = hmac.new(mac_key, digestmod=hashlib.sha512)
    mac.update(page[SALT_SIZE : PAGE_SIZE - RESERVE_SIZE + IV_SIZE])
    mac.update((1).to_bytes(4, "little"))
    return mac.digest()


def key_matches_page(key_material: bytes, page: bytes) -> bool:
    """用数据库第一页验证密钥材料：先按 SQLCipher passphrase 模式，再按 raw enc key 模式。"""
    if len(key_material) != KEY_SIZE or len(page) < PAGE_SIZE:
        return False
    salt = page[:SALT_SIZE]
    stored = page[PAGE_SIZE - HMAC_SIZE : PAGE_SIZE]
    if hmac.compare_digest(stored, _page1_hmac(_derive_mac_key(_derive_enc_key(key_material, salt), salt), page)):
        return True
    return hmac.compare_digest(stored, _page1_hmac(_derive_mac_key(key_material, salt), page))


# Weixin.dll 中的 internal_db_key 特征：连续四条 mov rdx, imm64（48 BA + 8 字节）后接 test rax, rax。
_DLL_KEY_PATTERN = re.compile(
    b"^\x48\xBA(.{8})"
    b".{3,8}?"
    b"\x48\xBA(.{8})"
    b".{3,8}?"
    b"\x48\xBA(.{8})"
    b".{3,8}?"
    b"\x48\xBA(.{8})"
    b".{3,8}?"
    b"\x48\x85\xC0",
    re.DOTALL,
)


def extract_dll_key_candidates(dll_path: Path) -> list[bytes]:
    """扫描 Weixin.dll 提取 internal_db_key 候选（微信 4.x 用它掩码内存中的真实密钥）。"""
    try:
        data = dll_path.read_bytes()
    except OSError:
        return []
    candidates: list[bytes] = []
    cursor = 0
    while True:
        index = data.find(b"\x48\xBA", cursor)
        if index < 0:
            break
        match = _DLL_KEY_PATTERN.match(data, index, index + 90)
        if match:
            key = match.group(1) + match.group(2) + match.group(3) + match.group(4)
            if key not in candidates:
                candidates.append(key)
            cursor = match.end()
        else:
            cursor = index + 1
    return candidates


def process_image_path(pid: int) -> Path | None:
    """查询进程可执行文件完整路径（用于定位 Weixin.dll）。"""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    k32 = _kernel32()
    handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        buffer = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        ok = k32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size))
        return Path(buffer.value) if ok else None
    finally:
        k32.CloseHandle(handle)


def find_weixin_dll(pids: list[int]) -> Path | None:
    for pid in pids:
        exe = process_image_path(pid)
        if exe is None:
            continue
        base = exe.parent
        for name in ("Weixin.dll", "WeChat.dll"):
            candidate = base / name
            if candidate.is_file():
                return candidate
        for pattern in ("*/Weixin.dll", "*/WeChat.dll"):
            try:
                hits = sorted(base.glob(pattern))
            except OSError:
                continue
            if hits:
                return hits[0]
    return None


def recover_key_for_db(pids: list[int], db_path: Path) -> bytes | None:
    """为指定数据库提取密钥：内存槽位候选 × DLL internal_db_key 候选（XOR 后验证）。"""
    try:
        with open(db_path, "rb") as handle:
            page = handle.read(PAGE_SIZE)
    except OSError:
        return None
    if len(page) < PAGE_SIZE:
        return None

    memory_candidates: list[bytes] = []
    for pid in pids:
        process = open_process(pid)
        if not process:
            continue
        try:
            memory_candidates.extend(collect_key_candidates(process))
        finally:
            _kernel32().CloseHandle(process)

    memory_candidates = [key for key in dict.fromkeys(memory_candidates) if is_potential_key(key)]
    _log(f"[*] 内存候选密钥 {len(memory_candidates)} 个（熵过滤后）")

    internal_keys: list[bytes | None] = [None]
    dll_path = find_weixin_dll(pids)
    if dll_path is not None:
        dll_keys = extract_dll_key_candidates(dll_path)
        _log(f"[*] Weixin.dll internal_db_key 候选 {len(dll_keys)} 个（{dll_path.name}）")
        internal_keys.extend(dll_keys)
    else:
        _log("[*] 未定位到 Weixin.dll，仅尝试未掩码候选")

    tasks: list[bytes] = []
    for internal in internal_keys:
        for memory_key in memory_candidates:
            tasks.append(bytes(a ^ b for a, b in zip(memory_key, internal)) if internal else memory_key)
    if not tasks:
        return None

    _log(f"[*] 共 {len(tasks)} 个组合待验证…")
    worker_count = max(1, min(8, (os.cpu_count() or 4)))
    try:
        with ThreadPoolExecutor(max_workers=worker_count) as pool:
            for ok, material in pool.map(lambda item: (key_matches_page(item, page), item), tasks):
                if ok:
                    _log("[+] 密钥验证通过（值已脱敏，不输出）")
                    return material
    except Exception as exc:  # 线程池异常时退化为串行
        _log(f"[*] 并行验证异常，改为串行：{exc}")
        for material in tasks:
            if key_matches_page(material, page):
                _log("[+] 密钥验证通过（值已脱敏，不输出）")
                return material
    return None


def _resolve_known_folder(csidl: int) -> str | None:
    buffer = ctypes.create_unicode_buffer(260)
    try:
        hresult = ctypes.windll.shell32.SHGetFolderPathW(None, csidl, None, 0, buffer)
    except Exception:
        return None
    return buffer.value if hresult == 0 else None


def xwechat_roots() -> list[Path]:
    """发现微信 4.x 数据根目录候选（自定义配置优先，其次默认位置与环境变量）。"""
    roots: list[Path] = []
    # 策略 0：微信 4.x 配置记录的数据位置（支持自定义存储盘符/目录）
    try:
        appdata = os.environ.get("APPDATA")
        if appdata:
            ini_name = hashlib.md5(XWECHAT_CONFIG_KEY_NAME.encode("utf-8")).hexdigest() + ".ini"
            ini_path = Path(appdata) / "Tencent" / "xwechat" / "config" / ini_name
            if ini_path.is_file():
                raw_bytes = ini_path.read_bytes()
                encoding = "utf-16" if raw_bytes[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8"
                text = raw_bytes.decode(encoding, errors="ignore").strip()
                base: str | None = None
                if re.match(r"^[A-Za-z]:[\\/]", text):
                    base = text
                else:
                    token = re.match(r"^mydocument(?::(\d+))?$", text, flags=re.IGNORECASE)
                    if token:
                        csidl = int(token.group(1)) if token.group(1) else CSIDL_PERSONAL
                        base = _resolve_known_folder(csidl & 0x0000FFFF)
                if base:
                    candidate = Path(base) / "xwechat_files"
                    if candidate.is_dir():
                        roots.append(candidate)
    except Exception:
        pass
    # 策略 1：默认 Documents 位置
    try:
        default = Path.home() / "Documents" / "xwechat_files"
        if default.is_dir():
            roots.append(default)
    except Exception:
        pass
    # 策略 2：环境变量覆盖
    for name in ("WECHAT_TOOL_XWECHAT_FILES", "WECHAT_XWECHAT_FILES"):
        raw = str(os.environ.get(name) or "").strip()
        if raw:
            path = Path(raw).expanduser()
            if path.is_dir():
                roots.append(path)
    unique: list[Path] = []
    for root in roots:
        if root not in unique:
            unique.append(root)
    return unique


def discover_db_storages(roots: list[Path]) -> list[Path]:
    """枚举每个数据根下带 db_storage 的账号目录。"""
    storages: list[Path] = []
    for root in roots:
        try:
            children = sorted(root.iterdir())
        except OSError:
            continue
        for child in children:
            if not child.is_dir():
                continue
            storage = child / "db_storage"
            if storage.is_dir():
                storages.append(storage)
    return storages


def _iter_region_chunks(handle, overlap: int = 0x80):
    """按 2MB 分块读取可读内存区域，返回 (基址, 数据) 迭代器。"""
    for base, size in iter_private_regions_all(handle):
        offset = 0
        tail = b""
        tail_base = base
        while offset < size:
            current = min(REGION_CHUNK_SIZE, size - offset)
            chunk = read_process_memory(handle, base + offset, current) or b""
            data_base = tail_base if tail else base + offset
            data = tail + chunk
            if data:
                yield data_base, data
            if overlap and chunk:
                tail = data[-overlap:]
                tail_base = data_base + max(0, len(data) - len(tail))
            else:
                tail = b""
                tail_base = base + offset + current
            offset += current


def iter_private_regions_all(handle):
    """枚举所有已提交且可读的内存区域（不限 MEM_PRIVATE，Config.Cipher 也出现在映射区）。"""
    mbi = MEMORY_BASIC_INFORMATION()
    address = 0
    while True:
        written = _kernel32().VirtualQueryEx(
            handle, ctypes.c_void_p(address), ctypes.byref(mbi), ctypes.sizeof(mbi)
        )
        if not written:
            break
        size = int(mbi.RegionSize or 0)
        protect = int(mbi.Protect or 0) & 0xFF
        # 0 = PAGE_NOACCESS（不可读），1 = PAGE_READONLY（可读）；排除 0 即可，保守起见两者都跳过时用 1 也可读——此处仅排除 NOACCESS(0)。
        if mbi.State == MEM_COMMIT and size and protect != 0:
            yield int(mbi.BaseAddress or 0), size
        address += size or PAGE_SIZE


def _u64(data: bytes, offset: int) -> int:
    if offset < 0 or offset + 8 > len(data):
        return 0
    return struct.unpack_from("<Q", data, offset)[0]


def _xor_repeat(data: bytes, mask: bytes) -> bytes:
    return bytes(value ^ mask[index % len(mask)] for index, value in enumerate(data))


def collect_config_cipher_candidates(pids: list[int]) -> list[tuple[str, str]]:
    """只读扫描微信 4.1+ 的 Config.Cipher 对象，解出 (enc_key_hex, salt_hex) 候选。"""
    candidates: list[tuple[str, str]] = []
    for pid in pids:
        process = open_process(pid)
        if not process:
            continue
        try:
            needle_addresses = []
            for base, size in iter_private_regions_all(process):
                memory = read_process_memory(process, base, size)
                if not memory:
                    continue
                cursor = memory.find(CONFIG_CIPHER_NAME)
                while cursor >= 0:
                    needle_addresses.append(base + cursor)
                    cursor = memory.find(CONFIG_CIPHER_NAME, cursor + 1)
            if not needle_addresses:
                continue
            patterns = [
                struct.pack("<Q", address) + struct.pack("<Q", len(CONFIG_CIPHER_NAME))
                for address in needle_addresses
            ]
            for base, data in _iter_region_chunks(process):
                for pattern in patterns:
                    pos = data.find(pattern)
                    while pos >= 0:
                        node = read_process_memory(process, base + pos - 0x10, 0x50) or b""
                        if (
                            len(node) >= 0x40
                            and _u64(node, 0x10) in needle_addresses
                            and _u64(node, 0x18) == len(CONFIG_CIPHER_NAME)
                        ):
                            config_ptr = _u64(node, 0x28)
                            if 0x10000 <= config_ptr < MAX_USER_ADDRESS:
                                obj = read_process_memory(process, config_ptr + 0x88, 0x28) or b""
                                if len(obj) >= 0x18:
                                    data_ptr = _u64(obj, 0x8)
                                    data_len = _u64(obj, 0x10)
                                    if 0 < data_len <= CONFIG_BLOB_MAX and 0x10000 <= data_ptr < MAX_USER_ADDRESS:
                                        blob = read_process_memory(process, data_ptr, int(data_len)) or b""
                                        if blob and len(blob) == data_len:
                                            for match in CONFIG_LITERAL_RE.finditer(_xor_repeat(blob, CONFIG_XOR_MASK)):
                                                run = match.group(1).decode("ascii").lower()
                                                for start in {0, len(run) - 96 if len(run) >= 96 else 0}:
                                                    if start < 0 or start + 64 > len(run):
                                                        continue
                                                    key_hex = run[start : start + 64]
                                                    salt_hex = run[start + 64 : start + 96] if start + 96 <= len(run) else ""
                                                    item = (key_hex, salt_hex)
                                                    if item not in candidates:
                                                        candidates.append(item)
                        pos = data.find(pattern, pos + 1)
        finally:
            _kernel32().CloseHandle(process)
    return candidates


def list_db_files(storage: Path) -> list[Path]:
    """枚举 db_storage 下的数据库文件。"""
    files: list[Path] = []
    try:
        for path in sorted(storage.rglob("*.db")):
            try:
                if path.is_file() and path.stat().st_size >= PAGE_SIZE:
                    files.append(path)
            except OSError:
                continue
    except OSError:
        pass
    return files


def match_db_keys(candidates: list[tuple[str, str]], db_files: list[Path]) -> dict[str, str]:
    """把候选密钥按数据库 salt 匹配并用页面 HMAC 验证，返回 {salt_hex: enc_key_hex}。"""
    by_salt: dict[str, list[str]] = {}
    for key_hex, salt_hex in candidates:
        by_salt.setdefault(salt_hex, []).append(key_hex)
    key_map: dict[str, str] = {}
    for db_path in db_files:
        try:
            with open(db_path, "rb") as handle:
                page = handle.read(PAGE_SIZE)
        except OSError:
            continue
        if len(page) < PAGE_SIZE:
            continue
        salt_hex = page[:SALT_SIZE].hex()
        if salt_hex in key_map:
            continue
        for key_hex in dict.fromkeys(by_salt.get(salt_hex, [])):
            if key_matches_page(bytes.fromhex(key_hex), page):
                key_map[salt_hex] = key_hex
                break
    return key_map


def _file_salt_hex(path: Path) -> str:
    try:
        with open(path, "rb") as handle:
            return handle.read(SALT_SIZE).hex()
    except OSError:
        return ""


def pick_probe_db(storage: Path) -> Path | None:
    """选择用于密钥验证的探针数据库（优先 contact/session）。"""
    for relative in (Path("contact") / "contact.db", Path("session") / "session.db"):
        candidate = storage / relative
        if candidate.is_file():
            return candidate
    try:
        for candidate in sorted(storage.rglob("*.db")):
            if candidate.is_file() and candidate.stat().st_size >= PAGE_SIZE:
                return candidate
    except OSError:
        pass
    return None


def _emit(payload: object) -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")


def _emit_error(message: str) -> int:
    _emit({"error": message})
    return 1


def _load_key_store(path: Path) -> dict:
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def main(argv: list[str] | None = None) -> int:
    if os.name != "nt":
        return _emit_error("自动引导（微信进程密钥提取）仅支持 Windows。请改用插件配置 dataDir 指向已有数据目录。")

    parser = argparse.ArgumentParser(prog="wchat_bootstrap")
    parser.add_argument("--data-dir", required=True, help="生成的 account_keys.json / databases 存放目录")
    parser.add_argument("--process-name", default="Weixin.exe")
    args = parser.parse_args(argv)

    data_dir = Path(args.data_dir).expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)

    pids = find_process_pids(args.process_name)
    if not pids:
        return _emit_error("未发现运行中的微信进程（Weixin.exe）。请先启动并登录微信后重试；若微信安装在其他路径或使用其他进程名，请用插件配置 dataDir 直接指定数据目录。")
    _log(f"[*] 微信进程 PID: {pids}")

    roots = xwechat_roots()
    storages = discover_db_storages(roots)
    if not storages:
        tried = "、".join(str(root) for root in roots) or "%USERPROFILE%\\Documents\\xwechat_files"
        return _emit_error(f"未发现微信数据目录（已尝试：{tried}）。若微信使用了自定义存储位置，请用插件配置 dataDir 直接指定。")
    _log(f"[*] 发现 {len(storages)} 个微信数据目录")

    key_store_path = data_dir / "account_keys.json"
    key_store = _load_key_store(key_store_path)
    accounts: list[dict] = []

    config_candidates: list[tuple[str, str]] | None = None
    for index, storage in enumerate(storages, 1):
        wxid = storage.parent.name
        db_files = list_db_files(storage)
        if not db_files:
            _log(f"[*] 跳过 {wxid}：db_storage 内未找到可用数据库")
            continue

        # 路径 1（微信 4.1+）：运行时 Config.Cipher 只读扫描 → 每库 enc_key
        if config_candidates is None:
            _log("[*] 扫描微信 4.1+ 运行时 Config.Cipher …")
            config_candidates = collect_config_cipher_candidates(pids)
            _log(f"[*] Config.Cipher 候选 {len(config_candidates)} 个")
        db_key_map = match_db_keys(config_candidates, db_files) if config_candidates else {}

        entry: dict | None = None
        if db_key_map:
            _log(f"[+] {wxid}：Config.Cipher 命中 {len(db_key_map)}/{len(db_files)} 个数据库密钥")
            primary = db_key_map.get(_file_salt_hex(db_files[0])) if db_files else None
            entry = {"db_keys": dict(sorted(db_key_map.items()))}
            if primary:
                entry["db_key"] = primary
        else:
            # 路径 2（微信 4.0.x）：内存槽位 + DLL 掩码 扫描
            probe = pick_probe_db(storage)
            if probe is not None:
                _log(f"[*] ({index}/{len(storages)}) Config.Cipher 未命中，回退内存扫描：{wxid}")
                key = recover_key_for_db(pids, probe)
                if key is not None:
                    entry = {"db_key": key.hex()}

        if entry is None:
            _log(f"[-] {wxid}：密钥提取失败")
            continue

        key_store[wxid] = entry
        source_dir = data_dir / "databases" / wxid
        source_dir.mkdir(parents=True, exist_ok=True)
        (source_dir / "_source.json").write_text(
            json.dumps({"db_storage_path": str(storage)}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        accounts.append({"account": wxid, "has_key": True})
        _log(f"[+] {wxid}：密钥已写入 account_keys.json（值已脱敏）")

    if not accounts:
        return _emit_error("密钥提取失败：微信进程在运行，但未匹配到有效密钥。请确认微信已登录且窗口处于解锁状态（未锁屏）后重试。")

    key_store_path.write_text(
        json.dumps(key_store, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    _emit({"data_dir": str(data_dir), "accounts": accounts})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
