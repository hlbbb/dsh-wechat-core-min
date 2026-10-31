# dsh-wechat-core-min

把 wechat-core-min（微信 4.x 本地数据库的只读核心，Python 实现）包装成 DSH 插件：Agent 可以在任意会话里直接调用工具，读取微信本地账号、会话、消息、联系人与群成员。

- 插件只做适配：通过子进程调用 `python -m wchat_core`，解密、缓存、消息解析全部复用原项目；
- 全程只读：不解密出图片/视频文件本身（只返回消息类型与元数据）、不发送消息、不修改微信数据、不访问网络；
- 密钥安全：插件从不读取、传递或回显 `account_keys.json` 与任何密钥，解密密钥由 Python 端自行读取。若用户自己设置了 `WCHAT_DB_KEY` / `WCHAT_DATA_DIR` 环境变量，会随宿主环境原样透传给 Python 子进程（CLI 原生支持的来源），插件自身不读取、不设置、不回显。

## 在其他电脑部署

插件已内置 wchat_core 源码并自动准备 Python 依赖，新电脑无需 clone 任何项目：

1. 确保 Agent 宿主环境有 Python 3.11+。支持三种来源：PATH 上的 `python`/`python3`/`py`；PEP 514 注册表登记的解释器（python.org 官方安装、Anaconda/Miniconda 均会登记，未加 PATH 也能找到）；以及 `%USERPROFILE%\anaconda3|miniconda3` 等常见 Anaconda 目录。
2. 安装插件：`dsh plugin --profile desktop add "github:hlbbb/dsh-wechat-core-min"`。
3. 准备微信数据目录，并在 profile 补丁层给插件行配置 `dataDir`（见下文配置示例）。

首次调用任意工具时自动完成环境准备，之后不再重复：

- 若配置的 `coreDir` 下有 `.venv`，直接使用它；
- 否则用探测到的系统 Python 在 `%LOCALAPPDATA%\dsh-wechat-core-min\runtime` 创建专用虚拟环境，并自动安装 `cryptography` / `zstandard`（需联网一次，之后完全离线可用）；
- 环境准备幂等，失败（如网络中断）后重试调用即可续装。

微信数据目录的来源：在装有微信 4.x 的电脑上用主程序导出（生成 `account_keys.json` 与 `databases/`）；也可以把现有 `output` 目录整个拷贝到目标电脑使用——`_source.json` 指向的原始库路径在新电脑上失效时，会自动退回解密快照模式（数据截止到拷贝时刻）。

完全找不到 Python 时，报错会给出安装指引；也可用 `pythonExecutable` 直接指定解释器路径。内置源码的同步方式见「开发自测」。

## 前置条件（开发机）

1. `wechat-core-min` 项目就绪（默认假定位于 `%USERPROFILE%\Documents\projects\wechat-core-min`），且已按其 README 创建 venv：

   ```powershell
   cd %USERPROFILE%\Documents\projects\wechat-core-min
   python -m venv .venv
   .venv\Scripts\pip install -r requirements.txt
   ```

2. 微信数据目录（含 `account_keys.json` 与 `databases/`），默认假定 `%USERPROFILE%\Documents\projects\WeChatDataAnalysis\output`。

以上路径都可通过插件配置覆盖（见下文）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `wchat_accounts` | 列出数据目录中的账号（wxid、是否有密钥、源库位置） |
| `wchat_decrypt` | 解密原始加密库为明文 SQLite 缓存（默认按源库修改时间增量，`refresh` 强制） |
| `wchat_sessions` | 列出 / 搜索会话（单聊与群聊），含最近摘要 |
| `wchat_messages` | 读取某聊天的消息，支持 `date` / `days` / `start/end`、翻页、`json/md/txt` 格式 |
| `wchat_contacts` | 列出 / 搜索联系人 |
| `wchat_group_members` | 列出群成员与群内昵称 |

工具执行为互斥（不并发），避免两次调用同时触发解密写同一缓存目录。

## 配置（cordis 补丁行的 `config`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `""` | 微信数据目录（需含 `account_keys.json` 与 `databases/`）；未配置且未设环境变量 `WCHAT_DATA_DIR` 时，工具报可操作错误提示配置方法 |
| `coreDir` | `""` | wchat-core 项目目录（需含 `wchat_core` 包，推荐有 `.venv`）；留空时默认路径存在则用之，否则回退插件内置源码 |
| `pythonExecutable` | `""` | Python 解释器；留空自动探测：coreDir 的 `.venv` → 自动运行时 venv → 系统 `python`/`python3`/`py`（缺依赖自动建环境） |
| `timeoutMs` | `180000` | 单次调用的超时毫秒数；首次解密大库可能耗时较长 |

在 profile 的补丁层覆盖示例：

```yaml
- id: dsh-wechat-core-min
  config:
    dataDir: "D:\\wchat\\output"
    timeoutMs: 300000
```

注意：补丁对 `config` 是整块替换，覆盖任一字段时需写全其余字段（省略的字段走 schema 默认值）。

## 安装 / 卸载

```powershell
# 从 GitHub 安装
dsh plugin --profile desktop add "github:hlbbb/dsh-wechat-core-min"

# 或本地目录安装（开发模式）
dsh plugin --profile desktop add "link:C:\path\to\dsh-wechat-core-min"
```

卸载用 `dsh plugin --profile desktop remove dsh-wechat-core-min`，或通过 DSH 插件管理界面操作。

## 开发自测

```powershell
node --check runner.js
node --check tools.js
node --check index.js
node scripts/e2e-check.mjs          # 常规链路：外部项目 + venv（accounts / sessions / messages / contacts / group-members / 错误分支）
node scripts/e2e-fresh-machine.mjs  # 新机首次部署模拟：内置源码回退 + 自动创建虚拟环境安装依赖 + 无 Python 兜底报错
node scripts/sync-core.mjs          # 上游 wechat-core-min 有更新后，同步进插件内置 python/
```
