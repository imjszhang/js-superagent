# 0.11：项目级后台运行时差距复核

后续更新（2026-11-04）：下文前两项已在 `0.12.0-alpha.0`／schema 13 工作区源码中补齐，实际行为与验证边界见 [Worker 原问题答复与 PR 重关联补投](worker-answers-and-pr-redelivery.md)。本轮尚未提交、推送或部署；第三项面板排序仍待处理，W18 和飞书继续暂缓。下文保留 0.11 复核时的发现与证据。

日期：2026-11-03（Asia/Shanghai）。本轮实现已提交并推送 `main`：[`24816475`](https://github.com/imjszhang/x-pkm-research/commit/24816475f48e64327060fa12610781ee4342248b)，版本 `0.11.0-alpha.0`／schema 12。提交仅包含 `packages/js-superagent` 的 37 个文件，其他工作区改动与暂存内容未纳入。

比较采用本次从公开上游拉取的固定快照 [`16ab4f56`](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/16ab4f56e5ca2af11f955ac0a06080070c3d135f)。其 Git tree 为 `3efbb036e5a56183c6bf642e2e1856a1f64e7be3`，216 个受版本控制的文件与上一轮 `6337fc8` 的完整 tree 相同；提交编号变化没有带来新的源码能力。没有修改现有上游参考仓库。

## 范围与结论

目标仍是每项目独立安装、保存状态并管理后台的持久 Agent 运行时，支持 CLI/SDK、Codex app-server、DSH SDK 和本地/GitHub 工作。协调器直接答疑、普通 Issue 固定代码读取、同仓明确引用关联和合批逐条答疑已接通，不再重复列为缺失。0.11 的实现和 186 项定向验证见[交付记录](candidate-routing-and-batched-answers.md)。

本轮确认三处实际差距：**既有 Worker 的原问题答复回传、PR 重新关联后的漏投反馈、长历史下的待办首屏可见性**。前两项影响工作闭环，第三项影响单项目日常监督；它们都在当前定位内。逐规则审计、后续新 Worker 在线换模型和有界会话日志仍是可选增强。

## 1. 优先：既有 Worker 回答原问题并回到原讨论

场景：Issue #1 已有工单，授权人在 Issue #2 提问并明确关联 #1；协调器把问题交给原 Worker，Worker 应在 #2 回答，同时保持原任务可继续。0.11 已能正确关联和继续原会话，但通用 Worker 报告没有 `answers`／原问题答复标识。协调器的零 Worker 答疑又有意拒绝接管已有工单的输入，因此这条路径没有受控的直接答案回传。

已用真实 ProjectRuntime、临时工作区及模拟 GitHub 频道复现两种报告：

| Worker 报告 | 当前结果 |
| --- | --- |
| `waiting`，summary 包含答案 | 问题已在原工单输入中；工单保持 waiting，回复列表为空 |
| `ready`，summary 包含答案 | 工单变为 completed；唯一答复发往来源 Issue #1，提问的 #2 没有答案 |

本地 [reports.mjs:48](../src/runtime/reports.mjs#L48) 的通用协议拒绝 `answers`；[agent-tools.mjs:20](../src/runtime/agent-tools.mjs#L20) 和 [index.mjs:3632](../src/index.mjs#L3632) 的业务报告工具也没有原问题答复字段。[index.mjs:3807](../src/index.mjs#L3807) 对普通 Issue 发送 attention/result，结果使用原工单来源。PR 另有反馈目的地和审阅处置路径，不能将本结论泛化为所有 Worker 回传都缺失。

上游明确支持 `reply_to_trigger_id` → `report.answers`：[executor.ts:81](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/16ab4f56e5ca2af11f955ac0a06080070c3d135f/src/app/tools/executor.ts#L81)。[notices.ts:108](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/16ab4f56e5ca2af11f955ac0a06080070c3d135f/src/app/notices.ts#L108) 将 `answer_to` 交给主协调器，即使只是 progress 也可转发已标记的答案；[replies.ts:78](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/16ab4f56e5ca2af11f955ac0a06080070c3d135f/src/core/replies.ts#L78) 核对工单已回答该原始问题后使用 `trigger.channel`。

建议补通用 Worker 报告及内置适配器的原问题答案标识，再由宿主核验当前任务、原输入归属、真人身份、来源版本和发送权限后持久回传。不让模型选择任意收件人，不为答疑强行结束任务，也不让协调器重新生成 Worker 尚未完成的答案。本地公共报告的 `attention.triggerId` 已可转为 `askedBy`，不将整个追问能力误记为缺失。

## 2. 优先：PR 明确重新关联后，补投此前未交付的反馈

场景：PR 同时有负责工单和只读旁观工单，远端 head 从 A 改为 B。B 上的新真人请求被旁观工单收到，负责工单因固定版本检查拒绝；操作者随后明确重新关联到 B，再次接收同一评论，仍只返回 `duplicate`，负责工单没有该输入。

离线运行实际 ProjectRuntime 得到：首次结果 `context-only`，其 `ownerOutcome.reason=pull-request-version-unavailable`；重新关联后 `linkedHead=B`，重收结果 `duplicate`，`ownerInputs=0`，旁观通知为 1。这里的缺口发生在**已经明确采用新版本之后**，不是要求后台盲目信任外部 head 变化。

本地 [index.mjs:2197](../src/index.mjs#L2197) 以全局事件/Trigger 直接判重；[index.mjs:2201](../src/index.mjs#L2201) 在旁观收到后保存事件收据；[index.mjs:2260](../src/index.mjs#L2260) 拒绝不匹配的负责人版本，而[重新关联路径](../src/index.mjs#L1962) 只更新绑定、退休旧 head 输入，没有补投新 head 尚未交给负责人的输入。

上游[当前 PR 讨论读取](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/16ab4f56e5ca2af11f955ac0a06080070c3d135f/src/sources/github.ts#L369)继续接收评论，[领域分发](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/16ab4f56e5ca2af11f955ac0a06080070c3d135f/src/core/intake.ts#L38)分别处理每个订阅工单。本地采用更严格的固定 SHA 边界是合理取舍，但“旁观已收到”不能永久代替负责人的投递结果。

建议按工单保存未投递原因；明确重新关联后，只补投仍属于当前 head、当前授权、当前评论修订且尚未到达该工单的输入。保留全局事件去重和每工单投递幂等，不通过删除版本检查或重新制造消息来修复。

## 3. 应补：长历史下，新待办应出现在面板首屏

场景：单项目已有 100 条历史完成工单，第 101 条新工单正在等待处理。管理接口按保存顺序先分页，前端只取前 100 条再局部按优先级/更新时间排序，新待办被藏在“更多”后。生产内存 Store 加真实管理 HTTP 的离线复现为 `total=101, loaded=100, includesNewestWaiting=false, nextOffset=100`。

证据：[Store 保存顺序](../src/store.mjs#L155)、[runtime.list](../src/index.mjs#L1798)、[API 分页](../src/management.mjs#L397)、[首屏加载和局部排序](../src/ui/app.js#L188)。已有搜索和继续加载可以找到该记录，所以不是数据丢失；但后台监督应主动把需要人的新任务显示出来。

上游在[分页之前按阶段筛选和时间排序](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/16ab4f56e5ca2af11f955ac0a06080070c3d135f/src/app/views/tickets.ts#L35)。建议服务端先按明确业务状态及更新时间排序/筛选，再分页；前端排序只负责展示，不能替代全量排序。这属于单项目面板能力，不需要中央控制台。

## 4. 仍成立的可选增强

| 能力 | 当前差距与适用边界 |
| --- | --- |
| 逐规则准入审计 | 本地 [coordinator.mjs:107](../src/coordinator.mjs#L107) 只有总体 reason 和命中 rule ID；上游 [policy.ts:40](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/16ab4f56e5ca2af11f955ac0a06080070c3d135f/src/policy.ts#L40)要求所有启用规则逐条给出 matched/reason，并保存意图证据。准备启用自主接单时值得优先加；不照搬上游对所有任务都要求方向已定的代码实施限制。 |
| 在线修改后续新 Worker 模型 | 本地 [configureExecutor](../src/index.mjs#L1395) 即使后台空闲也要求停循环；[在线设置入口](../src/runtime/owner-controls.mjs#L3)不包含它。上游 [settings.ts:160](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/16ab4f56e5ca2af11f955ac0a06080070c3d135f/src/app/settings.ts#L160)可核验并保存后续会话模型。仅考虑新会话，旧会话继续固定；账号、凭据、程序路径不必热更。 |
| 按工单有界只读会话内容 | 本地有业务轨迹、会话元数据、输入回执和恢复证据，但[项目上下文读取器](../src/runtime/coordination-context.mjs#L7)不提供原生消息。上游 [resources.ts:114](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/16ab4f56e5ca2af11f955ac0a06080070c3d135f/src/app/resources.ts#L114)通过宿主 inspect 提供 transcript/message。可做按权限脱敏的分页排障入口，无需复制聊天宿主或开放原生会话写入。 |

## 不算新增缺口及继续暂缓项

- 明确仓库引用关联已完成。无链接的“刚才那个修改”可将来设计受限检索，不能直接改为凭主题相似自动关联；上游 [dispatch.md:7](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/16ab4f56e5ca2af11f955ac0a06080070c3d135f/prompts/dispatch.md#L7)也要求明确指向原工单。
- GitHub 截图研判不是上游已经接通的优势：其 [GitHub 上下文实现](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/16ab4f56e5ca2af11f955ac0a06080070c3d135f/src/sources/github-read.ts#L159)没有图片接线；图片能力在飞书来源。Worker 读图能力不能替代候选研判的实际接线。
- 纯旁观订阅可能阻断直接答疑、深目录代码读取可能耗尽配置预算，仍属[已记录的共同限制或配置取舍](project-runtime-gap-review-0.10-2026-11-03.md)。原生子任务与本地独立快照、显式采纳的差异也不能泛称为子任务能力缺失。
- **W18 和飞书继续暂缓。** 本轮没有升级 DSH、试探新的原生 pending 唤醒能力或接入飞书。跨项目中央控制台、跨机器高可用、完整原生插件市场、默认自动合并不纳入当前必需差距。

## 验证与建议顺序

实现提交保留上一轮 **186/186 Node 定向测试、153/153 领域核心及同组 SQLite 153/153**、类型、构建和干净安装包验证。本次提交前再次通过来源清单和类型检查；差距复核另做上述离线最小复现，不冒充真实模型/GitHub验收。

比较记录完成后，根项目 `npm run check`（含工作流与技能检查）及 `npm run store:bootstrap` 通过。仍有 24 条既有溯源提醒和 3 个已登记但本地缺失的历史视频，与本包改动无关。

四项已知过时轮询回归本轮再次单独运行，仍为 **0/4 通过**：三个旧 PR 断言与一个缺少默认分支提交 mock 的 W15 fixture，详情见[上一轮记录](project-runtime-gap-review-0.10-2026-11-03.md)。未修改这些测试，也不将其算入通过数量；应恢复回归合同，不能据定向测试声称完整套件通过。

建议先补既有 Worker 原问题回传和 PR 重关联后的漏投，再修面板全量排序/筛选。与此同时恢复四项过时回归，冻结同一安装包做真实 GitHub 答疑/续作、未知发送结果后的重启去重、双项目持续运行与故障巡检验收；此前版本的真实证据不自动覆盖 0.11。可选增强按自主接单及运维需求安排。

本轮只推送源码与比较记录，没有部署、启动服务、迁移生产库、发布 npm 或发送真实 GitHub 评论。
