# W24–W29 交付与操作记录

日期：2026-11-02（Asia/Shanghai）。工作区版本 `0.7.0-alpha.0`，新写入语义 schema 8。起点为 `a67a990`／`0.6.0-alpha.0`，范围见 [实施计划](workflow-followup-plan.md)。本记录只说明本轮实际实现和有限验证，不替代历史记录，也不表示已经部署。

## 已接通的 GitHub 流程

| 阶段 | 当前行为 | 有限验证与边界 |
| --- | --- | --- |
| W24 关闭讨论接续 | 已关闭 Issue 的授权真人跟进进入原工单。关闭／合并 PR 的跟进先作只读判断：解释回原讨论；确需代码修改时保留工单 ID，核对目标并建立新工作区、分支和会话 lineage。 | 临时 Git 仓库与模拟 GitHub 验证同工单接续、解释不创建新工作区、合并后新目标、未合并目标澄清、人工取消、脏工作区和未知输入拒绝转换；Issue 跟进即使早于 PR 关闭事件也会刷新当前目标，手动关联保留工作区代次。历史工作区及会话保留；未创建真实远端 PR。 |
| W25 CI 变化与恢复 | PR 与默认分支读取配置选定的可信检查，保存基线、集合及故障身份。活跃工单可接收运行中与恢复上下文；已完成工单更新观察，不因转绿再执行。 | 来源验证默认分支初始故障不重放、一次恢复、重复与乱序、重跑歧义；runtime 验证等待→运行中→恢复、重开数据库后故障保留、旧 head／缺失／局部读取不误报恢复、完成工单不复活。默认分支恢复投递的宿主路径已实现，本轮没有真实 Actions 验收。 |
| W26 准入贯通 | 来源保留真实 actor 事实，由现行 Policy 分别判断候选、上下文和续作；配置为 bot 的 User 账号也不获得真人权限。没有新配置时不扩大默认接收范围。 | Policy 与 runtime 验证列名 bot、配置为 bot 的 User、名单外账号、observe 行为及已有／结束工单。bot 不执行取消，也不单独恢复真正结束的工单；ready 且当前 PR 开放的待审工单仍可按现行 Policy 接续，CI 信任名单仍独立约束。 |
| W27 未绑定行内接单 | `streams.reviewComments` 默认关闭。启用后，轮询读取仓库行内评论；Webhook 只存 selector，再权威补读 PR、评论及 root，统一版本去重、研判、绑定和回传。 | 使用真实渠道与来源代码、模拟 transport 跑通 selector→补读→轮询交叠→研判→工单→模拟 Worker；只有一次入库和执行。关闭发现后，排队 selector 不再补读。历史 diff 位置保留为上下文；fork 和当前 head 门禁保留。 |

CI 的“恢复”只指完整读取范围内、此前观察到的故障已被对应成功结果解除。它不代表 GitHub 分支保护要求的所有检查都已通过；缺失检查、运行中状态、不明先后关系和读取失败不会被当成全绿。状态观察不自动授权合并或发布。

讨论可继续读取或回复，不等于允许写入旧 PR head。续作仍检查当前授权、执行目标、未结算输入和工作区状态；遇到不明确的目标或证据，保留原数据并提出问题或要求检查。新一轮本地交付仍留在本地，只有原配置允许草稿 PR 交付时才会走对应流程。

## W28：DSH 原生长命令交接

已接通 `0.2.2-alpha.2` 的公开原生 job 合同。模型给出与本轮历史一致的问题或 blocked／failed 报告后，先安装 `jobs.wait` 收取器，再将进程归属和固定期限转入持久记录，释放 Worker 名额。真人回复可复用尚存的 SDK 进程；工具桥、取消信号与记录重新绑定本轮，不能延长原期限。最多保留 4 个交接进程组，每组最多 8 个 job；输出有界并脱敏。

命令完成只保存输出，不唤醒模型、不撤销问题；证据保存后退出 SDK 并清理工具桥。下一正常真人轮次按 session/job 身份读取结果，逐项确认消费，跨多次交接不重复或提前吞掉其余 job。取消、Assignment 结束、撤权、替换会话及停止回收原进程；失主重开进入检查，不能重建原命令。业务暂停保留已有进程的固定截止时间。

支持边界：rc.5 保持原等待行为。仍有原生命令运行时，不提前接受 `ready`；当前没有“证明某运行命令与完成无关”的额外协议。普通无人工交接的后台命令沿用等待策略。

W18 原生 pending 队列的无消息自动唤醒继续暂缓。保留 pending 身份及 `native-pending-wakeup-unsupported`，不重发旧输入、不改原生日志、不使用私有唤醒方法。W28 的状态不能替代 W18 的能力判断。

## 复核后修复

本次只修复已确认的四个接续问题，不扩展原生 Harness 能力或 W18：

- **PR 等待审阅**：SDK 增加 `awaitingReview`，界面显示等待审阅，保留已有状态值；ready／开放 PR 的可信 bot 审阅按当前政策接续，真正结束、撤权或关闭策略仍拒绝。
- **GitHub 停止请求**：Issue、PR 普通评论和行内评论的显式取消进入同一宿主路径。已配置协调者时，授权真人自然语言跟进保存原 trigger 并可提出停止；只允许原工单，执行前重查评论当前版本、绑定和现行权限。普通跟进不重复转发；未配置协调者或消息超过 16,000 字符时，不推断自然语言取消。暂停期间仍可处理显式取消。取消来源可在详情查看。
- **历史来源故障隔离**：只有工作区和 continuation 记录相互核验后才排除旧代次的来源依赖。当前 PR、实际待处理 GitHub 输入和仓库整体权限仍检查；本地回复不因旧来源故障停住。历史故障仍显示、继续补读，旧目的地的待发回复仍独立等待。
- **DSH 交接拒绝**：新租约只在宿主接受后成为结果归属；拒绝或抛错保留原租约，决定期间到达的结果按最终归属回传。首次拒绝仍保存本地证据，普通等待结束前在原期限内收齐已安装的收取器；不制造 ready 或自动唤醒原 pending。

修复采用临时本地仓库、模拟渠道／协调者及假 SDK＋本地工具桥作定向验证，没有真实 GitHub 写入或外网模型调用。证据分别见 [PR 与停止请求](../test/workflow-followup-fixes.test.mjs)、[历史健康依赖](../test/github-execution-refs.test.mjs)、[交接拒绝](../test/dsh-handoff-refusal.test.mjs)，以及受影响的 W26／W28 小范围用例。

上述定向验证共 42 项通过（17＋4＋7 个修复场景，以及 9＋5 个受影响旧场景）；构建、类型检查和 18 项上游文件哈希核对通过。根目录 `npm run check` 返回成功，仍列出既有本地媒体缺失及资料溯源警告。只读服务检查为 `loaded:false`、`running:false`、`pid:null`。未运行完整历史套件，未修改生产库，修复尚未提交或推送。

## 使用与升级

CLI 的 `submit/show/reply/cancel/retry` 和 SDK 工单入口保持不变；Codex app-server、DSH SDK 与实例级注册表保留。js-superagent 自己维护工单、授权、存储和工作区，没有 js-agent-runtime 包依赖、类型依赖或运行桥接。

未绑定行内接单在现有仓库来源设置中显式开启。例如在已经初始化且配置 GitHub 的 SDK 实例上：

```js
const settings = agent.getRepositorySourceSettings();
agent.configureRepositorySource(
  { enabled: true, streams: { reviewComments: true } },
  { expectedRevision: settings.revision },
);
```

CLI 沿用 `repository status` 与 `repository set <file> <revision>`，JSON 中使用相同字段。新流首次轮询建立基线，不把历史评论批量变成任务；已经验签并持久化的 selector 仍单独补读。关闭 `reviewComments` 后，尚未处理的未绑定审阅 selector 按配置变化忽略。它不改变已有绑定 PR 的审阅反馈入口，也不扩大 actor 或仓库授权。

`details <ticket>`／`getDetailed()` 可查看续作记录与检查原因；`github status`／`githubStatus()` 的 PR 绑定包含 CI 快照及完整性。查询不执行任务。完整读取仍不等于 GitHub 的 required-check 证明。

升级准备沿用现有流程：停止执行与所属工具，核对没有活跃 owner，使用 `upgrade`／`upgradeRuntime()` 做一致性备份并写入 schema 8。只读查询不自动升级旧库；旧写者不得接管新语义。配置、会话、工作区、工单 ID、输入及交付收据保留，升级不会批量重排旧失败或重放已忽略事件。回退须停止后基于备份，先核对备份之后的外部动作，不能直接用旧包打开 schema 8。

上述是使用说明，本轮没有对生产执行这些动作。临时库的旧版本只读、升级至 schema 8、备份及旧写者拒绝已通过定向检查；类型、构建、18 项上游文件哈希核对，以及临时安装包的 CLI 帮助／SDK 接单查询通过。SDK 检查没有启动 Worker。根目录 `npm run check` 通过。

## 本轮证据

以下是已确认通过的本地定向文件，均未调用外网模型或写入真实 GitHub：

- [关闭讨论 runtime](../test/w24-continuation-runtime.test.mjs)：8 项；[续作工作区](../test/w24-continuation-workspace.test.mjs)：3 项，以及受影响旧工作区分支的有限检查。
- [GitHub 来源与 CI 观察](../test/w24-w27-github-sources.test.mjs)：5 项。
- [CI 与行内接单 runtime](../test/w25-w27-runtime.test.mjs)：5 项，包括数据库重开和真实来源代码的模拟收件。
- [GitHub 准入 Policy](../test/w26-github-policy.test.mjs)：5 项；[GitHub 准入 runtime](../test/w26-github-runtime.test.mjs)：9 项（含暂停期间的持久入站及恢复重查），以及受影响旧 Policy 分支的有限检查。
- [DSH 收取器与协议](../test/w28-native-collector.test.mjs)：5 项；[宿主交接](../test/w28-native-handoff-runtime.test.mjs)：4 项，包含真实短 Node 进程、名额释放、回执消费及取消／关停清理。
- [真实本机 DSH 短场景](../test/w28-dsh-native-handoff.mjs)：使用已安装 alpha.2 和 loopback 模拟 provider，共 4 次本地 provider 调用；验证原生命令运行中先交接、真人接回同一进程、完成无模型唤醒、持久输出消费和全部进程退出。它不是外网模型实测。
- 最后核对生产服务：`loaded:false`、`running:false`，无服务 PID。

没有运行完整历史套件、长时间轮询、真实 GitHub Issue／PR／Actions、外网模型或跨平台矩阵。没有打开或迁移生产库，没有安装、启动或切换生产服务；后台保持停止。没有因此次实现自动提交推送、发布 npm 或部署。
