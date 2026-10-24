# @deepseek-ai/dsh-session-migration-mysql

[English](README.md) | 中文

[session-query 子系统](../../../docs/subsystems/session-query.zh.md)的显式冻结导出、断点暂存和受控切换库。本包不会扫描默认 Harness home，也不会启动即修改 profile。

## 导出与校验

归档检查在打开输入前及两次读取之间支持取消。读取使用同一个打开文件，在分配前执行完整数据的剩余字节预算，并拒绝读取期间变长或截短的文件。store-v1 与 workspace-v2 envelope 中未建模字段会返回 `FUTURE_FORMAT`；完整比较也核对顶层持久状态，不能因会话数量相同而遗漏不支持的 Office 域。

`captureArchive()` 要求提供方拥有独占的 `MigrationSource.freeze()` 能力，覆盖所有 Host、原生写者、工作区变更、投影发布及代际切换。单独 flush 或工作区 owner 租约都不够。归档父目录必须显式指定并位于源目录之外。稳定操作 ID 可续用完整不可变文件；部分写入保留临时文件，只有 fsync 后才独占发布最终路径。

归档保留原始字节、全部声明的历史代际、数值最高的选定源代际、完整逻辑导出、SHA-256 清单及源身份；最后才发布 manifest。`readArchive()` 逐字节校验数据、源身份和完整归档预算。未来格式、不支持的 UTF-16、源变化及未完成的工作区 mutation 都会阻止迁移；失败也不改原文件。

`diffLogical()` 比较完整 header、每条原生事件及嵌入紧凑流、继承切点、surface、代际、追加回执、投影，以及工作区记录／顺序／归档／置顶。失效候选 ID 仍保留；条数或摘要相同不足以通过。

## 导入与切换

提供方选择前的取消会阻止切换。选择已提交后，即使收到取消，也会完成核验和完成回执；取消不能暗示仍在使用原提供方。原归档和源字节继续保留。

`importArchive()` 仅接纳显式分配、`schemaMode: verify` 的目标，并要求稳定 run ID 和原空目标 revision。目标提供方负责暂存进度原子提交、原批次哈希、维护围栏及回执读回。追加 COMMIT 未知时必须核对持久前缀；发布未知时必须核对不可变回执。当前指针可见之前先做完整深度比较，源字节及操作回执继续保留。

`activateMysql()` 要求显式选择 MySQL、当前源冻结及已确认回执。`rollbackMysql()` 从完整导出切换后数据，经恢复到全新目标、显式切换，直到新加载后的深度比较，始终持有 MySQL 源冻结。原提供方文件及数据库行继续保留。缺少原 lifecycle／历史时阻止回退，避免丢数据。集成人提供 profile 切换，并在验证期间保持写者排空；切换结果未知或重新加载不符时，两端都须继续停写。

## Model Experience

无；这些显式维护操作不注册模型工具或提示词。

#### KV Cache effect

无；本库不发送模型请求。

## Known Limitations and Deferred Work

生产跨进程冻结、MySQL／文件持久暂存适配器及集成人拥有的 profile 切换尚未绑定；缺少能力时返回 `FREEZE_UNAVAILABLE`。协议 fixture 及真实文件系统归档不能证明数据库迁移或文件提供方恢复完成。当前数据库 cut 只提供一次有界事务观察，不是跨操作独占维护租约。操作顺序和前提见 [06 交接手册](../../../.artifacts/parallel-handoff/06/RUNBOOK.md)。
