# Agent 06｜MySQL 检索、冻结转储与切换回退

本文件可单独交给一个 Agent 执行。原交接快照与历史执行记录保留；2026-10-24 用户已授权本组恢复 GUI 深查十轮。当前按 TASKS.md 实计：整体 **175 项，137 完成／35 进行中／3 未开始**；本组 **0 完成／4 进行中**。

本组目标：基于规范原生日志实现有权限与水位保证的 MySQL 搜索、可靠冻结导入导出和可操作的存储切换／回退。四项均进行中，正式 MySQL／冻结迁移／数据回退仍未验收，不能把已有 Session 后端当作本组已完成。

## 本组任务清单（完整继承原验收标准）

| ID | 优先级 | 交接状态 | 任务 | 原验收标准 | 来源／前置依赖 |
| --- | --- | --- | --- | --- | --- |
| T075 | P1 | 进行中 | MySQL 全文索引构建与发布 | 复用语义提取/surface，staging 不可见，claim/版本水位/epoch 正确；中文/单字/emoji/代码验证 | R7；T071/T073 |
| T076 | P1 | 进行中 | MySQL 查询过滤与游标 | 权限/会话/时间/surface 先过滤再分组排序；索引落后显式失败，游标变化返回失效而非漏项 | R7；T075 |
| T077 | P1 | 进行中 | 冻结转储与逐会话差异校验 | 源备份/manifest/SHA/断点恢复/staging 发布/代际选择；逻辑导出深度相等，未来格式明确拒绝 | R7；T071/T073/T074 |
| T078 | P1 | 进行中 | 存储切换与回退演练 | 明确选择 MySQL 插件，不自动迁移本机历史；切回前导出新增数据，原文件及代际保留 | R7；T072/T076/T077 |

## 前置依赖与可并行部分

- 05 提供当前 lifecycle、完整观测 cut/log_revision、读一致性及工作区／投影语义。本组可先核对 R7、实现独立检索／导入导出模块和协议用例；真实产品启用必须等接口正式接入，不能用伪接口把依赖算完成。

- 使用现有 session-query 的语义提取、surface 和权限机制，先用 rg 找到真实索引／查询 provider 扩展点。不得直接 LIKE 扫所有 JSON 当作完成全文检索，不另改 Agent loop。

## T075 全文索引构建和发布

1. 复用原事件／紧凑流的语义提取，对中文、单字、emoji、代码及 surface 定义实际可复现检索行为。原生内容顺序与源 seq 可追溯，不只存聊天摘要。

2. staging 构建对查询不可见；claim、生命周期、版本、水位及 epoch 保护发布。失败或中断不会把半成品当 live 索引，重复构建不会重复发布旧代际。

## T076 查询过滤与游标

1. 当前员工权限、会话范围、时间及 surface 在分组／排序前过滤。搜索、计数、摘要及翻页都不能泄漏其他员工元数据。

2. 索引落后明确报不可用或待重建，不能静默返回不完整的“无结果”。游标绑定实际查询／权限／索引代际；环境变化返回失效并要求重查，不能跳项／重复。

## T077 冻结转储和差异校验

1. 真实冻结源并生成 manifest、SHA、版本／代际与断点信息；支持中断恢复、staging 导入与核验后发布。未来格式明确拒绝。

2. 逐会话比较完整逻辑导出：header、所有事件、surface、紧凑流、seq、工作区顺序／归档／置顶和必要派生状态。源文件原始字节、历史代际和回执保持；不能只比条数或摘要。

3. 任意 UTF-16／schema 无法表示的值明示不支持并保留源，不能替换字符、截断 ID、改原 JSONL 记录。

## T078 切换和回退

1. 只有显式选择 MySQL provider 才切换；默认 JSONL/JSON/SQLite 继续可用，不启动即自动迁移本机历史。

2. 先验证可回退：切换后新增数据先冻结导出／校验，再恢复目标 provider；原文件、代际和数据库记录保留，不以卸载插件代替数据迁回。

3. 覆盖中途中断、版本不兼容、源变化、未知提交和恢复后的再次追加；文档提供明确前提、失败状态和操作顺序。

## 文件归属、数据安全与交接

- 本组负责新的 MySQL search/query/import/export 叶子模块、对应协议／真实集成用例和局部文档。05 独占 schema 后继编号及数据库结构实施，本组提交结构需求；08 独占公共入口／插件 profile、依赖锁、构建和最终切换窗口。

- 真实数据库仅复用已审阅 fixture、经 05 核验 UUID／版本／库名／规范化 datadir 的专属实例，使用数据库级账号与本组独立 store namespace；不读取或使用 rootPassword。普通验收固定 schemaMode: verify；05 实施 DDL／回填／新 schema 回执前须停止并排空本组数据库场景。不同 namespace 不隔离共享表结构，不执行全库清理、schema reset、原 store 覆盖或停 mysqld。

- 需要验证完整导出与重新加载后的普通查询／原生续写，不能只在协议 SQL fixture 里通过。与 01/04 约定当前员工过滤，与 08 交付可执行回退手册和剩余外部限制。

## 用户要求：每位 Agent 都必须遵守

1. 产品定位：面向普通员工的企业私有化办公 Agent，通过配置打通企业已有管理系统。实现真实页面功能、持久数据与受控业务操作；不能只做原型、假上传、计时器或模拟成功。

2. 固定页面要求：移除最左侧公司层；主导航依次为工作台、AI会话、通讯录、网盘、工作、集成、工具，底部两个按钮保留。首页上方左 3/5 仪表板、右 2/5 日历＋待办及滚动公告，下方对话框；发送后进入保留左栏和右侧新建会话栏的独立 AI 页。

3. 日历用列表查看当日安排，可新建日程并邀请成员；待办有状态，在日历旁与空态可新建。通讯录展示组织成员，聊天像微信，功能在输入框上方，可发聊天、任务、会议和待办。头像显示登录成员、角色、岗位并可编辑资料。

4. 网盘像 Windows 文件夹，有私有／共享网盘和按账号设置的权限。工作页管理日常工作。集成展示本公司定制系统、支持导入和详情／定制需求；工具页展示技能及钉钉、企业微信、OA。AI 会话体现关联集成／工具；选择关联不等于授权执行。

5. 必须完整保留原有：会话、模型、Skills、MCP、工作流、定时任务；文件、终端、浏览器、子 Agent、权限、交付物；CLI／SDK、桌面菜单、快捷键、设置、历史数据和插件管理。不得用新办公壳替换掉原功能。

6. 2026-10-24 最新授权要求十轮不同重点的深查和功能完善，优先 GUI 实际使用流程。同一问题仍最多 3 次检查，历史额度与失败保留；已绿不为汇总重跑，不删除断言或过滤错误。旧正式 Host bundle 第 3 轮失败未复跑。

7. 每轮开头输出“第 N 轮｜本轮任务｜预计改动”，结尾输出“进展｜本轮改动｜下一轮方向”；每次对外进展同时给出整体总数、完成／进行中／未开始，按实时 TASKS.md 统计。本交接快照为 175／137／20／18，不能用本组完成数冒充整体进度。

8. 保持可运行。依据验收标准自查，失败在额度内修复；做不了的、缺凭据的、实现但未验收的、平台限制的分别列清单。不要问“接下来做什么”，能独立完成的先推进；缺真实接口或身份配置时如实记录依赖，不假连接。

9. 此前暂停已被本轮用户授权撤销，恢复范围仅 T075—T078；公共入口、profile、依赖锁及最终集成窗口仍由 08 顺序负责。

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
- [05 MySQL 原生持久化、事务工作区与投影](../05-mysql-core/task.md)
- [07 场景助手、企业外观、可访问性与终端体验](../07-experience-scenes/task.md)
- [08 统一整合、备份部署、安装包与最终验收](../08-release-integration/task.md)

## 本组执行记录（领取后维护）

| 轮次 | 任务 ID | 实际改动／证据 | 检查次数与结果 | 正式接入状态／剩余依赖 |
| --- | --- | --- | --- | --- |
| 交接 | 本组全部 | 阅读任务、原始 MySQL 表结构、适用 AGENTS 和既有事件／surface／权限实现；与 05 约定 lifecycle、完整 cut、log_revision、CAS 和锁序 | 继承历史额度，不重跑历史绿项 | 只负责 T075—T078，schema 交 05，公共装配交 08 |
| 源码实现 | T075、T076 | 新增 session-query-mysql；索引 claim、隐藏 staging、完整 cut 与 CAS 发布、授权过滤、游标和明确落后错误；接入 05 正式 observeMysqlSessionCut 与 codec | 初始源码用例 25/25；查询类型 r1 修正后 r2 通过，迁移类型 r1 通过 | 正式 05 读取接口已接；生产 authority／跨 Host flush 尚未提供 |
| 真实数据库 | T075、T076 | 已审阅 owned-v3 fixture、独立 namespace、schemaMode: verify；验证 staging 不可见、过期 claim、CAS、中文／单字／emoji／代码／空白查询、权限、游标、重载续写及真实 COMMIT 回执丢失读回 | 主场景 r1 因 fixture 缺 sourceEventSeqs 失败，修正 fixture 后 r2 通过；新增 analyzer 场景 r1 通过；schema receipts 不变，连接排空 | 仅代表真实查询与原生重载续写，不代表完整迁移恢复；原 namespace、事件、代际、staging 和回执保留 |
| 冻结／迁回协议 | T077、T078 | 新增 session-migration-mysql；原文件保留、manifest／SHA、完整会话与工作区差异、断点回执、显式选择 CAS、切换后新增数据归档及回退协议 | 新增归档完整性用例 5/5；新增发布／原生 codec 用例 7/7；累计 37 个不同源码用例通过，旧绿未重复 | 文件归档使用真实临时文件系统；导入 target 为协议 fixture。真实跨 Host freeze、持久 MySQL／文件 staging adapter 和 SelectionControl 尚未接入，缺失时明确失败 |
| 冻结交接 | 本组全部 | 两个包源码、README、局部清单、runbook、补丁及非敏感证据交 08；保留现有功能和所有未提交成果 | 最终类型检查 r3 通过；type-aware lint r2 通过；README 配对 r2、空白 r2、补丁静态检查 r1 通过，详见 CHECKS.json | 四项均进行中。08 报正式 Host bundle r3 因公共类型子路径导出失败，已封顶；无 Client／新页面／完整迁回验收，v119 基线保留，MySQL query 默认不接线 |
| 授权候选续接 | T076 | 只读审阅 01 authority-v4 的 native-search-authority.patch、native-search-metadata.patch 和 search-manifest.json；返回字段与 MysqlSearchAccess.authorize 相容，绑定原登录及权限专用 epoch | 01 报新增中央 HTTP／原生历史场景 3/3、类型与 lint 首轮通过；属于 01 候选证据，不计入 06 MySQL 场景或本组检查次数 | 未安装、无 flush／owner 证明／匿名 Native 真实 Host policy/version；provider/store 保护候选未应用，不能解除未验收状态 |
| 配置源文档收尾 | T075、T076 | 按 08 要求仅补 Config.storeKey 与 SearchLimits 十字段的 JSDoc，说明单位、预算范围及超限结果；保留 08 返回类型修订 | 使用 Node 24.22.0 生成补丁和 SHA；本组未运行任何新检查。08 续原失败 Config generator r2，不开第 4 次构建 | 补丁与前后 SHA 在 config-jsdoc/；旧 source-freeze.json 继续作为当时受检快照，不冒充新验收 |
| 记录修复 | 本组全部 | 将本组先前追加记录中的乱码修正为 UTF-8 中文；任务正文和既有成果保留 | 仅修正文档，不重跑绿项 | 当前整体最近确认 175 项：137 完成／35 进行中／3 未开始；本组 0 完成／4 进行中 |
| 新域清单接收 | T077、T078 | 接收 04 六个正式 v1 域与未采用的 authority_epoch 候选元数据，逐项列入 DOMAIN-INVENTORY.md／domain-inventory.json | 只更新未完成清单，无 DDL／数据库／构建／检查 | 新域未默认激活；原 local 备份只覆盖实际已有数据，nativeMysql／frozenMigration／rollback 均未验收；原 identity／member_invites 结构未改 |

## 本组交付与未完成项

- 两个叶子包位于 `packages/session-query/session-query-mysql/`、`packages/session-query/session-migration-mysql/`；不改原 Agent 执行循环，不自动迁移本机历史。
- 真实查询和重载续写证据见 [mysql-search-evidence.json](../../.artifacts/parallel-handoff/06/mysql-search-evidence.json)；analyzer 验证见 [mysql-analyzer-evidence.json](../../.artifacts/parallel-handoff/06/mysql-analyzer-evidence.json)。二者均为 verify 模式、已审阅 fixture 和本组独立 namespace。
- [RUNBOOK.md](../../.artifacts/parallel-handoff/06/RUNBOOK.md) 规定显式冻结、导入、选择及回退顺序；缺少正式适配器时不得绕过前提切换，不得把协议 fixture 称为真实数据库迁回。
- 五个方面的深查及实际检查次数分别见 [REVIEW.md](../../.artifacts/parallel-handoff/06/REVIEW.md)、[CHECKS.json](../../.artifacts/parallel-handoff/06/CHECKS.json)；没有宣称完整链路验证五遍。
- 尚需生产 employee/login/permission authority、跨 Host accepted-write flush 和维护冻结、真实持久 staging／恢复 target、原生匿名授权版本、匹配 provider/store 保护及 08 正式 profile／构建／选择装配；完整迁移、回退与原 Agent 模型续跑仍须真实验收。
- 本次仅补注释的 [补丁](../../.artifacts/parallel-handoff/06/config-jsdoc/config-jsdoc.patch) 与 [SHA](../../.artifacts/parallel-handoff/06/config-jsdoc/sha256.json) 单独交接；不覆盖已冻结的实现补丁、manifest／tsconfig 或历史证据。
- 新增 Office 域的未完成覆盖范围见 [DOMAIN-INVENTORY.md](../../.artifacts/parallel-handoff/06/DOMAIN-INVENTORY.md)；接收元数据不代表已实现原生 MySQL、冻结迁移或回退。

## 2026-10-24／25：本组 GUI 深查十轮

用户已明确重新授权十轮深查与功能完善，继续只负责 T075—T078。十轮按不同重点推进；旧失败额度、旧受检快照和证据保留，不复跑已绿的历史 MySQL／正式 Host 构建。所有新检查显式使用 Node 24.22.0，当前未启动数据库场景、DDL、应用进程或预览重启。

| 轮次 | 重点／实际修复 | 本轮证据 | 状态 |
| --- | --- | --- | --- |
| 1 | 读取当前任务、原始需求及 GUI／服务入口；确认失败误显示无结果、provider/store 未强制绑定、未建模顶层数据比较遗漏 | gui-20261024/baseline.json；TASKS.md 实计 175／137／35／3 | 只读审查完成，不计行为验收 |
| 2 | 查询初始化强制真实 MySQL provider 和相同 namespace；采用 05 正式 mysqlStoreKey 属性 | round02-binding-r1.log，2 个新增配置用例首轮通过 | 源码已接；无真实数据库新验收 |
| 3 | GUI 原位失败提示、保留名称匹配、同查询重试、清除后取消及迟到结果抑制；公共中英 locale 由 08 接入 | round03-gui-retry-r1.log，3 个新增＋1 个按新行为更新的原组件场景首轮通过 | 组件通过；真实应用窗口待 08 |
| 4 | 导出／读取／导入支持取消；已取消的操作不获取冻结、不读输入、不访问目标回执 | round04-cancellation-r1.log，3 个新增用例首轮通过 | 源码通过 |
| 5 | 单一打开文件的有界读取，拒绝读取期间变长／截短，完整预算包含元数据且按剩余预算读取 | round05-bounded-read-r1.log，4 个真实临时文件用例首轮通过 | 文件系统验证通过，无数据库声明 |
| 6 | 比较顶层持久状态；v1 store／v2 workspace 未建模字段明确 FUTURE_FORMAT，不能丢新域后仍报恢复一致 | round06-store-envelope-r1.log，4 个新增用例首轮通过 | 源码通过；新增 Office 域仍不支持迁移 |
| 7 | 接 05 正式 ownsMysqlWriter；Host/local flush 在事务外完成，store→全部相关 slots→leases 锁下核验 active owner，覆盖未发布 creator，外部／未知写者拒绝 | round07-writer-barrier-r1.log，6 个新增协议用例首轮通过 | 正式接口源码已接；真实跨 Host DB 场景未验收 |
| 8 | provider 选择前取消不切换；选择已提交后完成新读校验并保留回执；回退开头取消不启动导出 | round08-selection-cancellation-r1.log，4 个真实归档＋选择协议用例首轮通过 | 不代表真实 profile 切换或数据库恢复 |
| 9 | 中文组合输入提交后才查历史；候选阶段 Esc 不清空；清除组合输入后可接受新查询 | round09-gui-ime-r1.log，3 个新增组件用例首轮通过 | 组件通过；应用窗口待 08 |
| 10 | 严格类型／lint／双语文档、当前 SHA／补丁、真实 GUI 窗口与剩余依赖核验 | 新 diff 的检查与 08 窗口记录待补 | 进行中 |

本次已通过 30 个新增场景，另有 1 个原组件场景按明确的新失败提示行为更新并通过；历史 37 源码／2 真实数据库绿项没有重跑。四项任务仍进行中。公共 metadata、locale、05 ownership 出口均由 08 顺序接入；不能据组件或协议证据宣称生产 MySQL、完整冻结迁移、切回数据或 Electron/EXE 已验收。

## 2026-10-25 GUI 窗口最终记录

十轮深查与源码修复记录已形成；本轮 30 个新增场景和 1 个按新行为更新的既有场景通过，其中 GUI 组件场景 8 个。第 10 轮另发现重试后的焦点被外部点击处理移走，修复后同一焦点场景第 2 次通过。服务端严格类型最终第 3 次通过，server/client 定向 lint 均第 2 次通过，3 组具名双语文档检查第 1 次通过；未为汇总复跑旧绿。

真实 GUI 与组件证据分开：准备阶段的只读驱动第 1 次因表达式转义／编码失败（连接前），修正后第 2 次只读观察成功；owner06/revision6 窗口只读观察保留七导航及原生工作区入口。实际交互套件第 1 次未到达原生历史搜索输入框，完成场景数为 0；未进入网络失败注入／重试／真实 IME 场景，不能判断能力本身缺失，也不能宣称新 GUI 功能已通过。原导航、焦点、主题及尺寸恢复成功，全部本组 CDP 连接已关闭；08 随后收回 owner08/revision7，未再发 GUI 动作或重试。

本轮 GUI 未创建服务、会话或模型任务，未执行数据库／DDL；原文件、数据、代际及回执保留。生产授权、完整跨 Host 屏障数据库验收、持久迁移 source/target、实际切回数据、完整 GUI 及 Electron/EXE 仍未验收。GUI 完整依赖类型第 2 次还保留 4 个组外诊断，本组没有过滤或修改组外代码。T075—T078 继续全部进行中，整体 175／137 完成／35 进行中／3 未开始。

最终状态见 [FINAL-GUI-20261024.json](../../.artifacts/parallel-handoff/06/FINAL-GUI-20261024.json)、[GUI-REVIEW.md](../../.artifacts/parallel-handoff/06/gui-20261024/GUI-REVIEW.md) 和已冻结 [leaf-manifest.json](../../.artifacts/parallel-handoff/06/gui-20261024/leaf-manifest.json)。冻结清单的 ownedTask SHA 对应 GUI 前文档快照；运行源码与其 SHA 未改，GUI 后仅追加本节及最终记录。

## 2026-10-25 继续完善：Client 衔接修复及 GUI 入口分析

本批次依 08 顺序安排，只读分析上次 GUI `native-entry` 失败并消除剩余 4 个 Client 依赖诊断。没有连接或操作当前 GUI，没有新增驱动、数据库／DDL、服务、应用进程或根构建；后台索引工作循环留待后续接口及集成安排，不在本批次扩展。

08 已审阅并接入 [client-dependencies.patch](../../.artifacts/parallel-handoff/06/continue-20261025/client-dependencies.patch) 的两处最小修复：Browser 正文区分含 URL 的导航参数；`SidebarRightNavigator.openTabIn` 保留现有控制器的页面类型泛型，恢复 `kind` 与 `params` 的类型关系。原有 Preview 实现的 Excel／PDF raw 资源声明经其真实 client 项目引用进入隔离检查；不新增假声明、断言、业务依赖或诊断过滤。

Client 严格检查沿用原 r1、r2 的失败计数，最后 **r3 通过：Node 24.22.0、717 个源文件、13 个原有 ambient 输入、0 诊断、退出码 0**。成功后停止，没有第 4 次；此前 31 个已绿场景及历史数据库绿均未重跑。终端结果、命令、日志与适用范围见 [client-r3-result.json](../../.artifacts/parallel-handoff/06/continue-20261025/client-r3-result.json)。本结果不代表整个仓库构建通过。

上次 GUI 交互 r1 仍保留失败、完成搜索场景 0。源码确认旧驱动缺少视口／命中判定和布局状态等待，但既有记录不足以唯一确定失败子步骤；没有据此修改产品入口或权限。只读分析及后续真实交互的前提见 [NATIVE-ENTRY-ANALYSIS.md](../../.artifacts/parallel-handoff/06/continue-20261025/NATIVE-ENTRY-ANALYSIS.md)，真实 GUI 续验仍须由 08 排队安排，未执行 r2。

生产 authority／正式 profile、完整跨 Host 冻结屏障、持久迁移 source／target、实际切换后新增数据归档及迁回、真实搜索 GUI／Electron／EXE 仍未验收。05 本批次 T073 验证错误边界修复不等于提供维护冻结接口。原文件、数据、代际、回执及旧快照保留；T075—T078 均继续进行中。整体按 TASKS.md：**175 项，137 完成／35 进行中／3 未开始**，本组 **0 完成／4 进行中**。

本批次交付与冻结记录见 [REPORT.md](../../.artifacts/parallel-handoff/06/continue-20261025/REPORT.md) 和 [RESULT.json](../../.artifacts/parallel-handoff/06/continue-20261025/RESULT.json)。它们补充此前十轮记录，不覆盖旧失败或把未验收项目改为成功。

### 后续授权 GUI 同一场景 r2：失败停止

08 接受 Client r3 后，允许先修正原驱动，再分配 owner06／revision11 续原 `native-entry/search` 场景 r2 一次。修正仅涉及真实滚动、视口／命中／稳定几何、布局与焦点条件等待及失败子步骤；产品入口、权限、原 case 名和断言保留。Node 24.22.0 静态语法解析首次通过。

实际 GUI r2 失败于 `native-entry/native-button`：“原生工作区”候选 0，完成场景 0，没有执行入口鼠标点击或搜索。恢复时“工作台”候选也为 0，`restored=false`，不能确认原页及焦点恢复。清理只尝试清空组合输入和 Escape，全部本组 CDP 已关闭，监听错误 0；无新服务／会话／模型／数据库／DDL。已立即报告 08 接回核实当前页面和恢复，没有自动第 3 次或再次连接。

原 r1 失败且恢复成功、当前 r2 失败且恢复未确认分别保留。详见 [GUI-R2.md](../../.artifacts/parallel-handoff/06/continue-20261025/GUI-R2.md) 和 [真实 r2 回执](../../.artifacts/parallel-handoff/06/gui-20261024/gui-search-readonly-r2.json)。这次证据不足以唯一确定缺少控件的原因，不据此改变产品入口或权限；Client r3 通过仍有效。整体 **175／137 完成／35 进行中／3 未开始**，本组四项仍进行中。

### 08 收口与应用恢复回执

08 已正式接受两处 Client 依赖修复，具名 SHA 首轮匹配，继承的最后 Client r3 零诊断记账。本组没有复跑。08 接回 owner08／revision12 后发现现有窗口最小化、空 bootstrap DOM 和 root 注册顺序错误；恢复 r1 失败后仅一次页面 reload，恢复 r2 得到 HTTP200、导航可见、页面异常 0，未重启 Host。此恢复由 08 独立执行，不把本组搜索 r2、搜索能力或新挂载源码记为验收通过。

GUI 窗口分配已关闭，本组保持冻结，没有 GUI r3、数据库、构建或新检查。08 最新根 watcher 为 186 个诊断，局部挂载修复尚未进入实际 bundle；正式发布及完整迁移回退依赖仍未完成。记录见 [COORDINATOR-CLOSE.json](../../.artifacts/parallel-handoff/06/continue-20261025/COORDINATOR-CLOSE.json) 和 [08 最终报告](../../.artifacts/parallel-handoff/08/continue-20261025/REPORT.md)。整体继续 **175 项：137 完成／35 进行中／3 未开始**；T075—T078 全部进行中。
