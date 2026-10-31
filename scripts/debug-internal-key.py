"""诊断：用已知真实 key 反推 internal_db_key，并检查其是否存在于 Weixin.dll（不打印密钥）。"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
import wchat_bootstrap as bs  # noqa: E402


def main() -> int:
    data_dir = Path(sys.argv[1])
    prop_name = sys.argv[2] if len(sys.argv) > 2 else ""
    store = json.loads((data_dir / "account_keys.json").read_text(encoding="utf-8"))
    real_keys = [bytes.fromhex(str((item or {}).get("db_key") or "")) for item in store.values()]
    real_keys = [k for k in real_keys if len(k) == 32]
    if not real_keys:
        print("no usable key")
        return 1

    pids = bs.find_process_pids(prop_name or "Weixin.exe")
    dll = bs.find_weixin_dll(pids)
    print("dll:", dll, "| size MB:", (dll.stat().st_size // 1024 // 1024) if dll and dll.is_file() else "-")

    memory = []
    for pid in pids:
        h = bs.open_process(pid)
        if not h:
            continue
        try:
            memory.extend(bs.collect_key_candidates(h))
        finally:
            bs._kernel32().CloseHandle(h)
    memory = [k for k in dict.fromkeys(memory) if bs.is_potential_key(k)]
    print("memory candidates:", len(memory))

    dll_bytes = dll.read_bytes() if dll and dll.is_file() else b""
    print("dll bytes MB:", len(dll_bytes) // 1024 // 1024)

    for real in real_keys:
        hits_in_dll = 0
        hit_offsets = []
        for mem in memory:
            internal = bytes(a ^ b for a, b in zip(mem, real))
            pos = dll_bytes.find(internal)
            if pos >= 0:
                hits_in_dll += 1
                hit_offsets.append((pos, mem))
        print(f"real-key[?]: 内存候选反推出的 internal 在 DLL 命中 {hits_in_dll} 个")
        for pos, mem in hit_offsets[:3]:
            # 检查命中点在 DLL 中的后续结构（打印周围 48 字节的十六进制摘要，不含密钥本体）
            print(f"  dll_offset=0x{pos:X} 后续16字节={dll_bytes[pos+32:pos+48].hex()} 前8字节上下文={dll_bytes[max(0,pos-16):pos].hex()}")
            print(f"  mem 槽位前后判断: mem 前 8 字节十六进制={mem[:8].hex()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
