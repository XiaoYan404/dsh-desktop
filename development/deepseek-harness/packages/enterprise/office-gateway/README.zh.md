---
description: "通过一个集中办公服务，处理经过认证的员工工作、日历、私聊和网盘请求。"
kind: "package-reference"
---

# @deepseek-ai/dsh-enterprise-office-gateway

[English](README.md) | 中文

## 概述

员工登录同一个企业办公服务，本人的 Harness Host 继续保留模型、会话、原生工具和设置。网关只接收办公操作及本人账号管理请求，将业务操作者绑定到持久会话，并在排队写入执行前再次验证。管理员可开通员工密码，员工可管理本人密码和设备会话。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

先配置[办公服务](../office/README.zh.md)和凭据提供者，再挂载本网关。[示例组合](example/office.cordis.example.yml)只加载凭据、存储和办公插件。构建仓库，将配置复制到部署目录，通过 `OFFICE_BOOTSTRAP_PASSWORD` 凭据引用提供 15–1024 字符的首次密码。在仓库根目录执行 `node packages/enterprise/office-gateway/example/server.mjs --config <absolute-config-path>` 启动。相对数据路径以进程工作目录为基准。密码只初始化一次，后续修改启动秘密不会重置已有凭据。初始管理员在“团队”创建员工，并在那里设置登录密码。

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 仅办公业务的绑定地址 |
| `port` | `3082` | 监听端口；零表示由操作系统分配 |
| `ephemeralPortAttempts` | `16` | Fetch 可访问的自动候选端口数；1–64，显式端口只绑定一次 |
| `administratorId` | 必填 | 首次初始化使用的已有管理员 |
| `initialPasswordRef` | 无 | 首次初始化前必须提供的凭据引用 |
| `loginRequestsPerMinute` | `20` | 每个来源地址每分钟分别计算的登录尝试和首次密码邀请尝试预算 |

每位员工的 `ui-office` 条目配置 `gatewayUrl`，同时将 `principalId` 设为空字符串，并保持本地 `enterprise-office` 条目停用。本机原生凭据提供者保管集中令牌，浏览器只收到脱敏连接状态。远程网关 URL 要求 HTTPS，本机部署支持回环 HTTP。远程部署请通过 TLS 反向代理提供集中监听器。[UI 包](../../client/ui-office/README.zh.md)保存员工端覆盖配置示例。

办公服务显式开启 `memberInvites` 上限后，管理员可为没有密码的已有启用成员签发有限期邀请码，复制后自行私下交付。网关不向外发送邀请。`GET /health` 仅增加可选安全能力 `memberInvites: { protocol: 1, maxTtlMs }`；功能关闭及旧网关均省略此字段。员工 Host 独立发现此固定端点，不串入原连接和登录流程，因此能力缺失或查询失败不妨碍已有登录。

`POST /v1/invitations/accept` 是固定的预登录端点，仅接受 `{ code, newPassword }`。它沿用原浏览器 Origin 拒绝、未压缩 JSON 校验、8 KiB 请求体上限及全局请求预算。其独立来源尝试计数器使用 `loginRequestsPerMinute`，与登录尝试分别计数。成功返回 `{ ok: true, value: { memberId } }`，不返回 bearer 令牌、cookie，也不自动登录。重放不能重设已有凭据。管理员通过原经过认证、明确白名单的 RPC 端点调用 `memberInvite`、`issueMemberInvite` 和 `revokeMemberInvite`；调用者不能另选操作者。邀请码仅在首次签发响应出现，精确签发重试只返回元数据。备份邀请及凭据数据时遵循[办公恢复约束](../office/README.zh.md#use-this-package)。

<a id="understand-the-implementation"></a>
## 理解实现

自动端口分配使用原生 Web 载体共用的 HTTP 监听帮助函数。Fetch 禁用的候选在下次绑定前关闭，耗尽 `ephemeralPortAttempts` 时拒绝启动，所有候选均已关闭。显式端口保留配置值，绑定／关闭错误立即上抛。网关保留独立监听器、请求处理器和认证，共用分配逻辑不会暴露原生 Host 路由。

监听器提供健康、登录／退出、当前身份、本人会话／密码及一个版本化办公请求端点。请求校验器明确列出支持的办公方法及参数 schema，不提供通用 Cordis、原生文件、终端、模型、插件或工具执行端点。带浏览器来源的请求会被拒绝，由经过认证的员工 Host 发起服务间请求。授权不接受调用者自报操作者或角色，并在共享办公写入队列中重新检查当前成员权限和会话有效性。

请求限制 JSON 大小，设置有限的请求头／请求超时和来源请求预算。响应禁止缓存，失败仅返回稳定拒绝码，不包含原始存储错误或秘密。目前每个来源地址每分钟最多 300 个请求，预算表最多 4096 项；普通账号请求体最多 8 KiB，办公上传请求体最多 12 MiB。原整请求路径保留单文件 8 MiB 限制，可续传分块使用分别声明的边界。卸载时关闭归属监听器并等待已受理处理器结束。已有办公身份会话在服务重启后继续保留。

<a id="further-exploration"></a>
## 进一步探索

- [办公授权与持久化](../office/README.zh.md)。
- [员工工作台与登录](../../client/ui-office/README.zh.md)。
- [子系统 API](../../../docs/subsystems/enterprise-office.zh.md)。
- [真实 HTTP 验收](tests/http.spec.ts)。
- [首次密码邀请 HTTP 测试](tests/member-invitations.spec.ts)。

<a id="model-experience"></a>
## 模型体验

### 办公认证

#### 模型看到什么

网关不注册模型工具，也不增加 `Session` 上下文。密码、令牌回执和凭据引用不会作为模型输入。

#### Token 影响

不直接消耗模型 token。

#### KV Cache 影响

不改变模型请求历史或可复用前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- 当前身份提供者采用管理员管理的员工密码，SSO、目录同步和多因素认证继续待办。
- 一个集中办公进程负责配置的领域。多个写者共享 JSON 文件不能提供事务或高可用。
- 部署代理负责 TLS 终止。来源预算使用实际 socket 对端，不信任转发地址头，因此代理会共享该预算，部署时需设置合适限制。
- 员工 UI 可见时每五秒轮询。推送及大历史分页继续待办；Host 客户端限制单个响应为 16 MiB。

<a id="dev-note"></a>
### 开发备注

源码示例从已构建仓库启动，并等待异步挂载的子插件就绪后才报告实际监听地址。正式安装需要提供配置中列出的每个插件，网关不安装依赖，也不修改员工配置档案。独立 Node 进程检查覆盖凭据引用初始化以及重启后的密码／会话恢复。
