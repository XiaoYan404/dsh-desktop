# 为 CLI 与 SDK 会话选择 MySQL

[English](mysql-sessions.md) | 中文

## 概述

通过显式 profile 补丁选择管理员已准备的 MySQL Session 存储。普通 CLI、TypeScript SDK 与 Python SDK 保留原生 Agent、历史及事件 API。随产品交付的默认配置继续使用 JSONL；既有文件不会被导入或改写。

## 目录

- [准备部署](#prepare-the-deployment)
- [选择补丁](#choose-the-patch)
- [运行 CLI 或 SDK](#run-the-cli-or-sdk)
- [检查数据与失败](#inspect-data-and-failures)
- [部署限制](#deployment-limits)

<a id="prepare-the-deployment"></a>
## 准备部署

使用隔离的 Harness home 和已批准的 MySQL 地址。管理员需提供数据库级账号、完整且匹配的 R7 schema，以及既有 `dsh_stores.store_key` 命名空间。[连接参考](../../../packages/storage/mysql/README.zh.md)负责服务器设置、schema 初始化与升级；[Session 提供方参考](../../../packages/session/session-persistence-mysql/README.zh.md)负责命名空间与所有权规则。这些示例选择 `schemaMode: verify`，不执行初始化或历史导入。

将匹配版本的 `@deepseek-ai/dsh-mysql` 与 `@deepseek-ai/dsh-session-persistence-mysql` 制品作为可选依赖安装到所选 profile。`sdk-minimal` 还需要 `@deepseek-ai/dsh-credentials-local` 插件。通过现有[profile 包管理](../../../apps/cli/README.zh.md#profiles)使用经审阅的制品。仅安装包不会挂载这些插件，补丁负责提供配置行。开发目录中存在这些包，不表示 CLI 发行包或 Python 运行时 wheel 内置了它们。

在启动环境中提供以下设置。密码通过 Host 凭据提供方或其继承环境引用提供；不要把值放进补丁、URL 或诊断附件。

| 设置 | 含义 |
|---|---|
| `DSH_MYSQL_HOST`, `DSH_MYSQL_PORT` | 经审阅的数据库主机名与显式 TCP 端口 |
| `DSH_MYSQL_DATABASE`, `DSH_MYSQL_USER` | 既有数据库及其限定范围的账号 |
| `DSH_MYSQL_STORE_KEY` | 管理员已创建的命名空间 |
| `DSH_MYSQL_PASSWORD` | `passwordRef` 使用的凭据引用；秘密值保留在补丁之外 |
| `DSH_HOME` | Profile 配置与其余本地应用数据 |

模型凭据和地址仍独立配置。改变 Session 持久化不会限制模型、工具或插件联网；[私有化部署指南](enterprise-private-deployment.zh.md)说明这些选择。

<a id="choose-the-patch"></a>
## 选择补丁

将适用的仓库示例保存到经审阅的外部路径。npm CLI 当前的文件清单不包含 `config/examples/`；下列链接是仓库参考资源。

| Profile | 示例 | 应用的选择 |
|---|---|---|
| `headless` 或 `sdk` | [base.cordis.yml](../../../apps/cli/config/examples/mysql-session/base.cordis.yml) | 禁用 `session-persistence-jsonl`；使用既有凭据服务挂载 MySQL 连接与 Session 提供方 |
| `sdk-minimal` | [sdk-minimal.cordis.yml](../../../apps/cli/config/examples/mysql-session/sdk-minimal.cordis.yml) | 禁用 `sessions`；挂载凭据、MySQL 连接与 Session 提供方 |

显式传入该补丁，并放在其他选择持久化的补丁之后。Cordis 会替换目标行的完整 `config`；覆盖地址时必须重新提供其必填字段。继续 Session 时保持相同命名空间。即便外部 Session ID 相同，另一个命名空间也属于独立存储。

两个示例都为既有必需 `agent-loop` 行增加 `sessionPersistence` 依赖。Loader 保留插件的静态依赖。这些示例针对随产品交付的 profile，它们没有额外 `agent-loop.inject` 元数据；自定义 profile 增加该要求时，必须保留自己的元数据依赖。后续补丁也需保留该要求，避免持久化不可用时以纯内存运行。

<a id="run-the-cli-or-sdk"></a>
## 运行 CLI 或 SDK

保存 base 补丁并准备好部署环境后，使用普通启动器：

```sh
dsh --profile headless --patch /absolute/mysql/base.cordis.yml --json "First request"
dsh --profile headless --patch /absolute/mysql/base.cordis.yml --json --session-id <returned-session-id> "Continue"
```

首个 JSON 项包含 Session ID。已存储 ID 不存在时会失败，不会创建替代历史。Headless JSON 是经过限长的运行投影，不是每个原生事件的完整导出。

TypeScript SDK 将有序补丁转发给其相同版本的 `dsh` 依赖。完整 SDK profile 使用 base 补丁：

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

await using harness = new DeepSeekHarness({
  profile: 'sdk', patches: ['/absolute/mysql/base.cordis.yml'],
  dshHome: '/absolute/mysql/home', cwd: '/absolute/workspace',
  provider: 'deepseek-official', model: 'deepseek-v4-pro',
})
const result = await harness.run('Continue', { sessionId: 'my-session' })
console.log(result.finalResponse)
```

先关闭第一个实例，再创建另一个实例恢复同一 Session。提供 TypeScript `env` 时，它会替换子进程的环境，因此该对象必须显式包含所有必需的部署设置。

Python 可以通过公开的 `dsh_bin` 选择普通已构建 JavaScript CLI。此示例使用独立 profile 及其对应补丁：

```py
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(
    dsh_bin="/absolute/dsh/lib/bin.js",
    profile="sdk-minimal", patches=("/absolute/mysql/sdk-minimal.cordis.yml",),
    dsh_home="/absolute/mysql/home", cwd="/absolute/workspace",
    provider="deepseek-official", model="deepseek-v4-pro",
) as harness:
    result = harness.run("Continue", session_id="my-session")
print(result.final_response)
```

JavaScript 载体需要子进程 `PATH` 中存在受支持的 Node.js。Python `env` 将提供的值合并进其进程环境。第一个 Harness 关闭后，第二个 Harness 使用相同命名空间和 Session ID，经原生运行时恢复。两个 SDK 都不提供任意应用 argv；组合仍由 profile 选择与补丁完成。

<a id="inspect-data-and-failures"></a>
## 检查数据与失败

Session header、完整事件文本、追加回执和写入租约位于配置的数据库命名空间。Harness home 仍包含 profile 配置、凭据及其他独立选择的本地资源。既有 JSONL 文件保留原位置；选择命名空间不会迁移它们或办公／工作区数据。

`verify` 拒绝缺失、不兼容或部分迁移的 schema，不写入 DDL 或回执。保留显式依赖时，持久化服务不可用会使必需的 AgentLoop 无法激活。缺凭据验收在创建 MySQL 连接池或原生 Session 前非零退出，模型请求为零。重启前先修正地址、凭据、包安装或命名空间。事务结果未知时保留该状态，重试写入前查询持久回执；持久化回执不授权重复执行外部工具。观察关闭错误日志：Cordis 可能在记录调用方排空失败后，仍成功返回根释放。

<a id="deployment-limits"></a>
## 部署限制

仓库的制品验收通过受控 HTTP/SSE 模型覆盖显式 profile 依赖与三个公开启动路径。成功恢复运行发生在增加必需依赖之前；最终补丁另行通过组合／schema 和缺凭据启动检查，没有重复已成功的恢复运行。这不代表已验证注册表可用性、`dsh plugin` 安装、npm 发行，或 Python wheel／单文件可执行部署。需单独验证所交付制品及目标安装环境。

共享记录会话收集器仍读取 JSONL 文件。SQL 提供方验收不会启用该驱动器、历史导入、数据库代际迁移或协议连接层丢失 COMMIT 的故障覆盖。[提供方限制](../../../packages/session/session-persistence-mysql/README.zh.md#known-limitations-and-deferred-work)保留其余兼容性与持久性约束。
