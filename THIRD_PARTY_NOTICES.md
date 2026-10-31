# Third-party notices / 第三方代码声明

本仓库包含以下来自第三方（MIT 许可）的源代码，仅作必要改动（如去除本地依赖、增强校验）：

## python/image_key_resolver.py

- 来源：WeChatDataAnalysis（https://github.com/LifeArchiveProject/WeChatDataAnalysis）
  的 `src/wechat_decrypt_tool/image_key_resolver.py`
- 许可：MIT License
- 用途：从本机微信 kvcomm 缓存推导并校验图片解密密钥（只读，不落盘、不输出密钥值）
- 改动：无（原样复制，保留原始 docstring）

## 算法思路参考（未直接复制代码）

- 微信 4.1+ `Config.Cipher` 只读运行时扫描与 `WeChat.dll` internal_db_key 提取思路参考
  [TANGandXUE/wcdb-key-tool](https://github.com/TANGandXUE/wcdb-key-tool)（MIT）与
  WeChatDataAnalysis 的 `key_v4.py` / `dll_key_scan.py`；本仓库为独立实现
  （`python/wchat_bootstrap.py`，零第三方依赖：ctypes + hashlib）。
