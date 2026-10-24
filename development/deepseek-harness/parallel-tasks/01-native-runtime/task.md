# Agent 01｜原生运行、员工隔离与 Windows 兼容

2026-10-19 本组已按用户本次授权恢复限定范围开发；下文“暂停”保留为交接快照，不阻止本次执行。最新实时 TASKS.md 为 **175 项：完成 137、进行中 35、未开始 3**。本组仍为 6 个未完成父项，未提前变更中央状态；公共构建及预览由 08 负责。

本文件可单独交给一个 Agent 执行。交接快照：整体 **175 项，完成 137 项、进行中 20 项、未开始 18 项**；本组 **6 项，进行中 5 项、未开始 1 项**。当前自动开发已暂停，仅整理交接。

本组目标：完成已有 Native 能力的员工访问边界及剩余 Windows 兼容问题。优先修真实权限漏洞，再处理未封顶的平台与交互问题；保留普通原生会话的既有行为。

## 本组任务清单（完整继承原验收标准）

| ID | 优先级 | 交接状态 | 任务 | 原验收标准 | 来源／前置依赖 |
| --- | --- | --- | --- | --- | --- |
| T024 | P0 | 进行中 | 普通/事项会话草稿隔离 | 多会话文本、附件、模板、能力关联独立恢复；返回首页恢复普通会话，无跨账号数据 | R2；T009/T016 |
| T144 | P0 | 进行中 | 冷恢复和重载后的办公运行归属 | 从原始会话事件重建员工归属，插件重载及 Agent 冷恢复后仍阻止旧身份继续驱动模型或工具；不改变原日志字节，不用未来队列中的角色审核放行当前步骤；跨员工混合历史拒绝继续，未关联办公的原生会话保留 | R8；T024/T143 |
| T130 | P1 | 进行中 | 原生执行、工具目录和录制的 Windows 兼容余项 | 逐项定位和修复后台作业、变更文件、PTC、默认会话、录制回放、归档及语音等平台差异；实际运行工具并比对日志与文件，独立保留 POSIX 记录，禁止整体刷新 | R8；第 69 轮共同失败余项 41 个／13 文件，包括 background-job-list、changed-files-turn、code-language、default-workspace、live-interactions、live-job-stream、minimal-preset、ptc-round、replay-round-trip、session-archive-active、shipped-composition、turn-tail-actions、voice-input |
| T132 | P1 | 进行中 | 原生长会话、滚动、面板及 Steering 余项 | 实际验证持续会话、流式滚动归属、面板尺寸变化和转向／排队，取消和清理后无未处理异常；使用状态屏障，不以睡眠或弱化断言修复 | R8；第69轮共同失败余项原为6个／4文件：chat-continuous-conversation、chat-scroll-contract、navigation-panes、steering |
| T137 | P1 | 未开始 | Windows 文件符号链接验证环境 | 在具备文件符号链接权限的 Windows 会话中运行 API 5 文件 6 项及启动库 3 文件 4 项原链接用例，记录 Node、权限和真实结果 | R8；T003/T080 |
| T162 | P1 | 进行中 | 办公子 Agent 中断页偶发界面差异 | 保留原快照，存下实际文本界面和截图，定位首个差异；不以重复通过或跳过断言代替根因修复；中断、恢复、FIFO、图片及父离线操作继续真实验证 | R8；T080 |

## 已有进展与真实缺口

- T024/T144：普通／事项会话草稿、跨窗口同步、原生日志归属、后代继承、冷恢复拒绝、工作区文件读取与监视授权已经有实现和证据。Job list/follow/kill 的当前员工边界 13 项、Changes 的 8 项新源码场景已通过并在 v118/v119 构建中。剩余是完整多用户 Native 资源隔离；浏览器配置分区、缓存归属索引、会话描述均不能当授权凭据。

- 继续核对终端持续输出、浏览器及其他资源：取得资源、打开流、每帧交付和最终异步返回都要复核当前员工、角色、原 Agent/turn 及生命周期。归属证据缺失或混合历史要拒绝，不得默认归给当前员工；从未关联办公的原生会话保留原权限模型。

- T130：实际 pwsh 后台任务就绪／双按停止／公开 ZIP 前缀已通过；原第 69 轮 13 个文件、41 个 Windows 余项不是全部完成。按 TASKS.md 的原始清单逐项排查 PTC、默认工作区、录制回放、归档、交互及语音等剩余差异，不重跑已绿后台任务。

- T132：原 6 个余项已有 5 个通过：持续会话、wheel、fling、navigation、第二个 Steering。第一个 Steering 的业务断言虽已走通，持久日志仍与旧 POSIX 录制中的 Windows ACL 技能事件不同，整体未通过；该标题已三轮封顶，不得第四次或改名重跑、改 golden/normalizer。

- T137：Windows 原链接用例因缺文件符号链接权限出现 6+4 个 EPERM，原提交对照也失败。先确认实际 Node 和 SeCreateSymbolicLinkPrivilege／可用文件链接能力，再在有权限的环境验证原用例；不能把跳过、改为 junction 或删断言称作修复。

- T162：子 Agent 中断页曾出现首个离线快照差异，补存失败文本后整文件 6 项又通过，但根因尚未证实。保留原快照，定位首差异及中断／恢复／FIFO／图片／父离线路径，不靠重复通过结案。

## 具体执行顺序

1. 从最新源码和已冻结证据建立“未覆盖资源 × 授权阶段”小清单，优先解决可复现的数据或模型／工具越权。每项新增独立回归只验证对应漏洞及必要兼容分支。

2. 在会话、工具、文件、终端、流和子 Agent 的原扩展点实现；不在 Agent loop 增加办公特例，不将冷 Agent 为了查询而激活。

3. 处理仍有检查额度的 Windows 余项；封顶项继续只读分析并列入最终缺口，不制造新的同名或换名套件。

4. 与 08 协调窄构建和新的实际场景；将业务安全结果与平台环境限制分别记录。

## 文件归属与交接

- 本组负责 Native 授权和生命周期相关叶子实现及对应原测试；包括 api-session/workspace/terminal 的策略实现、tool-office 的 native-ownership/native-history/native-claims/driver 等已有归属代码。修改前用 rg 找到实际文件，不按旧摘要猜路径。

- 02 负责新图片工具及资料读取；涉及既有 driver/归属机制时双方先确定接口，不同时改文件。公共 Office/Client 入口和生成文件交 08 顺序整合。

- 原终端实际页面也已三轮封顶，止于后续输出检查；保留失败和已观察到的列表／新持有拒绝，不声称完整页面通过。

## 验收补充

- 换员工、降权、停用、退出、重载及冷恢复后，旧资源不得交付迟到字节、元数据或继续驱动模型／工具；无办公归属的原生能力仍可用。

- 原事件前缀、压缩日志、历史代际和旧录制不变；取消及卸载结算真实进程、句柄、观察者和 Promise，不能吞异常。

- 已封顶问题在交付清单写明“未通过／环境依赖”，不能为了将父项勾成完成而删去。

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

- [02 网盘文档、图片读取、知识库与办公交付](../02-drive-knowledge/task.md)
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
| 01-1 | T024/T144 | `history-access.ts` 在 terminal/workspace-files/job/deliverables 的原授权点增加认领角色复核；请求原取消信号保存初始归属限制，每次仍读取原生历史及当前员工授权，后续新角色认领不能给旧流续权；普通历史浏览不因角色变化消失。复用真实中央 HTTP、JSON 办公存储、Loader 和内存 SQLite fixture；未改公共入口 | 新 9 场景 r1 因 fixture 误用 Session 字段及关联版本字段全失败；修正 fixture 后 r2 为 4 Native 对照通过、5 角色漏洞真实失败；仅续 5 失败场景，r3 全通过。4 已绿对照未再跑，5 同题已封顶不重跑。`resource-roles-r1/r2/r3.json` 原样保留 | 三个源码／测试文件已冻结交 08；仅源码接入，未自行构建。T024/T144 整体仍未完成 |
| 01-2 | T024/T144/T130/T132/T137/T162 | 三文件严格 Host 窄类型检查；符号链接环境探针；只读汇总第69轮原41/13 Windows差异及子 Agent 历史报告；原终端页／首Steering／原子 Agent页面均未重跑 | lint r1 新测试行宽失败，r2 通过；类型 r1 窄程序缺显式事件类型导入失败，补 type-only 导入后 r2 通过。Node **24.22.0** 文件 symlink 一次 EPERM；进程未持有 SeCreateSymbolicLinkPrivilege，临时资源已清理，未重复原10个必失败用例 | 证据在 `.artifacts/parallel-handoff/01/`。DB drained，无真实 MySQL／DDL／在途DB，不参与公共构建或预览重启。退出后同员工新登录的原子身份epoch接口与06/08协调；浏览器员工资源隔离、完整终端页面、Windows其余项及旧子 Agent首差异仍列缺口 |
| 01-3 | T130 | 向08提交并由08正式应用 `voice-windows.patch`：原语音标题复用已有 `fresh-round-trip-windows/session.v4.jsonl`，输入前缀改用实际 pwsh；仅新增两份独立 Windows 文本期望，原POSIX及其他语音期望不动 | 保守继承第69轮主／对照两次，本次只用最后第3次，原标题整文件 **1/1通过，8.69秒**，严格持久回放及清理通过。21个保护文件摘要不变；voice窄lint首次通过；未重跑成功项。角色切片补 type-only 导入后的终末窄lint第3次通过，不再运行 | 源码／两份期望已由08应用；利用既有built验证，未新增公共构建或重启3081，浏览器窗口已归还08。原41个Windows清单保留，本次只收口语音这一项，不把T130整体标绿 |
| 01-4 | T024/T144 | 用户要求继续至全部完成后恢复；独立发现退出→同员工重登及Alice→Bob→Alice时旧资源仍有授权。暂存history-access候选复用原 `credentials/record-updated` 提交后事件，为旧办公请求撤销生命周期，当前账号／原生归属仍逐次复核，未读取token | 6个新独立场景r1为4真实负例失败／2无关凭据及Native对照通过；只续4失败项，候选r2全过。候选strict Host类型及窄lint首次通过；patch检查首次通过。没有重跑原role5、Job13、Changes8或旧绿对照 | `.artifacts/parallel-handoff/01/login-v2/login-resource.patch` 已交08；08统一编译冻结期间未改主树，暂存通过不记正式接入完成 |
| 01-5 | T024/T144 | 复用02许可的完整Loader／中央HTTP／AgentLoop fixture，原模型迟到chunk和实际已写文件的私有工具结果在重登后泄漏两个新负例真实复现。暂存native-ownership候选按原Agent/turn保存凭据代际，并取消准确办公运行、等待卸载结算；新登录新turn可恢复 | r1为2真实负例失败／1未关联Native模型对照通过；候选仅续2失败项r2均过。窄lint首过。严格类型r1发现借用fixture的private脚本属性冲突、可选reason及事件声明问题，由02修自身fixture，01同步引用responses后types r2通过；未重跑已绿行为 | `native-run-v3/native-run-login.patch`、`native-run-metadata.patch` 交08，源仍暂存。04正在提供完整原子authority接口，01已指出local身份兼容和“全Office revision会令工具自身合法写入后失权”的问题；待auth-only版本后再接scope/revision。Windows default-workspace补丁已准备，等08窗口只用原题最后1次 |
| 01-6 | T024/T144 | 08已应用01-4／01-5源码及元数据；实际拥有者编译发现裸`cancel()`缺实参，08改为`cancel({kind:'disposed'},{keepInbox:true})`。新增独立真实Native队列回归：旧活动撤销后仅1次模型／1turn，2条排队输入仍持久保留且无自动推进；显式新登录wake后按FIFO各消费一次，共4turn完成 | 新队列场景r1 **1/1通过，1.05秒**，窄lint r1通过，patch检查r1通过；没有重跑已绿2模型/工具、4资源或旧role5。此前候选noEmit使用旧引用声明，漏检cancel签名，其通过不能代表当前完整源码编译，现明确更正；实际拥有者emission以08为准 | `native-run-v3/native-login-queue.patch`提交08，含新回归及移除冗余`as unknown`的无运行时差异整理；原r2候选保存在`native-ownership.r2-no-args.ts`，旧报告不改。完整scope/session/revision仍等04 auth-only seam和08接入窗口 |
| 01-7 | T024/T144 | 04原子authority的完整实际Loader／中央HTTP候选接入：以原员工／登录session／sessions scope／独立权限epoch双版本限制准确Agent/turn及保留请求，每次仍读当前权威和原生祖先。当前源码在中央policy禁用→恢复而未换token时，模型、工具、实际Job旧流、保留历史可见集4种漏洞r1真实复现；候选拒绝迟到字节及结果，保留已完成文件 | 4负例r1全失败，候选r2全通过；实际authenticated createWork自身结果及未关联Native在Office scope禁用时继续完成2个新对照首次通过，共6/6，不再运行。类型r1检查程序路径大小写／未保留引用边界及fixture可选字段失败，修正后r2在strict、真实296项目引用、当前source redirect下通过（1144源文件），并核实Agent.cancel源声明及1个必需参数。窄lint r1通过；补丁检查r1通过 | `authority-v4/native-authority-consumer.patch`已交08，**仅候选通过，未改冻结主线／未构建**。04最终provider hash `c9916ca9d996907add87812073f0a67b9c1d3eb66b24f835f8db03b559803d98`；相对实际验证版仅JSDoc归位及候选副本输出，无行为变化。08 Host bundle r3失败封顶，不能重开旧构建或借v119称新版已验 |
| 01-8 | T024/T144 | 给06/08提供独立只读Office search authorize候选：精确登录及权限tuple包围原api-session/visible和原始祖先fold，交集限制候选，无冷激活、无业务revision、无凭据输出；原请求／插件／凭据代际撤销并清理观察者 | 实际中央HTTP与内存SQLite原生历史3个新场景r1首过：Alice/Bob/确认Native集合及原tuple，pending政策ABA，退出重登。新scope的strict真实引用＋当前source类型和实际MysqlSearchAccess接口相容首过；窄lint和两份patch检查首过；无MySQL运行、无旧绿复跑 | `authority-v4/native-search-authority.patch`／`native-search-metadata.patch`已交06/08，未注册或构建。缺Office grant时本helper拒绝；最终匿名Native分支仍需原真实Host授权／版本及无办公祖先证明，不能伪造Office revision。跨Host已接纳写屏障、writer持有/fence证明及匹配store guard由05/06/08提供 |
| 01-9 | T024/T144/T132 | 独立发现“先user取消→排队wake→后disposed撤销”保留首次AbortSignal原因而错误自动推进的缺口。既有通用取消用例未覆盖双取消顺序；仅新3场景复现Office旧登录、未关联Native运行和maintenance。通用每activity disposal意图候选同时压住原latch及随后迟到wake，保留输入、首次user原因及空闲后显式唤醒FIFO；loop无Office分支，无API／持久格式变化 | 新3负例r1全真实失败（模型次数2对1、3对1、维护2对0），候选r2 **3/3通过**；窄lint r1退出0但保留原loop两条unused disable警告。类型r1仅新测试3处`Inbox.hasPending`不在公开接口，改成公开`nextTurn=[]`及`nextStep=[]`的等价断言；早先queue交付同处同步更正。08消息到达时上述检查已在途完成，此后**不再追加检查**，类型修正未复验、补丁未作apply检查 | `disposal-v5/disposal-wake.patch`、`disposal-lifecycle-docs.patch`及manifest交08，均候选、未改冻结主线／构建。原测试形态保留为`disposal-wake.r2-tested.ts`与`native-login-queue.r1-tested.ts`，旧失败／成功报告不改。不得把该新通用取消候选当原T162首快照差异修复；本组六父项仍未完成 |
| 01-10（2026-10-25） | T024/T144 | 新用户授权后，按08限定仅处理延迟终端创建跨降权：复用真实Loader／Office HTTP／JSON办公存储／SQLite归属，以独立自有Node进程替代外部PTY分配并设返回屏障。候选在创建准入、工作目录和shell查询后、分配结果发布前复核原`terminal/access`，保留请求授权代际；拒绝后复用原allocation清理和失败重试归属。公共controller未自行写入 | 行为r1两题因fixture遗漏`cordis:`前缀失败；r2原源真实返回降权后的metadata，Native对照末尾误把合法工作目录事件计为0。r3候选实际拒绝旧请求、准确终止一次、done结算且真实PID消失；Native对照通过，但主场景末尾恢复角色后仍以失效登录查询registry遭拒，**整题失败、3次封顶**。只修末尾显式新登录，未复验。strict当前源码296引用／1083源文件r2通过，lint r2通过；均为末尾登录修正前版本。两个公共patch apply检查及窄diff检查首过 | `terminal-allocation-20261025/`含最小controller／测试依赖补丁、已在树leaf审查差异、准确r3源码快照及不改写的三轮报告；08负责决定接入、双语记录／锁／产物。候选不等于整题验收通过，禁止第四次或改名复跑；未操作现GUI、真实PTY、Host构建或DB。本组六父项及整体仍175／137完成／35进行中／3未开始 |

01-10源码补充：08只读审查指出`spawn()`最后一次授权检查与外层`await allocation`返回之间仍有生命周期间隙，owner registry不提供授权保护。已按08要求另交`public-controller-final-unverified.patch`和`source-only-closure.patch`：外层立即检查active及closed标识，拒绝后先登记准确BrowserTerminal为失败allocation、接原retention再等待close，保留清理失败重试；existing/pending路径也补await后的active与closed复核。成功路径不新增await，保留原close等待pending的次序。原实测`2804d2b3…`候选及manifest未改，最终`dcd78c13…`单独保存，类型／lint／行为／构建／apply均未检查，不能继承旧候选绿或重置三次封顶。08负责后续评估，01不再追加检查。整体仍175／137完成／35进行中／3未开始。

01-10最终文件状态：因公共controller仍为原4399582a版本，已把本轮两份新test及README新增说明完整暂存至`terminal-allocation-20261025/pending/`，只撤回本轮新增内容，原WIP与完整断言／r3准确版本／全部失败报告保留；没有在默认套件留下未接入必红spec。`staging.json`记录四份完整副本摘要，08若采用最终源码需配套应用一次`leaf-review.patch`及测试依赖补丁，不能把原manifest的叶子在树状态当当前状态。此后未运行任何检查，整题仍三次失败封顶，整体175／137完成／35进行中／3未开始。

01-10正式源接入回执：08随后确认已接最终`dcd78c13…`源码、ui-office三条测试devDependencies及其三个workspace锁链接；在收到上述暂存状态后，`leaf-review.patch`检查／应用均退出0，恢复两份新tests和双语README。`pending/`副本、r1/r2/r3原失败及准确实测文本均保留，`staging.json`仅记当时暂存，最新状态见`terminal-allocation-20261025/application.json`。08记录首次锁helper缺yaml失败后只续锁编辑，未重复源补丁；未新增行为第4次或编译。最终fixture新登录修正和源码closure仍未复验，整题失败封顶、正式构建／验收仍不记通过。01仅据08回执补记，未自行移动、检测或复验，现停止本批次。整体仍175／137完成／35进行中／3未开始。

### 当前交付与未解决事项

- 当前交付入口：`.artifacts/parallel-handoff/01/HANDOFF.md`、`CONTINUATION.md`及`final-manifest.json`；早期`manifest.json`保留为当时快照。`leaf.patch` 是基于领取时未提交工作树的最小审查差异，叶子已在共享树中，不能再次应用。`voice-windows.patch`、`documentation.patch`、login资源／run及元数据补丁已由08应用；双语配对记录及公共产物以08最终整合报告为准。本组未改根依赖、锁、统一配置、原快照或原生持久化格式。
- T024/T144：角色、同员工重登及Agent/turn凭据代际防护已进正式源，08确认准确取消调用emission通过；新增队列场景针对该正式源首过。完整原子scope/session/revision消费及只读search层候选已通过真实中央HTTP，但受08本轮Host bundle三轮失败封顶，未正式接入。浏览器手工guest获取／回调／交付仍缺Host授权桥；空闲远端资源回收、完整平台生命周期及无办公身份的真实Native检索provider仍待闭环，不能以分区或缓存作凭据。缺归属父备份不能猜测补建。Job13／Changes8旧绿不跑，原终端实际页已3轮封顶。
- T130：本次语音新切片已通过；默认工作区仅完成独立Windows补丁，原题最后第3次尚未使用，08未释放新Client／浏览器窗口，本组未冒用混合产物验收。其他后台列表、变更文件、工具目录、PTC、录制回放、归档、交互等原清单仍保留。`historical-checks.json` 记录原41/13及按精确原标题找到的报告，是只读索引而非重置额度的依据；交接任务书中已有改名／封顶／通过记录优先。
- T132：原5项通过保留，首Steering的持久日志Windows ACL技能差异仍未通过且3次封顶；仅复制只读差异说明，未改golden、normalizer或重新运行。
- 新通用取消候选与原T132／T162页面分开记账：3新行为候选通过，类型公开队列断言已修但未复验；原封顶标题未运行、原根因未被替换。08关闭本次整合窗口后不追加构建、浏览器、数据库或检查，已有源码及候选留完整交付链。
- T137：本进程无SeCreateSymbolicLinkPrivilege，实际Node24.22文件链接仍EPERM，环境依赖未解除；未运行原API6＋启动库4用例，不能算修复或跳过通过。
- T162：只读发现办公子Agent各标题已有39份匹配历史报告，含多次通过及原失败，不作为新的检查额度。冻结了原离线／流程截图；原JSON仅保留截断断言与堆栈，未保存可逐行比较的原实际ARIA正文，不能证实首差异根因。首项在停止及重新唤醒前失败，会使后续FIFO场景缺少所需轮次；这解释后续失败依赖，不能替代首差异修复。保持未完成，不重跑或改名验收。

### 2026-10-19 用户后续样式请求

用户在启动项目后新增“帮我优化样式 做的好看一点 有质感一点”。本次按该新请求仅做 Office 样式及主题语义别名，不据此恢复旧 Native／Host 构建和封顶检查。整体仍 **175 项：137 完成／35 进行中／3 未开始**，原六个父任务状态不变。

- 已修改 OfficePage／OfficeDrive 两份 CSS，完善深浅配色、导航选中态、卡片与指标层次、输入框、文件表格和小屏布局。OfficeCollaboration 仅三处原 1px 中性边框改为 0.5px，原功能／TS／数据不动。
- 公共 ui-theme 只交 `.artifacts/parallel-handoff/01/ui-polish/theme-source.patch`，由 08 应用。四份源补丁、原始源备份、v119 字节备份及四个纯样式候选产物均已交 08；未自行改公共产物或构建记录。模块类映射完全一致，屏蔽三处 CSS 字符串后的 JS 字节不变；CSS 行原无映射且总行数不变，map 字节不变。
- Node **24.22.0**：浏览器 r1 的布局／导航／390px／减动画通过，focus 失败；r2 仅续 focus 并新增对比检查，focus／暗色通过，浅色 placeholder 为 4.27:1；r3 仅续浅色对比，五组均通过，最低 4.73:1，原报告保留。最后四处焦点色 fallback 归一共享 token 后，未再复跑已绿浏览器场景。
- 样式既有规范 r1 **19/20**，唯一失败为原协作 CSS 三处粗线；只修宽度，r2 仅原失败题 **1/1** 通过，另 19 题未重跑。CSS 辅助发射器首次因未初始化声明识别报错，修正后通过；此后的发射均因实际样式变更，主题对比修正跳过已绿 Office 编译。未运行整仓 GUI/Web、旧 Native 标题、数据库或新 Host 构建。
- 完整交接、检查计数和未解决边界见 `ui-polish/HANDOFF.md`、`checks.json`。最终固定 Office bundle SHA `719ea7d9b2b5216480a2fafcbff579e89ce831a8413afbd515d09f796a2cbe04`。**08 已正式应用公共主题与四个纯样式产物**，独立确认只有两份 JS 的三段 CSS 字符串变化、357 份其余产物及原三公开值不变，并如实刷新 359 份完整摘要；见 `08/ui-polish/applied.json` 与 `.dsh-build/style-only-provenance.json`。实际页面装载只做一次：HTTP **200**、三份样式全部逐字匹配交付、页面错误 **0**，未注入 CSS、未重跑已绿功能／外观场景。报告 `.artifacts/ui-polish-20261019/served-asset-loading.r1.json`、实机截图 `served-home-final.png`；3081 仍运行并保留用户深色偏好。本次样式请求完成，不据此勾绿原六个 Native 父项。

### 2026-10-24 用户要求停止旧实例并启动 GUI 热开发

- 已核实并停止原 3080／3081 两个项目 Node 实例（20332／6640），保留原数据、WIP 和其他应用。先保存356个产物目录的完整归档 `gui-hot-dev-20261024/before-artifacts.tar`（202711552 字节）；最初较慢的逐文件副本明确标为未完成，不作恢复依据。
- 原 source CLI 启动在300秒内未就绪，日志、首次诊断和退出事实保留；停止其进程树后，第二次实际启动改用已有 built CLI。启动器另有一次扩展 env 后的本地前置正则拒绝，修正后继续，未启动第三个项目实例。没有重跑原封顶 Host／Electron／终端／Steering／子Agent 场景。
- 08 正式修改公共 `scripts/dev-web.ts`、`packages/client/tsdown.client.ts` 及原参数预期：Client 面监听、开发专用源码入口、`--built-host`。正式构建入口未改；严格类型监听仍运行。Node **24.22.0**，supervisor **59040**、Host **27404:3081**、独立 Chromium 应用窗口 **52664**，不是 Electron 安装包／Electron 新一轮验收。
- 实际热更新只检查一次并通过：TSX 源保存 **807ms** 到 GUI，CSS 源保存 **991ms** 到 GUI，0手动刷新／0页面CSS注入／0页面异常；两个临时探针已逐字节恢复，含原未提交内容。证据 `.artifacts/gui-hot-dev-20261024/gui-hot-check.r1.json`、`gui-hot-development.png`，通过后停止检查。
- 严格 Client 类型仍有 **143 个独立错误**，主要为新源码与旧 Office Remote 描述不一致；新场景配置区显示服务不可用。未冒称类型或业务整体通过。保留全部诊断；前端直接转译与独立严格诊断并行。pnpm 首次自动依赖预检遇已有 Lefthook 锁，后续按进程设 warn，未手动移除锁或重置依赖。
- `启动GUI热开发.cmd`／`停止GUI热开发.cmd` 和 `.local-run/gui-hot-dev/start.ps1` 已交付；开发数据在独立 `.local-run/gui-hot-dev/data`，旧数据保留，认证入口未输出。`.dsh-build/development-session.json` 标记非完整发布构建，旧构建记录未伪刷。完整交接见 `.artifacts/gui-hot-dev-20261024/REPORT.md`；原六父项及整体仍 **175／137完成／35进行中／3未开始**。
- 用户随后要求设为默认：原 `启动DeepSeekHarness.cmd`／`停止DeepSeekHarness.cmd` 已切到同一 GUI 热开发入口，旧默认文件原字节保存在 `default-launcher-before/`，旧私有 Web 脚本保留。默认启动命令仅实际调用一次，退出0并复用现有 GUI／服务，未重启或重复已绿热更新检查。最终3份公共最小补丁、5份控制文件和实际运行／限制清单见 `.artifacts/parallel-handoff/01/gui-hot-start-20261024/`，公共源码由08正式应用。

### 2026-10-25 用户追加十轮检查：GUI 退出恢复

- 继承08已绿14项控制器检查、原窗口恢复和热更新结果，旧封顶项均未重跑；本组仅在自有夹具完成10个新进程生命周期场景，未点击、关闭或重启现有GUI，未修改原数据或依赖。
- r1 **2通过／8失败**，其中两棵真实Windows自有进程树复现“监督进程已退出，Host／后生worker仍存活，却记stopped”；模拟场景另复现旧父PID关联、枚举后PID换代、已校验后数字PID变化、旧状态缺证据假报成功及部分退出后无法续停。
- 候选新增PID／路径／起始UTC身份记录，按父子创建时间核实当前树，用已绑定的进程对象停止；监督进程消失后仍可恢复已记录子进程。不可读身份保留至后续恢复，证据不足写stop-failed且不杀未知进程。记录中无命令行、token或env。
- r2仅续8失败：**7通过／1失败**；r3只续第8“进程信息不可读”：**1通过**，停检。首轮两绿及r2七绿未再跑，无第四次。最终10题均有通过记录，精确版本和次数见 `.artifacts/parallel-handoff/01/gui-recovery-20261025/manifest.json`，不声称所有题在最终版本重跑。两项真实孤儿树在修复后已确认Host和后生worker退出。
- 为保留原GUI子树回收，对最终新增IncludeGui遍历另做一次影响验证：两棵真实自有Node树，GUI根发现以测试自有进程替代，全部退出、首过；不是重跑旧GUI窗口或关闭用户浏览器。最终补丁及实测源码版本、原失败全部保留于 `gui-recovery-20261025/`。
- 公共controller原SHA `5d676a2c40e941de81012cc682e96408dcc3df2213b4e21b0c8490ade88356cc`，最终SHA `8a00514872ee681a1666d46671eec3b3a81dd67c3b51ec4f52301d5e29bacb8a`；**08已精确应用**，仅通过AST载入函数和`Save-HotProcessLedger`为现运行会话登记14个身份，原监督进程／浏览器／running状态保留。未执行主入口、未操作GUI、未stop／restart或复跑已绿；回执 `gui-recovery-20261025/application.json`。原manifest保留候选阶段未接入事实，正式接入另记，不改旧证据。完整报告 `gui-recovery-20261025/REPORT.md`。
- 本次未做真实GUI退出验收、完整Host／Electron构建或数据库工作；原143类型错误、场景服务、完整Electron运行时及六Native父项缺口仍保留。整体仍 **175／137完成／35进行中／3未开始**。

## 2026-10-25 dsh-desktop-fork 工程与开发安装交付

本节是用户追加的目录归拢、GUI安装程序和代码推送工作，不增加六个Native父任务完成数，也不改变原封顶记录。原仓库未改；资料迁入fork后保留原始目录、用户数据和已有WIP。

- 19,362文件复制时逐一校验；三仓Git bundle首验通过，24,944份运行脚本/记录另行保存。68个TypeScript派生js/map及原始会话进入私密归档，23项特殊Git模式保留。
- 使用Node24.22.0、pnpm11.28.5；桌面Electron43内置Node24.17.0分别记录。原生target首过，根仓typecheck首过；完整测试r1为1,599通过/30失败/7跳过，修复后仅续10失败项通过，余20失败保留。
- 源码GUI r1/r2/r3均保留失败且已封顶，未第四次运行。修正ESM入口和PowerShell继承管道问题后，实际EXE安装r1通过；安装GUI r1因系统分配6000被Chromium拒绝，保留原包和原报告，改用49152..65535端口，修正版在构建。
- 旧Host第三次构建、旧Electron/下载、终端、Steering、原子Agent和文件symlink失败均未重跑；目录junction不计为T137修复。实际交付结果见[验证与交付](../../../../project-docs/验证与交付.md)。
- 当前整体仍175项：137完成、35进行中、3未开始。

补充结果：端口修正版EXE已生成并覆盖安装通过；安装GUI r2于22秒内显示工作台/AI会话/通讯录，56327端口，关闭后exit0且controller=stopped，停检。安装前后既有测试Profile备份SHA不变。首版端口失败与所有历史记录保留；场景配置服务仍不可用，Root回归仍余20失败，不增加Native完成数。最终文件与代码交付见fork的project-docs及.artifacts/parallel-handoff/01/desktop-delivery-20261025。
