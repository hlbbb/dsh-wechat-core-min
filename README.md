# dsh-wechat-core-min

把 wechat-core-min（微信 4.x 本地数据库的只读核心，Python 实现）包装成 DSH 插件：Agent 可以在任意会话里直接调用工具，读取微信本地账号、会话、消息、联系人与群成员。

- 插件只做适配：通过子进程调用 `python -m wchat_core`，解密、缓存、消息解析全部复用原项目；
- 全程只读：不解密出图片/视频文件本身（只返回消息类型与元数据）、不发送消息、不修改微信数据、不访问网络；
- 密钥安全：插件从不读取、传递或回显 `account_keys.json` 与任何密钥，解密密钥由 Python 端自行读取。若用户自己设置了 `WCHAT_DB_KEY` / `WCHAT_DATA_DIR` 环境变量，会随宿主环境原样透传给 Python 子进程（CLI 原生支持的来源），插件自身不读取、不设置、不回显。

## 在其他电脑部署（开箱即用）

前提：那台电脑已安装并登录微信 4.x（Windows）。然后：

1. 安装插件：`dsh plugin --profile desktop add "github:hlbbb/dsh-wechat-core-min"`；
2. 直接调用任意工具。首次调用时插件自动完成：
   - 发现微信数据目录（读取微信配置记录的自定义位置 / `%USERPROFILE%\Documents\xwechat_files`）；
   - **微信 4.1+**：只读扫描微信进程中的 `Config.Cipher` 对象，提取每个数据库的密钥（不注入、不重启微信、不修改任何数据）；
   - **微信 4.0.x**：回退到内存槽位 + `Weixin.dll` 掩码扫描；
   - 生成数据目录到 `%LOCALAPPDATA%\dsh-wechat-core-min\data`（含 `account_keys.json` 与 `databases/<wxid>/_source.json`）；
   - 之后每次查询自动增量解密、追上新消息。
3. 需要密码/密钥时只用本机微信进程，密钥仅落盘到上述数据目录，不会出现在任何日志或输出里。

补充说明：
- 需要微信**已登录且窗口处于解锁状态**（未锁屏）；若提取失败，按报错提示重试，或在插件配置 `dataDir` 指向已存在的数据目录；
- 提取过程只读进程内存，可能触发个别安全软件的提示；
- 如已有现成数据目录（例如用 WeChatDataAnalysis 导出），直接配置 `dataDir` 即可跳过自动引导；
- **新增/切换微信账号后**，删除 `%LOCALAPPDATA%\dsh-wechat-core-min\data` 再调用一次工具，即会重新引导补齐新账号的密钥；

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
| `dataDir` | `""` | 微信数据目录（需含 `account_keys.json` 与 `databases/`）；留空时若 `autoBootstrap` 开启则自动生成到 `%LOCALAPPDATA%\dsh-wechat-core-min\data` |
| `autoBootstrap` | `true` | 未配置 `dataDir` 时自动发现微信数据目录并从微信进程只读提取数据库密钥（Windows，微信 4.x 需已登录） |
| `coreDir` | `""` | （可选）外部 wchat-core 项目目录，仅用于探测其 `.venv` 解释器；代码固定使用插件内置 `wchat_core`（含 4.1+ 按库密钥补丁） |
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
# 需要微信已登录；会自动生成到临时目录并验证解密链路（仅本机验证用）
$env:WCHAT_E2E_DATA_DIR="<已有数据目录>"; node scripts/e2e-check.mjs   # 常规链路
node scripts/e2e-fresh-machine.mjs  # 新机模拟：内置源码回退 + 自动建虚拟环境 + 数据目录异常分支
node scripts/sync-core.mjs          # 上游 wchat_core 有更新后同步（跳过 store.py，保留插件补丁）
```

> 说明：`python/wchat_core/store.py` 含插件补丁（微信 4.1+ 按库密钥 `db_keys` 支持），
> `sync-core.mjs` 会跳过它；上游 `store.py` 变更时需手动合并该补丁。
