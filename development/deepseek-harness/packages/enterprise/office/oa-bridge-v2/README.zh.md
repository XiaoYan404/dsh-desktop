# OA bridge v2 参考

[English](README.md) | 中文

## 概述

`oa-bridge-v2` 是供客户桥接服务实现的本项目自有协议，与 [v1](../oa-bridge/README.zh.md) 独立选择。它实现已声明的审批查询、材料要求、状态快照、审核提交、补充、撤回及同意／拒绝请求，不代表任何厂商接口，也不证明客户已连接。省略 `oaV2` 时保持关闭；启用提供方仍需当前允许的来源、私有凭据别名及 `v2/health` 探测配置。

## 目录

- [配置](#configuration)
- [HTTP 操作](#http-operations)
- [材料](#materials)
- [受理与恢复](#acceptance-and-recovery)
- [已知限制](#known-limitations)

<a id="configuration"></a>
## 配置

`members` 将 Office 员工映射到互不重复且精确匹配的桥接主体。每项 `actions` 包含普通角色准入的 `declaration`、固定 `scope`、显式 `materials` 布尔值及一种操作：`approvals`、`requirements`、`status`、`submit`、`supplement`、`withdraw`、`approve` 或 `reject`。前三种必须声明为读取，其余为写入。员工和模型不能指定 URL、方法、凭据、主体、操作类别或业务范围。除首次提交外，写入必须声明并审核 `approval_id` 与正安全整数文本 `expected_revision`。桥接服务必须检查上游当前归属、审批资格、流程迁移和版本冲突；Office 管理员身份不提供业务审批越权能力。

沿用现有目录、超时、完整响应、结果和条目限制。`maxMaterialBytes` 必须显式设置，所有附件合计不超过 16 MiB。启用材料的动作必须声明 `materials` 字段，且只能选择 `submit` 或 `supplement`。没有当前授权的不可变版本读取器时，不允许声明材料能力。[适配器](../src/oa-v2.ts) 在请求前验证配置；[材料读取器](../src/oa-materials.ts) 在 Office 原队列内复用已有网盘授权和对象读取器，禁止在适配器内递归调用公开的排队网盘方法。

<a id="http-operations"></a>
## HTTP 操作

所有路径保留已配置的基路径；请求不跟随跳转、不内部重试。`X-OA-Actor` 是映射主体的一次百分号编码值；认证使用已有 Host 凭据头。凭据别名不能提供保留的主体、动作或幂等头。

| 操作 | 固定请求 |
| --- | --- |
| 健康检查 | `GET v2/health`；准确响应 `{"protocol":2}` |
| 已声明读取 | `GET v2/actions/{actionId}/read`，`X-OA-Actor` |
| 审核写入 | `POST v2/actions/{actionId}/submit`，`X-OA-Actor`、`Idempotency-Key` |
| 原结果核查 | `GET v2/executions/{executionId}`，`X-OA-Actor`、`X-OA-Action` |

读取响应准确包含 `protocol: 2`、匹配的 `actor`、`action`、`scope`、`operation`、ISO `observedAt` 及 `approvals`。每项审批包含 `id`、正整数 `revision`、`state` 及受限的材料要求文本列表 `requirements`。状态为 `pending`、`needs_materials`、`approved`、`rejected`、`withdrawn`。重复标识或超限的完整展示被拒绝。这些是观察到的业务状态，与不可变提交回执分开；原有显式读取同步可保存快照。

写入正文准确包含 `protocol: 2`、映射 `actor`、声明的 `action`、固定 `operation` 与 `scope`、原始 `executionId`、准确审核的 `values` 及显式 `attachments`。`Idempotency-Key` 等于服务端执行 UUID，不是业务审批编号。非首次提交动作在 `values` 中包含已审核的 `approval_id` 和 `expected_revision`。

提交与原结果响应包含匹配的 `protocol`、`actor`、`action`、`scope`、`operation`、`executionId` 及 `outcome`。受理结果为 `{"status":"succeeded","acceptance":"accepted","reference":"OA-1"}`；其他结果为 `{"status":"unknown"}` 或 `{"status":"rejected","rejection":"not_accepted"}`，后者原因也允许 `denied`、`unauthorized`、`rate_limited`、`invalid_input`。明确拒绝表示上游未受理，不代表后续业务审批被拒。未知字段或坐标不匹配均不能确认结果。

<a id="materials"></a>
## 材料

审核字段 `materials` 是最多 20 个不同 `{id, version, sha256}` 不可变网盘引用组成的严格 JSON 列表。它是声明的业务字段，不是任意传输 JSON。每项按当前员工及祖先权限解析，读取器检查准确版本和摘要、验证真实字节，并在每次异步分块后及提交前再次授权。没有路径或调用者提供的附件 URL。适配器从普通 `values` 移除此引用字段，将验证后的附件准确发送为 `{id, version, sha256, name, mediaType, contentBase64}`。桥接服务必须将准确元数据和字节绑定到原执行键。

<a id="acceptance-and-recovery"></a>
## 受理与恢复

原 Office 执行账本先预留并持久记录派发，再调用适配器。执行成功表示操作受理证据；包括请求 `approve` 后，也必须另查审批状态。它不证明送达、支付或模型执行完成。业务 POST 的网络错误、非 2xx 或模糊回执均保持未知。恢复仅用当前凭据和原配置连接 GET 原 UUID，不重新上传附件、不重放业务 POST，查询无记录不授权重试。

客户桥接必须在上游副作用前，将 UUID、主体、动作、范围、操作类别、准确字段和附件持久绑定；跨重启和凭据轮换保留权威结果，并自行实施版本与权限规则。数据库提交回执不证明第三方副作用恰好一次。预检或结果存储失败可保守保留未知；页面指引员工核查原执行。

<a id="known-limitations"></a>
## 已知限制

本协议通过真实 Loader、回环 HTTP、Office 上传及 JSON 存储进行本地验证。客户／厂商认证、地址、授权范围、真实员工映射、上游幂等与恢复仍需联调。自动审批状态订阅需要已认证来源及读取同步策略；v2 不包含厂商回调解析器或自主轮询计时器。v1 数据和 Session 格式保持原样。
