# Agent 05｜MySQL 原生持久化、事务工作区与投影

本文件可单独交给一个 Agent 执行。交接快照：整体 **175 项，完成 137 项、进行中 20 项、未开始 18 项**；本组 **4 项，进行中 4 项、未开始 0 项**。当前自动开发已暂停，仅整理交接。

本组目标：完成当前可选 MySQL 提供方的剩余原生兼容与恢复语义，正式接入规范工作区及投影检查点；现有 JSONL/JSON/SQLite 默认路径完整保留。

2026-10-19 本次执行已获用户重新授权，范围仅 T071–T074。当前已完成 schema v3 独占迁移与 verify、新 Workspace/Projection 提供方正式源码及 Loader 接线，新增 11 个真实引擎标题和 6 个协议标题均有通过。08 的 owning Host 类型发射第 3 次通过，整体 Host bundle 第 3 次受 Office Remote 类型出口阻塞而失败，已封顶停止。本组四项保留进行中，未把 source 证据冒称发行验收。实时 TASKS.md 为 **175／137 完成／35 进行中／3 未开始**。完整证据和边界见 [05 交付](../../.artifacts/parallel-handoff/05/HANDOFF.md)、[五遍复查](../../.artifacts/parallel-handoff/05/REVIEW.md)。

## 本组任务清单（完整继承原验收标准）

2026-10-24～25 用户重新授权的十轮不同重点深查已完成，包含真实 GUI。本轮修复 Host-only 精确 writer/namespace 端口、Workspace 后台冻结报告、两提供方同步异常／重入退役、Session 永久失败路由降噪、Projection 同 provider/store 校验及无效标识入队前拒绝。新增 17 项协议首过；隔离增量 noEmit/lint 各 r1 仅新测试声明／样式失败，修复后 r2 通过并停止。08 两次独占 verify 窗口内，同一全新真实 writer-proof 用例 r1 因 fixture 的 SQL 字符串标志断言类型错误失败，保留失败后用 native count 解析，r2 1/1 通过；实际核验未发布 creator 租约、精确归属、foreign 拒绝及关闭释放。GUI owner05/revision4 窗口内 3 项只读检查 r1 全过：原生工作区入口、1 条目录往返一致、0 页面异常；导航已恢复，GUI/DB 窗口均释放。旧绿、Host/完整 MySQL 封顶均未重跑，DDL／回填／schema 回执写入为 0。详见 [十轮复查记录](../../.artifacts/parallel-handoff/05/REVIEW-GUI-10.md)；本轮复查完成不等于四项任务验收完成，T071–T074 仍进行中，整体 **175／137 完成／35 进行中／3 未开始**。

| ID | 优先级 | 交接状态 | 任务 | 原验收标准 | 来源／前置依赖 |
| --- | --- | --- | --- | --- | --- |
| T071 | P1 | 进行中 | MySQL SessionPersistence | 完整 header/事件/surface/紧凑流、seq 连续、生命周期/代际、句柄/单写者租约符合原接口 | R7/R8；T070 |
| T072 | P1 | 进行中 | MySQL 追加幂等和故障恢复 | 同批次重试核对持久回执，旧 fence/过期租约拒绝，COMMIT 断连结果可查，不重复工具副作用 | R7；T071 |
| T073 | P1 | 进行中 | MySQL 工作区事务映射 | 原 ID/路径/顺序/归档/置顶/候选账本完整，create/delete 全局事务或保留恢复协议 | R7；T070/T071 |
| T074 | P1 | 进行中 | MySQL 投影检查点 | identity/version/seq/CAS 校验，整值替换删除旧 key，失配缓存可重建且不损坏历史 | R7；T071 |

## 既有实现与证据

- T071：可选 SessionPersistence、schema v2、真实新 Loader 恢复及追加、根卸载排空、built CLI／TS SDK／Python SDK 恢复、单个真实 MySQL ACP corpus 的 7 种等待及父子最终收集已通过。完整旧历史 corpus／seeded fork、任意 UTF-16 无损表示及发行安装验证尚未完成。TLS DNS 和显式 IP 拨号＋审阅 DNS 身份共 8 个新场景已过；不宣称直接 IP SAN 或客户环境全部兼容。

- CLI／TS SDK／Python SDK 的成功恢复发生在 overlay 补强必需依赖之前；最终 overlay 仅另外验证了组合／schema 和缺凭据拒绝，没有重复成功恢复。见 [MySQL 启动指南](../../docs/user/guide/mysql-sessions.zh.md)，不能把不同配置版本的证据混作最终版全链通过。

- T072：真实 COMMIT OK 丢失后原回执可达、暂不可达后 flush、异常退出自然租约到期恢复已通过。异常恢复保留原 24 事件／7 回执前缀、fence 1→2、最终 37 事件／12 回执；不能再作为新测试重复。剩余缺失／冲突回执等实际故障和外部副作用边界仍要补。

- T073：可选 KvUnit.commitAtomic／Domain.mutateAtomic 桥已正式接入；legacy JSON/SQLite 不声明能力时沿原 pendingMutation 协议。规范表 adapter、普通 IO unknown 冻结／Registry producer 排空 hardening 仍只在 artifacts，不存在正式 MySQL 工作区 route。

- T074：规范投影 adapter 8 个新协议已通过，仅在 artifacts。原 cache put 缺生命周期 UUID／完整观测 cut／CAS，不能直接映射到 KV 后声称完成。

## 必读交接

- [正式 atomic bridge](../../.artifacts/enterprise-office/mysql-workspace/bridge/FORMAL-HANDOFF.md)；[adapter](../../.artifacts/enterprise-office/mysql-workspace/adapter/HANDOFF.md)；[hardening](../../.artifacts/enterprise-office/mysql-workspace/adapter/hardening/HANDOFF.md)。原 bridge freeze 中一处 committed 属性 JSDoc 后来补过注释，核对当前源码，不能强行用旧 SHA 覆盖。

- [projection handoff](../../.artifacts/enterprise-office/mysql-projections/HANDOFF.json) 及 SCHEMA-PROPOSAL.json。8 个协议绿不等于真实数据库、正式 provider 或内存上界已经验证。

## 必须完成的接线与边界

1. 工作区规范表保留原 ID、路径、记录／候选账本、顺序、归档顺序与置顶；补 archive_position 和 global 从未写入／已物化的显式区分。旧布尔归档集合无法推导顺序，无权威原文档时不能猜。global 未写入与 global:null 的表示必须精确。

2. 仅新增后继 schema 迁移，保留 assets/001-r7.sql、002-json-safe-integers.sql 及原回执字节；部分 DDL／回填失败不写成功回执。schema 编号与 DDL 由本组唯一负责，同 06 先约定，不并发迁移。

3. 正式接入 hardening：后端 ACK 后一次发布 Domain／Workspace 缓存再通知；unknown／stale／原始 IO 错误冻结直到 reopen，无隐式重发／JSON 回落。验证错误／no-op 不污染，held Entity 读取也遵守冻结。

4. 统一 store/slot 锁序，处理跨进程缓存失效。单向 retire 先拒新生产者并 drain，再关底层；避免生产者持队列等待自身 dispose。两种加载／卸载顺序都要保持 closing events。

5. 投影只接完整验证的 event prefix、当前 lifecycle 和 log_revision；checkpoint identity/version/seq/CAS、整值替换和删除旧 key 均准确。现有 191 字符 key、INT version、Unicode 子集之外必须明确拒绝或新增兼容后继，不能截断。

6. 当前 projection states 读取后才检查数量／字节，不是驱动分配前硬上界；正式启用前补 header/unit_count 与有界分页／值读取。派生缓存失败可以重建，但不能损坏权威历史。

7. 对真正剩余的 Session 故障做新定向验证，保持 FrozenBatch id/hash/seq、单写者 fence 和准确结果未知语义。与 06 提供生命周期／cut／游标／冻结导出接口；与 08 交付 CLI/SDK/安装器集成要求。

## 数据库与验证约束

- 仅复用已审阅的 owned-instance／owned-profile fixture 使用专属回环实例 127.0.0.1:11406；连接前核验 server UUID、预期 8.4.11 版本、专属库名和规范化 datadir。仅使用数据库级账号，不读取或使用描述符中的 rootPassword；不得连接或改 MySQL57/MySQL80、客户库或旧 store。私有描述符不写文档、终端或 Git。普通验收固定 schemaMode: verify，每组使用唯一 store namespace；新增迁移由 05/08 独占窗口执行并暂停／排空其他数据库场景。

- 原整体 MySQL 联调历史超过三轮的记录必须保留，不再重跑旧全套；旧绿、真实 crash、wire 回查及 TLS 场景均绿停。新增能力要有协议＋真实引擎证据，不能拿 protocol fixture 冒充。

- 本组可改持久化／MySQL／workspace 的具体叶子实现及新 schema 后继；公共 Service Definition、公共入口、根依赖／锁和生成文档由 08 顺序整合，不同时写。

## 用户要求：每位 Agent 都必须遵守

1. 产品定位：面向普通员工的企业私有化办公 Agent，通过配置打通企业已有管理系统。实现真实页面功能、持久数据与受控业务操作；不能只做原型、假上传、计时器或模拟成功。

2. 固定页面要求：移除最左侧公司层；主导航依次为工作台、AI会话、通讯录、网盘、工作、集成、工具，底部两个按钮保留。首页上方左 3/5 仪表板、右 2/5 日历＋待办及滚动公告，下方对话框；发送后进入保留左栏和右侧新建会话栏的独立 AI 页。

3. 日历用列表查看当日安排，可新建日程并邀请成员；待办有状态，在日历旁与空态可新建。通讯录展示组织成员，聊天像微信，功能在输入框上方，可发聊天、任务、会议和待办。头像显示登录成员、角色、岗位并可编辑资料。

4. 网盘像 Windows 文件夹，有私有／共享网盘和按账号设置的权限。工作页管理日常工作。集成展示本公司定制系统、支持导入和详情／定制需求；工具页展示技能及钉钉、企业微信、OA。AI 会话体现关联集成／工具；选择关联不等于授权执行。

5. 必须完整保留原有：会话、模型、Skills、MCP、工作流、定时任务；文件、终端、浏览器、子 Agent、权限、交付物；CLI／SDK、桌面菜单、快捷键、设置、历史数据和插件管理。不得用新办公壳替换掉原功能。

6. 最新执行规则优先：已取消 20 轮清单检查、10 遍核对及完成后 20 轮检查。同一问题重复检查最多 3 轮，通过即停；原检查额度跨 Agent 继承。不得第四次、改名、删除断言、改 golden 或过滤失败来伪造通过。只运行必要定向测试／构建，不重复旧绿。

7. 每轮开头输出“第 N 轮｜本轮任务｜预计改动”，结尾输出“进展｜本轮改动｜下一轮方向”；每次对外进展同时给出整体总数、完成／进行中／未开始，按实时 TASKS.md 统计。本交接快照为 175／137／20／18，不能用本组完成数冒充整体进度。

8. 保持可运行。依据验收标准自查，失败在额度内修复；做不了的、缺凭据的、实现但未验收的、平台限制的分别列清单。不要问“接下来做什么”，能独立完成的先推进；缺真实接口或身份配置时如实记录依赖，不假连接。

9. 本次用户已明确先停止开发。此文档是后续分工入口；只有接到执行本文件的指令才恢复本组开发，不恢复原先跨项目“永不停止”模式。本次生成文档不改变原任务完成状态。

## 共同基线、资料与开发约束

- 仓库：`E:\CodeRepository\VibeCoding\Agent封装Claude\deepseek-harness`，PowerShell，交接日期 2026-10-19。当前 v119 本地预览 `http://localhost:3081` 保持运行并沿用原数据；不要为领任务重启或清数据。

- 必读 [TASKS.md](../../TASKS.md) 本组原行／验收／历史、根和目录适用 AGENTS.md；改 packages 前读 docs/architecture.md，生命周期／并发读 docs/defensive-patterns.md，UI 遵循 packages/client/AGENTS.md。

- 原始需求：[会话记录](../../../会话记录_2026-10-14.md)、[设计说明](../../../企业工作台页面原型改造/设计说明.md)、[PyQt 使用说明](../../../企业工作台页面原型改造/PyQt使用说明.md)、[完善记录](../../../企业工作台页面原型改造/完善记录.md)、[Harness 架构分析](../../../DeepSeekHarness技术与业务架构分析.md)、[MySQL 表结构](../../../转储数据存储MYSQL表结构.md)。最新聊天与当前 V0.8 交互优先于撤销的旧布局；相邻原型／Fork 仅参考，不改相邻项目。

- 当前仓库含大量已有未提交／未跟踪成果。不要 reset/checkout 覆盖、clean、stash 丢失、统一格式化或恢复成干净 HEAD；新工作树必须先携带当前工作快照及本组所需非敏感 artifacts，否则会丢失已实现能力。

- 显式使用 `../.local-run/node-v24.22.0-win-x64/node.exe`；便携目录有 pnpm.cmd。先 `rg --files` 找实际路径，再 `rg` 查内容；不要猜旧摘要中的文件名。Node 源测试与 built 测试分面，保持 strict、真实项目引用和实际运行版本。

- 通过 Cordis 插件／Slots／标准服务扩展，界面只接数据／回调／hooks。产品文案进 typed locale，样式用语义 token；模型可见内容必须可从原 Session 日志重建。新持久格式仅追加受审阅后继，不覆盖旧代际／回执或放松旧读取。

- 用户已授权项目必要开发及本机平台操作，但客户凭据并不存在于授权本身。不要向对话、Git、截图、审计或日志输出密码、邀请码、token URL、数据库描述符；不主动给外部联系人发消息。受控业务写入仍沿原产品审批／权限／幂等。

## 八 Agent 并行协作规则

- 本文件只负责下表 ID。不要重复实现标成完成的 137 项；先读现有源码和证据再补缺口。每组只更新自己的 task.md 进度记录，状态变更由 [08 统一整合](../08-release-integration/task.md) 写回 TASKS.md，避免互相覆盖。

- 公共文件由 08 唯一顺序写入：TASKS.md、根 package/lock/tsconfig、插件 profile/bundle、生成目录、公共 Office/Client index/types/request/contracts/locales 汇总、API Remote 聚合、构建记录和预览。各组把接线补丁与元数据需求放 `.artifacts/parallel-handoff/<本组编号>/`，告知 08 后整合；不能多人同时编辑公共入口。叶子模块和本组 README／测试可独立修改。

- 需要另一组接口时先给出明确输入／输出／失败／生命周期约定，并记录依赖；可并行准备独立模块和用例，但暂存代码、协议 fixture、补丁检查不算正式接入完成。08 应用公共补丁后必须完成实际产品路径的必要验证。

- 不并发 install、统一生成、根构建、预览重启或数据库迁移。05 独占 MySQL schema 编号和 DDL；实施 DDL／回填／新回执前由 08 暂停并排空其他数据库验收，不同 store namespace 不能隔离共享结构。普通数据库验收固定 schemaMode: verify；08 安排统一构建与集成窗口。测试只清理自己创建且已核验路径／PID／store 的资源，不按名称杀所有进程，不碰其他 Agent 数据。

## 收尾交付格式

每项写清：改了哪些文件、实际实现、运行命令及真实结果、检查轮数、是否已进入正式构建、剩余限制／外部依赖和下一位整合人。附最小可审查补丁和非敏感证据路径。完成、暂存通过、实现未验收、阻塞必须分开；不能只回复“已完成”。

## 其他任务负责人

- [01 原生运行、员工隔离与 Windows 兼容](../01-native-runtime/task.md)
- [02 网盘文档、图片读取、知识库与办公交付](../02-drive-knowledge/task.md)
- [03 钉钉、企业微信、OA 与办公自动化](../03-connectors-automation/task.md)
- [04 成员身份、审计、消息与群组协作](../04-identity-collaboration/task.md)
- [06 MySQL 检索、冻结转储与切换回退](../06-mysql-search-migration/task.md)
- [07 场景助手、企业外观、可访问性与终端体验](../07-experience-scenes/task.md)
- [08 统一整合、备份部署、安装包与最终验收](../08-release-integration/task.md)

## 本组执行记录（领取后维护）

| 轮次 | 任务 ID | 实际改动／证据 | 检查次数与结果 | 正式接入状态／剩余依赖 |
| --- | --- | --- | --- | --- |
| 交接 | 本组全部 | 仅拆分任务；未新增产品代码、测试或构建 | 不重跑历史检查 | 保持上表原状态，等待分组执行 |
| 本组 1／W1 | T071–T074 | 08 收齐全组 DB drained 后独占执行追加 003；21 个 session-only store 显式采用已有 normalized global，archive/workspace 原行均 0；核验 UUID/8.4.11/库/datadir/数据库级账号。migration-W1.json 保留旧 001/002 回执及时间，v3 verify 20 表/25 FK | 新 schema 协议 3 项 r1 过；真实迁移 r1 过，后续 verify 过；无旧 DDL 重放 | schema v3 已在审阅 fixture 生效；普通场景恢复 verify；无客户库接入 |
| 本组 1 | T071/T072 | 同 FrozenBatch 的真实 COMMIT 前断连／缺失回执；真实冲突 receipt 冻结并释放 lease；seeded exact cut 与同 ID 新 UUID/旧 reader 绑定；store-first 锁序、完整有界 cut 公共接口已交 06 | 新引擎 3 标题 r1 全过；旧 crash/wire/TLS/corpus 不复跑 | 正式源码及真实 Loader 已接；任意 UTF-16、完整旧 corpus、服务端重启/失败心跳、发行安装仍有边界 |
| 本组 1 | T073 | 正式 workspace-mysql canonical backend、global-written/archive ordinal、原字段和候选账本、fenced registry lease；hardening 与公共可选读 guard、单向 producer drain 由 08 接入 | 新引擎 5 标题均有过：4 项 r1；剩余项 r1 测试顺序误判、r2 typed refusal 被洗成通用错、修复后 r3 过并封顶 | 正式 source/Loader 通过；统一产物待 08；Session 创建与关联仍保留两次原生操作，registry lease 不是全 store 维护冻结 |
| 本组 1 | T074 | 正式 projection-mysql 及 cache provider 选路、完整 cut/CAS/whole replacement、有界头/分页/值读取；unknown 后零 SQL、重开/版本失配重建；默认 Domain 保留 | 新协议 r1 include 未收集，r2 实际 3 项过；新引擎 r1 两过/启动依赖竞态一失败，08 改 await inject 后仅原失败 r2 过 | 正式 source/Loader 已接；同步裸 Header 不含 UUID，保守 miss；191/UINT32/Unicode 之外拒绝；无 immutable cache receipt |
| 本组 1 收尾 | 本组全部 | 各项五遍不同视角静审并修复；中英 README/升级说明齐备；最末 terminal enqueueLive failure guard 与 fixture 提前注册/memoized cleanup 交 08 构建确认 | strict type r2 过，公共/样式变更后 final r3 过；窄 lint r2 仅原失败文件过。末尾两文件 lint-r3 剩 prefer-const 一项，修为 const holder 后不第四次；guard/fixture/schema 单测 v3 适配的最终差异未完整复验，旧绿未跑 | 最小补丁、SHA manifest、完整命令和限制放 05 交接；public/lock/build/生成配对归 08，不提前变更整体完成数 |
| 08 最终整合 | 本组全部 | 本组 owning Host TS 发射随 08 r3 通过；整体 bundle r3 因 `OfficeAutomationCommandInput` public non-root type 出口失败，封顶停止。Workspace 缺 `lib/index.js`；唯一一次 plain Node24 package 出口 import 预检真实报 MySQL 未导出 `mysqlConsumerTransaction` | 两个新的 published smoke 均未启动；import 预检失败一次即停；DB 连接和 namespace 新增 0；没有绕 source/lib/types 或第 4 次构建 | 发布装配/built smoke/新页面均未验收；保留 source/11 引擎/6 协议原证据。已向 08 确认无产物读取及 DB，允许其归档部分生成物后恢复预存 v119；本组源码冻结，最终状态见 05/integration-final.json |
| GUI 十轮续作 | T071–T074 | 精确 writer/namespace 公共端口由 08 接入并交 06；后台冻结报告、退役异常/重入清理、终止路由降噪、投影 provider/store 绑定与入队验证；15 叶子/4 对文档 SHA 及补丁、截图和 FINAL-GUI-20261024.json 已交付 | 新协议 17 项 r1 过；新 noEmit/lint r2 过；独占 verify 真库新 proof r1 fixture 类型断言失败保留、仅 native count 修复后 r2 1/1 过；GUI 只读 r1 3 检查过，旧绿未跑 | 十轮复查完成，四任务仍进行中；GUI/DB 已排空释放，DDL/回填/新 schema 回执 0；新 MySQL GUI、published build、Electron/安装器及完整跨 Host/迁移仍未验收 |
| 2026-10-25 有限续作 | T073 | 新 StorageMutationValidationError 仅声明该次变更未开始 backend IO，Domain 普通/atomic 与 Registry create/delete 保留旧缓存、修正队列继续；IO/lease/CAS/unknown/pub 仍冻结，cause 保留原验证错误；public 3 文件已由 08 接入，8 叶子/4 文档对 SHA 与补丁见 resume-20261025 | 新 8 协议：r1 五过/三因 spy 安装晚于 bind 失败，原三失败修 fixture 后 r2 过；types r1 两项测试 optional 错、r2 过，lint r1 过；旧绿不跑，DB/DDL/GUI/根build 为 0 | 单修复闭环完成，Node artifact/class identity 与配对交 08；四任务仍进行中，整体 175/137/35/3；没有新维护 freeze/staging 接口 |
