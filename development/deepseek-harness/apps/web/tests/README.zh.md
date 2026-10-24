# apps/web 浏览器 e2e

[English](README.md) | 中文

这些测试在进程内启动真实的 web 组合，并用真实浏览器通过真实 HTTP 驱动它。Chromium 运行整个 lane；[模型与推理强度选择场景](declared-reasoning.e2e.ts)还在 WebKit 中运行，以覆盖原生鼠标焦点行为。[会话回放恢复](session-replay-reload.e2e.ts)在两种浏览器中运行原生模式和办公模式，选择对应平台的 `fresh-round-trip` 录制。该用例覆盖输出中刷新、完成后刷新和重新打开 Session，并检查实际命令结果与持久化事件。办公界面的预期输出放在[独立目录](expected/office-session-replay-reload/)中；原生模式保留共享的预期输出。该 lane 的运行机制——模式、fixture（测试前置数据）、golden，以及与 `dsh web` 之间刻意保留的组合差异——记录在 [`scaffold.ts`](scaffold.ts) 和 [浏览器 e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.zh.md) 中。

[网盘场景](enterprise-office-drive.e2e.ts)还会在浏览器保留目录视图时，通过真实 HTTP Remote 验证审核式替换、历史、旧版本分段读取和删除／恢复。[网盘读取器对比](fixtures/office-drive-reader-compat.mjs)使用冻结和当前读取器打开旧文档及替换文档，核对只读文件字节不变，并验证已认证的办公请求准入。[清理读取器对照](fixtures/office-drive-purge-reader-compat.mjs) 验证不支持清理记录的读取器拒绝且不改写数据。

版本及恢复界面场景使用各自的[预期输出](expected/office-drive-lifecycle/)，覆盖源文件审核与取消、并发元数据变化、发布及恢复失败、历史字节下载、父目录撤权及恢复、刷新和小窗口。并发变化通过真实服务写入；界面必须保留审核草稿，直到用户明确刷新或采纳。

永久清理界面场景审核本人范围、取消且零写入、授权保存失败后保留同一确认，并在真实对象 unlink 失败后继续既有待完成回执。完成前额度继续占用。原生 `write`／`present` 实际生成交付物；删除其网盘副本须保留原始字节和会话事件，重载后仍可下载交付物。另一个场景撤下无权访问的元数据，并在审核根条目变化后重置确认。只有新增的清理审核预期属于这些场景；原生录制保持不变。

[办公文件测试](enterprise-office-files.e2e.ts)的旧目录恢复场景使用[独立预期输出](expected/office-legacy-child/)。场景真实切换员工 Host 身份，验证冷 Agent 不激活时的读取限制，保留父日志原始字节和子日志前缀，并区分子创建角色与父会话后续审核。原生场景在父会话首次办公输入前创建目录记录，恢复后核对实际原生文件写入。历史测试日志包含完整原生轮次和当前 codec 必需的受保护系统头。

[连接测试](enterprise-office-connectors.e2e.ts)中的同步协议场景验证真实 Remote codec 和客户 HTTP 读取，同时保留可用集成页面。[独立预期输出](expected/office-connector-sync/) 覆盖实际结果状态、只含元数据的历史、保留的原字段及客户请求次数。查询认证失败不复用先前成功结果。

同步界面场景审核并取消且不读取客户系统，使用原请求恢复持久化发布失败和提交后回执丢失，展示真实 401 失败且不保留旧数据。刷新恢复历史且不再次读取客户系统。连接变化隐藏已有字段；切换员工关闭私有窗口，新员工历史为空。独立界面预期保存在协议场景所属目录，原生录制不改。

[集成插件生命周期场景](enterprise-office-plugin-lifecycle.e2e.ts)从公司包跳转原管理器。真实 Loader 包注册并卸载客户 HTTP 读取器。受控 pnpm 将测试包复制到隔离 Profile；真实配置变化和加载覆盖审核取消、启停、卸载确认及重装更新后的第三方版本。不宣称已安装真实客户平台或外部仓库包。[独立预期输出](expected/office-plugin-lifecycle/)保留原生录制。

[提交电子表格用例](enterprise-office-xlsx.e2e.ts)通过网盘上传实际 OOXML，将保存版本关联到既有 Native 输入，并在允许 `office_read_xlsx` 前审核准确文件、版本、摘要及单元格预算。它将持久化工具结果与下一次模型请求比较，核对数字原始词面及公式缓存状态，并在工具卡中展示实际结果。只有模型推理受控，上传、解析、原生持久化和浏览器交付均真实执行。

安装工作区依赖后，在仓库根目录安装浏览器及其系统依赖：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install --with-deps chromium webkit
```

在 Linux 上，`--with-deps` 会通过系统包管理器安装依赖。持久化 CI VM 必须通过镜像维护提供这些依赖，CI 只安装浏览器程序，遵循[故障切换手册](../../../.agents/notes/implemented/process/2026-07-26-ci-failover-runbook.zh.md)的要求。

完成完整构建后，通过 `pnpm run test:web:built` 运行选定的浏览器测试。[HMR 场景](hmr-live.e2e.ts)需要 pnpm 的 `npm_execpath` 生命周期入口，才能在不使用 shell 的情况下启动监视器。浏览器辅助函数将录制时区固定为 `Asia/Shanghai`；Windows 上的 Chromium 忽略 `TZ`，因此[隔离检查](support-timezone.e2e.ts)显式设置环境上下文的时区。

[固定拒绝快捷键](shortcuts-fixed.e2e.ts)选择对应平台的审批录制，并验证录制中实际指定的目标文件未被写入。[Worker 部署验收](preview-boot.e2e.ts)通过相对 URL 覆盖表提供临时文件中的生成镜像，在 Windows 上保留 URL 分隔符，且不改写构建所有的 `dist/`。

[Markdown 图片验收](markdown-images.e2e.ts)比较原文请求路径、编码 URL、响应字节和源文件字节，保留 Windows 分隔符拼写，并检查图片加载及失败状态。

[文档复制验收](document-preview.e2e.ts)检查代码文件的 LF 字节、渲染文本及真实剪贴板写入的准确输入。代码和表格的原生剪贴板读回值遵循[平台文本格式](https://learn.microsoft.com/en-us/windows/win32/dataxchg/standard-clipboard-formats)，Windows 使用 CRLF，其余平台使用 LF；断言直接比较实际读回值，不转换其行尾。

回放式 [Inspector 用例](session-inspector.e2e.ts)使用对应平台已有的 `fresh-round-trip` 录制，只读比较持久化 Session，并检查实际 Shell 结果的 UTF-8 字节。Windows Raw Log 和 Chat Group 预期存放在[独立目录](expected/session-inspector-windows/)，其余 Inspector 预期继续与 POSIX 共用。

[两轮 Goal 验收](goal-multi-turn-actions.e2e.ts)在 Windows 选择通过真实 `dsh web` 及公开 Session 导出、配合确定性模型替身录制的[独立场景](../../../snapshots/web/goal-multi-turn-actions-windows/)。它逐字节比较 8 次真实 `pwsh` 返回，保留显式 exit 127、每轮 6 步的两轮 Native 执行及 Goal 完成。Windows Session 在界面捕获时只读，POSIX 录制及界面预期保持不变。

[后台任务停止验收](background-job-list.e2e.ts)使用对应平台的真实 Shell 和有上限的释放文件屏障。Windows 用例先从 `pwsh` 实际写入的文件核对本次随机标记的精确字节，再截图或通过双按控件停止作业。它只读复用原生录制，通过公开 Session 导出保留恢复后的完整事件前缀。[Windows 界面预期](expected/background-job-list-windows/)保留实际退出及用户取消详情，POSIX 预期保持不变。

普通场景以没有已登记 Workspace 或 Session、但持久化标记记录默认 Workspace 已被删除的状态启动，使显式文件夹选择场景自行决定 cwd。`launchWebScaffold({ firstUse: true })` 保留初始化资格，供启动场景使用。

[十二轮连续会话场景](chat-continuous-conversation.e2e.ts)逐轮通过真实输入框提交，在第四和第九轮运行平台原生工具并精确比较输出。它核对流式显示、持久历史和两次工具展开均属于同一 Session；Windows 使用通用 `pwsh` 展开控件及 CRLF 输出。

[Chat 长滚动场景](chat-scroll-contract.e2e.ts)在增量到达时保留阅读锚点，回到底部后恢复跟随。wheel 场景在虚拟卸载后保留工具展开状态；独立的模拟惯性滚动场景只改变滚动位置，不发送 wheel 输入。Windows 工具先登记文件系统事件等待，再发布就绪标记，收到释放后输出相同的64行及准确CRLF；超时和清理失败均明确报告。

终端卡片[导航场景](navigation-panes.e2e.ts)先测量实际命令与已载入字体，再将卡片缩窄到确实需要横向滚动的宽度。历史 Bash 行提供呈现元数据。场景对照原有预期，保留焦点、键盘、wheel、拖动、剪贴板、主题及恢复宽度检查。

已认证拒绝[审计场景](enterprise-office-audit.e2e.ts)通过中央网关发送真实员工请求，筛选管理员已保存的拒绝元数据，并检查实际下载的 NDJSON。七个白名单字段包含安全拒绝代码，不含被拒绝的输入和凭据。同一员工的审计页面与导出 RPC 仍被拒绝。

[办公日历场景](enterprise-office.e2e.ts)将 Host 时钟推进到公司午夜之后，打开通知并重试暂时失败的读取。它核对“今天”跟随公司日期，手动选定日期则持续保留；浏览器与 Host 时钟保持独立。

## 完成状态观察

[队列操作场景](queue-actions.e2e.ts)分别等待队列变更确认及会话标题栏的预设投影，再比较收起的队列。收到队列响应不代表会话元数据已经到达浏览器。原生和办公模式保留各自预期输出，并在界面比较后验证持久化的 FIFO 行为。

[Steering 场景](steering.e2e.ts)保留独立的 Host 与浏览器固定时钟，在发送前用 `page.clock.runFor(0)` 重设 Playwright 计时调度。局部轮次完成观察在失败时释放监听。整队列场景使用对应平台的 Cmd/Ctrl 快捷键，并将已 flush 的 Windows Session 保存在所属测试产物目录。单行场景继续与共享 Session 录制严格比较；该录制缺少 Windows ACL 技能目录记录，平台夹具缺口仍导致最终比较失败。

依赖状态的用例使用 Workspace、接纳、附件和模型流屏障，区分可见中间状态与已完成操作。模型选择器的持久化断言等待默认设置保存完成，不以菜单关闭作为完成信号。详情关闭等待框架过渡结束；归档验证为 seed Session 设置显式标题，并跨重载跟踪该身份。[CI 测试可靠性工作流](../../../.agents/skills/dsh-ci-test-reliability/SKILL.md#synchronize-on-state)负责这些同步规则。

[空闲提交交接](idle-submission-handoff.e2e.ts)对 Host 帧和浏览器中的消息归位的等待使用 scaffold 的 30 秒 Turn 完成预算。Vitest 负责 scaffold 清理，使 replay 消耗检查错误不会覆盖场景中失败的断言。

插件管理器的开关为 Host 的 profile 写入与 store 随后的 inventory 读取预留 `PLUGIN_TOGGLE_SETTLE_MS`（10 秒），这两步完成后才会重新发布 `aria-checked`；链路的实测值记录在该常量的 JSDoc 中。

显式滚动使用 `support.ts` 的 `scrollIntoView`：旧元素脱离 DOM 时重新解析 locator，并在同一个浏览器任务中检查连接状态、执行原生滚动。各场景保留滚动后的可见性与几何断言。

办公模式使用 `expected/office-*` 下的独立预期输出比较完整 Conversation；共用的队列卡片和引用菜单保留原预期输出。队列和子 Agent 场景在完成这些比较后继续执行，对照实际持久化事件验证精确到单次出现的编辑、停止／重试行为和 FIFO 恢复。

## 这些是 Host 面的测试

它们在根 `tsconfig.host.json` 中做类型检查，而不在 Client aggregate 中，因为它们直接读取 Host 服务：`ctx.connection`、Host 侧 `SessionStore` 与 `ctx.sessionProjectionCache`。运行时驱动浏览器并不使一个文件成为 Client 程序的一部分——两个 face 在相同的键上以不同服务合并 Cordis `Context`，因此单个程序无法同时看见两者。把这些文件挪进 Client aggregate 会让每一处 Host 服务访问都无法编译。

## 不要在此 import `@deepseek-ai/dsh-client-*`

import 一个 Client 包——无论值还是类型——都会把它整个 TypeScript 工程、以及它引用的每个工程拉进 **Host 构建图**。这已经坑过本 lane 一次：四个 Client 消费方包引用了 `api/remotes` 的 Client face，而该 face 必须等 Host tsdown 生成 `@deepseek-ai/dsh-goal/remote` 之后才能编译，于是 Host 构建阶段变成在等一个由它自己产出的产物。

当某个场景需要 Client 持有的常量或纯函数时，改为在此处镜像一份，并紧挨着一条注释掉的 import 点明源模块。这样漂移会表现为选择器未命中或镜像值陈旧——是响亮的失败，绝不会是静默通过。`scaffold.ts` 按此规则镜像 welcome-notice 的 namespace、确认字段、版本和被断言的中文文案。

built-client harness 是例外。`assembled-boot.ts` import `AppWebEntry`、boot manifest（元数据清单）类型与 `RemoteMock`；`assembled-remote.ts` import Client test runtime 的默认响应与 `RemoteMock`。这些包是显式的工程引用，用于通过测试持有的 carrier 启动真实 shell。chat 场景仍在 `support.ts` 中镜像 `conversationContextKey`，而不 import 其 Client owner。

没有任何机制强制这条规则；靠 review 守住它。
