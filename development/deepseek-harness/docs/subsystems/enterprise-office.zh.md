# 员工办公领域

[English](enterprise-office.md) | 中文

可选的[办公服务](../../packages/enterprise/office/README.zh.md)拥有员工事项。[办公 UI](../../packages/client/ui-office/README.zh.md)将已认证的单个本机 Host 适配到此服务。Agent 会话和定时任务继续使用各自的存储与执行机制。

员工 Host 向受信任消费方提供 `ctx.officeController`。`OfficeOutcome<T>` 返回 `{ ok: true, value: T }` 或预期业务拒绝 `{ ok: false, code: OfficeErrorCode }`；非预期基础设施故障会抛出。`OfficeConnection` 报告本机或网关模式、连接状态及已认证员工，不含会话令牌。请求不能选择操作者。按需启用的[原生工作工具](../../packages/enterprise/tool-office/README.zh.md)使用这个 BFF，办公服务继续负责授权。

可选的 `OfficeView.calendarTime` 提供 `OfficeCalendarTimeView`：同一次服务器 `checkedAt` 观测，以及原本获准读取的活动和保留事项时间判断。`OfficeCalendarItemTime` 将 `OfficeItemId` 关联到工作截止与逾期标记、会议开始／结束瞬间与阶段，或安全的 `unresolved` 标记。这些派生字段不改变持久化数据或状态。[服务参考](../../packages/enterprise/office/README.zh.md#use-this-package)定义公司时间及失败规则；客户端展示判断而不使用自己的时钟，字段缺失时保留原有界面。

## 身份与授权

可选的 `OfficeMemberInviteConfig` 启用有容量边界的首次密码邀请。`OfficeMemberInviteId` 标识服务端签发的邀请码，`OfficeMemberInviteView` 携带安全的审核状态，只有首次 `OfficeMemberInviteIssueReceipt` 返回原始邀请码。独立的 `enterprise_office_member_invites` 第 1 版领域保留修订号及仅含摘要的签发／撤销记录。接受邀请只在原身份领域提交首次凭据；已有凭据使所有邀请失效。恢复时必须使用组织目录、身份及邀请账本的一致快照，恢复旧身份可能使邀请码重新具备使用资格。此领域不改变原生 Session 格式。[服务参考](../../packages/enterprise/office/README.zh.md)定义签发、复核和恢复。

`OfficeReminderConfig` 通过有边界的轮询间隔、补投窗口及保留台账条数／字节上限显式启用中央提醒。`OfficeReminderId` 是服务端为单个接收人的一次发生生成的 UUID。`OfficeReminder` 包含接收人、事项、`work_due` 或 `meeting_start` 类型、发生和投递时间、个人已读状态及当前有权查看的 `itemTitle`；标题不保存在提醒台账中。可选的 `OfficeView.reminders` 仅在配置启用后返回协议 1 的 `OfficeRemindersView`。`markReminderRead` 在共用办公队列中重新检查当前接收人及事项资格。独立的 `enterprise_office_reminders` 第 1 版领域保留发生身份及已读状态，既有业务通知和原生 Session 格式保持原结构。[服务参考](../../packages/enterprise/office/README.zh.md)规定投递、容量及关闭规则。

办公输入手势在原生发送前准备私有选择元数据；空白第一版选择记录明确办公意图，不添加能力。`OfficeController.prepareNativeInput` 检查原生可见性，在独立提示词之前绑定员工 Host 生命周期内的归属限制。原生准备检查该限制，并在首个办公快照接纳前复查员工身份。现有格式快照提供持久归属，保护后续读取与其他操作。原生工作区手势保持原路径，单纯启用覆盖层不会认领原生历史。准备与快照均不授予执行权限。

`OfficeDriveId` 标识企业元数据，不是本机路径。`OfficeDriveQuery` 选择私有或共享位置及名称查询，`OfficeDriveView` 返回可见条目、面包屑及创建权限。私有根目录仅属于该员工，其他调用者即使是管理员也不能查看。共享根目录仅管理员可创建内容；共享条目所有者通过 `OfficeDrivePermissionsInput` 设置继承、默认及账号条件。编辑个人部门或岗位不授予权限。每个祖先均可见后，子条目的显式授权或所有权才生效。重命名要求条目和父目录均可编辑。`enterprise_office_drive` 第 1 版原子提交目录及审计，过期版本、非法名称和写入失败均不发布变更。

`OfficeDriveUploadInput` 携带有大小边界的编码字节、声明大小和重试 UUID。不可变文件对象在 `DSH_HOME/office/drive/v1/objects` 下完成 fsync 后，才发布目录元数据。`OfficeDriveDownload` 只包含当前有权访问的文件经校验的大小、SHA-256 和字节。逻辑路径不会转换成本机路径。资源管理器按服务端声明的能力选择传输 API。备份包含元数据和不可变对象；旧整请求失败可能遗留可续传台账以外的不可达对象。

`OfficeMemberId`、`OfficeItemId` 和 `OfficeNotificationId` 是彼此独立的品牌身份。`OfficeProfile` 包含公开联系信息，`OfficeMember` 增加身份、`OfficeRole` 和启用状态。角色为 employee、manager 或 admin。编辑资料不能改变权限。受信任适配器提供操作者；排队写入执行时，服务会再次检查成员是否启用。当前 UI 使用部署方分配的本机身份，尚未提供企业 SSO。

`OfficeLoginInput` 接收员工编号和密码，不接受调用者自报角色。受信任的后端适配器一次性收到 `OfficeLoginResult`，保管其中的秘密令牌，仅向 UI 返回已认证成员。`OfficeSessionId` 和 `OfficeSessionInfo` 标识员工本人的会话，本身不授予权限。`OfficePasswordChangeInput` 要求当前密码，替换后撤销全部旧令牌。仅管理员可读的 `OfficeIdentityOverview` 只报告开通情况，不含凭据值。独立的第 1 版身份领域保存加盐密码摘要、会话哈希和脱敏审计，与成员变更共用写入队列。身份数据损坏或通讯录丢失时拒绝启动。可选的[集中网关](../../packages/enterprise/office-gateway/README.zh.md)提供明确的办公操作白名单，认证实际会话令牌，并重新检查排队请求。员工 Host 通过原生凭据提供者保管令牌，仅向登录／账号 UI 返回脱敏连接状态；原生 Agent 能力继续保留在本机。SSO 仍待实现。

`OfficeAuditQuery` 按有上限的精确条件筛选七类 `OfficeAuditSource` 历史，并携带排他的 `OfficeAuditCursor`。`OfficeAuditPage` 返回独立复制的 `OfficeAuditRecord` 元数据、当前保留记录的匹配总数及更早续读位置；`OfficeAuditExport` 将一批记录编码为 NDJSON。每次请求重新检查当前启用管理员权限，仅复制来源、修订号、操作者、操作、目标和时间。`request_denial` 来源还可带有白名单内的 `denialCode`，原六类来源保留准确原字段。[服务参考](../../packages/enterprise/office/README.zh.md#use-this-package)规定筛选、排序和保留限制。

`OfficeRunHistoryState` 是仅供 Host 使用的折叠状态，包含可空的员工／角色归属、`mixed` 和 `invalid` 限制及可选 `inherited: true`、`pendingRole: true` 标记。子会话自身的必读继承记录设置 `inherited`，后续输入保留它。`pendingRole` 标记首次排队角色，直到输入被认领或已证实继承确定角色。归属缓存状态版本 3 会重建旧检查点。`OfficeRunInheritance` 保留父标识、归属和限制，不形成模型可见内容。[员工 Host 参考](../../packages/client/ui-office/README.zh.md#understand-the-implementation) 负责说明旧目录恢复及缺失证据的限制。

`OfficeRequestDenialScope` 将四种服务端选定修改之一绑定到已校验的成员、事项或网盘目标。`withSession` 在请求受理前捕获认证员工，`executeOfficeRequest` 登记已解析操作，不接收操作者字段。共用队列将指定的类型化拒绝保留到独立的 `enterprise_office_request_denials` 第 1 版领域，直接等待有容量边界的写入完成后才返回拒绝。既有队列排空同时负责拒绝审计写入。不发布业务成功，审计持久性未确认时返回安全的不可用响应。[服务参考](../../packages/enterprise/office/README.zh.md#use-this-package)规定纳入错误、容量、备份及独立于管理员检索的限制。既有业务及原生 Session 格式不变。

## 可续传网盘协议

可选的 `OfficeDriveView.transfers` 字段声明 `OfficeDriveTransferLimits`：第 1 版协议、文件大小、员工共用额度、新票据分块大小、未完成数量和有效期。原整请求边界保留独立字段。`OfficeDriveUploadId` 是服务端不透明票据身份。`OfficeDriveUploadDeclaration` 固定逻辑目标、名称、字节数、媒体类型、SHA-256 和重试 UUID；`OfficeDriveUploadChunkInput` 携带一段有边界的规范分块及其位置、摘要。`OfficeDriveUploadTicket` 仅暴露所有者的声明、回执位置、已确认字节数、协商分块大小、时间、状态和结果文件身份。

独立的 `enterprise_office_uploads` 第 1 版领域与网盘目录共用成员及会话串行边界。每次暂存或发布尝试都重新检查目标授权与额度。相同分块重试复用不可变字节，发布目录前校验完整文件。目录提交后回执失败可被重新核对，不创建第二个文件。取消先保存终态决定，已发布对象继续保留引用。过期及终态保留策略在启动、上传操作和配置的计时器中回收所属暂存内容。清理失败保留记录供重试，未发布且已过期的暂存内容在清理成功前继续占用预留额度。原办公及网盘结构不变。

`OfficeDriveDownloadInfo` 在完整对象校验后返回已检查元数据和 `OfficeDriveVersionId`。`OfficeDriveRangeInput` 将一段有边界字节固定到该不可变版本。每段读取重新检查当前成员和全部祖先，`OfficeDriveDownloadRange` 返回字节及分段摘要。客户端在保存前校验完整摘要。已有整请求上传对象使用同一不可变对象目录，也可通过该协议读取。

<a id="drive-versions-and-recovery"></a>
## 网盘版本与恢复

`OfficeDriveView.cleanup: 1` 表明服务支持永久清理。可选 `OfficeDriveQuota` 返回当前员工的 `usedBytes`、`reservedBytes` 和 `limitBytes`。`OfficeDrivePurgePlan` 包含审核过的删除条目、范围摘要及文件／文件夹／版本／字节总数。`OfficeDrivePurgeInput` 绑定条目标识、修订号、摘要及品牌类型 `OfficeDrivePurgeRequestId`。`OfficeDrivePurgeReceipt` 保留根标识、请求标识、待完成／已完成状态、申请／完成时间及相同总数。回收站条目提供 `canPurge` 和可选回执。待完成授权禁止恢复并继续占用额度；完成后该根条目不再列入回收站。授权及恢复规则见[服务契约](../../packages/enterprise/office/README.zh.md#drive-version-history-and-recovery)。

`OfficeDriveView.lifecycle: 1` 表明服务提供版本和回收站方法。`OfficeDriveUploadDeclaration.target` 可将替换绑定到文件标识和审核过的修订号。`OfficeDriveVersion` 包含不可变版本标识、SHA-256、字节数、媒体类型、创建时间、作者及当前版本标志。`OfficeDriveHistory` 将有权访问的条目与新版本在前的列表组合。`OfficeDriveTrashEntry` 为条目元数据增加 `deletedAt`；`OfficeDriveTrash` 包含当前修订号、员工标识和可见删除根条目。`OfficeDriveLifecycleInput` 指定标识、修订号、`trash` 或 `restore` 操作及可选恢复名称。[服务参考](../../packages/enterprise/office/README.zh.md#drive-version-history-and-recovery) 负责说明授权、额度计算及恢复行为。

## 私聊文件

`OfficeChatFilesInput` 在 `OfficeChatInput` 上增加有序的 `OfficeChatFileInput`，包含受限的内联字节。`OfficeChatFileLimits` 返回协议 1、当前员工用量、独立额度、文件／数量／消息上限及恢复有效期。协议限制每条消息解码后文件合计为 8 MiB，网盘续传另行处理。`OfficeChatMessage.attachments` 可选地包含有权查看的 `OfficeChatAttachment` 元数据，包括不透明的 `OfficeChatAttachmentId`、文件名、媒体类型、字节数和 SHA-256。`OfficeChatFileCoordinates` 将下载绑定到保留消息；`OfficeChatFileDownload` 只向启用的参与人提供完整核验后的字节，管理员不能绕过。

独立的 `enterprise_office_chat_files` 第 1 版账本先声明不可变文件标识，再将对象写入 `DSH_HOME/office/chat/v1/objects` 并 fsync。文件就绪后才提交原文字聊天消息头，由消息头决定发布。回执失败时在重试或启动中依据消息头恢复，保留唯一消息及原聊天 schema。过期未发布文件只依据所属账本记录回收，清理失败保留额度。保留的聊天水位在启动或回收前识别原聊天丢失。备份需同时保留原聊天、文件账本及对象。未发送选择使用独立草稿领域。

## 私有文件草稿持久化

`OfficeChatFileDraftInput` 使用稳定重试 UUID 和受限完整文件替换已审核的联系人选择。`OfficeChatFileDraft` 提供版本、不可变元数据及可选的准确待恢复发送。`OfficeChatFileDraftView` 仅包含认证所有者的记录及草稿额度。`OfficeChatFileDraftCoordinates` 和 `OfficeChatFileDraftDownload` 恢复本人当前版本文件，预定接收人和管理员均无草稿读取绕过。空选择保留版本墓碑，过期修改冲突，不覆盖另一个窗口。

`enterprise_office_chat_file_drafts` 第 1 版原子保存规范字节、摘要、版本及发送恢复数据。独立的员工／全公司逻辑额度限制编码后存储单元，既有文本草稿和已发送文件 schema 不变。`OfficeChatFileDraftSendInput` 在通过不可变文件流程发布前固定消息 UUID、联系人版本及准确说明。确认后只清除原选择。启动及重试依据保留的原消息恢复清除失败，旧重试不能清除新选择。草稿事件不含内容，根 Host 卸载等待已接收写入完成。UI 负责保存提示和冲突选择。

可选的 `OfficeChatFileDraft.peer` 提供有权查看的当前联系人，包括本人草稿关联的停用员工。该保留关系允许只读空聊天视图，不开放无关停用联系人。显式空保存只清除审核版本并保留已提交消息，旧的排队草稿发送不能恢复它。降低额度后仍可清除。文件句柄及编码重试内容仅属于 UI 所有者，恢复元数据后可通过 `sendChatFileDraft` 发送，无需先下载全部草稿字节。

## 正式组织

正式组织使用独立的 `enterprise_office_organization` 第 1 版领域。`OfficeUnitId` 和 `OfficePositionId` 标识持久实体，与可编辑的显示标签分离。`OfficeOrganizationUnit` 形成有深度边界的部门层级；`OfficePosition` 可全公司通用或限定部门。`OfficeOrganizationAssignment` 保存带版本的归属，包括显式置空的未分配记录。`OfficeOrganizationView` 向员工展示有权读取的启用层级，向管理员保留停用记录。只有显式配置后，`OfficeView` 才包含这一可选字段，既有输出继续兼容。

管理员先在团队中审核公司、时区与通讯录标签。初始化检查审核过的通讯录修订号；后续 `OfficeUnitInput`、`OfficePositionInput` 和 `OfficeAssignmentInput` 要求实体版本。共用队列重新核查管理员权限。层级环、不兼容岗位、停用仍在使用的实体和过期写入均不发布变更。自助联系资料修改不能改变正式归属或权限。空的 `office/organization-changed` 事件用于重新载入有权视图。存储设施级的消费者排空屏障，既保护单独卸载办公插件，也保护关闭整个 Host 时已经接受的写入。

## 公司系统集成

公司系统清单使用独立的 `enterprise_office_integrations` 第 1 版领域。`OfficeIntegrationManifest` 描述系统，不含连接秘密或代码；`OfficeIntegrationId` 标识持久化的 `OfficeIntegration`。`OfficeIntegrationImportInput` 包含已审核 JSON 与重试 UUID。共用队列核查当前管理员权限，校验 UTF-8 大小和标准化名称唯一性，并在同一次提交中保存目录及导入审计。`OfficeIntegrationView` 通过 `OfficeView` 提供公司目录，空的 `office/integrations-changed` 事件触发重新读取有权视图。员工可以查看登记；导入不会安装插件或建立系统连接。

`OfficeConnectorAuthentication` 选择部署允许的凭据别名。`OfficeConnectorConfiguration` 包含适配器、基础地址、相对探测路径及启用状态；`OfficeConnectorInput` 增加已登记集成、审核版本及重试 UUID。独立的 `enterprise_office_connectors` 第 1 版将保存的配置和审计一起提交，不修改清单或 Session schema。`OfficeConnectorEntry` 投影 `OfficeConnectorStatus`，只有管理员记录含可编辑配置。`OfficeConnectorView` 提供当前适配器，以及仅管理员可见的来源／别名选项。配置就绪与网络结果分别报告。

`OfficeConnectorProbeStatus` 和 `OfficeConnectorProbe` 描述一次经过授权、指定版本的网络检查，不含响应内容或密钥。`OfficeConnectorAdapter`、`OfficeConnectorProbeRequest` 和 `OfficeConnectorProbeResult` 是仅供 Host 使用的扩展类型。适配器接收新解析的私有请求头、中止信号及完整响应上限；所属释放函数中止当前操作并移除可用状态。内置 GET JSON 适配器从不跟随重定向，办公服务负责管理员权限和网络／响应体期限。[包参考](../../packages/enterprise/office/README.zh.md#company-connections)定义配置及失败语义。办公操作不安装原生插件，也不改变 MCP 执行。

`OfficeConnectorActionDeclaration` 在公共 `OfficeConnectorActionView` 的标识、名称、说明和读写类型上增加明确允许的角色。`OfficeConnectorActionsView` 返回单个系统的当前就绪状态、已保存连接版本、进程内适配器版本及角色允许的元数据。登记会冻结声明，并限制完整公共响应的大小。不可用连接不暴露动作；就绪解析期间更换适配器会返回冲突。`OfficeConnectorView.actionCatalog` 声明目录协议及上限。目录不授予执行权限、不解析秘密值，也不发起网络操作。

`OfficeConnectorReadInput` 指定已声明读取动作及准确的已保存连接／提供方版本。`OfficeConnectorActionsView.readSupported` 声明读取实现已安装。`OfficeConnectorReadRequest` 只提供服务端认证的员工身份及获准私有连接输入。`OfficeConnectorReadResult` 和 `OfficeConnectorReadReceipt` 仅在 `status: read` 时包含脱敏的 `OfficeConnectorReadData`，其他网络状态不含数据。共用队列核查当前角色，拒绝写动作及过期提供方，即时解析凭据，并在网络接纳和返回结果前重新验证来源会话。字段数量和完整 UTF-8 回执上限拒绝无效或超限结果。适配器中止采用协作方式，必须停止工作后才结束。查询不产生业务写入、自动重试、持久办公执行历史或模型输入。

`OfficeConnectorWriteInput` 保留准确审核过的动作／连接／提供方坐标、员工重试 UUID、可选原生捕获及有上限的平面文本值。`OfficeConnectorExecutionId` 是独立的服务端生成标识。独立的 `enterprise_office_connector_executions` 第 1 版提交严格有序的 `OfficeConnectorExecutionStage` 证据。`OfficeConnectorExecutionReceipt` 不含输入值，并将 `dispatched` 映射为未知状态。私有回执读取核查当前已认证员工，管理员不绕过归属。内部队列修改预留后续审计／结果空间，在接纳时确定结果上限，不能再次派发可能已发送的操作。[包契约](../../packages/enterprise/office/README.zh.md#external-write-evidence)定义重试、容量及恢复语义。

`OfficeConnectorActionField` 声明具有标签、必填标记及有限长度的唯一文本输入。可选 `OfficeConnectorActionsView.writeSupported` 声明已安装受信任写入器。`OfficeConnectorWriteRequest` 在私有读取输入上增加准确校验值、协商结果字节和用作外部幂等键的服务端执行标识。`OfficeConnectorWriteResult` 仅允许脱敏成功、权威拒绝或未知。队列内 `writeConnectorAction` 协调器核查当前角色、审核版本及可选捕获，先持久派发再调用写入器，先提交回执再返回成功。相同未决业务输入不能通过新的 UUID 重放。`execution_unknown` 报告不确定性，不暴露私有诊断 cause。可选原生消费方增加独立人工写审批，将真实回执追加到原生模型历史；员工表单使用同一协调器，明确的结果核查按原执行身份读取，不重放业务。

`OfficeConnectorExecutionQuery` 选择公司登记及可选的本人末条游标。`OfficeConnectorExecutionPage` 返回有上限、由新到旧的 `OfficeConnectorExecutionSummary` 元数据，不含原输入、结果字段或审计数组。通过 `OfficeConnectorView.executionHistory` 声明的 `OfficeConnectorExecutionLimits` 将每页限制为 20 行及 32 KiB 完整 JSON，详情信封上限为 4 MiB 加 4 KiB。他人和跨系统游标被拒绝，新增提交不改变稳定的更早页锚点。明确的私有详情读取返回保留回执，不执行适配器。员工 UI 在账号、角色、系统及连接变化后拦截晚到的页／详情响应，并区分未知结果与终态成功。

`OfficeConnectorReconcileRequest` 按原执行标识读取已有客户操作，不包含业务值或写派发。`OfficeConnectorExecutionCheck` 返回保留回执及明确的更新／未知／不可用／连接已变状态。`OfficeConnectorExecutionLimits.checks` 可选声明此读取协议。当前角色、原已保存连接及当前核查器注册控制接纳；重新加载提供方不授予查询新地址的权限。继续使用原结果上限，在私有披露前再次核查权限，仅持久权威证据可结束未知操作。员工详情视图明确发起核查、拦截过期响应，不修改原生模型历史。

`OfficeConnectorSyncId` 标识不可变的员工私有读取结果。`OfficeConnectorSyncInput` 在审核读取坐标上增加重试 UUID。`OfficeConnectorSyncSummary` 包含标识、来源坐标、观察／同步时间及实际网络状态。`OfficeConnectorSyncDetail` 增加员工标识、当前可用性及可空的已授权数据。`OfficeConnectorSyncQuery` 选择系统及可选较旧标识；`OfficeConnectorSyncPage` 返回本人元数据及下一锚点。可选 `OfficeConnectorSyncLimits` 经 `OfficeConnectorView.synchronization` 声明协议 1、页面数量及保留条目／字节上限。[服务参考](../../packages/enterprise/office/README.zh.md#synchronized-read-records) 负责说明持久化、当前权限及重试行为。

本机包观察使用 `OfficeIntegrationPlugin` 将部署声明的连接器及包根名称关联到可为空的安装、启用选择和实际 Loader 组件计数。`OfficeIntegrationPlugins` 标识已认证员工、部署模式、管理可用性和关联包。`integrationPlugins` 只读；网关模式报告集中管理范围，不用员工本机清单替代服务端状态。[员工 Host 文档](../../packages/client/ui-office/README.zh.md#local-integration-plugins)拥有配置和原生跳转说明。

显式启用的 `OfficeDingTalkConfig` 提供企业内部应用标识、私有员工到 union-id／日历映射、明确允许的操作及受限的未来日历窗口。注册的 `dingtalk` 连接器消费连接凭据引用，以当前应用凭据认证，并通过既有读取／同步协议只投影映射员工的待办／日程字段。可选的 `create_todo` 沿用已审核的执行回执，将钉钉 `sourceId` 绑定到服务端标识，仅以匹配来源／创建者的 GET 核查。`create_calendar` 固定私有日历、发送 `x-client-token`，不加入参与人或提供未知日程核查。可选适配器 `reconcileActions` 将核查限制到支持的写入标识，不改变旧提供方结果或持久回执。[办公参考](../../packages/enterprise/office/README.zh.md#company-connections)负责部署、第一页限制、不确定结果及客户验收要求。

私有提供方单元 `enterprise_office_dingtalk_messages` 第 1 版在派发前预留原服务端执行标识，并保留脱敏回执。员工／角色及应用／端点／内容指纹约束重放；待确认标记重启后仍为未知。可选 `send_message` 要求显式机器人及员工标识映射，只向该员工提交审核后的 Markdown，并报告异步平台受理。原提供方回执可恢复外层办公回执写盘失败，无需再次请求机器人；缺少平台回执仍为未知。[办公参考](../../packages/enterprise/office/README.zh.md#message-provider-outbox)负责有限容量、通讯录恢复及存储关闭约束。已声明的写入准入独立于提供方预留，承担客户操作授权。

显式启用的 `OfficeWeComConfig` 通过 `corpId`／`agentId`、不区分大小写的员工 `members` 及批准的 `profile` 读取或审核后的 `send_message` 操作标识内部应用。`wecom` 连接器使用当前凭据引用及有界、仅进程内的令牌缓存；资料读取只暴露本人映射的姓名与岗位。消息提交固定收件人和应用，将原样文本限制为 2,048 个 UTF-8 字节，并在派发前将原执行标识预留到私有的 `enterprise_office_wecom_messages` 第 1 版。原提供方结果区分平台受理与送达，并能在不再次请求消息的情况下恢复外层回执失败。各提供方容量独立，共用预留机制保留钉钉单元原身份／schema。[办公参考](../../packages/enterprise/office/README.zh.md#company-connections)负责官方来源、部署、令牌过期／卸载及客户联调说明。

## 私有定制需求

`OfficeCustomizationId` 标识员工自己的需求。`OfficeCustomizationFields` 包含系统或技能名称、联系人及保留原样的多行说明；`OfficeCustomizationInput` 增加审核过的修订号和重试 UUID，新建时标识为空且修订号为零。`OfficeCustomizationRecord` 增加服务端公司、员工、修订号、时间及 `delivery: 'not_sent'`。`OfficeCustomizationSaveReceipt` 返回原提交记录和当前修订号，包括后续编辑后的旧请求重试。员工和管理员均不能读取其他员工的需求。

可选的 `OfficeView.customizations` 声明 `OfficeCustomizationLimits`：协议 1、每页二十条元数据及配置的操作次数／UTF-8 字节上限。`OfficeCustomizationPage` 不含联系人和需求正文。`customizationRequests` 使用员工范围内的排他保存位置；`customizationRequest` 读取本人最新版本；`saveCustomizationRequest` 通过办公共用队列提交。独立的 `enterprise_office_customizations` 第 1 版领域保留不可变保存回执，恢复时要求原员工通讯录。没有操作向外发送；员工页面导出审核过的已保存版本，以便通过认可渠道交付。

## 私有会话关联

`OfficeConversationConnectorInput` 将目录发现限制在员工私有提交捕获中的一个系统。`OfficeConversationConnectorReadInput` 在准确读取坐标上增加该捕获。当前角色、私有选择版本及捕获的连接版本必须一致，原生审批不能绕过这些检查。可选办公工具消费方通过原生工具结果日志记录发现及真实业务结果，办公领域 schema 保持不变。

`OfficeConversationId` 标识同一已认证员工私有选择中的逻辑原生会话，不授予原生历史访问权或执行权。`OfficeToolReference` 指定面向用户的原生技能或办公请求模板。`OfficeConversationLinks` 保留已审核的选择版本，`OfficeConversationLinksInput` 使用重试 UUID 编辑其中一个列表。独立的 `enterprise_office_conversation_links` 第 1 版保存这些草稿，不改变 Session、系统清单或连接 schema。空选择继续保留版本，管理员没有私有选择的读取绕过权限。

`OfficeToolRequirement` 将部署声明的集成登记名称解析为当前编号，并明确列出缺失名称。选择工具时自动加入已登记依赖；显式编辑集成列表可以移除依赖而保留工具。`OfficeConversationLinksView` 包含员工编号、当前草稿、依赖和 `OfficeConversationLinkLimits`。解析到登记记录不表示已连通，也不授予执行权限。共用队列重新检查当前员工／登录会话权限，持久化失败不发布变化。空的 `office/conversation-links-changed` 通知触发有权重新读取。[包参考](../../packages/enterprise/office/README.zh.md#conversation-associations)负责上限和配置说明。

`OfficeConversationCaptureInput` 指定审核版本及提示词重试编号。`OfficeConversationCaptureId` 属于已认证员工的私有空间，不是持有即授权的凭据。`OfficeConversationCapture` 冻结该版本及当时员工角色、声明依赖、摘要和 `OfficeCapturedIntegration` 记录，后者仅包含系统描述元数据及配置就绪状态。独立的 `enterprise_office_conversation_captures` 第 1 版保留准备证据，不改变可编辑选择或原生 Session 历史。后续修改后的准确重试仍恢复原上下文，其他员工及管理员不能读取。记录数量、总字节及单个上下文上限均在失败时保持未发布；准备不记录原生接纳或执行。[包参考](../../packages/enterprise/office/README.zh.md#prepared-contexts)负责保留、字节统计及失败语义。

`OfficeConversationFileReference` 表示服务端确认的不可变网盘元数据。`OfficeConversationFiles` 是当前员工在逻辑原生会话中已审核的选择；`OfficeConversationFilesInput` 仅提交已审核坐标及重试 UUID。独立的 `enterprise_office_conversation_files` 第 1 版领域保存选择与提交资料证据，不修改现有集成／工具关联领域。每个选择最多 20 份不同文件，最多保留 10,000 个选择及 10,000 份快照，领域紧凑 JSON 上限为 64 MiB。

`OfficeConversationFileLimits` 声明提交资料协议及固定文本上限。其可选的 `pdf.maxBytes`、`docx.maxBytes` 与 `xlsx.maxBytes` 能力分别允许引用当前服务输入字节上限内的对应格式；省略某项能力则该格式不可选，不提供这些能力的旧服务继续只允许文本选择。`OfficeConversationFilesView` 在私有选择上增加当前员工编号、角色和上限，不改变持久选择值。`OfficeView` 和 `OfficeConversationLinksView` 上可选的 `conversationFiles` 元数据允许消费方继续使用旧服务的普通功能。员工 Host 在原生接纳前准备类型为 `office-files` 的 `OfficeFilesPromptContextSource`，身份混合、角色变化和取消的准备不会进入接纳。该归属快照进入原上下文日志，可选的 `office_read_file`、`office_read_pdf`、`office_read_docx` 和 `office_read_xlsx` 工具通过普通工具结果提供单独授权的正文。

`OfficeConversationFilesCaptureId` 标识私有提交证据，不是访问凭据。`OfficeConversationFilesCapture` 冻结已审核选择、员工、角色、请求身份及完整性摘要。准备与准确重试都会重新检查当前文件权限和版本。`OfficeConversationFileReadInput` 请求已选文件的受限文本窗口，`OfficeConversationFileRead` 通过 `readConversationFile` 返回校验后的 UTF-8 文本及不可变元数据。每次读取均校验快照归属、当前角色、启用状态、祖先权限、最新版本及 SHA-256。该文本读取器的文件上限为 1 MiB，字符预算上限为 16,384 个 UTF-16 码元；偏移不能截断代理项对，末尾的代理项对补齐后返回下一偏移。二进制、编码错误及越权文本读取不返回正文。这些服务 API 本身不会把上下文附加到原生提交。

`OfficeConversationPdfReadInput` 在提交文件窗口上增加从 1 开始的 `pageNumber`，供独立的 `readConversationPdf` 路径使用。`OfficeConversationPdfRead` 返回已校验的不可变文件元数据、实际页码及文档页数、提取文本，以及页内的 `offset`、`nextOffset`、`totalCharacters` 和 `eof`。连续读取限定在这一页内。每次调用在读取前及返回解析结果前重新核查当前提交文件权限和版本。扫描页可能没有可选文本；该读取器不执行 OCR。加密、损坏、越权及超限 PDF 不返回正文。

`OfficeConversationPdfConfig` 通过 `conversationPdf` 提供输入字节数、文档总页数、单页提取字符数、转义后完整原生工具内容 JSON 字节数、worker 期限及 V8 老年代堆的部署覆盖值。[办公包参考](../../packages/enterprise/office/README.zh.md#prepared-contexts)负责默认值、隔离解析器生命周期、办公队列内末次权限核查及取消行为。解析器不保留完整文档缓存或原生附件副本；真实的有界文本由工具消费者写入原有原生结果日志。

`OfficeConversationDocxReadInput` 使用提交资料快照、已选文件及有界 UTF-16 窗口，供独立的 `readConversationDocx` 路径使用。`OfficeConversationDocxRead` 返回已校验不可变元数据、正文段落／表格数量、实际文本，以及正文相对的 `offset`、`nextOffset`、`totalCharacters` 和 `eof`。制表符分隔按源顺序排列的表格单元格，换行分隔段落和表格行。每次调用在读取前及发布解析结果前重新核查当前提交文件权限和版本。页眉、脚注、批注、绘图、分页及 OCR 不在此读取器范围内；损坏、宏文档、越权及超限输入不返回正文。

`OfficeConversationDocxConfig` 通过 `conversationDocx` 提供压缩字节数、ZIP 条目数、全部声明解压字节数、解析 XML 字节数、访问节点数、提取文本、转义后完整原生工具内容 JSON 字节数、worker 期限及 V8 老年代堆的部署覆盖值。[办公包参考](../../packages/enterprise/office/README.zh.md#prepared-contexts)负责默认值、准确提取范围、隔离 worker 的终止和取消，以及办公队列内末次权限核查。DOCX 不使用完整文档缓存或原生附件副本，其工具消费者在原有原生日志中记录真实的有界结果。

`OfficeConversationXlsxReadInput` 指定提交快照／文件、从 1 开始按工作簿顺序排列的 `sheetNumber`、已存单元格 `offset` 及 `maxCells`（1–256）。`OfficeConversationXlsxRead` 返回不可变文件元数据、有界 `OfficeConversationXlsxSheet` 目录、工作簿 `dateSystem`、所选工作表序号、准确单元格连续坐标和 `eof`。已存单元格按行／列顺序排列，包含显式空白，不展开稀疏空洞或合并范围。目录记录名称、顺序、隐藏状态及已存单元格数量。每次读取在解析前校验真实字节与 SHA-256；最终办公队列重新核查当前身份、快照角色、祖先访问权及最新版本。

`OfficeConversationXlsxCell` 保留地址、行／列、隐藏标记、带类型的 `value`、准确 XML `rawValue`、数字格式及原公式文本／类型／共享索引／范围。数字与日期序列保持字符串，`dateSystem` 提供 1900／1904 纪元。共享字符串保留原始表索引，布尔原值保留 `0`／`1`。公式 `cacheState` 为 `not_formula`、`missing` 或 `present_may_be_stale`，零、false 和空字符串缓存与缺失保持区别。不计算公式、不展开共享引用、不获取外部目标，单元格值和公式只作不可信数据。

`OfficeConversationXlsxConfig` 通过 `conversationXlsx` 限制压缩／解压归档字节数、条目数、XML 字节／节点、工作表、已存单元格、文本、转义后完整原生内容 JSON 字节数、期限及堆。[办公包参考](../../packages/enterprise/office/README.zh.md#prepared-contexts)负责默认值、宏／外部依赖拒绝、解析范围、worker 终止／取消及准确原值解释。完整结果预算只接纳完整单元格，目录或第一个单元格无法容纳时失败，不返回截断值。不引入完整文档缓存、原生附件副本或持久化格式变化。

## 基于捕获上下文的 Agent 工作

`OfficeAgentWorkInput` 使用私有快照及执行 UUID 标识一次内部任务／待办创建。`OfficeAgentWorkReceipt` 返回稳定请求坐标及当前有权查看的事项。新写入复核员工、快照归属、角色、审核后的提醒模板选择及声明依赖。独立的 `enterprise_office_agent_work` 第 1 版在工作领域提交前预留服务端生成的事项编号，恢复时核对该事项而不再次建单。已提交的准确重试属于读取，未完成重试仍复核当前执行权限。[包参考](../../packages/enterprise/office/README.zh.md#agent-work-execution)负责保留、就绪状态及失败语义。

## 公司公告

`OfficeAnnouncementId` 标识不可变发布记录，`OfficeAnnouncementInput` 携带纯文本、投递范围及稳定重试 UUID。独立的 `enterprise_office_announcements` 第 1 版领域将公告及当时启用的接收成员原子提交。仅管理员发布或撤回，接收人只确认本人仍有效的投递。`OfficeAnnouncement` 不包含其他员工的已读记录；`OfficeView` 中可选的 `OfficeAnnouncementView` 兼容旧服务器。全体投递在发布时冻结，不自动包含后来入职的成员。撤回后正文与已读记录仍保留供管理员管理。空的 `office/announcements-changed` 事件触发有权读取。界面将公告与事项通知合并，员工阅读或要求减少动态效果时暂停首页轮播。

## 事项与邀请

`OfficeTaskDeliveryInput` 指定提交、确认或退回及非空原因。仅任务可使用的可选 `OfficeItem.deliveries` 保留 `OfficeTaskDelivery` 操作者、当时负责人、时间和父事项修订号。仅负责人可提交进行中任务，发起人或管理员负责验收。当前提交须为最后一条 submit，且修订号和负责人均与事项相同；中间变更后须重提。确认使任务完成，退回保留进行中状态。有交付历史的任务只能明确确认完成，其他任务保留普通状态操作。`delivery_submitted`、`delivery_accepted`、`delivery_returned` 通知及审计与历史一并提交，兼容规则见[交付升级指南](../upgrade-guide/v0.2.1-alpha.2/office-task-delivery/guide.zh.md)。

可选的 `OfficeItem.subtasks` 保留最多 100 个 `OfficeSubtask`，包含 `OfficeSubtaskId`、标题及完成标记。`OfficeWorkSubtasksInput` 替换已查看的清单；空编号由服务端生成，既有编号必须属于当前事项。发起人、当前负责人或管理员可编辑未关闭的任务／待办，子项继承父事项访问权限。变化与 `work_subtasks_updated` 审计及接收人通知一并提交。[子任务升级指南](../upgrade-guide/v0.2.1-alpha.2/office-work-subtasks/guide.zh.md)说明旧读取器的拒绝行为。

`OfficeScheduleAvailabilityInput` 包含办公本地日期、起止时间、最多 500 个成员编号及可选的有权读取会议排除项。`OfficeScheduleAvailability` 返回去重成员的布尔忙闲、时区和查询时间，不含会议编号或内容。调用者及被查询成员均须启用。部署配置 `scheduleAvailabilityEnabled` 显式开启此独立读取操作；`OfficeView.scheduleAvailabilityEnabled` 缺省表示不可共享。占用及隐私规则见[办公包](../../packages/enterprise/office/README.zh.md#use-this-package)。

`OfficeWorkInput` 创建任务或待办；`OfficeScheduleInput` 创建起止时间有效、可邀请成员的当日会议。已提交的 `OfficeItem` 保存发起人、负责人、日期、说明和修订号。`OfficeItemStatus` 为 pending、in_progress、completed 或 cancelled。`OfficeParticipant` 保存成员的 `OfficeInvitationReply`：pending、accepted 或 declined。主办人自动接受，不能拒绝自己的会议。

普通事项仅允许发起人、负责人或管理员修改状态；会议状态仅允许主办人或管理员修改。受邀人只能为自己答复。事项修订号检查会拒绝过期修改，不覆盖更新的记录。记录不存在与无权查看使用相同拒绝结果。

`OfficeScheduleUpdateInput` 编辑未关闭会议的标题、日期、起止时间、地点、说明及可选的 `inviteeIds`。省略受邀人保留成员，空数组仅保留主办人；标识、主办人和生命周期不变。仅发起人或管理员可提交已查看的修订号。新受邀人须启用并收到 `invited` 通知；被移除的普通成员失去读取权限，并保留含此前标题的 `schedule_removed` 通知。日期或时间变更将非主办人的答复重置为待回复，其他修改保留原成员答复。成员变化提交 `schedule_members_updated` 审计，其他修改仍使用 `schedule_updated`。事项、接收人通知和审计一并提交，内容和成员均相同时不提交。[成员兼容性指南](../upgrade-guide/v0.2.1-alpha.2/office-schedule-members/guide.zh.md)规定协调部署及旧读取器明确拒绝的行为。

`OfficeTaskDecisionInput` 表示明确的接受、附原因拒绝或附原因转交操作。只有当前负责人可接受或拒绝待处理任务；负责人、发起人或管理员可将未关闭任务转交给其他启用成员，使其重新待处理。`OfficeItem.taskActions` 可选地按顺序保存 `OfficeTaskAction`，包含操作、事项修订号、操作者、前后负责人、原因和时间。既有状态更新保留这些历史。操作将事项、`task_accepted`／`task_rejected`／`task_transferred` 通知及对应审计一并提交。通知中可选的 `itemTitle` 为原负责人保留标题，不授予继续读取任务的权限。[任务兼容性指南](../upgrade-guide/v0.2.1-alpha.2/office-task-decisions/guide.zh.md)规定旧读取器明确拒绝的行为。

`OfficeWorkUpdateInput` 包含任务／待办可编辑的标题、说明、本地日期和可选截止时间，不包含种类、状态或负责人。当前发起人、负责人或管理员可携带已查看的修订号编辑未关闭事项，不提供时间会将其清除。事项标识和任务操作历史保持不变。内容变化将 `work_updated` 通知和审计与事项一并提交，相同内容不提交。[事项编辑兼容性指南](../upgrade-guide/v0.2.1-alpha.2/office-work-edits/guide.zh.md)规定协调部署及旧读取器明确拒绝的行为。

可选的 `OfficeItem.priority` 使用 `OfficeWorkPriority`，可选低、普通、高和紧急。新建默认普通，保留既有工具参数。省略 `OfficeWorkUpdateInput.priority` 会保留当前值，明确指定普通时移除非默认值。实际变化将 `work_prioritized` 通知和审计与事项原子提交，恢复普通时也如此。工作列表继续按日期时间排序。[优先级兼容性指南](../upgrade-guide/v0.2.1-alpha.2/office-work-priority/guide.zh.md)规定协调升级及旧读取器明确拒绝的行为。

`OfficeTodoAssignment` 将负责人历史字段限定为 transfer 操作。`OfficeItem.todoAssignments` 可选地按顺序保留负责人变更记录，与任务操作历史分开。`OfficeTaskDecisionInput` 的 transfer 分支可将未关闭待办转交给其他启用成员，使其重新待处理；待办仍不接受 accept/reject。授权、修订号检查和原因要求与任务转交一致。事项、`todo_reassigned` 通知和审计原子提交；内容与状态编辑保留转交历史。[待办兼容性指南](../upgrade-guide/v0.2.1-alpha.2/office-todo-assignment/guide.zh.md)规定旧读取器明确拒绝的行为。

## 视图与持久提交

`OfficeView` 包含授权的通讯录、事项、通知和 `OfficeDay` 当日视图。“今天”依据配置的 IANA 时区确定。有时间的事项排在无时间事项前，已关闭记录仍然显示。完成率的分母排除已取消事项。

仅管理员收到完整的 `managedMembers` 通讯录，其中包含停用身份。新增成员必须使用未占用的编号；携带已查看成员记录的编辑会在提交队列内拒绝并发变更。最后一名启用的管理员必须继续启用并保留管理员角色。普通通讯录和派发选项只收到启用成员。

`OfficeNotification` 仅属于一个接收人。`OfficeAuditEntry` 记录操作、操作者、目标和时间，仅管理员可查看审计历史。`enterprise_office` 版本 1 整体提交将事项、参与记录、通知和审计一起持久化。存储失败时均不发布；提交后观察者异常不会将成功写入变成业务失败。多 Host 事务存储、分页和保留策略仍待实现。

`OfficeErrorCode` 区分 invalid_input、forbidden、not_found、conflict、duplicate_name、closed、unauthenticated、rate_limited、conversation_capacity、context_too_large 和 execution_unknown。适配器本地化预期拒绝及未确认的外部结果；意外存储失败仍作为异常处理，派发后诊断仅保留在私有 cause 中。办公读写不注册模型工具，也不注入模型上下文。

## Cordis 接口

联系人私有草稿使用 `enterprise_office_chat_drafts` 第 1 版领域。`OfficeChatDraftView` 只属于启用员工本人，管理员同样受限；`OfficeChatDraftInput` 携带已查看的联系人版本及重试 UUID，保存返回 `OfficeChatDraft`。空文本墓碑防止旧窗口恢复已清除内容。页面在写入期间保留新输入，使用原标识重试不确定写入，并要求用户明确选择冲突处理方式。草稿正文不广播，也不存入浏览器存储。需等待保存确认后再依赖刷新恢复，最新延迟保存输入在此之前尚未持久化。

人与人文字聊天使用独立的 `enterprise_office_chat` 领域。`OfficeChatInput` 携带客户端生成的 `OfficeMessageId` 和接收人，幂等重试保留唯一的 `OfficeChatMessage`。`OfficeChatView` 仅提供本人的 `OfficeChatThread` 列表和一个有上限的会话页。`OfficeChatPeer` 只包含身份、显示姓名和启用状态。管理员不能绕过私聊参与范围。已读游标必须属于这一对员工。共享修改队列在发送或确认已读前重新检查成员资格，销毁时等待所有办公领域均完成写入。`office/chat-changed` 让客户端重读私有视图，不广播消息正文。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxoffice--officeservice"></a>

### `ctx.office` — `OfficeService`

Employee work lifecycle. Returned records are borrowed read-only; callers must not mutate them.

```ts cordis-catalog
/**
 * Read employee contacts, their work and inbox; administrators see all work.
 * Company today and item time decisions share one server observation. A known invalid item time
 * marks only that item unresolved; unexpected failures reject the read. No status or reminder is written.
 * @param actorId - Authenticated identity supplied by a trusted adapter.
 * @param date - Existing local day; omission selects today in the configured office timezone.
 * @returns authorized projection; throws forbidden for absent/inactive employees.
 */
view(actorId: OfficeMemberId, date?: string): OfficeView

/**
 * Query active coworkers' internal meeting occupancy only after deployment consent.
 * @param actorId - Current authenticated active employee.
 * @param input - Office-local date and interval, up to 500 members and an optional readable meeting to exclude.
 * @returns Unique requested members' busy flags and observation time, without meeting ids or content.
 * Pending and accepted invitations occupy time; closed meetings and declined invitations do not. No writes or reservations occur.
 */
scheduleAvailability(actorId: OfficeMemberId, input: OfficeScheduleAvailabilityInput): OfficeScheduleAvailability

/**
 * Register a descriptive company manifest through current administrator authority.
 * @param actorId - Authenticated active employee, rechecked inside the shared queue.
 * @param input - Bounded JSON object and stable UUID for an uncertain-response retry.
 * @returns Durable registration without installing or activating plugin code.
 */
importIntegration(actorId: OfficeMemberId, input: OfficeIntegrationImportInput): Promise<OfficeIntegration>

/**
 * Register a trusted Host connector implementation, independently of native MCP and plugin installation.
 * @param adapter - Unique implementation; abort must stop its outstanding probe before settlement.
 * @returns Disposer to attach to the contributing plugin's effect; removal aborts its probe.
 */
registerConnector(adapter: OfficeConnectorAdapter): () => void

/**
 * Read current company connection readiness without returning credential values.
 * @param actorId - Authenticated active employee; only administrators receive editable configuration.
 * @returns Adapter availability, versions and current credential presence, without a connectivity claim.
 */
connections(actorId: OfficeMemberId): Promise<OfficeConnectorView>

/**
 * Explicitly synchronize a reviewed declared read and persist its actual sanitized outcome.
 * @param actorId - Authenticated current employee, never selected in the request body.
 * @param input - Stable retry identity and exact action/connection/provider coordinates.
 * @returns Durable original record and currently authorized data; failed storage reports no success.
 */
syncConnectorAction(actorId: OfficeMemberId, input: OfficeConnectorSyncInput): Promise<OfficeConnectorSyncDetail>

/**
 * List only this employee's synchronization metadata without querying the company system.
 * @param actorId - Active authenticated employee, checked inside the office queue.
 * @param query - One company registration and optional owner-scoped older anchor.
 * @returns Bounded records without retained fields, credentials or customer response bodies.
 */
connectorSyncPage(actorId: OfficeMemberId, query: OfficeConnectorSyncQuery): Promise<OfficeConnectorSyncPage>

/**
 * Recheck current role, declared read and saved connection before delivering historical retained fields.
 * @param actorId - Active authenticated owner; administrators have no private-data bypass.
 * @param id - Server synchronization identity.
 * @returns Historical metadata with data withheld after authorization or connection changes; no customer GET occurs.
 */
connectorSyncDetail(actorId: OfficeMemberId, id: OfficeConnectorSyncId): Promise<OfficeConnectorSyncDetail>

/**
 * Read private customization metadata without sending requirements outside the office.
 * @param actorId - Active authenticated employee.
 * @param before - Exclusive employee-local save position, or null for newest records.
 * @returns A bounded own page with no contact or requirement bodies.
 */
customizationRequests(actorId: OfficeMemberId, before: number | null): Promise<OfficeCustomizationPage>

/**
 * Read the current own draft for editing or explicit export.
 * @param actorId - Current authenticated employee; administrators have no owner bypass.
 * @param id - Server-created customization identity.
 * @returns Latest saved private version, explicitly marked not sent.
 */
customizationRequest(actorId: OfficeMemberId, id: OfficeCustomizationId): Promise<OfficeCustomizationRecord>

/**
 * Persist a reviewed requirement version; this operation has no external delivery side effect.
 * @param actorId - Authenticated employee, never accepted in the input.
 * @param input - Exact retry identity, reviewed version and plain-text fields.
 * @returns Original durable receipt plus the current revision; failed persistence reports no success.
 */
saveCustomizationRequest(actorId: OfficeMemberId, input: OfficeCustomizationInput): Promise<OfficeCustomizationSaveReceipt>

/**
 * Discover one system's current role-admitted business-action declarations without executing them.
 * @param actorId - Authenticated employee, rechecked in the shared office queue.
 * @param integrationId - Company system identity; callers cannot choose a URL or role.
 * @returns Bounded public metadata and current connection/registration coordinates, without credentials.
 */
connectorActions(actorId: OfficeMemberId, integrationId: OfficeIntegrationId): Promise<OfficeConnectorActionsView>

/**
 * Read the current employee's retained external-operation receipts without request values or an administrator bypass.
 * @param actorId - Active authenticated employee, rechecked in the shared office queue.
 * @returns Own evidence only; a dispatched request remains unknown until its authoritative outcome is durable.
 */
connectorExecutions(actorId: OfficeMemberId): Promise<readonly OfficeConnectorExecutionReceipt[]>

/**
 * Read a newest-first bounded page of this employee's executions in one company system.
 * @param actorId - Current authenticated employee; administrators have no private history override.
 * @param query - System registration and optional own older-page anchor.
 * @returns Small receipt metadata without raw inputs, audit arrays or large business results.
 */
connectorExecutionPage(actorId: OfficeMemberId, query: OfficeConnectorExecutionQuery): Promise<OfficeConnectorExecutionPage>

/**
 * Read one employee-private bounded execution receipt, including retained authoritative result and audit stages.
 * @param actorId - Current authenticated employee, selected by the server rather than a request payload.
 * @param executionId - Own server-generated execution identity.
 * @returns The retained receipt; unlinked adapters do not erase history and another employee's id remains unavailable.
 */
connectorExecutionDetail(actorId: OfficeMemberId, executionId: OfficeConnectorExecutionId): Promise<OfficeConnectorExecutionReceipt>

/**
 * Check an own possibly committed customer operation by its original execution identity without resending it.
 * @param actorId - Current authenticated employee; current role, original connection and session remain authoritative.
 * @param executionId - Own retained server idempotency identity, never caller-selected transport parameters.
 * @returns Retained unknown/unavailable evidence or a newly durable authoritative receipt; checking never dispatches a write.
 */
checkConnectorExecution(actorId: OfficeMemberId, executionId: OfficeConnectorExecutionId): Promise<OfficeConnectorExecutionCheck>

/**
 * Submit one reviewed declared customer-system write through durable, employee-private execution evidence.
 * @param actorId - Current server-authenticated employee; clients cannot supply another actor or role.
 * @param input - Stable retry UUID, exact action/provider versions and declared text fields; optional capture narrows authority.
 * @returns Durable receipt; exact terminal retries and equivalent unresolved writes never invoke the customer system again.
 */
writeConnectorAction(actorId: OfficeMemberId, input: OfficeConnectorWriteInput): Promise<OfficeConnectorExecutionReceipt>

/**
 * Query one declared read action using current employee identity and reviewed connection/provider versions.
 * @param actorId - Authenticated employee; queued requests and asynchronous network admission recheck their session.
 * @param input - Registered system, declared read action and exact reviewed versions; no arbitrary parameters.
 * @returns Sanitized bounded fields or a network failure, without performing business writes or automatic retries.
 */
readConnectorAction(actorId: OfficeMemberId, input: OfficeConnectorReadInput): Promise<OfficeConnectorReadReceipt>

/**
 * Discover current actions for one system in this employee's submitted native conversation context.
 * @param actorId - Authenticated employee; private captures have no administrator bypass.
 * @param input - Private capture and selected registered integration, without URLs or claimed roles.
 * @returns Role-admitted directory only while the captured connection and current associations still match.
 */
conversationConnectorActions(actorId: OfficeMemberId, input: OfficeConversationConnectorInput): Promise<OfficeConnectorActionsView>

/**
 * Query a declared read action under the submitting employee's current private conversation associations.
 * @param actorId - Authenticated employee; execution does not accept a caller-selected actor.
 * @param input - Private capture and exact action/connection/provider coordinates reviewed by native approval.
 * @returns Bounded real query result; revoked associations, changed roles and stale connections prevent execution.
 */
readConnectorActionFromConversation( actorId: OfficeMemberId, input: OfficeConversationConnectorReadInput, ): Promise<OfficeConnectorReadReceipt>

/**
 * Read private association choices and current declared integration requirements for one native conversation.
 * @param actorId - Authenticated active employee; administrators receive no bypass to another employee's choices.
 * @param conversationId - Logical native Session identity, scoped to that employee.
 * @returns Reviewed choices, capacity bounds and explicit missing dependencies, without execution authority or secrets.
 */
conversationLinks(actorId: OfficeMemberId, conversationId: OfficeConversationId): Promise<OfficeConversationLinksView>

/**
 * Save one association list without modifying Session history or granting a tool permission.
 * @param actorId - Authenticated current employee, rechecked inside the shared mutation queue.
 * @param input - Reviewed version, exact retry identity and selected tools or integrations.
 * @returns Confirmed private choice version; selecting tools also adds their currently registered dependencies.
 */
saveConversationLinks(actorId: OfficeMemberId, input: OfficeConversationLinksInput): Promise<OfficeConversationLinks>

/**
 * Prepare immutable association evidence before a separate native prompt admission.
 * @param actorId - Authenticated employee, rechecked inside the office queue.
 * @param input - Reviewed logical conversation version and exact native prompt retry identity.
 * @returns Private prepared context; no prompt is sent and no capability is authorized.
 */
captureConversation(actorId: OfficeMemberId, input: OfficeConversationCaptureInput): Promise<OfficeConversationCapture>

/**
 * Recover one employee's prepared context after uncertain acknowledgement or restart.
 * @param actorId - Current active employee; administrator role does not bypass ownership.
 * @param id - Prepared context identity, scoped to its owner.
 * @returns Historical metadata, without implying native admission or model dispatch.
 */
conversationCapture(actorId: OfficeMemberId, id: OfficeConversationCaptureId): Promise<OfficeConversationCapture>

/**
 * Read this employee's private drive references for one native conversation.
 * @param actorId - Authenticated employee; administrator role does not bypass private ownership.
 * @param conversationId - Logical native Session identity, without execution authority.
 * @returns Reviewed immutable metadata; later content reads require fresh permission checks.
 */
conversationFiles(actorId: OfficeMemberId, conversationId: OfficeConversationId): Promise<OfficeConversationFilesView>

/**
 * Replace reviewed file references with metadata resolved by the authority.
 * @param actorId - Current active employee, rechecked inside the mutation queue.
 * @param input - Optimistic version, exact retry UUID and immutable file coordinates.
 * @returns Committed private selection; no bytes are copied into native attachments.
 */
saveConversationFiles(actorId: OfficeMemberId, input: OfficeConversationFilesInput): Promise<OfficeConversationFiles>

/**
 * Freeze file references before a separate native prompt is admitted.
 * @param actorId - Current active employee.
 * @param input - Reviewed file-selection version and native request identity.
 * @returns Immutable descriptive evidence; every content read still rechecks authority.
 */
captureConversationFiles(actorId: OfficeMemberId, input: OfficeConversationCaptureInput): Promise<OfficeConversationFilesCapture>

/**
 * Recover retained file context for its original employee and authority role.
 * @param actorId - Current authenticated employee.
 * @param id - Private capture identity; possession grants no read access.
 * @returns Historical submitted metadata without implying native admission or dispatch.
 */
conversationFilesCapture(actorId: OfficeMemberId, id: OfficeConversationFilesCaptureId): Promise<OfficeConversationFilesCapture>

/**
 * Read a bounded character window from an explicitly submitted immutable UTF-8 file.
 * @param actorId - Current authenticated employee, rechecked before accessing bytes.
 * @param input - Owned submitted context, selected file and bounded character window.
 * @returns Verified inert text; changed versions, denied ancestors and invalid encodings return no body.
 */
readConversationFile(actorId: OfficeMemberId, input: OfficeConversationFileReadInput): Promise<OfficeConversationFileRead>

/**
 * Parse one submitted PDF page under finite input, worker and complete output limits.
 * @param actorId - Current employee; private capture role and current file authority are rechecked.
 * @param input - Exact submitted file, one-based page and bounded character window.
 * @param signal - Optional original tool or transport cancellation; office unload also terminates parsing.
 * @returns Actual selectable PDF text; malformed, encrypted, stale or over-budget files disclose no body.
 */
readConversationPdf(actorId: OfficeMemberId, input: OfficeConversationPdfReadInput, signal?: AbortSignal): Promise<OfficeConversationPdfRead>

/**
 * Read actual main-document paragraphs and tables from one explicitly submitted DOCX.
 * @param actorId - Current authenticated employee; capture role and current file authority remain mandatory.
 * @param input - Exact submitted immutable file and bounded UTF-16 body-text window.
 * @param signal - Original native tool or disconnected transport cancellation; office unload also terminates parsing.
 * @returns Verified body text with paragraph/table counts; malformed, denied and over-budget packages return no body.
 */
readConversationDocx(actorId: OfficeMemberId, input: OfficeConversationDocxReadInput, signal?: AbortSignal): Promise<OfficeConversationDocxRead>

/**
 * Read exact saved cells and formula caches from one submitted XLSX worksheet.
 * @param actorId - Current employee; capture role, ancestor access and latest version remain mandatory.
 * @param input - Exact submitted worksheet and sparse-cell continuation.
 * @param signal - Original native cancellation or disconnected transport; office unload also stops the parser.
 * @returns Whole saved cells with raw numeric/date lexemes; unauthorized and over-budget input returns no cells.
 */
readConversationXlsx(actorId: OfficeMemberId, input: OfficeConversationXlsxReadInput, signal?: AbortSignal): Promise<OfficeConversationXlsxRead>

/**
 * Read saved shape/table text or explicitly selected speaker notes from one submitted presentation slide.
 * @param actorId - Current employee; captured role, ancestor access and exact latest version remain mandatory.
 * @param input - Submitted immutable file, relationship-ordered slide and bounded section text window.
 * @param signal - Original native or transport cancellation; office unload also stops the isolated parser.
 * @returns Verified saved text and slide directory after final queued authorization; failures disclose no text.
 */
readConversationPptx(actorId: OfficeMemberId, input: OfficeConversationPptxReadInput, signal?: AbortSignal): Promise<OfficeConversationPptxRead>

/**
 * Save one integration's reviewed connection using deployment-approved origins and credential aliases.
 * @param actorId - Authenticated administrator, rechecked inside the office queue.
 * @param input - Configuration, reviewed revision and retained retry UUID; no inline credentials.
 * @returns Durably saved metadata; network connectivity remains unverified until a separate check.
 */
saveConnection(actorId: OfficeMemberId, input: OfficeConnectorInput): Promise<OfficeConnectorEntry>

/**
 * Probe a reviewed connection with fresh Host credentials and bounded response size and time.
 * @param actorId - Authenticated administrator, rechecked before any outbound request.
 * @param integrationId - Saved integration identity; arbitrary request URLs are not admitted.
 * @param revision - Reviewed connection version, preventing a check of a competing replacement.
 * @returns Point-in-time outcome without remote content or secrets; no automatic retries or business writes.
 */
probeConnection(actorId: OfficeMemberId, integrationId: OfficeIntegration['id'], revision: number): Promise<OfficeConnectorProbe>

/**
 * Publish plain text to a frozen set of current company employees.
 * @param actorId - Authenticated administrator, rechecked inside the mutation queue.
 * @param input - Reviewed text, delivery scope and retained retry UUID.
 * @returns Durable publication after its recipient list is committed.
 */
publishAnnouncement(actorId: OfficeMemberId, input: OfficeAnnouncementInput): Promise<OfficeAnnouncement>

/**
 * Acknowledge a publication in this employee's inbox.
 * @param actorId - Authenticated current recipient.
 * @param id - Delivered publication identity.
 */
markAnnouncementRead(actorId: OfficeMemberId, id: OfficeAnnouncementId): Promise<void>

/**
 * Acknowledge this recipient's current central reminder without changing business notifications.
 * @param actorId - Authenticated active employee, rechecked after queue admission.
 * @param id - Delivered reminder UUID; another employee's or obsolete occurrence is unavailable.
 * @returns After durability; repeated acknowledgements write nothing.
 */
markReminderRead(actorId: OfficeMemberId, id: OfficeReminderId): Promise<void>

/**
 * Withdraw a reviewed publication while retaining its history.
 * @param actorId - Current administrator.
 * @param id - Publication identity.
 * @param expectedRevision - Content revision reviewed before withdrawal.
 */
withdrawAnnouncement(actorId: OfficeMemberId, id: OfficeAnnouncementId, expectedRevision: number): Promise<void>

/**
 * Read only this employee's private conversations, even for administrators.
 * @param actorId - Authenticated active employee.
 * @param peerId - Optional conversation to open, including retained inactive peers.
 * @param before - Exclusive sequence for older history.
 * @returns Authorized threads and at most 100 messages.
 */
chat( actorId: OfficeMemberId, peerId?: OfficeMemberId, before?: number, ): OfficeChatView

/**
 * Read a private/shared directory or authorized name search without native filesystem access.
 * @param actorId - Authenticated active employee.
 * @param input - Logical location and search string.
 * @returns Authorized metadata, breadcrumbs and current write capability.
 */
drive(actorId: OfficeMemberId, input: OfficeDriveQuery): OfficeDriveView

/**
 * Create a folder after checking current membership and ancestor permissions.
 * @param actorId - Trusted employee identity, not a browser-selected owner.
 * @param input - Logical parent and Windows-compatible display name.
 * @returns Committed directory entry.
 */
createDriveFolder( actorId: OfficeMemberId, input: OfficeDriveFolderInput, ): Promise<OfficeDriveEntry>

/**
 * Rename only an editable entry inside an editable parent, using a reviewed version.
 * @param actorId - Authenticated employee.
 * @param input - Opaque entry identity, version and new name.
 * @returns Committed metadata or a denial without changing the directory.
 */
renameDriveEntry( actorId: OfficeMemberId, input: OfficeDriveRenameInput, ): Promise<OfficeDriveEntry>

/**
 * Upload actual bytes under current directory permissions and a stable retry identity.
 * @param actorId - Trusted employee identity.
 * @param input - Logical destination, bounded bytes and retry key.
 * @returns Committed file metadata after both immutable bytes and metadata are durable.
 */
uploadDriveFile( actorId: OfficeMemberId, input: OfficeDriveUploadInput, ): Promise<OfficeDriveEntry>

/**
 * Download an authorized immutable version while permission changes share the same queue.
 * @param actorId - Authenticated active employee.
 * @param id - Opaque file identity.
 * @returns Actual bytes and their digest; denied and corrupt reads disclose no content.
 */
downloadDriveFile( actorId: OfficeMemberId, id: OfficeDriveId, ): Promise<OfficeDriveDownload>

/**
 * Let a shared entry's owner replace account conditions without an administrator privacy bypass.
 * @param actorId - Authenticated employee.
 * @param input - Reviewed version and complete conditions.
 * @returns Committed owner projection.
 */
saveDrivePermissions( actorId: OfficeMemberId, input: OfficeDrivePermissionsInput, ): Promise<OfficeDriveEntry>

/**
 * Read only this employee's drafts; administrators have no private-draft bypass.
 * @param actorId - Authenticated active employee.
 * @returns Contact drafts with their reviewed versions, including cleared tombstones.
 */
chatDrafts(actorId: OfficeMemberId): OfficeChatDraftView

/**
 * Save a private draft without silently overwriting another window's changes.
 * @param actorId - Authenticated owner; never selected by a browser method.
 * @param input - Contact, reviewed version, exact text and retry identity.
 * @returns The durable version; exact retries return it without another write.
 */
saveChatDraft( actorId: OfficeMemberId, input: OfficeChatDraftInput, ): Promise<OfficeChatDraft>

/**
 * Send one private message; retrying its exact identity cannot duplicate it.
 * @param actorId - Authenticated sender, rechecked in the shared mutation queue.
 * @param input - Retry identity, recipient and original text.
 * @returns Committed message; changed retry payloads reject without side effects.
 */
sendMessage( actorId: OfficeMemberId, input: OfficeChatInput, ): Promise<OfficeChatMessage>

/**
 * Read this active employee's file-message policy and retained usage.
 * @param actorId - Authenticated employee.
 * @returns Current bounded file policy without other employees' usage.
 */
chatFileLimitsFor(actorId: OfficeMemberId): OfficeChatFileLimits

/**
 * Verify immutable files before publishing one private message through the original chat sequence.
 * @param actorId - Current authenticated sender, checked inside the shared queue.
 * @param input - Exact retry identity, recipient, caption and ordered bounded files.
 * @returns Published header and file metadata; failure may retain a recoverable declaration but never a partial message.
 */
sendMessageFiles(actorId: OfficeMemberId, input: OfficeChatFilesInput): Promise<OfficeChatMessage>

/**
 * Read one immutable file through its original private message and current participant identity.
 * @param actorId - Active authenticated sender or recipient.
 * @param input - Retained message and file coordinates.
 * @returns Verified complete bytes; hidden and missing coordinates share one denial.
 */
downloadChatFile(actorId: OfficeMemberId, input: OfficeChatFileCoordinates): Promise<OfficeChatFileDownload>

/**
 * Read current private file draft versions without returning file bytes.
 * @param actorId - Current authenticated owner.
 * @returns Only the owner's contact drafts, tombstones and logical draft quota.
 */
chatFileDrafts(actorId: OfficeMemberId): OfficeChatFileDraftView

/**
 * Atomically replace one reviewed contact's private file draft.
 * @param actorId - Authenticated owner rechecked inside the shared queue.
 * @param input - Reviewed contact version, original retry UUID and complete bounded files.
 * @returns Saved metadata; stale versions and changed retries reject without clearing the draft.
 */
saveChatFileDraft(actorId: OfficeMemberId, input: OfficeChatFileDraftInput): Promise<OfficeChatFileDraft>

/**
 * Restore complete file bytes from the authenticated employee's own reviewed contact draft.
 * @param actorId - Active owner; recipients and administrators receive no bypass.
 * @param input - Contact, current draft version and opaque file identity.
 * @returns Verified bounded draft content or a uniform missing-file denial.
 */
downloadChatFileDraft(actorId: OfficeMemberId, input: OfficeChatFileDraftCoordinates): Promise<OfficeChatFileDraftDownload>

/**
 * Publish an exact reviewed durable file selection, then clear only that original draft.
 * @param actorId - Current authenticated sender, serialized with sign-out and membership edits.
 * @param input - Reviewed version, captured caption and stable message identity.
 * @returns One committed file message; retries reconcile publication before clearing the original selection.
 */
sendChatFileDraft(actorId: OfficeMemberId, input: OfficeChatFileDraftSendInput): Promise<OfficeChatMessage>

/**
 * Acknowledge only messages displayed from this employee's own conversation.
 * @param actorId - Authenticated reader.
 * @param peerId - Other participant.
 * @param through - Observed sequence in this exact conversation.
 * @returns After durable acknowledgement; older acknowledgements are idempotent.
 */
readChat( actorId: OfficeMemberId, peerId: OfficeMemberId, through: number, ): Promise<void>

/**
 * Read one active item through the employee policy used for daily lists and calendars.
 * @param actorId - Authenticated identity.
 * @param itemId - Requested work.
 * @returns Active item; hidden, inactive or missing work returns the same not_found denial.
 */
getItem(actorId: OfficeMemberId, itemId: OfficeItemId): OfficeItem

/**
 * Create a task or to-do and deliver the assignee's notification in one commit.
 * @param actorId - Authenticated initiator.
 * @param input - User-authored work.
 * @returns durable item; validation, membership or storage failure publishes no new revision.
 */
createWork( actorId: OfficeMemberId, input: OfficeWorkInput, ): Promise<OfficeItem>

/**
 * Create one internal task/to-do under a private reminder capture, rechecking authority immediately before a new write.
 * @param actorId - Authenticated active employee; the payload cannot choose a business actor.
 * @param input - Exact retry identity, private capture and ordinary work fields.
 * @returns Stable request receipt with the current authorized item; existing committed retries perform no second write.
 */
createWorkFromConversation(actorId: OfficeMemberId, input: OfficeAgentWorkInput): Promise<OfficeAgentWorkReceipt>

/**
 * Edit ordinary work content and deadline while preserving assignment and lifecycle.
 * @param actorId - Current active creator, assignee or administrator.
 * @param itemId - Existing task or to-do identity.
 * @param expectedRevision - Revision reviewed before editing, including any task decisions.
 * @param input - Content and deadline; omitted time clears it, omitted priority preserves it, and normal clears a stored priority.
 * @returns Committed work; unchanged input writes nothing, and stale, closed or unauthorized edits publish no changes.
 */
updateWork(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, input: OfficeWorkUpdateInput): Promise<OfficeItem>

/**
 * Submit a task delivery or review its current unchanged submission with a retained explanation.
 * @param actorId - Current assignee for submission; task creator or administrator for review.
 * @param itemId - Existing task; to-dos and meetings use their own operations.
 * @param expectedRevision - Parent revision reviewed before the action.
 * @param input - Submission, acceptance or return with a bounded nonempty reason.
 * @returns Task with atomically retained history, recipient notifications and audit. Acceptance completes the task.
 * Any intervening item revision invalidates a pending submission; denied, closed or stale actions publish nothing.
 */
reviewTaskDelivery(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, input: OfficeTaskDeliveryInput): Promise<OfficeItem>

/**
 * Archive, move to the recycle bin or restore reviewed work while retaining complete business history.
 * @param actorId - Current authenticated creator or administrator; assignment alone grants no deletion authority.
 * @param itemId - Existing readable task or to-do, including inactive records.
 * @param expectedRevision - Revision explicitly reviewed before confirming the action.
 * @param input - Confirmed action and nonempty explanation; deletion retains data in the recycle bin.
 * @returns Committed item with atomic history, notices and audit. Unchanged states write nothing.
 * Inactive records leave daily work and cannot be edited, executed or read as active work until restored.
 */
changeWorkLifecycle(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, input: OfficeWorkLifecycleInput): Promise<OfficeItem>

/**
 * Resolve linked file names only while the caller can read the item and its reviewed current Drive versions.
 * @param actorId - Authenticated active employee.
 * @param itemId - Existing readable task or to-do.
 * @returns Current attachment availability without private names or metadata for inaccessible references.
 */
workAttachments(actorId: OfficeMemberId, itemId: OfficeItemId): OfficeWorkAttachmentsView

/**
 * Replace reviewed attachment references without copying bytes or granting Drive access.
 * @param actorId - Current item creator, assignee or administrator.
 * @param itemId - Existing open task/to-do.
 * @param expectedRevision - Reviewed parent revision; any change invalidates pending delivery review.
 * @param input - At most 20 distinct files; new or changed references require current Drive access and version.
 * @returns Atomically committed item, notifications and audit; unchanged references write nothing.
 */
updateWorkAttachments(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, input: OfficeWorkAttachmentsInput): Promise<OfficeItem>

/**
 * Authorize a linked reviewed file version before starting a verified Drive download.
 * @param actorId - Current active reader of both item and file.
 * @param itemId - Existing readable work item still retaining this reference.
 * @param fileId - Linked logical file identity.
 * @returns Physically verified download metadata; missing, denied or replaced versions return no content.
 */
workAttachmentInfo(actorId: OfficeMemberId, itemId: OfficeItemId, fileId: OfficeDriveId): Promise<OfficeDriveDownloadInfo>

/**
 * Replace a task/to-do checklist using the version reviewed by its creator, assignee or administrator.
 * @param actorId - Current authenticated employee.
 * @param itemId - Existing task/to-do; all checklist access derives from this item.
 * @param expectedRevision - Reviewed parent revision, including other work changes.
 * @param input - Up to 100 entries; existing ids must belong to this work, and null ids receive fresh server identities.
 * @returns Committed work with atomic notification/audit; unchanged lists write nothing and closed or stale changes reject.
 */
updateWorkSubtasks(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, input: OfficeWorkSubtasksInput): Promise<OfficeItem>

/**
 * Create a meeting with one accepted organizer and pending, distinct invitees.
 * @param actorId - Authenticated organizer.
 * @param input - Same-day schedule.
 * @returns durable meeting; invalid times or inactive invitees leave no invitation or item.
 */
createSchedule( actorId: OfficeMemberId, input: OfficeScheduleInput, ): Promise<OfficeItem>

/**
 * Update a meeting on the revision its organizer or administrator reviewed.
 * @param actorId - Authenticated organizer or administrator.
 * @param itemId - Existing meeting identity.
 * @param expectedRevision - Last reviewed item revision, including invitation responses.
 * @param input - Same-day fields and optional invitees; omission preserves membership and the organizer always remains.
 * @returns Committed meeting with atomic invitations/removal notices; time changes reset invitee responses.
 * Closed or stale edits reject without writes.
 */
updateSchedule(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, input: OfficeScheduleUpdateInput): Promise<OfficeItem>

/**
 * Decide a task or transfer a to-do while retaining its history and original identity.
 * @param actorId - Current authenticated assignee, or creator/administrator for a transfer.
 * @param itemId - Existing task, or to-do for transfer; meetings retain their own controls.
 * @param expectedRevision - Item revision reviewed before deciding.
 * @param input - Explicit action; rejection and transfer include a reason, and transfer identifies an active new owner.
 * @returns Committed work and decision/assignment history; denied, closed or stale decisions publish no changes.
 */
decideTask(actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, input: OfficeTaskDecisionInput): Promise<OfficeItem>

/**
 * Change a work item's status with optimistic concurrency and execution-time authorization.
 * @param actorId - Authenticated owner/initiator or administrator.
 * @param itemId - Work to update.
 * @param expectedRevision - Last observed item revision.
 * @param status - New lifecycle state.
 * @returns committed item; stale writes reject with conflict. Only the organizer/admin changes meeting status.
 * Tasks with delivery history complete only through explicit delivery confirmation.
 */
setStatus( actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, status: OfficeItemStatus, ): Promise<OfficeItem>

/**
 * Reply only to the caller's own live invitation and notify the organizer.
 * @param actorId - Authenticated invitee.
 * @param itemId - Meeting being answered.
 * @param expectedRevision - Last observed item revision.
 * @param reply - Accepted or declined.
 * @returns committed meeting; closed meetings, organizer changes and stale writes reject without side effects.
 */
reply( actorId: OfficeMemberId, itemId: OfficeItemId, expectedRevision: number, reply: Exclude<OfficeInvitationReply, 'pending'>, ): Promise<OfficeItem>

/**
 * Edit contact fields, never role or active state.
 * @param actorId - Authenticated employee.
 * @param input - Complete profile fields.
 * @returns committed directory entry; unknown privilege fields reject at admission.
 */
updateProfile( actorId: OfficeMemberId, input: OfficeProfile, ): Promise<OfficeMember>

/**
 * Administrator-only directory creation, role change or offboarding. Historical identities remain.
 * @param actorId - Authenticated administrator.
 * @param member - Complete employee record.
 * @param expected - Null creates an identity; a reviewed record protects edits. Omission preserves trusted upserts.
 * @returns committed member; removing the last active administrator is rejected.
 */
saveMember( actorId: OfficeMemberId, member: OfficeMember, expected?: OfficeMember | null, ): Promise<OfficeMember>

/**
 * Mark one delivered notification as read without acknowledging another employee's inbox.
 * @param actorId - Authenticated recipient.
 * @param notificationId - Notification to acknowledge.
 * @returns after durability; missing and hidden notifications return the same not_found denial.
 */
markRead( actorId: OfficeMemberId, notificationId: OfficeNotificationId, ): Promise<void>

/**
 * Read committed operation history, restricted to active administrators.
 * @param actorId - Authenticated administrator.
 * @returns borrowed read-only audit entries.
 */
audit(actorId: OfficeMemberId): readonly OfficeAuditEntry[]

/**
 * Search retained operation metadata and authenticated request denials across the office histories.
 * @param actorId - Active administrator, rechecked on every page.
 * @param query - Bounded exact filters and exclusive older-page position.
 * @returns Allowlisted metadata only; source retention applies and pages are current reads, not a snapshot.
 */
auditPage(actorId: OfficeMemberId, query: OfficeAuditQuery): OfficeAuditPage

/**
 * Export one bounded metadata batch without including business fields, credential data or provider diagnostics.
 * @param actorId - Active administrator, rechecked for every batch.
 * @param query - Same filters and continuation used by auditPage.
 * @returns Newline-delimited JSON plus the next position; an empty batch has empty content.
 */
auditExport(actorId: OfficeMemberId, query: OfficeAuditQuery): OfficeAuditExport

/**
 * Initialize backend sign-in for an existing administrator once; later values never reset credentials.
 * @param administrator - Deployment-owned active administrator.
 * @param password - First password from the trusted server startup channel.
 * @returns Whether initialization committed; this is not a public signup endpoint.
 */
initializeIdentity( administrator: OfficeMemberId, password: string, ): Promise<boolean>

/**
 * Read the optional pre-login invitation capability without directory or credential information.
 * @returns Safe explicit lifetime capability, or null when invitations are disabled.
 */
memberInviteCapability(): OfficeMemberInviteCapability | null

/**
 * Read one managed member's latest invitation and independent current enrollment facts.
 * @param actorId - Current authenticated administrator.
 * @param memberId - Existing retained company member.
 * @returns Credential-free invitation metadata without a code or secret hash.
 */
memberInvite(actorId: OfficeMemberId, memberId: OfficeMemberId): Promise<OfficeMemberInviteView>

/**
 * Issue a finite first-password invitation for a reviewed active member with no credentials.
 * @param actorId - Current authenticated administrator; no role comes from the recipient.
 * @param input - Exact member/role, expiry and original issuance retry UUID.
 * @returns Committed metadata and a code only on the first response; retries cannot recover that code.
 */
issueMemberInvite(actorId: OfficeMemberId, input: OfficeMemberInviteIssueInput): Promise<OfficeMemberInviteIssueReceipt>

/**
 * Revoke a reviewed invitation; an already-set credential remains governed by the existing account controls.
 * @param actorId - Current authenticated administrator.
 * @param input - Invitation identity and observed revision.
 * @returns Retained revocation evidence; it does not remove or reset a password.
 */
revokeMemberInvite(actorId: OfficeMemberId, input: OfficeMemberInviteRevokeInput): Promise<OfficeMemberInvite>

/**
 * Authenticate a limited code and set only its target's first password in one original identity commit.
 * @param input - Code and recipient-selected password, with no caller-selected identity or role.
 * @param signal - Original request cancellation; unload prevents new commitment and drains admitted hashing.
 * @returns Only the login member id after commitment; no business token or automatic sign-in.
 */
acceptMemberInvite(input: OfficeMemberInviteAcceptInput, signal?: AbortSignal): Promise<OfficeMemberInviteAcceptReceipt>

/**
 * Enroll or reset employee credentials through a trusted, authenticated administrator adapter.
 * @param actorId - Verified administrator supplied by the gateway.
 * @param memberId - Active target employee.
 * @param password - Replacement password; never logged or returned.
 */
setIdentityPassword( actorId: OfficeMemberId, memberId: OfficeMemberId, password: string, ): Promise<void>

/**
 * Sign in without caller-claimed authority; adapters keep the returned secret out of UI and logs.
 * @param input - Employee id and password.
 * @returns A durable session's one-time bearer receipt for the trusted authentication adapter.
 */
login(input: OfficeLoginInput): Promise<OfficeLoginResult>

/**
 * Bind a gateway business request to its actual active employee and current role.
 * @param token - Opaque token from the authentication header, never a caller-selected actor id.
 * @returns Current employee authority; this does not expose password material.
 */
authenticate(token: string): OfficeMember

/**
 * Bind a trusted gateway operation to its session, including execution-time queue checks.
 * @param token - Actual request bearer token; never an employee id or claimed role.
 * @param operation - Trusted callback receiving the authenticated employee and a server-only denial-scope registrar.
 * @returns The operation result, with revoked or expired queued work rejected before execution.
 */
withSession<T>( token: string, operation: (memberId: OfficeMemberId, auditDenial: (scope: OfficeRequestDenialScope) => void) => Promise<T>, ): Promise<T>

/**
 * Read only a signed-in employee's device sessions.
 * @param token - Current opaque token.
 * @returns Sanitized own-session handles without bearer material.
 */
identitySessions(token: string): readonly OfficeSessionInfo[]

/**
 * Durably revoke this bearer session; repeating a successful logout is harmless.
 * @param token - Session to revoke.
 */
logout(token: string): Promise<void>

/**
 * Revoke only a device session belonging to the authenticated employee.
 * @param token - Current bearer token.
 * @param id - Own device-session handle.
 */
revokeIdentitySession(token: string, id: OfficeSessionId): Promise<void>

/**
 * Verify the current password before replacing it and revoking every old session.
 * @param token - Current bearer token.
 * @param input - Reviewed current password and replacement.
 */
changeIdentityPassword( token: string, input: OfficePasswordChangeInput, ): Promise<void>

/**
 * Read administrator-only enrollment metadata with no credential values.
 * @param actorId - Verified administrator.
 * @returns Enrollment presence, never salts, password hashes or tokens.
 */
identityOverview(actorId: OfficeMemberId): OfficeIdentityOverview

/**
 * Read administrator-managed departments, positions and formal employee affiliations.
 * @param actorId - Authenticated active employee.
 * @returns Authorized structure, including an explicit first-configuration state.
 */
organization(actorId: OfficeMemberId): OfficeOrganizationView

/**
 * Initialize formal organization once from the directory the administrator reviewed.
 * @param actorId - Authenticated administrator.
 * @param officeRevision - Reviewed office revision; a concurrent directory edit rejects first initialization.
 * @returns Committed structure; later calls never overwrite existing organization with profile labels.
 */
initializeOrganization( actorId: OfficeMemberId, officeRevision: number, ): Promise<OfficeOrganizationView>

/**
 * Create/edit/deactivate a department through current administrator authority and its reviewed version.
 * @param actorId - Authenticated administrator.
 * @param input - Department identity, parent, name and version.
 * @returns The committed department without changing contact labels or authorization roles.
 */
saveOrganizationUnit( actorId: OfficeMemberId, input: OfficeUnitInput, ): Promise<OfficeOrganizationUnit>

/**
 * Create/edit/deactivate a formal position; positions do not grant office authorization roles.
 * @param actorId - Authenticated administrator.
 * @param input - Position, optional department and reviewed version.
 * @returns Committed position, or a denial preserving in-use employee affiliations.
 */
savePosition( actorId: OfficeMemberId, input: OfficePositionInput, ): Promise<OfficePosition>

/**
 * Assign formal department and position independently of self-service contact profile edits.
 * @param actorId - Authenticated administrator.
 * @param input - Existing employee, target entities and reviewed assignment version.
 * @returns A committed affiliation, including versioned explicit unassignment.
 */
assignOrganization( actorId: OfficeMemberId, input: OfficeAssignmentInput, ): Promise<OfficeOrganizationAssignment>

/**
 * Reserve a resumable file under the employee's current membership, destination permissions and quota.
 * @param actorId - Authenticated employee supplied by the Host or gateway.
 * @param input - Reviewed immutable file declaration and retry identity.
 * @returns A durable owner-only upload ticket.
 */
beginDriveUpload(actorId: OfficeMemberId, input: OfficeDriveUploadDeclaration): Promise<OfficeDriveUploadTicket>

/**
 * List unfinished uploads for the current employee without exposing another account's receipt positions.
 * @param actorId - Authenticated active employee.
 * @returns Owner-only resumable tickets.
 */
driveUploads(actorId: OfficeMemberId): Promise<readonly OfficeDriveUploadTicket[]>

/**
 * Recover an owned upload after a lost response or application restart.
 * @param actorId - Current authenticated employee.
 * @param id - Server-minted upload coordinate.
 * @returns The confirmed private receipt state.
 */
getDriveUpload(actorId: OfficeMemberId, id: OfficeDriveUploadId): Promise<OfficeDriveUploadTicket>

/**
 * Stage one chunk after rechecking this employee's session, current directory access and shared quota.
 * @param actorId - Authenticated active employee.
 * @param input - Reviewed upload identity, position, digest and bounded encoded bytes.
 * @returns Acknowledged receipt positions after durability.
 */
appendDriveUpload(actorId: OfficeMemberId, input: OfficeDriveUploadChunkInput): Promise<OfficeDriveUploadTicket>

/**
 * Verify and publish a complete upload once, retaining the original request identity through uncertain responses.
 * @param actorId - Authenticated active employee.
 * @param id - Owned resumable upload coordinate.
 * @returns The confirmed completed ticket and logical file identity.
 */
completeDriveUpload(actorId: OfficeMemberId, id: OfficeDriveUploadId): Promise<OfficeDriveUploadTicket>

/**
 * Cancel owned staging; a file already durably published is reported as completed and retained.
 * @param actorId - Current active owner, including after destination access was revoked.
 * @param id - Server-owned upload identity.
 * @returns The confirmed terminal outcome; temporary-byte cleanup retries in the background.
 */
cancelDriveUpload(actorId: OfficeMemberId, id: OfficeDriveUploadId): Promise<OfficeDriveUploadTicket>

/**
 * Authorize and verify a file before giving the client its immutable download version.
 * @param actorId - Authenticated active reader.
 * @param id - Logical file identity.
 * @returns Verified metadata and the current bounded download chunk size.
 */
driveFileInfo(actorId: OfficeMemberId, id: OfficeDriveId): Promise<OfficeDriveDownloadInfo>

/**
 * Read current authorized version history without opening content or changing the file head.
 * @param actorId - Authenticated active reader.
 * @param id - Logical file identity.
 * @returns Immutable version metadata ordered newest first.
 */
driveHistory(actorId: OfficeMemberId, id: OfficeDriveId): OfficeDriveHistory

/**
 * Read only the current employee's visible recycle-bin roots.
 * @param actorId - Authenticated active owner.
 * @returns Retained deleted metadata with current restore permissions.
 */
driveTrash(actorId: OfficeMemberId): OfficeDriveTrash

/**
 * Review the exact owned deleted subtree before permanent cleanup.
 * @param actorId - Authenticated active owner.
 * @param id - Deleted root identity.
 * @returns Read-only scope totals and the digest required by confirmation.
 */
drivePurgePlan(actorId: OfficeMemberId, id: OfficeDriveId): OfficeDrivePurgePlan

/**
 * Permanently clear only an exactly reviewed owned subtree after durable authorization.
 * @param actorId - Authenticated active owner.
 * @param input - Exact reviewed revision, digest and stable request identity.
 * @returns Pending or completed receipt; only completion releases the charged quota.
 */
purgeDrive(actorId: OfficeMemberId, input: OfficeDrivePurgeInput): Promise<OfficeDrivePurgeReceipt>

/**
 * Inspect an existing owner cleanup receipt without changing its scope or reading bytes.
 * @param actorId - Authenticated active owner.
 * @param id - Original deleted root identity.
 * @returns Durable status or null when no permanent cleanup has been approved.
 */
drivePurgeStatus(actorId: OfficeMemberId, id: OfficeDriveId): OfficeDrivePurgeReceipt | null

/**
 * Continue an already approved owner cleanup, including after an uncertain acknowledgement.
 * @param actorId - Authenticated active owner.
 * @param id - Previously approved root; no new scope is authorized by this operation.
 * @returns Latest durable receipt; completed retries perform no further writes.
 */
retryDrivePurge(actorId: OfficeMemberId, id: OfficeDriveId): Promise<OfficeDrivePurgeReceipt>

/**
 * Confirm one reviewed deletion or restoration without discarding versions or Native files.
 * @param actorId - Authenticated active owner.
 * @param input - Reviewed revision, action and optional new restore name.
 * @returns Committed active or deleted metadata; denied writes do not publish.
 */
changeDriveLifecycle(actorId: OfficeMemberId, input: OfficeDriveLifecycleInput): Promise<OfficeDriveEntry | OfficeDriveTrashEntry>

/**
 * Authorize and verify a selected historical object before exposing download metadata.
 * @param actorId - Authenticated active reader.
 * @param id - Logical file identity.
 * @param versionId - Immutable version selected from authorized history.
 * @returns Verified version metadata with its original media type and current chunk bound.
 */
driveVersionInfo(actorId: OfficeMemberId, id: OfficeDriveId, versionId: OfficeDriveVersionId): Promise<OfficeDriveDownloadInfo>

/**
 * Read one reviewed immutable range with fresh membership and ancestor-permission checks.
 * @param actorId - Current authenticated active reader.
 * @param input - Logical file, immutable version and bounded byte span.
 * @returns Actual range bytes and their digest; denied or corrupt reads return no content.
 */
downloadDriveRange(actorId: OfficeMemberId, input: OfficeDriveRangeInput): Promise<OfficeDriveDownloadRange>
```

Source: [`packages/enterprise/office/src/index.ts`](../../packages/enterprise/office/src/index.ts)

<a id="ctxofficecontroller--officecontroller"></a>

### `ctx.officeController` — `OfficeController`

No method accepts a caller-selected actor id. This adapter is not a shared multiuser login gateway.

```ts cordis-catalog
/**
 * Read this employee's authorized board and directory.
 * @param date - Optional local day; absent selects office today.
 * @returns safe view or a business denial.
 */
@Remote view(date?: string): Promise<OfficeOutcome<OfficeView>>

/**
 * Search retained audit metadata using the Host's current administrator identity.
 * @param query - Explicit bounded filters and an exclusive older-page position.
 * @returns Authorized allowlisted metadata, or a denial rechecked by the office authority for this page.
 */
@Remote auditPage(query: OfficeAuditQuery): Promise<OfficeOutcome<OfficeAuditPage>>

/**
 * Read one bounded NDJSON batch after fresh administrator authorization.
 * @param query - Same reviewed filters and continuation used for audit search.
 * @returns Credential-free metadata content; each later batch requires another authorized request.
 */
@Remote auditExport(query: OfficeAuditQuery): Promise<OfficeOutcome<OfficeAuditExport>>

/**
 * Read only this employee's association draft for one native logical conversation.
 * @param conversationId - Native conversation identity; it is not an authorization credential.
 * @returns Reviewed private choices and explicit resolved/missing dependency metadata, without execution permission.
 */
@Remote conversationLinks(conversationId: OfficeConversationId): Promise<OfficeOutcome<OfficeConversationLinksView>>

/**
 * Save a reviewed private association list while keeping the actor assigned by the authenticated Host.
 * @param input - Conversation identity, reviewed version, exact retry id and selected tools or integrations.
 * @returns Confirmed association choices; this operation never prompts an Agent or runs a selected capability.
 */
@Remote saveConversationLinks(input: OfficeConversationLinksInput): Promise<OfficeOutcome<OfficeConversationLinks>>

/**
 * Bind an explicit office gesture before its separate Native prompt reaches this Host.
 * @param id - Exact Native input; this restriction never grants Session visibility or execution authority.
 * @returns A Host-lifetime restriction to the current employee; empty inputs carry no private history across restarts.
 */
@Remote prepareNativeInput(id: OfficeConversationId): Promise<OfficeOutcome<null>>

/**
 * Capture the employee's reviewed association version independently of native message delivery.
 * @param input - Logical conversation, reviewed version and exact native prompt retry id.
 * @returns Immutable private prepared context without execution authority, addresses or credentials.
 */
@Remote captureConversation(input: OfficeConversationCaptureInput): Promise<OfficeOutcome<OfficeConversationCapture>>

/**
 * Read the current employee's immutable prepared context after an uncertain response or restart.
 * @param id - Opaque context identity; ownership is checked independently of this value.
 * @returns Historical metadata that does not imply a native prompt was admitted or dispatched.
 */
@Remote conversationCapture(id: OfficeConversationCaptureId): Promise<OfficeOutcome<OfficeConversationCapture>>

/**
 * Read this employee's reviewed drive references for one logical native conversation.
 * @param id - Native Session identity, without file access authority.
 * @returns Private immutable-version metadata; content reads remain separately authorized.
 */
@Remote conversationFiles(id: OfficeConversationId): Promise<OfficeOutcome<OfficeConversationFilesView>>

/**
 * Save reviewed immutable file coordinates as the authenticated employee.
 * @param input - Current selection revision, exact retry UUID and selected file versions.
 * @returns Committed metadata; client-supplied names, bytes and employee identities are not admitted.
 */
@Remote saveConversationFiles(input: OfficeConversationFilesInput): Promise<OfficeOutcome<OfficeConversationFiles>>

/**
 * Prepare file context before a separate native prompt admission.
 * @param input - Reviewed file selection and exact native prompt request identity.
 * @returns Private immutable metadata; later reads still require current permissions.
 */
@Remote captureConversationFiles(input: OfficeConversationCaptureInput): Promise<OfficeOutcome<OfficeConversationFilesCapture>>

/**
 * Recover submitted file evidence after an uncertain response or restart.
 * @param id - Server-issued private capture identity.
 * @returns Historical metadata for this employee and authority role, without execution authority.
 */
@Remote conversationFilesCapture(id: OfficeConversationFilesCaptureId): Promise<OfficeOutcome<OfficeConversationFilesCapture>>

/**
 * Read a bounded verified UTF-8 window from a file selected in submitted context.
 * @param input - Owned capture, selected file id and character coordinates.
 * @returns Inert text only after fresh membership, ancestor ACL and version checks.
 */
@Remote readConversationFile(input: OfficeConversationFileReadInput): Promise<OfficeOutcome<OfficeConversationFileRead>>

/**
 * Read one submitted PDF page for a native tool without creating an attachment copy or a browser RPC.
 * @param input - Owned capture, selected immutable file and page text window.
 * @param signal - Original native tool cancellation; unload also stops the operation.
 * @returns Actual bounded PDF text after fresh authority checks, or a stable office denial.
 */
readConversationPdf(input: OfficeConversationPdfReadInput, signal: AbortSignal): Promise<OfficeOutcome<OfficeConversationPdfRead>>

/**
 * Read submitted DOCX body paragraphs and tables for the exact original native tool call.
 * @param input - Owned submitted file and bounded body-text window.
 * @param signal - Original native cancellation, combined with the controller lifetime.
 * @returns Actual verified text after current authority checks, or a stable office denial; no browser RPC is added.
 */
readConversationDocx(input: OfficeConversationDocxReadInput, signal: AbortSignal): Promise<OfficeOutcome<OfficeConversationDocxRead>>

/**
 * Read exact saved spreadsheet cells for the original native tool without adding a browser RPC.
 * @param input - Owned submitted file, workbook sheet number and sparse-cell window.
 * @param signal - Original native cancellation, combined with controller lifetime.
 * @returns Verified raw values and saved formula caches after current authority checks, or a stable office denial.
 */
readConversationXlsx(input: OfficeConversationXlsxReadInput, signal: AbortSignal): Promise<OfficeOutcome<OfficeConversationXlsxRead>>

/**
 * Read saved presentation text or explicit speaker notes for the original native tool without a browser RPC.
 * @param input - Submitted immutable file, actual slide number, explicit section and bounded UTF-16 window.
 * @param signal - Original native cancellation, combined with the controller lifetime.
 * @returns Verified saved text after current authority checks, or a stable office denial.
 */
readConversationPptx(input: OfficeConversationPptxReadInput, signal: AbortSignal): Promise<OfficeOutcome<OfficeConversationPptxRead>>

/**
 * Register a bounded descriptive integration manifest as the authenticated administrator.
 * @param input - Exact JSON object and retained retry UUID; contains no executable code or credentials.
 * @returns Committed company registration or a business denial.
 */
@Remote importIntegration(input: OfficeIntegrationImportInput): Promise<OfficeOutcome<OfficeIntegration>>

/**
 * Read company connection readiness without resolving credential values in the employee Host.
 * @returns Current versions and administrator-only configuration choices.
 */
@Remote connections(): Promise<OfficeOutcome<OfficeConnectorView>>

/**
 * Read one company system's role-filtered declarations without performing a business operation.
 * @param integrationId - Registered system identity, never a caller-selected address or actor.
 * @returns Bounded current directory without private connection configuration or role-admission rules.
 */
@Remote connectorActions(integrationId: OfficeIntegrationId): Promise<OfficeOutcome<OfficeConnectorActionsView>>

/**
 * Read this authenticated employee's retained external-operation receipts without another employee's request data.
 * @returns Own execution stages and authoritative results; unknown outcomes never imply success or an automatic retry.
 */
@Remote connectorExecutions(): Promise<OfficeOutcome<readonly OfficeConnectorExecutionReceipt[]>>

/**
 * Read this employee's bounded execution metadata for one system without large results or raw input values.
 * @param query - Registered system and optional own last-entry cursor.
 * @returns Newest-first own receipt page with an explicit older-page anchor.
 */
@Remote connectorExecutionPage(query: OfficeConnectorExecutionQuery): Promise<OfficeOutcome<OfficeConnectorExecutionPage>>

/**
 * Read one retained own receipt after an explicit detail selection.
 * @param executionId - Server-generated own operation identity, never another employee's claimed actor.
 * @returns Bounded result and audit history; adapter removal does not erase retained evidence.
 */
@Remote connectorExecutionDetail(executionId: OfficeConnectorExecutionId): Promise<OfficeOutcome<OfficeConnectorExecutionReceipt>>

/**
 * Query the original customer's outcome for an own unknown operation without replaying its business request.
 * @param executionId - Own server-generated execution identity.
 * @returns Current private receipt and explicit availability/uncertainty, after current authority and durable result checks.
 */
@Remote checkConnectorExecution(executionId: OfficeConnectorExecutionId): Promise<OfficeOutcome<OfficeConnectorExecutionCheck>>

/**
 * Submit a reviewed declared write; unknown outcomes never trigger automatic re-dispatch.
 * @param input - Exact declared business fields, reviewed connection/provider coordinates and stable retry UUID.
 * @returns Own durable receipt or a stable denial/unknown handling identity, without private diagnostics.
 */
@Remote writeConnectorAction(input: OfficeConnectorWriteInput): Promise<OfficeOutcome<OfficeConnectorExecutionReceipt>>

/**
 * Query a declared read action under the authenticated employee's current permissions.
 * @param input - Reviewed system, read action, saved connection and provider versions.
 * @returns Bounded plain-text fields or a network outcome; caller-supplied identities and URLs are rejected.
 */
@Remote readConnectorAction(input: OfficeConnectorReadInput): Promise<OfficeOutcome<OfficeConnectorReadReceipt>>

/**
 * Persist a reviewed declared read under an exact employee-scoped retry identity.
 * @param input - Original action/source coordinates and stable request UUID.
 * @returns Durable network outcome and currently authorized retained data.
 */
@Remote syncConnectorAction(input: OfficeConnectorSyncInput): Promise<OfficeOutcome<OfficeConnectorSyncDetail>>

/**
 * Read this employee's small synchronization metadata without a customer request.
 * @param query - Selected system and owner-scoped older anchor.
 * @returns Bounded private metadata page.
 */
@Remote connectorSyncPage(query: OfficeConnectorSyncQuery): Promise<OfficeOutcome<OfficeConnectorSyncPage>>

/**
 * Recheck current access before returning the owner's retained synchronization fields.
 * @param id - Server synchronization identity.
 * @returns Actual historical metadata with unavailable content withheld.
 */
@Remote connectorSyncDetail(id: OfficeConnectorSyncId): Promise<OfficeOutcome<OfficeConnectorSyncDetail>>

/**
 * Discover actions only for a system in this employee's submitted native conversation context.
 * @param input - Private capture and selected registered system identity.
 * @returns Role-admitted directory after current association and connection checks.
 */
@Remote conversationConnectorActions(input: OfficeConversationConnectorInput): Promise<OfficeOutcome<OfficeConnectorActionsView>>

/**
 * Query a declared read action under the authenticated employee's current native conversation associations.
 * @param input - Private capture and exact reviewed action/connection/provider coordinates.
 * @returns Real bounded result or a current business denial; arbitrary actors and URLs are rejected.
 */
@Remote readConnectorActionFromConversation(input: OfficeConversationConnectorReadInput): Promise<OfficeOutcome<OfficeConnectorReadReceipt>>

/**
 * Save a reviewed connection as the authenticated administrator.
 * @param input - Deployment-approved location and credential alias, version and exact retry UUID.
 * @returns Durable metadata; importing a manifest remains an independent operation.
 */
@Remote saveConnection(input: OfficeConnectorInput): Promise<OfficeOutcome<OfficeConnectorEntry>>

/**
 * Check a reviewed connection with credentials resolved only by its owning office server.
 * @param integrationId - Saved integration identity, never an arbitrary URL.
 * @param revision - Reviewed connection version.
 * @returns Sanitized bounded probe outcome; no business writes or remote response content.
 */
@Remote probeConnection(integrationId: OfficeIntegrationId, revision: number): Promise<OfficeOutcome<OfficeConnectorProbe>>

/**
 * Publish an administrator-reviewed announcement and recipient list atomically.
 * @param input - Plain text, delivery scope and stable retry UUID.
 * @returns Durable publication or a business denial.
 */
@Remote publishAnnouncement(input: OfficeAnnouncementInput): Promise<OfficeOutcome<OfficeAnnouncement>>

/**
 * Acknowledge only this employee's delivered announcement.
 * @param id - Publication identity.
 * @returns Null after durability, or a business denial.
 */
@Remote markAnnouncementRead(id: OfficeAnnouncementId): Promise<OfficeOutcome<null>>

/**
 * Withdraw a reviewed company announcement as the current administrator.
 * @param id - Publication identity.
 * @param expectedRevision - Reviewed content revision.
 * @returns Null after withdrawal, or a business denial.
 */
@Remote withdrawAnnouncement(id: OfficeAnnouncementId, expectedRevision: number): Promise<OfficeOutcome<null>>

/**
 * List or search an employee-authorized virtual drive location.
 * @param input - Space, opaque folder and name query.
 * @returns Only visible metadata and breadcrumbs.
 */
@Remote drive(input: OfficeDriveQuery): Promise<OfficeOutcome<OfficeDriveView>>

/**
 * Create a directory whose owner comes from the Host identity.
 * @param input - Logical destination and name.
 * @returns Committed directory metadata.
 */
@Remote createDriveFolder( input: OfficeDriveFolderInput, ): Promise<OfficeOutcome<OfficeDriveEntry>>

/**
 * Commit actual bounded bytes and their authorized file metadata.
 * @param input - Logical destination, file content, length and stable retry id.
 * @returns File metadata after durability, or a business denial.
 */
@Remote uploadDriveFile( input: OfficeDriveUploadInput, ): Promise<OfficeOutcome<OfficeDriveEntry>>

/**
 * Read immutable file bytes through current employee and ancestor authorization.
 * @param id - Opaque enterprise file identity, never a native path.
 * @returns Verified bytes with their SHA-256 digest.
 */
@Remote downloadDriveFile( id: OfficeDriveId, ): Promise<OfficeOutcome<OfficeDriveDownload>>

/**
 * Rename a reviewed, editable directory entry.
 * @param input - Opaque identity, version and name.
 * @returns Committed metadata or a business denial.
 */
@Remote renameDriveEntry( input: OfficeDriveRenameInput, ): Promise<OfficeOutcome<OfficeDriveEntry>>

/**
 * Replace shared account conditions through ownership and a reviewed version.
 * @param input - Entry, version, default and account overrides.
 * @returns Owner-authorized committed metadata.
 */
@Remote saveDrivePermissions( input: OfficeDrivePermissionsInput, ): Promise<OfficeOutcome<OfficeDriveEntry>>

/**
 * Create and durably dispatch employee work.
 * @param input - Task or to-do fields.
 * @returns committed item or a business denial.
 */
@Remote createWork(input: OfficeWorkInput): Promise<OfficeOutcome<OfficeItem>>

/**
 * Execute one internal task/to-do under this employee's reviewed reminder context.
 * @param input - Private capture, stable execution retry identity and work fields.
 * @returns Durable receipt or a current business denial; retries do not create another item.
 */
@Remote createWorkFromConversation(input: OfficeAgentWorkInput): Promise<OfficeOutcome<OfficeAgentWorkReceipt>>

/**
 * Create a meeting and its recipient invitations atomically.
 * @param input - Schedule and invitees.
 * @returns committed meeting or a business denial.
 */
@Remote createSchedule( input: OfficeScheduleInput, ): Promise<OfficeOutcome<OfficeItem>>

/**
 * Submit a task delivery or review its current submission through the authenticated employee.
 * @param id - Existing task identity.
 * @param revision - Parent revision reviewed before submitting or deciding.
 * @param input - Submission, confirmation or return with an explanation.
 * @returns Committed task with retained delivery history, or a business denial without partial changes.
 */
@Remote reviewTaskDelivery(id: OfficeItemId, revision: number, input: OfficeTaskDeliveryInput): Promise<OfficeOutcome<OfficeItem>>

/**
 * Replace a task/to-do checklist under its current parent permissions and reviewed version.
 * @param id - Existing work item identity.
 * @param revision - Parent revision reviewed before editing.
 * @param input - Existing entries or null ids for server-created entries.
 * @returns Committed work or a business denial without partial checklist changes.
 */
@Remote updateWorkSubtasks(id: OfficeItemId, revision: number, input: OfficeWorkSubtasksInput): Promise<OfficeOutcome<OfficeItem>>

/**
 * Read attachment metadata under current work and Drive access.
 * @param id - Existing task/to-do identity.
 * @returns Available names or metadata-free unavailable references.
 */
@Remote workAttachments(id: OfficeItemId): Promise<OfficeOutcome<OfficeWorkAttachmentsView>>

/**
 * Apply a confirmed archive, recycle-bin deletion or restoration under creator/admin authority.
 * @param id - Existing readable work, including inactive records.
 * @param revision - Item revision reviewed before confirmation.
 * @param input - Action and retained explanation.
 * @returns Committed record or denial without partial lifecycle changes.
 */
@Remote changeWorkLifecycle(id: OfficeItemId, revision: number, input: OfficeWorkLifecycleInput): Promise<OfficeOutcome<OfficeItem>>

/**
 * Save reviewed Drive references without granting file access.
 * @param id - Existing open task/to-do.
 * @param revision - Reviewed parent revision.
 * @param input - At most 20 distinct reviewed file versions.
 * @returns Committed work or denial without partial changes.
 */
@Remote updateWorkAttachments(id: OfficeItemId, revision: number, input: OfficeWorkAttachmentsInput): Promise<OfficeOutcome<OfficeItem>>

/**
 * Authorize one linked reviewed version before verified Drive download.
 * @param id - Readable task/to-do retaining the reference.
 * @param fileId - Logical Drive file identity.
 * @returns Physically verified metadata or current-access denial.
 */
@Remote workAttachmentInfo(id: OfficeItemId, fileId: OfficeDriveId): Promise<OfficeOutcome<OfficeDriveDownloadInfo>>

/**
 * Query coworkers' busy flags through the company's explicitly enabled internal meeting policy.
 * @param input - Office-local interval, selected members and an optional readable meeting to exclude.
 * @returns Current busy flags or an authenticated business denial, without private meeting content.
 */
@Remote scheduleAvailability(input: OfficeScheduleAvailabilityInput): Promise<OfficeOutcome<OfficeScheduleAvailability>>

/**
 * Update an existing meeting using its reviewed revision.
 * @param id - Existing meeting identity.
 * @param revision - Revision reviewed before editing.
 * @param input - Content, time and optional invitees; the organizer and lifecycle remain unchanged.
 * @returns Committed meeting or a business denial.
 */
@Remote updateSchedule(id: OfficeItemId, revision: number, input: OfficeScheduleUpdateInput): Promise<OfficeOutcome<OfficeItem>>

/**
 * Decide a task or transfer a to-do under the current authenticated employee.
 * @param id - Task or to-do being reviewed.
 * @param revision - Last reviewed task revision.
 * @param input - Accept, reject with reason, or transfer to an active new assignee with reason.
 * @returns Committed work with history or a business denial; stale and closed items are not changed.
 */
@Remote decideTask(id: OfficeItemId, revision: number, input: OfficeTaskDecisionInput): Promise<OfficeOutcome<OfficeItem>>

/**
 * Edit task/to-do content on the revision reviewed by this employee.
 * @param id - Existing task or to-do identity.
 * @param revision - Reviewed version, including task decisions.
 * @param input - Content and deadline; assignment, kind and status remain unchanged.
 * @returns Committed work or a business denial; stale and closed edits are not written.
 */
@Remote updateWork(id: OfficeItemId, revision: number, input: OfficeWorkUpdateInput): Promise<OfficeOutcome<OfficeItem>>

/**
 * Update one authorized item without overwriting a concurrent edit.
 * @param id - Target item.
 * @param revision - Last observed item revision.
 * @param status - Desired state.
 * @returns committed item or a business denial.
 */
@Remote setStatus( id: OfficeItemId, revision: number, status: OfficeItemStatus, ): Promise<OfficeOutcome<OfficeItem>>

/**
 * Answer only this employee's invitation on the version they reviewed.
 * @param id - Invited meeting identity.
 * @param revision - Last observed item revision.
 * @param reply - Accept or decline the invitation.
 * @returns The committed meeting or an expected business denial.
 */
@Remote reply( id: OfficeItemId, revision: number, reply: 'accepted' | 'declined', ): Promise<OfficeOutcome<OfficeItem>>

/**
 * Mark one notification in this employee's own inbox as read.
 * @param id - Recipient-owned notification identity.
 * @returns Confirmation or an expected business denial.
 */
@Remote markRead(id: OfficeNotificationId): Promise<OfficeOutcome<null>>

/**
 * Acknowledge a currently eligible reminder owned by this authenticated employee.
 * @param id - Server-created reminder occurrence identity.
 * @returns A durable read acknowledgement or an expected authorization denial.
 */
@Remote markReminderRead(id: OfficeReminderId): Promise<OfficeOutcome<null>>

/**
 * Edit contact details without changing this principal or authorization role.
 * @param profile - Complete public contact fields.
 * @returns committed employee or a business denial.
 */
@Remote updateProfile(profile: OfficeProfile): Promise<OfficeOutcome<OfficeMember>>

/**
 * Create or edit an employee through administrator authority and a reviewed record.
 * @param member - Complete employee fields.
 * @param expected - Null creates a new identity; a prior record protects an edit.
 * @returns Committed member or a business denial without overwriting another edit.
 */
@Remote saveMember( member: OfficeMember, expected: OfficeMember | null, ): Promise<OfficeOutcome<OfficeMember>>

/**
 * Read only this employee's private conversations and one bounded history page.
 * @param peer - Optional other participant.
 * @param before - Exclusive sequence for older history.
 * @returns Participant-authorized private projection.
 */
@Remote chat( peer?: OfficeMemberId, before?: number, ): Promise<OfficeOutcome<OfficeChatView>>

/**
 * Read only this Host employee's private unsent drafts.
 * @returns Authorized drafts and versions, or an expected denial.
 */
@Remote chatDrafts(): Promise<OfficeOutcome<OfficeChatDraftView>>

/**
 * Read only the current employee's file-message limits and usage.
 * @returns Advertised inline-file policy, or an expected denial.
 */
@Remote chatFileLimits(): Promise<OfficeOutcome<OfficeChatFileLimits>>

/**
 * Publish a private message after its ordered files are durable and verified.
 * @param input - Stable original message identity, caption and bounded files.
 * @returns Published header with immutable file metadata.
 */
@Remote sendMessageFiles(input: OfficeChatFilesInput): Promise<OfficeOutcome<OfficeChatMessage>>

/**
 * Download one private message file as its active sender or recipient.
 * @param input - Message and opaque immutable attachment coordinates.
 * @returns Verified complete content without any server path.
 */
@Remote downloadChatFile(input: OfficeChatFileCoordinates): Promise<OfficeOutcome<OfficeChatFileDownload>>

/**
 * Read only the authenticated employee's file draft metadata and versions.
 * @returns Private contact selections and owner quota without inline file bytes.
 */
@Remote chatFileDrafts(): Promise<OfficeOutcome<OfficeChatFileDraftView>>

/**
 * Save one reviewed private contact selection with bounded real bytes.
 * @param input - Exact retry UUID, contact version and ordered complete files.
 * @returns Durable metadata or a stable denial retaining the existing draft.
 */
@Remote saveChatFileDraft(input: OfficeChatFileDraftInput): Promise<OfficeOutcome<OfficeChatFileDraft>>

/**
 * Restore one file from the authenticated employee's own reviewed contact selection.
 * @param input - Contact, version and opaque file identity.
 * @returns Verified bounded bytes without granting the intended recipient draft access.
 */
@Remote downloadChatFileDraft(input: OfficeChatFileDraftCoordinates): Promise<OfficeOutcome<OfficeChatFileDraftDownload>>

/**
 * Publish the exact reviewed durable selection and reconcile its original clear-on-send decision.
 * @param input - Draft version, captured caption and stable message retry identity.
 * @returns One committed private file message; a retry never clears a newer selection.
 */
@Remote sendChatFileDraft(input: OfficeChatFileDraftSendInput): Promise<OfficeOutcome<OfficeChatMessage>>

/**
 * Save an unsent contact draft using a reviewed version and retry identity.
 * @param input - Contact, text, version and idempotency key.
 * @returns Committed draft or a conflict that preserves the user's local input.
 */
@Remote saveChatDraft( input: OfficeChatDraftInput, ): Promise<OfficeOutcome<OfficeChatDraft>>

/**
 * Send a private human message with an idempotent retry identity.
 * @param input - Message identity, recipient and text.
 * @returns Confirmed message or an expected denial.
 */
@Remote sendMessage( input: OfficeChatInput, ): Promise<OfficeOutcome<OfficeChatMessage>>

/**
 * Acknowledge an observed cursor in this employee's own conversation.
 * @param peer - Other participant.
 * @param through - Message sequence actually displayed to this employee.
 * @returns Durable acknowledgement or an expected denial.
 */
@Remote readChat( peer: OfficeMemberId, through: number, ): Promise<OfficeOutcome<null>>

/**
 * Read the configured office connection without exposing its secret session.
 * @returns Sanitized connection state or a business denial.
 */
@Remote connection(): Promise<OfficeOutcome<OfficeConnection>>

/**
 * Inspect declared local integration packages through the existing profile manager without executing package operations.
 * @returns Actual package selection and Loader phases; gateway mode never represents the employee Host as its server.
 */
@Remote integrationPlugins(): Promise<OfficeOutcome<OfficeIntegrationPlugins>>

/**
 * Sign in to the configured central office and retain its token in the Host credential provider.
 * @param input - Employee id and password, with no claimed role.
 * @returns Sanitized connection state after the credential write completes.
 */
@Remote signIn(input: OfficeLoginInput): Promise<OfficeOutcome<OfficeConnection>>

/**
 * Revoke the central office session before clearing the exact local credential.
 * @returns Confirmation after durable server revocation and local credential cleanup.
 */
@Remote signOut(): Promise<OfficeOutcome<null>>

/**
 * Read only the signed-in employee's device-session handles.
 * @returns Sanitized own-session metadata or a business denial.
 */
@Remote identitySessions(): Promise<OfficeOutcome<readonly OfficeSessionInfo[]>>

/**
 * Revoke a session belonging to the current employee.
 * @param id - Public own-session handle.
 * @returns Confirmation after the server commit.
 */
@Remote revokeIdentitySession(id: OfficeSessionId): Promise<OfficeOutcome<null>>

/**
 * Verify the old password, replace it and revoke every previous session.
 * @param input - Current and replacement passwords.
 * @returns Confirmation; the employee must then sign in again.
 */
@Remote changeIdentityPassword( input: OfficePasswordChangeInput, ): Promise<OfficeOutcome<null>>

/**
 * Discover a safe optional invitation capability without making it a login precondition.
 * @returns Capability from the configured gateway, or null for local, older or unavailable authorities.
 */
@Remote memberInviteCapability(): Promise<OfficeOutcome<OfficeMemberInviteCapability | null>>

/**
 * Read one managed member's latest invitation through current central administrator authority.
 * @param memberId - Existing company employee from the administrator's directory.
 * @returns Safe metadata and current independent facts without a code or hash.
 */
@Remote memberInvite(memberId: OfficeMemberId): Promise<OfficeOutcome<OfficeMemberInviteView>>

/**
 * Sign a reviewed first-password invitation through the selected central authority.
 * @param input - Current member/role, finite expiry and retained issuance request UUID.
 * @returns Original metadata; only the first committed response contains its nonrecoverable code.
 */
@Remote issueMemberInvite(input: OfficeMemberInviteIssueInput): Promise<OfficeOutcome<OfficeMemberInviteIssueReceipt>>

/**
 * Revoke a reviewed invitation without removing an already-set credential.
 * @param input - Exact invitation id and observed revision.
 * @returns Retained revocation metadata after current administrator authorization.
 */
@Remote revokeMemberInvite(input: OfficeMemberInviteRevokeInput): Promise<OfficeOutcome<OfficeMemberInvite>>

/**
 * Accept a limited first-password code without signing in or replacing the current Host account.
 * @param input - Recipient-selected code and new password; no member or role override is accepted.
 * @returns Committed member id for the existing login form, or a safe denial.
 */
@Remote acceptMemberInvite(input: OfficeMemberInviteAcceptInput): Promise<OfficeOutcome<OfficeMemberInviteAcceptReceipt>>

/**
 * Read credential-enrollment presence through central administrator authority.
 * @returns Enrollment presence without credential values, or a business denial.
 */
@Remote identityOverview(): Promise<OfficeOutcome<OfficeIdentityOverview>>

/**
 * Enroll or reset an active employee through central administrator authority.
 * @param memberId - Target employee from the managed directory.
 * @param password - Replacement password; no token or hash is returned.
 * @returns Confirmation after all target sessions have been revoked.
 */
@Remote setIdentityPassword( memberId: OfficeMemberId, password: string, ): Promise<OfficeOutcome<null>>

/**
 * Read authorized formal organization or its explicit first-configuration state.
 * @returns Departments, positions and current affiliations without secret account data.
 */
@Remote organization(): Promise<OfficeOutcome<OfficeOrganizationView>>

/**
 * Adopt the directory's reviewed department/position labels once through administrator authority.
 * @param officeRevision - Office revision displayed at the configuration review.
 * @returns Committed organization; repeated calls preserve existing formal assignments.
 */
@Remote initializeOrganization( officeRevision: number, ): Promise<OfficeOutcome<OfficeOrganizationView>>

/**
 * Create, edit or deactivate one reviewed department.
 * @param input - Opaque department, reviewed version, name and parent.
 * @returns Committed department after server authority and hierarchy validation.
 */
@Remote saveOrganizationUnit( input: OfficeUnitInput, ): Promise<OfficeOutcome<OfficeOrganizationUnit>>

/**
 * Create, edit or deactivate an administrator-managed position.
 * @param input - Position, department and reviewed version.
 * @returns Committed position; this does not grant an authorization role.
 */
@Remote savePosition( input: OfficePositionInput, ): Promise<OfficeOutcome<OfficePosition>>

/**
 * Change a formal employee affiliation through administrator authority.
 * @param input - Employee, department, position and observed assignment version.
 * @returns Committed formal affiliation, independent of editable profile labels.
 */
@Remote assignOrganization( input: OfficeAssignmentInput, ): Promise<OfficeOutcome<OfficeOrganizationAssignment>>

/**
 * Reserve a resumable file using the Host's current authenticated employee.
 * @param input - Reviewed immutable destination, length, digest and retry identity.
 * @returns An owner-only durable ticket or business denial.
 */
@Remote beginDriveUpload(input: OfficeDriveUploadDeclaration): Promise<OfficeOutcome<OfficeDriveUploadTicket>>

/**
 * Recover only the current employee's unfinished uploads.
 * @returns Private resumable tickets, excluding other employees and terminal history.
 */
@Remote driveUploads(): Promise<OfficeOutcome<readonly OfficeDriveUploadTicket[]>>

/**
 * Resolve an owned upload after an uncertain response.
 * @param id - Server-minted upload coordinate.
 * @returns Confirmed receipt state or an indistinguishable missing/foreign denial.
 */
@Remote getDriveUpload(id: OfficeDriveUploadId): Promise<OfficeOutcome<OfficeDriveUploadTicket>>

/**
 * Stage one bounded chunk under current membership, session and directory permissions.
 * @param input - Owned upload, position, digest and canonical encoded bytes.
 * @returns Receipt positions only after durable acknowledgement.
 */
@Remote appendDriveUpload(input: OfficeDriveUploadChunkInput): Promise<OfficeOutcome<OfficeDriveUploadTicket>>

/**
 * Publish the reviewed complete file once after verifying all bytes.
 * @param id - Owned upload identity.
 * @returns A confirmed completed ticket or a retryable denial.
 */
@Remote completeDriveUpload(id: OfficeDriveUploadId): Promise<OfficeOutcome<OfficeDriveUploadTicket>>

/**
 * Cancel owned staging while retaining an already committed file after an uncertain completion response.
 * @param id - Server-owned upload coordinate.
 * @returns The confirmed terminal outcome.
 */
@Remote cancelDriveUpload(id: OfficeDriveUploadId): Promise<OfficeOutcome<OfficeDriveUploadTicket>>

/**
 * Authorize and verify a file before starting bounded downloads.
 * @param id - Logical enterprise file identity.
 * @returns Safe metadata, immutable version and negotiated range size.
 */
@Remote driveFileInfo(id: OfficeDriveId): Promise<OfficeOutcome<OfficeDriveDownloadInfo>>

/**
 * Read version metadata using the employee's current file permissions.
 * @param id - Logical file identity.
 * @returns Authorized version history without content or retry credentials.
 */
@Remote driveHistory(id: OfficeDriveId): Promise<OfficeOutcome<OfficeDriveHistory>>

/**
 * Read the employee's recoverable deleted roots.
 * @returns Authorized owner metadata and current restore capabilities.
 */
@Remote driveTrash(): Promise<OfficeOutcome<OfficeDriveTrash>>

/**
 * Review the exact owned deleted subtree before irreversible cleanup.
 * @param id - Deleted root identity.
 * @returns Current scope totals and confirmation digest.
 */
@Remote drivePurgePlan(id: OfficeDriveId): Promise<OfficeOutcome<OfficeDrivePurgePlan>>

/**
 * Submit the original reviewed permanent-cleanup confirmation.
 * @param input - Exact revision, digest and stable request identity.
 * @returns Durable pending or completed cleanup receipt.
 */
@Remote purgeDrive(input: OfficeDrivePurgeInput): Promise<OfficeOutcome<OfficeDrivePurgeReceipt>>

/**
 * Read an owner's existing cleanup status without touching bytes.
 * @param id - Original deleted root identity.
 * @returns Durable receipt, or null before approval.
 */
@Remote drivePurgeStatus(id: OfficeDriveId): Promise<OfficeOutcome<OfficeDrivePurgeReceipt | null>>

/**
 * Continue only an already approved permanent cleanup.
 * @param id - Original approved root identity.
 * @returns Current durable status; a completed retry does not repeat metadata writes.
 */
@Remote retryDrivePurge(id: OfficeDriveId): Promise<OfficeOutcome<OfficeDrivePurgeReceipt>>

/**
 * Confirm one reviewed owner deletion or restoration.
 * @param input - Exact revision, action and optional restore name.
 * @returns Confirmed metadata or a typed denial; versions and Native files remain retained.
 */
@Remote changeDriveLifecycle(input: OfficeDriveLifecycleInput): Promise<OfficeOutcome<OfficeDriveEntry | OfficeDriveTrashEntry>>

/**
 * Verify one historical file version before downloading its bytes.
 * @param id - Logical file identity.
 * @param versionId - Immutable authorized history selection.
 * @returns Verified version metadata and bounded download coordinates.
 */
@Remote driveVersionInfo(id: OfficeDriveId, versionId: OfficeDriveVersionId): Promise<OfficeOutcome<OfficeDriveDownloadInfo>>

/**
 * Read one immutable version range after fresh employee and ancestor authorization.
 * @param input - Reviewed file, version and bounded byte coordinates.
 * @returns Verified bytes and a range digest.
 */
@Remote downloadDriveRange(input: OfficeDriveRangeInput): Promise<OfficeOutcome<OfficeDriveDownloadRange>>

/**
 * Read this employee's private customization metadata through the selected office authority.
 * @param before - Exclusive own save position, or null for the newest page.
 * @returns Bounded own metadata without requirement bodies.
 */
@Remote customizationRequests(before: number | null): Promise<OfficeOutcome<OfficeCustomizationPage>>

/**
 * Read a currently authorized saved draft for explicit editing or export.
 * @param id - Server-issued request identity.
 * @returns Latest own record; this never sends externally.
 */
@Remote customizationRequest(id: OfficeCustomizationId): Promise<OfficeOutcome<OfficeCustomizationRecord>>

/**
 * Save reviewed private requirements without choosing a recipient or transport.
 * @param input - Strict fields, reviewed version and original retry UUID.
 * @returns Durable original receipt or an expected denial.
 */
@Remote saveCustomizationRequest(input: OfficeCustomizationInput): Promise<OfficeOutcome<OfficeCustomizationSaveReceipt>>
```

Source: [`packages/client/ui-office/src/index.ts`](../../packages/client/ui-office/src/index.ts)

<a id="ctxofficegateway--officegateway"></a>

### `ctx.officeGateway` — `OfficeGateway`

Central authenticated office listener; a separate employee Host retains all native Agent tools.

Source: [`packages/enterprise/office-gateway/src/index.ts`](../../packages/enterprise/office-gateway/src/index.ts)

<a id="office-events"></a>

### `office/*` events

<a id="officeannouncements-changed--parallel"></a>

#### `office/announcements-changed` — parallel

A publication, withdrawal or acknowledgement changed; no text or recipient identities are broadcast.

```ts cordis-catalog
/**
 * A publication, withdrawal or acknowledgement changed; no text or recipient identities are broadcast.
 * @mode parallel
 */
'office/announcements-changed'(): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)

<a id="officechanged--parallel"></a>

#### `office/changed` — parallel

Committed office revision. Consumers re-read an employee-authorized projection.

```ts cordis-catalog
/**
 * Committed office revision. Consumers re-read an employee-authorized projection.
 * @mode parallel
 * @param revision - New durable revision.
 */
'office/changed'(revision: number): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)

<a id="officechat-changed--parallel"></a>

#### `office/chat-changed` — parallel

Committed private messaging change; consumers re-read only their own conversations.

```ts cordis-catalog
/**
 * Committed private messaging change; consumers re-read only their own conversations.
 * @mode parallel
 */
'office/chat-changed'(): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)

<a id="officechat-drafts-changed--parallel"></a>

#### `office/chat-drafts-changed` — parallel

Private drafts changed; readers fetch only their authenticated employee's drafts.

```ts cordis-catalog
/**
 * Private drafts changed; readers fetch only their authenticated employee's drafts.
 * @mode parallel
 */
'office/chat-drafts-changed'(): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)

<a id="officeconversation-links-changed--parallel"></a>

#### `office/conversation-links-changed` — parallel

A private conversation choice version changed; identities and selected capabilities are not broadcast.

```ts cordis-catalog
/**
 * A private conversation choice version changed; identities and selected capabilities are not broadcast.
 * @mode parallel
 */
'office/conversation-links-changed'(): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)

<a id="officedrive-changed--parallel"></a>

#### `office/drive-changed` — parallel

Drive metadata changed; clients re-read an authorized directory.

```ts cordis-catalog
/**
 * Drive metadata changed; clients re-read an authorized directory.
 * @mode parallel
 */
'office/drive-changed'(): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)

<a id="officeintegrations-changed--parallel"></a>

#### `office/integrations-changed` — parallel

Company integration catalog changed; no manifest or credentials enter this event.

```ts cordis-catalog
/**
 * Company integration catalog changed; no manifest or credentials enter this event.
 * @mode parallel
 */
'office/integrations-changed'(): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)

<a id="officeorganization-changed--parallel"></a>

#### `office/organization-changed` — parallel

Formal organization changed; clients fetch their authorized company projection.

```ts cordis-catalog
/**
 * Formal organization changed; clients fetch their authorized company projection.
 * @mode parallel
 */
'office/organization-changed'(): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)

<a id="officereminders-changed--parallel"></a>

#### `office/reminders-changed` — parallel

Durable central reminder delivery or acknowledgement changed; recipients re-read their authorized view.

```ts cordis-catalog
/**
 * Durable central reminder delivery or acknowledgement changed; recipients re-read their authorized view.
 * @mode parallel
 */
'office/reminders-changed'(): void
```

Source: [`packages/enterprise/office/src/types.ts`](../../packages/enterprise/office/src/types.ts)
<!-- END GENERATED cordis-surface -->
