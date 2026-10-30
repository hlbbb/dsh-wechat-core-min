# dsh-wechat-core-min

把 wechat-core-min（微信 4.x 本地数据库的只读核心，Python 实现）包装成 DSH 插件：Agent 可以在任意会话里直接调用工具，读取微信本地账号、会话、消息、联系人与群成员。

- 插件只做适配：通过子进程调用 `python -m wchat_core`，解密、缓存、消息解析全部复用原项目；
- 全程只读：不解密出图片/视频文件本身（只返回消息类型与元数据）、不发送消息、不修改微信数据、不访问网络；
- 密钥安全：插件从不读取、传递或回显 `account_keys.json` 与任何密钥，解密密钥由 Python 端自行读取。若用户自己设置了 `WCHAT_DB_KEY` / `WCHAT_DATA_DIR` 环境变量，会随宿主环境原样透传给 Python 子进程（CLI 原生支持的来源），插件自身不读取、不设置、不回显。

## 前置条件

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
| `dataDir` | `""` | 微信数据目录；留空依次尝试环境变量 `WCHAT_DATA_DIR` 与内置默认路径 |
| `coreDir` | `""` | wchat-core 项目目录；留空用内置默认路径 |
| `pythonExecutable` | `""` | Python 解释器；留空自动探测 `coreDir\.venv\Scripts\python.exe`，再回退 PATH |
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
node scripts/e2e-check.mjs   # 真实跑一遍 accounts / sessions / messages / contacts / group-members 与错误分支
```
