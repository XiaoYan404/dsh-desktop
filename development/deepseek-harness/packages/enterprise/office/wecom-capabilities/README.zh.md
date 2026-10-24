# 企业微信联调参考

[English](README.md) | 中文

## 概述

当前连接器支持映射本人资料读取和审核文本消息提交，沿用私有认证、令牌轮换、执行账本及提供方发件箱。配置清单不证明客户已连接；本地保留消息回执不证明远端送达、已读、原生待办创建、卡片交互确认或业务完成。

## 目录

- [能力证据](#capability-evidence)
- [官方协议依赖](#primary-protocol-dependency)
- [客户依赖](#customer-dependencies)

<a id="capability-evidence"></a>
## 能力证据

| 能力 | 适配代码 | 协议证据 | 真实客户请求 |
| --- | --- | --- | --- |
| 钉钉本人待办／日程及审核创建／消息 | 保留已有实现 | 继承原官方协议、本地 HTTP 与页面证据 | 缺凭据及应用授权 |
| 企业微信本人资料／文本消息 | 保留已有实现 | 继承原协议、本地 HTTP 与页面证据 | 缺凭据及应用授权 |
| 企业微信原生待办 | 不声明支持 | 需当前官方待办接口正文 | 未联调 |
| 企业微信交互卡片／完成回调 | 不声明支持 | 需官方请求、回调与签名正文 | 未联调 |
| OA v1 | 保留已有实现 | 自有 v1 协议及原本地证据 | 需客户桥接 |
| OA v2 | 独立可选适配器 | 自有 [v2 协议](../oa-bridge-v2/README.zh.md) 及本地 HTTP／存储／材料证据 | 需客户桥接 |

纯[配置就绪辅助函数](../src/wecom-capabilities.ts) 只读取非秘密的配置布尔清单。缺应用身份、凭据引用、员工映射或允许来源时返回 `pending_configuration`；清单完整也只返回 `configured_unverified`，客户连接始终为 false。无论清单如何，待办、卡片、回调均保留明确的官方协议依赖。此函数不探测网络，不接收密钥值。

<a id="primary-protocol-dependency"></a>
## 官方协议依赖

现有实现依据官方[令牌](https://developer.work.weixin.qq.com/document/path/91039)、[成员](https://developer.work.weixin.qq.com/document/path/90196)、[应用消息](https://developer.work.weixin.qq.com/document/path/90236)、[错误码](https://developer.work.weixin.qq.com/document/path/90313) 页面。卡片调查也引用过官方路径 94872、94876、94888，但没有取得当前正文。[保留的获取交接](../../../../.artifacts/enterprise-office/wecom-card-readonly/handoff.json) 已记录仅 SPA 外壳及官方正文读取端点的 HTTP 403，并停止获取；不以镜像固化 schema，不重试该失败端点。本次官方域名检索未取得可用的企业微信卡片／待办正文，因此不编造厂商字段或签名解析器。

当前[钉钉待办能力概览](https://open.dingtalk.com/document/orgapp/dingtalk-todo-task-overview) 列出原生待办操作。它属于概览，不等同重新逐字段验证原请求。原绿套件不为刷新证据复跑，消息不能改称待办；配置就绪检查不向客户发送新消息。

<a id="customer-dependencies"></a>
## 客户依赖

需提供真实租户／应用身份及凭据引用、授权范围、网络／TLS 规则、已核对且互不冲突的员工映射。原生待办／卡片还需当前官方请求／响应字段、限制、能力准入及权威原结果查询方式。完成回调需客户实际端点配置、签名／加密规则、密钥轮换、重放窗口、事件标识／顺序、当前员工与业务权限及有审计的状态迁移规则。按钮确认本身不构成业务审批。未知原写入持续阻断重发，直到取得权威原结果恢复依据。
