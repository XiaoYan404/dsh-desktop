# 网盘图片、知识库与办公交付检查

[English](README.md) | 中文

本参考说明网盘可选读取能力及其当前授权。[原生办公工具](../../tool-office/README.zh.md) 负责审批和 Session 日志，[原 Office Skills](../../../skill/skill-office/README.zh.md) 负责文件编写。

## 图片

省略 `imageRead` 时不允许图片读取，也不声明图片能力。启用时必须显式提供源字节、固有像素、单边、完整响应和 MIME 限额。包含元数据及 base64 的完整 UTF-8 成功响应不得超过 16 MiB；源文件满足编码字节限制，也可能因 base64 膨胀而超过响应限制。

员工 Host 在同步 inbox 工具注册前，通过当前连接、成员和角色准备只含元数据的能力提示；提示不授予源文件权限。Native 消费者还要求独立开启 `image: true`、提供正安全整数 `imageMaxNormalizedResultBytes`、持久附件提供方及模型服务。请求源字节之前重新解析模型图像输入能力。原 `readApproval` 默认仍为人工确认。

每次读取和末次复核检查当前登录、capture 成员与角色、已选文件、当前祖先权限、最新版本、字节长度和摘要。源准入及 Native 规范化各自有限额。动画只表示规范化首帧；真实 immutable 附件以原 Native ImageBlock 和工具结果发布。

已经开始的 Sharp 或 `saveImage` 必须等待结算，之后取消可以拒绝发布；两者均没有单次即时中止接口，也不保证进程 RSS 硬上限。末次拒绝可能在原保留策略下留下不可达的 immutable 附件。之后网盘撤权不会追溯删除先前合法披露的图片块或 Session 历史。

## 知识库

省略 `knowledge` 时不启用其数据域与 API。启用时显式提供 `maxDocuments`、`maxIndexBytes`、`maxSourceBytes`、`maxDocumentCharacters`、`maxSections`、`chunkCharacters`、`maxChunksPerDocument`、`maxResults`、`maxResponseBytes` 和 `timeoutMs`。索引使用追加的 `enterprise_office_knowledge` 独立域，不改变网盘或 Session 代际。

当前管理员和经理可通过审阅后的发布修订及稳定请求 UUID，发布当前可访问的准确网盘版本。增量替换只更新该文件当前索引。复用已有有界 Worker 解析 PDF 可选文本页、DOCX 正文、XLSX 保存单元格和已配置 PPTX 的幻灯片正文；UTF-8 仍作为普通数据。XLSX 公式保留保存时证据，不重新计算。图片、OCR 和旧 DOC/XLS 不在支持范围内。

检索按规范化后的字面关键词匹配。只有当前仍可访问的最新源版本参与正文、结果数量或 `hasMore`。引用携带文件、版本、摘要、发布修订、分块与源位置；重新打开会再次授权。删除、撤权、撤下或版本替换后的源不返回旧正文。撤下会删除当前索引正文；不可访问或过期的索引条目按权限过滤，不自动宣称物理擦除，底层保留仍由存储提供方负责。

员工网盘页支持检索、读取当前引用和显式发布审阅。Native 知识库工具独立开启，仅作用于带已提交文件上下文的轮次；不会为没有办公关联的普通 Native 对话直接开启全库工具。完整响应限制同时覆盖 HTTP 成功信封和转义后的 Native 文本块。Client 在身份、角色或能力撤回时清除私有结果；发布回执不确定时重试同一 UUID。

知识库界面区分尚未查询、查询中和已完成但无匹配结果；输入法组合期间按 Enter 不提交。切换员工或角色时重置查询草稿。长源文件名自动换行，正文区域可用键盘滚动。引用下载通过现有授权版本下载器选择引用中的准确不可变版本。

结果标明实际提交的关键词，即使员工正在编辑下一次尚未发送的草稿。查询失败有独立重试入口，只重发原关键词，不发布文档或替换草稿。未确认的发布在后续查询期间保留独立通知和恢复入口；读取失败不替换其状态或原变更 UUID。正在写入与写入结果未知分别显示。

关闭发布审阅会退出弹窗；已关闭的读取审阅不会被迟到响应重新打开。写入期间关闭弹窗不会取消写入：结果不确定时保留原文件、操作、修订和 UUID，通过明确的重试操作恢复，即使网盘选择已改变也不替换请求。索引变更确认后清除旧检索状态，不将其误报为旧关键词无匹配结果。

## 办公交付

既有文档、表格、演示及 PDF 请求配方保留原 Office Skills。`templateSource` 标识选中的内置工作流程，不证明文档实际作者；没有宣称引入十六套外部模板库。

省略 `deliveryChecks` 时不启用检查。启用时显式提供 `maxSourceBytes`、`maxDocumentCharacters`、`maxSections`、`timeoutMs`、`maxResultBytes`、`maxExpectedTexts` 和 `maxExpectedTextCharacters`。Native `deliveries` 开关在原只读审批下独立开启 `office_check_deliverable`。工具读取准确的已提交文件，并复用同一解析器检查真实 DOCX/XLSX/PPTX/PDF 结构与必需正文；改后缀的纯文本及缺失内容断言会被拒绝。结果明确为 `structure_and_text` 和 `visualLayout: not_checked`，不据此推断公式重算、渲染保真或业务验收。

通过原 Office Skills 和 Native 交付机制编写与 present 文件。企业交付使用显式网盘上传、审阅后的不可变工作附件、员工提交和审核人验收；既有预览和授权下载保留原归属。Native deliverables 与网盘之间没有自动外键或同步，结构检查也不会直接完成工作事项。
