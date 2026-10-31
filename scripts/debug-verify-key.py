"""调试：用已知可用的 db_key 校准密钥验证模式（只输出模式与布尔结果，绝不打印密钥）。"""

import hashlib
import hmac
import json
import struct
import sys
from pathlib import Path

PAGE_SIZE = 4096
SALT_SIZE = 16
IV_SIZE = 16
HMAC_SIZE = 64
RESERVE_SIZE = IV_SIZE + HMAC_SIZE
KEY_SIZE = 32


def derive_mac_key(enc_key: bytes, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha512", enc_key, bytes(b ^ 0x3A for b in salt), 2, dklen=KEY_SIZE)


def derive_enc_key(key_material: bytes, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha512", key_material, salt, 256000, dklen=KEY_SIZE)


def page1_hmac(mac_key: bytes, page: bytes) -> bytes:
    mac = hmac.new(mac_key, digestmod=hashlib.sha512)
    mac.update(page[SALT_SIZE:PAGE_SIZE - RESERVE_SIZE + IV_SIZE])
    mac.update((1).to_bytes(4, "little"))
    return mac.digest()


def main() -> int:
    data_dir = Path(sys.argv[1])
    db_path = Path(sys.argv[2])
    store = json.loads((data_dir / "account_keys.json").read_text(encoding="utf-8"))
    page = db_path.read_bytes()[:PAGE_SIZE]
    salt = page[:SALT_SIZE]
    stored = page[PAGE_SIZE - HMAC_SIZE:PAGE_SIZE]
    print(f"db={db_path.name} size={db_path.stat().st_size} salt_hex_prefix={salt.hex()[:8]}…")
    for account, item in store.items():
        raw = bytes.fromhex(str((item or {}).get("db_key") or ""))
        if len(raw) != KEY_SIZE:
            print(f"{account}: key 格式异常，跳过")
            continue
        modes = {}
        modes["raw_enc_key"] = hmac.compare_digest(stored, page1_hmac(derive_mac_key(raw, salt), page))
        derived = derive_enc_key(raw, salt)
        modes["sqlcipher_passphrase"] = hmac.compare_digest(stored, page1_hmac(derive_mac_key(derived, salt), page))
        print(f"{account}: " + ", ".join(f"{k}={v}" for k, v in modes.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
