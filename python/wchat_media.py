"""导出微信聊天中的文件原件与图片（插件能力，独立于 wchat_core 的数据查询）。

- 图片：定位 `msg/attach/<md5(会话username)>/<年月>/Img/*.dat`，用本机 kvcomm 推导的
  图片密钥（image_key_resolver，V2 模板校验）解密为 png/jpg；微信 4.x 图片消息不含 md5，
  采用「文件 mtime ≈ 消息时间」启发式配对（原图优先，原图已清理时回退缩略图）。
  仅当插件处于「实时模式」（_source.json 指向本机微信目录）时可用。
- 文件：按消息里的文件名/大小在 `msg/file/<年月>/` 定位明文原件并复制。
- 只读：只复制/解密到 --out 目录，不修改微信原始数据。

用法：
  python -m wchat_media --data-dir <dir> --chat <名称或username> [--date today|YYYY-MM-DD|all]
      [--days N] [--start ISO --end ISO] [--types image,file] [--limit 50] [--out <目录>]
输出：stdout 单行 JSON（saved / skipped / errors / counts）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import sys
from datetime import datetime
from pathlib import Path

from wchat_core import cli, contacts, store

V2_MAGIC = bytes((0x07, 0x08, 0x56, 0x32, 0x08, 0x07))


def _log(message: str) -> None:
    print(message, file=sys.stderr)


def _xor_bytes(data: bytes, key: int) -> bytes:
    if not key:
        return data
    return bytes(value ^ key for value in data)


def _unpad_pkcs7(data: bytes) -> bytes:
    if not data:
        return data
    pad = data[-1]
    if 1 <= pad <= 16 and data[-pad:] == bytes([pad]) * pad:
        return data[:-pad]
    return data


def decrypt_image_dat(data: bytes, xor_key: int, aes_key: str) -> bytes:
    """解密微信 4.x 的图片 .dat（V2 = AES-128-ECB + 原始段 + XOR 段；旧格式 = 整文件 XOR）。"""
    if len(data) < 16 or data[:6] != V2_MAGIC:
        return _xor_bytes(data, xor_key)
    signature, aes_size, xor_size = struct.unpack("<6sLLx", data[:15])
    if aes_size <= 0 or aes_size % 16 or 15 + aes_size > len(data):
        return b""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    rest = data[15:]
    aes_data = rest[:aes_size]
    tail = rest[aes_size:]
    decryptor = Cipher(algorithms.AES(aes_key.encode("utf-8")[:16]), modes.ECB()).decryptor()
    plain = _unpad_pkcs7(decryptor.update(aes_data) + decryptor.finalize())
    if xor_size and xor_size <= len(tail):
        raw_data = tail[:-xor_size]
        xored = _xor_bytes(tail[-xor_size:], xor_key)
    else:
        raw_data, xored = tail, b""
    return plain + raw_data + xored


def detect_image_ext(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return ".gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return ""


def sanitize_name(value: str) -> str:
    text = re.sub(r'[\\/:*?"<>|\x00-\x1f\r\n\t]+', "_", str(value or "")).strip(" .")
    return text[:80] or "untitled"


def load_image_keys(account_root: Path) -> tuple[int, str] | None:
    """用本机 kvcomm 推导图片密钥（不落盘、不输出）；失败返回 None。"""
    try:
        from image_key_resolver import resolve_local_image_key

        appdata = str(os.environ.get("APPDATA") or "").strip()
        if not appdata:
            return None
        kvcomm = Path(appdata) / "Tencent" / "xwechat" / "net" / "kvcomm"
        if not kvcomm.is_dir():
            return None
        resolution = resolve_local_image_key(kvcomm_dir=kvcomm, account_dir=account_root, account=account_root.name)
        if resolution is None or not resolution.verified:
            return None
        return int(resolution.xor_key), str(resolution.aes_key)
    except Exception:
        return None


def _month_of(iso_time: str) -> str:
    try:
        return datetime.fromisoformat(iso_time).strftime("%Y-%m")
    except Exception:
        return ""


def _raw_attrs(raw: str) -> dict[str, str]:
    return {key: value for key, value in re.findall(r'([a-zA-Z_][\w-]*)="([^"]*)"', raw or "")}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="wchat_media")
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--account")
    parser.add_argument("--cache-dir")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--chat", required=True)
    parser.add_argument("--date", default="today")
    parser.add_argument("--days", type=int)
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--types", default="image,file")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)

    wanted = {item.strip().lower() for item in str(args.types or "").split(",") if item.strip()}
    if not wanted:
        wanted = {"image", "file"}

    data_dir = store.resolve_data_dir(args.data_dir)
    account = store.resolve_account(data_dir, args.account)
    cache = store.ensure_cache(data_dir, account, cache_root=args.cache_dir, refresh=args.refresh)
    storage = store.source_storage(data_dir, account)
    if storage is None or not Path(storage).is_dir():
        print(json.dumps({"error": "当前为解密快照模式，无法访问媒体原件；请在有微信运行的本机使用实时模式。"}, ensure_ascii=False))
        return 1
    account_root = Path(storage).resolve().parent
    attach_root = account_root / "msg" / "attach"
    file_root = account_root / "msg" / "file"

    contact_map = contacts.load_contact_map(cache.contact_db) if cache.contact_db else {}
    sessions = cli._load_sessions(cache, contact_map)
    chat = cli._match_chat(sessions, contact_map, args.chat)

    bounds = argparse.Namespace(date=args.date, days=args.days, start=args.start, end=args.end)
    start_ts, end_ts = cli._date_bounds(bounds)
    messages = cli._read_messages(cache, chat["username"], start=start_ts, end=end_ts, include_raw=True)

    chat_hash = hashlib.md5(chat["username"].encode("utf-8")).hexdigest()
    chat_attach = attach_root / chat_hash
    out_dir = Path(args.out).expanduser().resolve() / sanitize_name(chat.get("name") or chat["username"])
    out_dir.mkdir(parents=True, exist_ok=True)

    image_keys = None
    saved: list[dict] = []
    skipped: list[dict] = []
    counts = {"image": 0, "file": 0}

    # 图片与消息的配对：微信 4.x 图片消息不含 md5，用「文件 mtime ≈ 消息时间」最近匹配。
    image_files: list[tuple[Path, float]] = []
    if "image" in wanted and chat_attach.is_dir():
        for path in chat_attach.glob("*/Img/*.dat"):
            try:
                image_files.append((path, path.stat().st_mtime))
            except OSError:
                continue
    full_files = [(p, m) for p, m in image_files if not p.name.endswith("_t.dat")]
    thumb_files = [(p, m) for p, m in image_files if p.name.endswith("_t.dat")]
    used_paths: set[str] = set()

    def pick_image(iso_time: str, tolerance: float = 180.0):
        try:
            message_ts = datetime.fromisoformat(iso_time).timestamp()
        except Exception:
            return None
        best = None
        for pool, is_thumb in ((full_files, False), (thumb_files, True)):
            for path, mtime in pool:
                if str(path) in used_paths:
                    continue
                delta = abs(mtime - message_ts)
                if delta > tolerance:
                    continue
                if best is None or delta < best[0]:
                    best = (delta, path, is_thumb)
            if best is not None:
                break
        if best is None:
            return None
        used_paths.add(str(best[1]))
        return best[1], best[2]

    def save_bytes(name: str, data: bytes) -> Path:
        target = out_dir / name
        index = 1
        while target.exists():
            target = out_dir / f"{Path(name).stem}-{index}{Path(name).suffix}"
            index += 1
        target.write_bytes(data)
        return target

    for message in messages:
        kind = message.get("kind")
        if kind not in wanted or counts.get(kind, 0) >= max(0, int(args.limit)):
            continue
        iso_time = str(message.get("time") or "")
        stamp = re.sub(r"[^0-9]", "", iso_time)[:14] or "0"
        sender = sanitize_name(str(message.get("sender") or ""))

        if kind == "image":
            if image_keys is None:
                image_keys = load_image_keys(account_root)
                if image_keys is None:
                    skipped.append({"kind": "image", "time": iso_time, "reason": "未获取到本机图片密钥（kvcomm 未命中）"})
                    continue
            picked = pick_image(iso_time)
            if picked is None:
                skipped.append({"kind": "image", "time": iso_time, "reason": "本地无对应的图片文件（可能已过期/未下载）"})
                continue
            candidate, is_thumb = picked
            try:
                data = decrypt_image_dat(candidate.read_bytes(), image_keys[0], image_keys[1])
            except Exception:
                data = b""
            ext = detect_image_ext(data or b"")
            if not data or not ext:
                skipped.append({"kind": "image", "time": iso_time, "reason": "图片解密失败"})
                continue
            suffix = "_thumb" if is_thumb else ""
            path = save_bytes(f"{stamp}_{sender}_image{suffix}_{candidate.stem[:8]}{ext}", data)
            saved.append({"kind": "image", "time": iso_time, "sender": message.get("sender"), "path": str(path), "size": len(data), "thumb": is_thumb, "source": candidate.name})
            counts["image"] += 1
            continue

        if kind == "file":
            title = sanitize_name(str(message.get("title") or ""))
            file_size = int(message.get("file_size") or 0)
            month = _month_of(iso_time)
            candidates = []
            if title:
                month_dir = file_root / month
                if month_dir.is_dir():
                    candidates.extend(sorted(month_dir.glob(f"*{title}*")))
                if not candidates and file_root.is_dir():
                    candidates.extend(sorted(file_root.glob(f"*/{title}")))
                    candidates.extend(sorted(file_root.glob(f"*/*{title}*")))
            matched_path = None
            for candidate in candidates:
                try:
                    if candidate.is_file() and (not file_size or candidate.stat().st_size == file_size):
                        matched_path = candidate
                        break
                except OSError:
                    continue
            if matched_path is None:
                skipped.append({"kind": "file", "time": iso_time, "reason": f"未找到本地文件：{title or '(无标题)'}"})
                continue
            target = out_dir / f"{stamp}_{sender}_file_{sanitize_name(matched_path.name)}"
            index = 1
            while target.exists():
                target = out_dir / f"{Path(target).stem.split('-')[0]}-{index}{target.suffix}"
                index += 1
            shutil.copyfile(matched_path, target)
            saved.append({"kind": "file", "time": iso_time, "sender": message.get("sender"), "path": str(target), "size": target.stat().st_size, "source": matched_path.name})
            counts["file"] += 1

    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps({"out_dir": str(out_dir), "counts": counts, "saved": saved, "skipped": skipped[:20]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
