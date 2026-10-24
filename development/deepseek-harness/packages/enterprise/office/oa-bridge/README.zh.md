# OA 桥接 v1 参考

[English](README.md) | 中文

<a id="summary"></a>
## 概述

查询已配置的审批记录和材料要求，提交审核后的文本字段，并按原服务端执行标识恢复结果不确定的提交。这是由客户在 OA 系统前实现的 DeepSeek Harness 桥接协议，不描述现成厂商 API，也不表示客户系统已经连接。省略 `oa` 配置时不启用提供方。

<a id="contents"></a>
## 目录

- [部署配置](#deployment-configuration)
- [HTTP 协议](#http-protocol)
- [持久化与恢复](#durability-and-recovery)
- [材料与审批进度](#materials-and-approval-progress)
- [客户联调](#customer-commissioning)

<a id="deployment-configuration"></a>
## 部署配置

办公服务端的可选 `oa` 配置包含 `members` 和 `actions`：前者将办公员工编号映射到不同的桥接主体字符串，后者使用既有 `OfficeConnectorActionDeclaration` 字段。主体准确匹配、区分大小写且不做规范化；字符串必须为合法 Unicode，不含控制字符，具有非空白内容，长度为 1–256 个 UTF-16 码元。未映射员工不请求桥接服务。每个动作明确声明允许的办公角色，管理员没有角色绕过权限。注册时冻结元数据和字段，并应用既有动作数量及字节上限。

本例声明本地联调字段，不代表客户 OA 表单。将其放入办公插件已有的部署配置，并保留该部署的通讯录、存储和其他设置。

```yaml
connectorAllowedOrigins: ['http://127.0.0.1:48080']
connectorCredentials:
  oa-key: COMPANY_OA_TOKEN
oa:
  members:
    lin: oa-lin
  actions:
    - id: my-approvals
      label: My approvals
      description: Read the mapped actor's configured approval scope.
      kind: read
      allowedRoles: [employee]
    - id: submit-request
      label: Submit request
      description: Submit reviewed text; acceptance does not mean approval.
      kind: write
      allowedRoles: [employee]
      fields:
        - name: title
          label: Title
          required: true
          maxLength: 200
        - name: reason
          label: Reason
          required: false
          maxLength: 4000
```

`COMPANY_OA_TOKEN` 是 Host 凭据引用名称，不是秘密值。登记公司集成后，使用既有管理员连接表单保存适配器 `oa-bridge-v1`、基础 URL `http://127.0.0.1:48080/oa/`、检查路径 `v1/health` 及已声明的凭据别名。产品不附带或自动启动本例服务。生产来源、路径、凭据和授权须由部署所有者提供。保存配置或读取动作目录不请求桥接服务。[连接所有者说明](../README.zh.md#company-connections)定义规范来源、凭据解析、版本、期限和当前会话授权。

员工和模型只能选择已声明动作标识及审核版本，不能覆盖基础 URL、HTTP 方法、私有请求头、映射主体或凭据。写字段使用不重复的已声明名称及原样文本，每次最多 32 个字段，每值最多 4,000 个 UTF-16 码元；声明可以设置更小上限。读取不接受调用者提供的业务参数。不得把 URL、任意 JSON 请求或另一员工身份作为传输指令编码进字段。

<a id="http-protocol"></a>
## HTTP 协议

以下路径均相对已保存的基础 URL 解析，并保留基础路径。请求接受 JSON，不跟随重定向，也不内部重试。响应必须为完整、有界的 UTF-8 JSON，且仅含文档定义字段。应用既有响应、条目和完整结果上限；超大、格式错误及额外字段均被拒绝。`summary` 和值是最多 4,000 个 UTF-16 码元的纯文本，每个非空标签最多 200 个码元。远端标记和诊断文本不能作为可执行指令。

| 操作 | 方法及固定相对路径 | 上下文 |
|---|---|---|
| 健康检查 | `GET v1/health` | 既有私有凭据头，不带主体 |
| 声明读取 | `GET v1/actions/{actionId}/read` | `X-OA-Actor` |
| 审核提交 | `POST v1/actions/{actionId}/submit` | `X-OA-Actor`、`Idempotency-Key`、JSON 正文 |
| 原结果 | `GET v1/executions/{executionId}` | `X-OA-Actor`、`X-OA-Action`，不带业务正文 |

`actionId` 为已注册动作标识。`executionId` 为办公服务端 UUID，不是员工重试 UUID 或 OA 业务单号。`X-OA-Actor` 是使用 `encodeURIComponent` 编码一次的 UTF-8 主体字符串，桥接服务解码一次；响应的 `actor` 使用原 Unicode 字符串。`X-OA-Action` 包含已声明写动作标识。认证沿用既有私有连接配置；若凭据别名使用 `X-OA-Actor`、`X-OA-Action` 或 `Idempotency-Key` 请求头，则在任何请求前拒绝。桥接服务必须认证请求并执行该主体的上游访问控制；请求头本身不构成主体认证。

健康检查返回 HTTP 2xx，且仅含：

```json
{"protocol":1}
```

声明读取返回 HTTP 2xx，并准确回显映射主体和动作。`data` 使用既有有界业务结果字段：

```json
{"protocol":1,"actor":"oa-lin","action":"my-approvals","data":{"summary":"Approvals observed now.","entries":[{"label":"Status","value":"Pending approval"}]}}
```

提交发送以下固定 JSON 正文，并携带等于 `executionId` 的 `Idempotency-Key`。执行标识和主体均不来自审核的业务值：

```json
{"protocol":1,"actor":"oa-lin","action":"submit-request","executionId":"00000000-0000-4000-8000-000000000001","values":{"title":"Reviewed purchase","reason":"Verified material summary"}}
```

提交和原结果查询共用严格的 HTTP 2xx 响应。确认受理需要三项坐标均与请求相同，并具有持久化的权威结果：

```json
{"protocol":1,"actor":"oa-lin","action":"submit-request","executionId":"00000000-0000-4000-8000-000000000001","outcome":{"status":"succeeded","result":{"summary":"Submission accepted; approval is pending.","entries":[{"label":"Request","value":"OA-LOCAL-1"}]}}}
```

其他允许的 `outcome` 值为 `{"status":"unknown"}` 或 `{"status":"rejected","rejection":"not_accepted"}`。拒绝结果也可使用 `denied`、`unauthorized`、`rate_limited` 或 `invalid_input`。只有桥接服务保证本次提交未被受理时，拒绝结果才具有权威性；它不表示后续业务审批被驳回。额外属性、缺失坐标、另一主体／动作／执行标识或非 1 的协议号，均不能确认成功或拒绝。

读取的 HTTP 401/403、429 和其他非 2xx 响应分别保留未授权、限流和 HTTP 失败状态。业务 POST 响应丢失或任何非 2xx 响应均保持未知，包括 401、429 和重定向。结果查询失败、HTTP 404、含糊匹配及主体映射变化同样保持未知。远端原始错误正文不返回员工或模型。

<a id="durability-and-recovery"></a>
## 持久化与恢复

既有办公执行所有者先提交预留，再提交 `dispatched`，之后才调用桥接服务。员工准确重试返回原执行；相同内容的未解决提交不能通过新重试 UUID 绕过。预留失败不发送请求。派发持久化后，响应丢失或重启均不授权另一次 POST。结果仅在办公回执持久化后才作为已确认结果显示。

客户桥接服务必须在任何上游业务副作用前，持久预留每个执行 UUID，并绑定准确主体、动作及原样文本值，忽略字段顺序。UUID 在桥接服务稳定的执行命名空间内跨主体和动作保持归属。同一标识及输入返回保留的原结果，不再次向上游提交；同一标识改变绑定时产生冲突。返回已确认结果前，须持久保存权威受理／未受理证据。上游结果含糊时保持未知，不能自动重新提交。原标识证据至少保留到办公执行保留期结束，并在桥接重启及凭据轮换时保留。无法满足这些要求的桥接服务不得声明提交支持。

员工在既有执行历史页明确核查未知提交。适配器只使用当前映射主体、动作和即时解析的凭据，按原执行 UUID 发送 GET，不发送业务值。只有匹配的权威结果才能结束回执。办公结果写入失败时，可再次明确 GET 恢复。已保存连接变化时，返回既有 `connection_changed` 状态，不查询替换位置。提供方不可用或授权撤销不删除原证据，也不授予重试权限。备份需同时包含既有执行、连接、集成及员工领域；本适配器不增加独立持久领域。

<a id="materials-and-approval-progress"></a>
## 材料与审批进度

既有审批材料模板及已选择的公司文件读取器用于整理带来源的说明和缺失材料清单。提交仅传输已审核的声明文本值，不隐式上传文件字节、路径、网盘引用或任意 JSON。桥接服务负责固定业务字段含义，包括已配置的表单范围；模型生成的文本不能选择另一端点或执行命令。

`succeeded` 只确认提交受理证据，不代表审批或付款。终态执行回执不可变，也不持续轮询。为本人的材料要求和审批进度分别声明读取动作，再使用既有显式读取同步和历史快照。这些读取不接受任意单号、筛选条件或员工参数。实时审批决定、补充／撤回操作、附件、回调和自动同步均不属于桥接 v1。

<a id="customer-commissioning"></a>
## 客户联调

真实客户连接需要提供桥接部署，并核实上游 OA 规范。本适配器不预设客户地址、凭据或授权约定。需要约定并验证：

- OA 产品／版本、测试及生产地址、应用权限、认证／令牌／签名要求及网络／TLS 策略。
- 准确员工／租户映射、主体归属和权限、允许表单、字段类型、金额／币种精度及材料要求。
- 持久幂等范围及保留期、原标识查询、权威未受理证据、不确定上游结果恢复及备份／恢复行为。
- 实际查询、审核取消零提交、一次受理提交、明确拒绝、响应丢失、桥接／办公重启、凭据轮换及跨员工拒绝。
- 后续附件、补充、审批决定或回调工作各自的授权、签名、去重及顺序规则。

[适配器源码](../src/oa.ts)负责固定协议处理；[定向真实 HTTP 及存储场景](../tests/oa.spec.ts)在本地验证本产品协议，不验证客户 OA 实现或应用权限。
