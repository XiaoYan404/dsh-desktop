---
kind: upgrade-guide
description: "Session 接管、作用域查找、上传、文件预览及终端交付现在要求目标当前可见。"
---

# 授权 Session 接管及 Native 资源

[English](guide.md) | 中文

## 变更

`session.create` 在接管既有 Agent 或激活冷历史前，以及异步准备后检查 `api-session/visible`。隐藏目标返回 `session/not-found`，不泄漏 cwd 或预设详情。工作区挂接遵循同一策略。

办公 Host 拒绝接管其他员工已有归属的会话，包括已审核的空选择。原员工保留访问；无可见性策略的 Host 保留原生新建及接管。Session 格式、写锁及 wire 类型不变。

Agent／Session／Host 上下文查找及两种上传传输在交付或激活目标前检查可见性。上传在存储后复核，授权变化时不签发凭证。解析器撤回后拒绝上传直到替换项登记；始终未配置解析器的原生 Host 保留活动会话上传。已存字节可能保留，但没有新凭证。

Session 作用域文件预览在查找 header 前，以及交付内容、元数据或每条监听帧前检查。更换员工会抑制迟到的读取。策略撤回会取消已持有的授权，并保持读取不可用直到替换项登记；没有策略的原生 Host 保留其文件系统权限。

终端列表及持有在不激活 Agent 的情况下检查 Session 历史授权。跟随者复核每条快照、输出或状态帧。拒绝只释放观察，不终止 shell。未配置策略的原生 Host 保留访问；该策略不划分操作系统账号或浏览器存储。

## 迁移

工作区归档／停止、恢复、置顶／取消及排序执行当前可见性检查，包括锚点和排队预检。结果及跟随帧筛选私有 Session 标识。请同步升级注册表、API Workspace Controller 和办公提供方。既有数据无需转换；自定义策略委托已文档化的 Workspace 瀑布。

1. 将 Host Session Controller、`dsh-client-file-upload` 与员工可见性提供方重新构建，保留既有 Session、附件及工作区目录。
2. 确认本人活动／冷会话的显式 ID 接管；其他员工必须收到 `session/not-found`，且不激活或修改私有历史。
3. 验证原生新建及重复接管。目标不存在时选择已授权目标；写锁争用仍使用 `session/writer-held`。
4. 检查二进制／编码上传及存储期间换员工。拒绝不能签发凭证。重载的解析器必须登记替换项，撤回不能恢复不受限兜底。
5. 将 `dsh-api-workspace-files` 与办公策略同步升级，验证预览和迟到字节被阻止。遇到 `workspace-file/access-unavailable` 时先恢复策略再重试；自定义策略返回并保留已委托的取消生命周期。
6. 将 `dsh-api-terminal-controller` 与办公策略同步升级。Host 调用者等待 `list(sessionId, signal)`，Client wire 参数不变。消费 `retain`／`follow`，以接收迭代中的准入错误。自定义 `terminal/access` 策略委托并保留取消生命周期。遇到 `terminal/access-unavailable` 时先恢复策略再重试。检查换员工后的拒绝及原员工对同一 shell 的重新挂接。
