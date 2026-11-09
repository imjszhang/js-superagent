# 协调器直接答疑与普通 Issue 代码补读

后续实现更新：`0.11.0-alpha.0` 已支持合批候选按原始消息逐条答疑，并加入最小领域扩展，详见[本轮交付记录](candidate-routing-and-batched-answers.md)。本文的单消息限制、内核未变及验证数量均是 `0.10` 阶段快照。

日期：2026-11-03。工作区版本 `0.10.0-alpha.0`，项目数据库 schema 11。完成[项目级后台运行时差距复核](project-runtime-gap-review-2026-11-03.md)的前两项；W18 原生 pending 自动唤醒和飞书继续暂缓。本文记录源码与离线验证，不表示已安装、发布或部署。

提交状态更新：实现已由 [`8eebf0ad`](https://github.com/imjszhang/x-pkm-research/commit/8eebf0adc7888b5432a2b660c22aba4b7a66638d) 推送至 `main`。提交后的剩余能力与使用限制见[0.10 复核](project-runtime-gap-review-0.10-2026-11-03.md)；生产部署状态未变。

## 可用行为

配置了协调器后，授权真人在配置仓库内显式提出的问题，可以由协调器读取证据并直接在原讨论回答。例如询问某文件的配置值，先读固定版本的文件，再回答该值及对应提交。此路径不创建工单、不运行 Worker、不取得 PR 归属，也不扩展任务实施权限。已有工单接续继续由原工单处理。

Codex app-server 和 DSH SDK 协调器共享 `answer` 输出约定：`triggerId` 必须是唯一候选原始事件，`answer` 为至多 8000 字符的答案；不能同时携带工单路由、实施范围或匹配规则。模型不能指定其他收件人或直接调用发送工具。多个触发事件混合的候选、自动推断候选、bot、旁观上下文和已归属工单的输入不适用直接回答。

GitHub Issue、PR 总讨论及已准入的行内讨论使用原有频道回传。行内入口仍服从 `reviewComments` 配置；本次没有自动开启新的接单入口。没有配置协调器时，不会因升级自动启动模型答疑。

## 发送与审计边界

- 在入队和新远端写入前，宿主核验原始事件指纹、真人稳定身份、当前策略、配置仓库、原讨论地址、已观察到的评论/正文修订和工单归属。失权、事件被替换或已转入工单时撤销未发答案；暂停时保留到恢复后处理。
- 原始事件确定回复身份；重投、重新研判及进程重开不会生成第二份答案。回复、来源证明与候选收尾在同一事务写入；领域内核保持原样，候选以带 `coordinatorAnswer` 审计的 `ignore` 收尾，事件诊断将其展示为 `answer`。
- 复用持久 Outbox、讨论内顺序和回执。请求可能已成功但响应丢失时，先按本项目标记和发送身份只读核对已有评论；核对成功只补收据，不再发一条，即使此时权限已撤销。
- 尚待发送的未归属 PR 答案会加入该轮来源观察，避免为了送达答案创建工单或永久订阅。已知来源错误、观察过期及仓库权限检查仍会阻止新写入。
- 完成研判的 `assessment:<evalId>` 记录保存实际成功读取的引用、版本、分页位置；代码记录另带仓库、固定提交 SHA 和路径。最多记录 64 次读取，不保存额外文件副本。答案内容的事实质量仍依赖模型判断，fixture 不证明真实模型在所有问题上都能正确回答。

## 普通 Issue 的代码证据

普通 Issue 候选增加延迟解析的仓库根目录引用。协调器遇到代码行为或“是否已实现”的问题，提示词要求先补读相关目录和文件，再作决定或回答；证据不足或读取额度耗尽时应返回 `unavailable`。宿主提供可读取的引用，不以问题关键词强制所有候选下载代码。

首次读取时核验配置仓库身份，解析默认分支并固定提交 SHA；后续目录、文件和重试沿用同一提交，分支移动不改变本轮事实。优先读取 origin 匹配的本地 Git 对象，忽略未提交文件；没有本地提交时，通过该仓库的 Git commits/trees/blobs 只读接口补读。固定 PR head 仍使用自己的提交；fork、缺少合法 head 或混合 PR 候选不能借用普通 Issue 的默认分支入口。

远端读取沿用项目 GitHub App 或专用账号身份。端点与路径由宿主生成；模型只能请求已发放的引用。目录有分页和引用上限，拒绝截断树、符号链接、子模块、受限凭据路径及不安全路径；文件限 256 KiB 文本，远端 blob 校验字节长度及 Git 对象哈希。实际模型读取继续受协调器的次数、字节与时间预算限制。每次读取及缓存返回仍检查取消/授权；后续远端代码读取重查 repository ID，拒绝同名仓库替换。

默认分支不可读取、本地 origin 不匹配、对象损坏或超出预算时保留失败证据，不用工作目录内容、其他仓库或新的默认分支补猜。代码读取只支持当前配置仓库，不提供任意 URL、文件系统或跨项目检索。

## 升级与旧写入者

新答案使用独立 `coordinator-answer` 待执行类型，保存发送前重验所需的来源证明。schema 10 → 11 迁移写入最低版本 `0.10.0-alpha.0`；旧包重新打开新库时拒绝，已打开且只派发旧 `reply` 类型的写入者也不会取得新答案。该隔离有冻结旧派发逻辑的 fixture 验证，不代表支持混用版本或热升级。

升级前仍须停止项目服务、前台执行和受管子任务，再使用新版 `js-superagent --project /absolute/project upgrade` 核验、备份和迁移。项目 ID、原工单和旧会话的执行端绑定保留；不自动更换模型、开启恢复或启动后台。生产库和服务在本轮没有操作，也未发布 npm。

## 验证记录

最终定向组合 **138/138 项通过**，覆盖协调器合约、两个内置适配器协议、来源证明、Issue/PR/行内频道、Outbox 未知写入核对、零工单/Worker、撤权及修订替换、暂停恢复、旧派发逻辑隔离、普通 Issue 固定代码读取及审计、事件诊断、迁移、搬迁、设置与巡检。

串联场景使用真实 ProjectRuntime、受限读取循环和 GitHub 频道代码，加临时 Git/模拟远端传输：Issue 问配置值 → 读取固定默认分支目录/文件 → 原处送达一次，零新工单/Worker；同时推进默认分支并保留脏本地文件，证明答案只来自固定提交。读取失败场景只留下 `unavailable`，没有猜测答案或派工。

两个内置协调器另以 fake Codex app-server / fake DSH SDK 协议完成目录读取 → 新引用文件读取 → 基于文件值及 SHA 返回 `answer`，覆盖真实适配器的提示词、结构化输出和验证接线；这属于离线协议验证，不等同于真实模型验收。

`check:core`、类型检查、构建及干净安装包 CLI/SDK smoke 通过。上游内核哈希未变，包保持独立。未调用外网模型、未发送真实 GitHub 评论、未运行持续后台验收；本轮不声称整个历史测试套件通过。

仓库根 `npm run check`（含工作流与技能检查）和 `npm run store:bootstrap` 通过。根检查仍报告 24 条既有溯源警告，以及三个已登记但本地缺失的历史视频；与本包改动无关，未改动这些资料。

扩展 GitHub 轮询回归发现四项既有失败，并在改造前 `24065e3278c5ba9f8e12a340f2eb6ea3599f576a` 的隔离源码副本中逐项复现相同断言（4/4 失败）。本次未修改其轮询实现或将其计入通过数：`github-pr-channel.test.mjs` 的 “only explicit PR bindings are polled; CI endpoints stay disabled by default”、“changed head, closed and merged PRs emit only current state without fetching stale feedback”、“CI selects latest attempt by app and name, latest status per context, and keeps producer identity”，以及 `w15-w19-github-channel.test.mjs` 的 “W15 default-branch CI isolates checks and statuses, holds unknown identities and retries known ids beyond the cursor”。
