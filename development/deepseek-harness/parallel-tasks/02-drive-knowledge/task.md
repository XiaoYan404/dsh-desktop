# Agent 02｜网盘文档、图片读取、知识库与办公交付

本文件可单独交给一个 Agent 执行。交接快照：整体 **175 项，完成 137 项、进行中 20 项、未开始 18 项**；本组 **4 项，进行中 2 项、未开始 2 项**。2026-10-19 已获用户明确授权恢复本组开发；公共状态由 08 统一写回。

本组目标：把剩余文件能力接入真实网盘、原生 Agent 和持久日志，再提供有权限与版本依据的企业知识库及可打开的办公交付物。

当前执行汇总：2026-10-25 用户继续授权完善；本组本批仅收敛知识库查询失败恢复及其与未确认写入的状态隔离，并修正既有 image-associations 测试 exactOptional 类型问题。新增 9 个定向模型／组件场景首次通过，两个新受控 Chromium 组件 GUI 场景首次通过；正式产品页面未验收。整体实时为 **175／137 完成／35 进行中／3 未开始**，四项继续进行中；原知识 lint 第 3 次保留待真实 Client/Remote 声明，旧 Host／XLSX／authority／Electron 封顶项均不复跑。

## 本组任务清单（完整继承原验收标准）

| ID | 优先级 | 交接状态 | 任务 | 原验收标准 | 来源／前置依赖 |
| --- | --- | --- | --- | --- | --- |
| T044 | P1 | 进行中 | 网盘搜索、预览与 AI 附件 | 授权搜索/真实内容预览；引用到会话仍检查权限与版本，撤权后不能继续读取 | R1/R2；T042/T026 |
| T141 | P1 | 进行中 | 网盘图片、PDF 及 Office 文档的 Agent 读取 | 通过提交引用读取真实图片或文档，解析／模型输入及结果入原生日志；每次读取复核归属、角色、权限和版本，限制总字节及解析资源，撤权后不能借未授权完整缓存读取新内容 | R1/R2/R8；T044/T139/T140 |
| T046 | P2 | 未开始 | 企业知识库发布和检索 | 解析真实文件、授权索引、增量更新；问答引用到可访问正文与版本，删除/撤权后不召回 | R3/R9；T044 |
| T047 | P2 | 未开始 | 企业模板和办公交付链路 | Word/Excel/PPT/PDF 输出可打开并检查；模板来源清晰，原 Office Skills 完整保留 | R1/R3/R6；T028/T031 |

## 已有进展与真实缺口

- T044：私有／共享网盘、搜索、真实文本／位图预览、会话资料引用、逐次提交快照及当前授权已存在。不要重建文件系统或用复制完整附件的浏览器缓存代替授权。剩余格式和 Agent 读取由 T141 接续。

- T141：受限 PDF、DOCX、XLSX 和 PPTX 已有正式实现。PPTX 已在 v118 真实页面走通上传 3315 字节→选定原 Session→人工批准→tool/result→下一次模型相同内容。XLSX 复杂 OPC/Strict/绘图夹具已三轮封顶，最终局部 lint 修正后未复验；不得重跑第四次或称兼容性齐全。旧 DOC/XLS、OCR 仍未实现，按需求价值明确支持范围，不以模板替代解析。

- 图片已由 08 应用正式源码接线；新的 Loader＋中央 HTTP＋Native 人工审批、真实附件／日志及下一受控模型请求链有通过证据。原 Stage A 11 项、Stage B 13 项和 early-cancel 原绿仅作历史分层证据，没有复跑。正式构建和真实页面尚待 08，不以源码测试替代页面或外部模型验收。

## 图片接入必须从这些交接继续

- Native 最新候选：[implementation-reviewed](../../.artifacts/enterprise-office/image-reader/implementation-reviewed/result.json)、[接线方案](../../.artifacts/enterprise-office/image-reader/implementation-reviewed/native-c-plan.json)。取消信号已在模型解析前组合；新取消行为 1 次、窄类型 1 次、lint 2 次完成，原 11 绿未复跑。

- Authority 最新候选位于不同根目录：[HANDOFF.zh.md](../../.artifacts/image-reader/authority-reviewed/HANDOFF.zh.md)、[manifest](../../.artifacts/image-reader/authority-reviewed/patch-manifest.json)。不要误用旧 enterprise-office/image-reader/authority 中未修审查点的补丁。新候选完整响应限制为 128..16 MiB，policy JSDoc 和入口内联 Config 已补。

- 最新 authority 补丁检查首过、lint 第 3 次过；artifact noEmit 已三轮封顶仍有 vendor 编译选项差异，整体不能写通过。唯一响应边界标题已编写但从未执行，正式装配后保留原标题运行；不再重复该 artifact 类型装配。

- 与 08 核对 manifest 原 SHA，再接入 Office 同一队列的读取／末次权限复核、固定 RPC allowlist 和 Native-only Host BFF。Host GatewayClient 完整响应上限是 16 MiB；不能全局放大上限绕过候选限制。

- 完成 tool-office 的默认关闭配置、正整数硬结果字节限额、提交文件工具注册、显式图片审核分支及原 readApproval；可选 attachments/llm 不能加入无条件 inject 导致原插件等待新服务。

- agent/inbox/claimed 是同步 void emit，不能 await 查询能力／模型后才注册工具。Capture 不含 limits；必须在真实异步 Host 准备链提供受账号／角色／连接约束的能力提示，仍在执行时重新验证模型图像输入、当前 authority 和最终源版本。

- Native 实际 AttachmentStore.saveImage、原 ImageBlock、tool/result 持久化及下一模型请求二进制必须一致；独立限制源字节／像素／边长、完整响应、规范化结果。GIF/动画只归一化首帧。Sharp/saveImage 无单次取消接口，等待已开始操作结算后禁止发布，不能宣称即时中止或硬 RSS。

## 知识库与交付物

1. T046 新增知识库发布、真实解析、权限索引和增量更新。引用必须返回可访问正文、源文件版本与位置；删除、撤权、版本替换后不得召回旧正文。复用已支持解析器并明确未支持格式，不另写虚假解析。

2. T047 复用现有 Office Skills 和原交付机制，提供真实 Word/Excel/PPT/PDF 产出、模板来源、文件预览／下载和工作事项交付。实际打开或解析检查结构及内容；不以改后缀的文本当二进制文档。

3. 与 04 的任务验收和 08 的双员工流程约定交付引用；目前 Native deliverables 到 Drive 没有自动外键，不能凭空宣称自动同步。

## 文件归属与验收

- 本组负责文档／图片 reader 叶子实现、tool-office 文件读工具、网盘文件能力模型／组件、新知识库与模板交付模块及其局部测试和 README。公共入口、Config 汇总、依赖锁、类型目录和统一构建交 08。

- 图片至少有一次新的正式 Loader＋中央 HTTP＋Native 人工审批＋真实持久图像／下一请求链验证；按已执行次数使用剩余额度。模型用受控 adapter 时明确说明，不能声称外部模型已调用。

- 撤权后禁止新的未经授权读取／recheck，不得从未授权缓存向共享快照、知识索引、导出或新提交披露内容。先前合法披露并持久化的 ImageBlock 及 Native 历史不追溯删除或改写；末次复核拒绝也可能留下不可达的 immutable 附件对象，须如实说明保留／回收范围，不能宣称已撤回历史中的图像。

## 用户要求：每位 Agent 都必须遵守

1. 产品定位：面向普通员工的企业私有化办公 Agent，通过配置打通企业已有管理系统。实现真实页面功能、持久数据与受控业务操作；不能只做原型、假上传、计时器或模拟成功。

2. 固定页面要求：移除最左侧公司层；主导航依次为工作台、AI会话、通讯录、网盘、工作、集成、工具，底部两个按钮保留。首页上方左 3/5 仪表板、右 2/5 日历＋待办及滚动公告，下方对话框；发送后进入保留左栏和右侧新建会话栏的独立 AI 页。

3. 日历用列表查看当日安排，可新建日程并邀请成员；待办有状态，在日历旁与空态可新建。通讯录展示组织成员，聊天像微信，功能在输入框上方，可发聊天、任务、会议和待办。头像显示登录成员、角色、岗位并可编辑资料。

4. 网盘像 Windows 文件夹，有私有／共享网盘和按账号设置的权限。工作页管理日常工作。集成展示本公司定制系统、支持导入和详情／定制需求；工具页展示技能及钉钉、企业微信、OA。AI 会话体现关联集成／工具；选择关联不等于授权执行。

5. 必须完整保留原有：会话、模型、Skills、MCP、工作流、定时任务；文件、终端、浏览器、子 Agent、权限、交付物；CLI／SDK、桌面菜单、快捷键、设置、历史数据和插件管理。不得用新办公壳替换掉原功能。

6. 最新执行规则优先：已取消 20 轮清单检查、10 遍核对及完成后 20 轮检查。同一问题重复检查最多 3 轮，通过即停；原检查额度跨 Agent 继承。不得第四次、改名、删除断言、改 golden 或过滤失败来伪造通过。只运行必要定向测试／构建，不重复旧绿。

7. 每轮开头输出“第 N 轮｜本轮任务｜预计改动”，结尾输出“进展｜本轮改动｜下一轮方向”；每次对外进展同时给出整体总数、完成／进行中／未开始，按实时 TASKS.md 统计。本交接快照为 175／137／20／18，不能用本组完成数冒充整体进度。

8. 保持可运行。依据验收标准自查，失败在额度内修复；做不了的、缺凭据的、实现但未验收的、平台限制的分别列清单。不要问“接下来做什么”，能独立完成的先推进；缺真实接口或身份配置时如实记录依赖，不假连接。

9. 交接阶段曾按用户要求暂停；2026-10-19 已收到执行本文件的明确授权，仅恢复本组范围，不恢复原先跨项目“永不停止”模式。父任务完成状态仍由 08 按实际验收写回。

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
- [03 钉钉、企业微信、OA 与办公自动化](../03-connectors-automation/task.md)
- [04 成员身份、审计、消息与群组协作](../04-identity-collaboration/task.md)
- [05 MySQL 原生持久化、事务工作区与投影](../05-mysql-core/task.md)
- [06 MySQL 检索、冻结转储与切换回退](../06-mysql-search-migration/task.md)
- [07 场景助手、企业外观、可访问性与终端体验](../07-experience-scenes/task.md)
- [08 统一整合、备份部署、安装包与最终验收](../08-release-integration/task.md)

## 本组执行记录（领取后维护）

| 轮次 | 任务 ID | 实际改动／证据 | 检查次数与结果 | 正式接入状态／剩余依赖 |
| --- | --- | --- | --- | --- |
| 交接 | 本组全部 | 仅拆分任务；未新增产品代码、测试或构建 | 不重跑历史检查 | 保持上表原状态，等待分组执行 |
| 02-1 | T044/T141 | 8 项 authority 原 SHA 全匹配；迁入正式 image-authority/image-types/image-tool 与同步注册、显式图片审核、Host 准备能力及 UI 引用准入。08 已核验 9 项公共候选 SHA 并顺序应用 image-public.patch；本组无 DB 在途。证据见 `.artifacts/parallel-handoff/02/` | 新正式 Loader＋中央 HTTP＋Native 6 语义：5 首轮、1 第二轮通过（修正 fixture 的 sha256: 前缀）；cap/UI 3 首轮通过。完整响应原标题第 3 轮通过：首轮同名上传 fixture 冲突，第二轮未携带原 30s 配置而在 5s 超时，恢复原 30s 后通过并封顶。旧绿／XLSX 封顶／artifact noEmit 不复跑 | 正式源码接线已应用；22,565 字节真实 PNG→10,162 字节 Native immutable image→JSONL→下一受控模型请求一致，有真实 approval/decided。完整成功响应 16,776,188 字节，超限响应结构化拒绝。统一构建与真实页面尚未验收，未宣称外部模型调用；已保存合法历史不追溯改写 |
| 02-2 | T046 | 独立知识域、同队列真实解析／当前授权索引、增量替换、引用重开、网盘发布审阅和检索组件、Native 检索／引用工具已接正式源码；7 个 Office 语义和 6 个 UI／HTTP＋Native 消费者语义有通过记录 | 原 5 个新 Office 场景中 3 首轮绿、2 第三轮绿（fixture 的目录 revision／search 及 withSession 参数修正），已封顶停止；删除源和 Native 转义包装字节上限 2 个新场景首轮绿；consumer 6 项首轮绿。见 `knowledge-behavior-r1..r3`、`knowledge-retirement-output-r1`、`knowledge-consumers-r1` | 默认关闭，显式 10 项资源限额；删除／撤权／换版本不召回旧正文，原词面与位置可重开。索引旧记录按权限过滤，不宣称物理擦除。Native 工具仅用于带已提交文件上下文的轮次；普通无关联聊天不自动全库检索。未做 SQL 接入、真实页面或外部模型验收 |
| 02-3 | T047 | 复用原四类流程和已有解析器，新增只读交付检查、固定配方来源、原工具人工审批；实际 DOCX/XLSX/PPTX/PDF 字节检查后，沿原工作附件→员工提交→审核人验收，另验中央 HTTP＋Native 日志及下一受控请求 | 6 新场景第二轮全过；首轮依据 08 提前的“已应用”通知启动，实际公共补丁因 07 上下文冲突未应用，6 项缺 method 装配失败均保留。refresh 的 `f068a224…` 真正应用后复验通过并停止；XLSX 使用新 ExcelJS 简单输出，没有重跑复杂封顶夹具 | 正式源码接线完成，未宣称新编写引擎、16 套模板、视觉排版、公式重算或 Native→Drive 自动外键。原 Office Skills/present/网盘上传下载和工作提交验收沿用；完整真实模型编写／真实页面交付验收仍待整合 |
| 冻结审查 | 全部 | 按身份权限、生命周期、资源完整上限、持久化／原历史、UI／部署证据 5 个不同方面完成深查；修正 MIME 准入与 authority 规范格式不一致，并新增 2 负例首轮通过。新增图片页面用例已编写，尚未执行 | 新行为共 10 个源码测试文件、31 个唯一场景有通过证据。图片新集成 lint 首轮失败的样式已修；知识库／交付 lint 首轮的样式和页面 Context augment／YAML 导入已修。Client Remote 和 Office 声明仍是旧产物，待 08 生成后仅续失败文件，不能把待复验写为 lint 通过 | 旧 image authority artifact noEmit 三轮失败、复杂 XLSX 三轮封顶、先前合法 Native 图像历史均保留。未安装、未根构建、未重启预览、未连接数据库。证据／命令／剩余额度及冻结 SHA 交 `.artifacts/parallel-handoff/02/handoff.json`，08 为下一整合人 |
| 02-5 | T044/T141 整合 | 08 将 `office/image-reader-enabled` 的唯一 Events 声明从内部 image-admission.ts 移至公共 Host index，使其进入 index.d.ts；本组核对只有一个声明，运行逻辑不变，更新 freeze-v2 并保留 v1 | 08 正式 Host owning 第 2 轮仅剩此声明，已修后第 3 轮编译进行中，尚不记通过。没有复跑旧 artifact noEmit、旧绿或任何封顶检查；本组两组严格 lint 均仍仅第 1 轮 | Client/API Remote/Web 产物及图片页面继续由 08 顺序整合；当前整体仍 175／137／34／4，不提前结项 |
| 02-6 | 组间 fixture 类型修复 | 01 复用本组真实 HTTP＋Native fixture 的窄 strict 类型首轮发现三类错误：公开 script 覆盖基类私有字段、审批 reason 可缺省、prepare-context 声明未显式导入。本组修为 responses、reason 缺省记录空字符串，并导入 session-controller 类型声明；未改生产运行逻辑 | 01 原类型第 1 轮失败记录保留，待其同步候选 responses 引用后仅续第 2 轮；本组未重跑已绿身份／图片／知识库／交付行为 | 更新 freeze-v3，保留前两版；01 拥有自己的新身份场景与检查预算，08 继续独占共享编译。整体仍 175／137／34／4 |
| 02-7 最终收束 | 全部 | 核对 08 的正式证据：Host 类型 r3 exit 0；Host bundles r3 exit 1，原因为 OfficeAutomationCommandInput 未从公共 non-root type 子路径导出。08 已封顶停止，不做第四次或改名重跑，也不以 v119 验收新页面。01 fixture 窄 strict r2 已通过，未重跑行为。新增最终 HANDOFF.md 和 freeze-v4，历史三版保留 | 本组31唯一源码场景通过记录不变；两组严格 lint 均停在原第1轮失败后局部修复状态，完整 Client Remote 生成／Client／Web 和新图片页面均未验收。发现原 README 补丁的中文锚点受 stdin 编码影响未落位，改用 UTF-8 文件生成三份中文增量补丁，v1保留；仅新补丁 apply --check 首过，实际共享文档及配对仍由08处理 | 四项继续进行中；最终状态为“正式源码已接、Host类型通过、发行构建失败封顶、真实页面未验收”。01／04新增登录生命周期 authority 候选的正式接入不在本组已通过结论内。整体175／137／35／3 |
| 02-8 Config 文档收尾 | T046/T047 | 依 08 原 Config generator r1 失败补齐 OfficeKnowledgePolicy 10 字段和 OfficeDeliveryPolicy 3 字段 JSDoc；说明撤回记录计数、完整索引及回执字节、UTF-16 文本长度、页／幻灯片／工作表上限、完整输出和提取期限。两份叶子类型文件没有改动字段或运行逻辑 | 本组仅做 1 轮五维静态审阅，TypeScript scanner 确认非注释 token 完全相同；13 条字段注释新增。行为／lint／build／generator 本轮均 0 次，不重跑旧绿或封顶项。证据 config-jsdoc-review-r1.json，保留原失败 | 两份源码 SHA 已交 08；仅由其续原失败 Config generator 第 2 轮，尚不记生成通过。freeze-v5 保留 v1–v4；原 Host bundle 三轮封顶和 Client／页面未验收状态不变。整体 175／137 完成／35 进行中／3 未开始 |
| 02-9 文档移位交接 | T044/T141/T046/T047 文档 | 08 为复用既有双语 README 配对语料，将 drive-readers.md／drive-readers.zh.md 保留原快照后移为 office/drive-readers/README.md／README.zh.md，并更新三包六个引用及文件内相对链接；本组仅更新 task／handoff／freeze-v6，不改共享 README 或检查器 | 本组仅首次静态核对移位：原快照 SHA 与 freeze-v5 一致，正文仅相对链接改变，六份入口 README 仅链接替换，其余 35 个冻结文件未漂移；行为／lint／build／generator 均 0 次 | 新路径已接入共享文档；08 通知的 11 对具名文档首次实际配对 write 尚待结果，不声明配对通过。原运行产物封顶、Client／页面未验收和四项进行中不变；整体 175／137／35／3 |

## 2026-10-24/25 GUI 十轮检查

范围仍为 T044/T141/T046/T047，仅修改本组 GUI 叶子、测试、参考文档及私有交接。公共 knowledgeSearch 双语键由 08 按补丁上下文接入；未改旧 search，也未改公共入口、锁、生成目录、运行配置、数据库或原历史。

| 轮次 | GUI 检查主题 | 实际处置／结果 |
| --- | --- | --- |
| GUI-1 | GUI 基线与验收分层 | 阅读当前任务、发布记录和源码；保留 Host bundle 封顶及 v119 基线，不推断 Electron 已验收 |
| GUI-2 | 查询状态与结果上限 | 记录提交关键词、忽略空白并修剪输入；收紧限额时同时约束迟到和已显示结果 |
| GUI-3 | 键盘、输入法与员工草稿 | 组合输入期间 Enter 不提交；忙碌时禁止重复提交；员工或角色变化重建输入草稿 |
| GUI-4 | 弹窗退出与准确重试 | 关闭读取审阅后迟到响应不再打开弹窗；隐藏的未确认写入保留原操作、文件、修订和 UUID，明确重试才恢复 |
| GUI-5 | 窗口大小、主题与长内容 | 复用既有 token 新增叶子 CSS、文件名换行和有界正文滚动；初次 GUI 截图暴露视觉问题并保留失败 |
| GUI-6 | 拒绝访问与正文安全呈现 | 引用拒绝后清除正文和 hasMore；源标记保持惰性文本；不新增权限授予或追溯改写历史 |
| GUI-7 | 文档访问与预览操作 | 引用调用既有版本下载器选择准确版本；预览正文可键盘聚焦；只验证回调，未实际下载文件 |
| GUI-8 | 真实 Chromium 源码组件交互 | 受控 Remote 的六个新 GUI 场景首次通过；页面及控制台错误均零；仅关闭自建标签并保留原应用 |
| GUI-9 | 截图人工审查与视觉修复 | 记录文件名挤压、深色正文和按钮文案问题；仅两受影响区域第二轮通过，间隔 8px、390px 不溢出、对比度 11.98:1 |
| GUI-10 | 补充断言、严格整合与交接 | 三个新断言首次通过，原十六项跳过；严格 lint 继承第 2 轮仍失败，公共 Remote/Client 声明仍须整合 |

本次新增源码场景 19 项：首批 16 首轮通过，后续 3 首轮通过且原 16 跳过。真实 Chromium 组件首批交互 6 项首轮通过；人工截图另发现长文件名挤压、深色弹窗正文和搜索按钮文案问题，仅两受影响区域第 2 轮复验通过。对比度 11.98:1、390px 无横向溢出、文件名与版本信息间隔 8px。所有新标签已关闭，3081 原应用保留。受控 Remote、不连接真实数据库、不调用外部模型，不将下载回调当实际文件下载。

检查次数：组件静态资源依赖准备 r1/r2 失败、r3 成功后停止；随后因新视觉修复生成私有候选资源，不运行 Host/Typert。locale 补丁首次无尾部上下文失败，真实 diff 刷新后第 2 次 check 通过；08 等价接入。严格 lint 继承原 knowledge-delivery-lint 第 2 轮失败；本地四份修正已由 08 校验 SHA 后接入，生产 JS 等价，未复跑 lint 或 GUI，公共 Remote/Client 声明及原第 3 次仍待整合。图片 lint 原第 1 轮和历史封顶项没有复跑。

当前源码能力、组件 GUI 与正式软件验收分别记录。实际 Office/Host/Client 页面、真实知识库/办公写入、实际版本文件下载、Electron 安装与菜单均不纳入本次通过。证据及完整命令见 .artifacts/parallel-handoff/02/gui-20261024/REPORT.md 与 report.json；08 为下一整合人。

2026-10-25 整合回执：08 在安全交接点用指定 Node 24.22.0 接入四份自有 lint-only 候选，回执见 gui-20261024/lint-fixes/applied.json。仅更新当前冻结与交接为 freeze-v8，保留 v1–v7；没有执行新的检查、GUI 操作或构建。严格 lint 仍是原第 2 轮失败，剩余第 3 次等待真实 Client/Remote 声明。整体 175／137 完成／35 进行中／3 未开始。

## 2026-10-25 查询恢复有限批次

用户新指令恢复本组工作，08 限定本批一条知识 GUI 状态闭环。结果标明已提交关键词，即使输入框已有新草稿；查询失败独立显示并仅重发原关键词。未确认发布与查询各有恢复入口；正在写入与回执未知分别标识，读取错误不覆盖变更状态，查询重试不会重发写入或丢失原 UUID。仅修改本组 3 个 GUI 叶子、相关测试及 reader 中英参考，复用既有 locale 和回调，不新建 RPC／公共入口。

新增 knowledge-query-recovery.client.spec.tsx 共 9 个场景首轮通过：双语慢响应草稿、原关键词重试、双恢复入口及原 UUID、读取忙碌与未知变更区分、后续审阅／确定拒绝不清查询错误、旧员工写入不清新员工 saving。旧绿不复跑，旧两套 fixture 只补新增快照字段。image-associations 原断言全部保留，用真正省略 image 属性表示能力缺失，不放宽 exactOptional 属性。

仅准备一次私有静态组件资源，未启动服务／Host／数据库／GUI／外部模型，未写原数据或改历史。源码先冻结为 freeze-v9；08 随后分配 owner02/rev10 短窗口，两新 GUI 场景首轮通过，当前冻结续为 freeze-v10。受控组件通过不替代正式 Office/Host/Client 或 Electron 验收。证据和 SHA 见 .artifacts/parallel-handoff/02/knowledge-query-20261025/report.json；严格 lint 仍保留原第 2 轮失败，不消耗剩余第 3 次。整体 175／137／35／3。

本批 GUI 回执：knowledge-query-20261025/browser-r1.json。仅两新场景首次通过：1100px 明色慢响应／原关键词与新草稿，440px 深色双错误／查询原关键词重试／发布原 UUID 恢复；每 case 前核验 owner02/rev10。仅关闭自建标签并回原 3081 页面，未改导航、尺寸、主题或原数据；页面及控制台错误均 0。两截图已人工复核；旧 9 项源码绿、旧 GUI、旧 lint 第 3 次和全部封顶项均未复跑。仅更新交接和 freeze-v10 共 42 文件，保留 v1–v9，结束本批一条知识 GUI 状态闭环。整体 175／137／35／3。
