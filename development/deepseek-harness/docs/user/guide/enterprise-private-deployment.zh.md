# 准备私有化办公部署

[English](enterprise-private-deployment.md) | 中文

## 概述

在不改动当前预览的情况下，准备隔离的办公数据目录、公司模型路由、连接策略和明确的联网选项。仓库工具校验公开 JSON，生成普通的 `dsh web --patch` 覆盖层，显示本地数据位置，并可按需检查审核后的健康地址。它不会启动应用、读取凭据值或改动现有应用数据。

## 目录

- [准备与查看](#prepare-and-inspect)
- [验证产物与服务地址](#verify-artifacts-and-endpoints)
- [应用部署](#apply-the-deployment)
- [联网选项与数据位置](#network-choices-and-data-locations)
- [离线备份与恢复](#offline-backup-and-recovery)
- [升级与回退](#upgrade-and-rollback)
- [客户配置与限制](#customer-configuration-and-limits)

<a id="prepare-and-inspect"></a>

## 准备与查看

使用仓库支持的 Node 和 pnpm 版本。在仓库根目录运行以下 PowerShell 命令；上级 `.local-run` 目录必须已经存在。先复制[公开示例](../../../apps/cli/config/examples/enterprise-private-deployment.json)，再编辑它：

```powershell
Copy-Item apps/cli/config/examples/enterprise-private-deployment.json ../.local-run/private-office.json
pnpm --config.verifyDepsBeforeRun=false exec tsx scripts/enterprise-private-deployment.ts --config ../.local-run/private-office.json
```

示例使用回环占位服务。请提供真实的模型基础地址、API 协议、模型标识、上下文容量和输出容量。支持的自定义协议为 `openai-completions`、`openai-responses` 和 `anthropic-messages`。`apiKeyEnv` 指向已有的 Host 凭据引用；仅在明确使用无认证模型服务时省略。密钥值应保存在已有凭据提供方或启动环境中，不能写入此 JSON。

`home` 相对 JSON 文件解析，不展开 `~`、环境变量或 Shell 表达式。因此，复制后的示例指向 `../.local-run/private-office-data`。数据目录不存在是有效状态，查看时仍不会创建。数据目录为文件或不可读时会阻止产物生成。报告展示声明的位置和选项，不检查运行中 Host 的配置。

办公部分提供首次启动的公司通讯录、一个固定本机员工身份、会议忙闲共享同意、准确规范的连接器来源、凭据别名及连接超时。标识必须唯一，所选员工必须存在，通讯录必须包含管理员。初始化成员不会替换已有办公通讯录。部署策略后，通过管理员已有的连接页面配置真实连接。

<a id="verify-artifacts-and-endpoints"></a>

## 验证产物与服务地址

写入一个新目录，再用同一 JSON 比较产物：

```powershell
pnpm --config.verifyDepsBeforeRun=false exec tsx scripts/enterprise-private-deployment.ts --config ../.local-run/private-office.json --write ../.local-run/private-office-v1
pnpm --config.verifyDepsBeforeRun=false exec tsx scripts/enterprise-private-deployment.ts --config ../.local-run/private-office.json --verify ../.local-run/private-office-v1
```

工具写入 `private-office.patch.yml` 和 `launch.json`。目标目录已经存在时会拒绝写入，始终不会覆盖 Profile。写入失败会保留不完整目录以便检查；恢复时选择新的目标目录。验证会拒绝缺失或发生变化的产物。移动输出目录会改变绝对启动路径，因此应在最终使用位置重新生成。

联网检查必须显式指定 `--probe`：

```powershell
pnpm --config.verifyDepsBeforeRun=false exec tsx scripts/enterprise-private-deployment.ts --config ../.local-run/private-office.json --verify ../.local-run/private-office-v1 --probe
```

每个地址必须与配置模型、获准连接器、已启用搜索或已启用反馈收集器的来源一致。使用经运维人员批准的只读健康路径：每项探测只发送一次无认证 GET，不跟随重定向、不发送凭据、不读取响应正文，也不自动重试。检查不代表模型推理、凭据验证或业务动作检查。HTTP 401/403 报告为 `authentication-required`；重定向、HTTP 失败、服务不可达、超时和取消分别报告。

退出码 `0` 表示本地校验成功，且所有显式探测均返回 HTTP 成功。`1` 表示配置无效、数据目录异常或产物／文件操作失败。`2` 表示至少一项显式探测退化、要求认证或被取消。探测失败后，配置和产物保持完整。恢复服务或网络后重复同一命令；Ctrl+C 会取消当前请求及剩余检查。默认命令不发送联网请求。

<a id="apply-the-deployment"></a>

## 应用部署

检查生成的覆盖层和启动元数据。元数据包含绝对补丁路径、仓库工作目录和所需 `DSH_HOME`，不包含凭据值。请使用全新的隔离数据目录：覆盖层会替换完整插件配置，包括 `llm-pi-ai` 提供方部分，不会合并已有部署的自定义路由或迁移数据。规划此类迁移前，应分别保留来源部署的配置和数据。

已有 CLI（命令行界面）可以在不挂载服务的情况下查看组合后的 Profile：

```powershell
$privateLaunch = Get-Content ../.local-run/private-office-v1/launch.json -Encoding UTF8 -Raw | ConvertFrom-Json
$env:DSH_HOME = $privateLaunch.environment.DSH_HOME
pnpm --config.verifyDepsBeforeRun=false dsh web --patch $privateLaunch.args[3] --dump-config
```

部署管理员把同一命令中的 `--dump-config` 替换为 `--no-open` 后启动应用；这一目标环境操作需要所提供的服务和凭据。在已有模型界面选择配置的私有路由。部署覆盖层应放在其他普通覆盖层之后，使其选项生效。更低层设置中的编辑可能被覆盖层的完整配置覆盖；变更部署策略时，修改已审核 JSON，并生成新的产物目录。

`--dump-config` 会输出组合后的配置。请在本地审阅；其他部署的配置转储未经内联秘密检查，不应附加到诊断材料中。工具自身的报告从不读取环境变量值、凭据文件、会话正文或远端响应正文。

<a id="network-choices-and-data-locations"></a>

## 联网选项与数据位置

隐私字段分别控制已有的独立机制：

| 选项 | 实际行为 |
| --- | --- |
| `sessionTelemetry.mode: disabled` | 停用 `session-telemetry-otel` 条目，不挂载其导出器。 |
| `sessionTelemetry.mode: feedback-only` | 使用明确收集地址挂载已有的仅反馈后端。用户显式反馈可能导出已授权的会话日志前缀。 |
| `productAnalytics: disabled` | 同时停用桌面产品导出器及产品分析接收条目。 |
| `productAnalytics: profile-default` | 由所选 Profile 决定两条目的状态；普通 Web 默认停用，Desktop 有自己的采集策略。 |
| `webSearch.enabled: false` | 停用内置 DeepSeek 搜索提供方。启用时必须单独提供地址、模型和凭据引用。 |
| `webFetch: false` | 停用内置 HTTP 抓取提供方。搜索及抓取都停用时，同时停用其内置工具。 |

这些选项不是进程防火墙。其他已安装模型／账号路由、Shell、子进程、浏览器、MCP 服务和插件保留原有能力。启用的模型向配置服务发送已准入的会话上下文；启用的网页抓取可以访问请求的 HTTP(S) 目标。连接器来源限制仅约束办公连接器请求。公司级出站白名单应在网络或操作系统实施，并单独验证基础设施。后续覆盖层及环境策略也可能影响最终进程。

使用产物中的 `DSH_HOME` 时，报告列出 `profiles/web`、`sessions`、`storages`、`attachments/v1`、`office/drive/v1`、`office/chat/v1`、`.credentials.yaml` 和 `cache`，仅读取数据根目录的文件系统状态。这些是内置本地提供方的预期路径；自定义存储插件及显式路径覆盖需要另外检查。工作区文件、共享 agent（智能体）配置、浏览器存储及 Desktop 载体数据可能位于该目录之外。工具不会将存储引擎替换为 MySQL 或其他远端数据库。

<a id="offline-backup-and-recovery"></a>

## 离线备份与恢复

停止中央办公服务和全部员工 Host，排空写入与子进程，并阻止新流量直到备份完成。`--quiescent` 表示运维人员确认此前提；工具不会停止进程或获取应用维护锁。两次一致的来源扫描可以发现变化，但不能使运行中的多文件写入变成事务。

备份完整的实际 `DSH_HOME`，办公目录、身份及邀请台账须一起保留，并包含网盘／聊天字节、全部原生 Session 代际、附件、Profile、凭据及存储提供方文件。通过 `--root id=path` 补充外部工作区、单个配置文件、Desktop 数据和自定义提供方根目录；工具不会自动发现它们。来源不能重叠，符号链接、junction 和特殊文件均拒绝。在仓库中使用固定的便携 Node：

```powershell
$releaseNode = '../.local-run/node-v24.22.0-win-x64/node.exe'
& $releaseNode --import tsx/esm scripts/enterprise-backup.ts diagnostics --home ../.local-run/enterprise-preview-home
& $releaseNode --import tsx/esm scripts/enterprise-backup.ts backup --home ../.local-run/enterprise-preview-home --provider local --quiescent --output ../.local-run/release-backup-v1 --root deployment=enterprise-workbench.patch.yml
& $releaseNode --import tsx/esm scripts/enterprise-backup.ts verify --backup ../.local-run/release-backup-v1
& $releaseNode --import tsx/esm scripts/enterprise-backup.ts restore --backup ../.local-run/release-backup-v1 --output ../.local-run/release-restore-v1
```

每个目标必须是新目录。失败操作保留未完成目录以供检查；修正后选择另一目标。完整备份包含 `manifest.json` 和 SHA-256 `COMPLETE` 标记。验证核对全部所选字节，并拒绝缺失、额外、变化或未来格式内容。摘要可以发现损坏，不能防止数据及摘要被一起恶意替换。备份包含凭据与业务数据，应使用经过审核的 Windows ACL 和加密存储保护。工具保留 POSIX 模式位；Windows ACL 须在重新打开前单独应用。输出仅包含总数或安全失败码。诊断返回数量、字节和可用容量；应用限额及服务状态仍通过现有网盘额度视图与获准的健康探测确认。不要向支持请求附加原始日志。

验证总数和 `RESTORED.json` 标识本次操作真正核验过的清单字节。之后替换清单文件不会改变这个标识；复制出的内容仍须匹配已核验的条目。

恢复会创建 `home/` 及每个附加来源的独立目录，不改动原部署，也不选择提供方。在隔离 Host 中指向恢复后的根目录。切换前核实已有成员登录、邀请单次语义、有权及越权文件读取、附件准确字节、旧 Session 读取和一次新追加。不得让两个中央服务打开同一份数据。文件验证本身不能证明应用恢复成功。

MySQL 需要排空全部数据库消费者，并取得提供方冻结的逻辑导出。用 `--provider mysql-frozen-export --mysql-export <verified-export-directory>` 代替 `--provider local`。工具仅核对导出字节；数据库负责人仍须验证完整逻辑内容、生命周期与 staging 导入。运行中 datadir 的复制、不同 namespace 或摘要不能证明数据库快照有效。没有正式维护围栏及 staging 导入器时，保持禁止切换并保留原提供方。参阅 [MySQL 指南](mysql-sessions.zh.md)。

<a id="upgrade-and-rollback"></a>

## 升级与回退

记录实际构建／运行时版本、公开 Client 值、提供方、数据根目录和备份摘要，保留当前安装包与程序文件。验证离线备份，在新目录恢复并执行上述应用检查。按发生变化的依赖面编译；Office Remote 变更还需要重打 API remotes 的 **Client** bundle 及 Web 产物。实际命令成功后再写产物记录。

在隔离试装位置安装替换程序并使用恢复数据。检查启动、原菜单／快捷键、插件管理、历史、登录及文件权限。生产更新验收还需要真实配置的策略服务与更新源。显式 Windows `--unsigned --local` 安装包省略签名和更新服务，仅用于本机安装试验；参阅 [Desktop 打包](../../../apps/desktop/README.zh.md#unsigned-windows-test-installer)。

回退前，停止替换程序并冻结／导出所有新增写入，保留导出及两份数据根目录。将经过验证的旧备份恢复到另一个新目录，再显式选择旧应用／提供方。切换提供方时，须先经过验证地导入新增数据，才能宣称数据已保留；卸载插件不会迁移数据。不得覆盖运行中数据、替换 Session 代际或截断日志。旧读取器拒绝新格式时，应保留新数据及兼容读取器，并报告回退受阻。

<a id="customer-configuration-and-limits"></a>

## 客户配置与限制

客户需提供可达的模型地址与真实容量、模型／搜索／连接器凭据、获准的只读健康路径、连接器适配器与集成定义、远程访问所需 TLS／反向代理配置、文件系统权限、备份策略及所需网络隔离。示例中的 `principalId` 选择受信任本机工作站身份，不是中央员工登录、SSO 或安全的共享 Host 部署。这些独立职责请参考已有[办公架构](../../subsystems/enterprise-office.zh.md)与[反向代理指南](public-deployments.zh.md)。

受控本地检查覆盖真实 Profile 组合、Loader 激活、导出器停用、离线恢复前后产物不变、认证／HTTP 错误、阻止重定向、超时及取消。客户模型推理、真实公司 API、目标网络隔离、SSO、MySQL、备份恢复及运行中客户环境的有效策略，仍需运维人员验证。

## 开发备注

无。
