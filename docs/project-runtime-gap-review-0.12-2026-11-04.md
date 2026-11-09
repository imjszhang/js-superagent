# 0.12：项目级后台运行时差距复核

日期：2026-11-04（Asia/Shanghai）。本轮实现已提交并推送 `main`：[`0fe9bebe`](https://github.com/imjszhang/x-pkm-research/commit/0fe9bebef38588d8a359b0747d4cc64357633387)，版本 `0.12.0-alpha.0`／schema 13。提交包含 `packages/js-superagent` 的 36 个文件，其他工作区与暂存内容未纳入；没有部署。

本次重新拉取公开上游，固定快照为 [`8c32a9dc`](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4)。完整 Git tree `3efbb036e5a56183c6bf642e2e1856a1f64e7be3`、216 个受控文件，与前两轮比较快照相同。提交编号变化没有带来新的源码能力；现有参考仓库未修改。

## 范围与结论

定位继续是每项目独立安装、持久保存状态并管理后台的 Agent 运行时，保留 CLI/SDK、Codex app-server、DSH SDK 及本地/GitHub 工作。协调器直接答疑、普通 Issue 固定代码补读、同仓明确引用关联、合批逐条答疑，以及本轮 Worker 原问题答案回传和 PR 重关联补投均已有实现；不将它们笼统重列为缺失。

本次确认四项实际差距，均有离线运行复现：

| 顺序 | 差距 | 实际影响 |
| --- | --- | --- |
| 1 | Worker 退回请求后无法重新研判 | 源消息仍有效，却被旧工单的输入退休记录挡住，不能分给新工单。 |
| 2 | PR 跨讨论关联没有先检查可执行条件 | 关联显示成功，缺少明确 PR 绑定使 Worker 无法继续，还阻塞同工单后续合法 Issue 输入。 |
| 3 | 跨讨论的定向澄清尚未接通共享工具和 Codex | 答案能回原问题，但需要追问时仍可能回到工单起点。 |
| 4 | 长历史下新待办不在面板首屏 | 先取旧的 100 条再排序，新的等待工单只能通过搜索或“更多”找到。 |

前两项优先修复工作链路；后两项分别补沟通和监督体验。逐规则审计、后续新 Worker 在线换模型和有界原生日志仍属于可选增强。**W18 和飞书继续暂缓。**

## 1. 退回原请求后，协调器误判整条来源已失效

场景：Issue 已有 Worker；授权人的下一条请求属于另一项工作，Worker 正确 handback，宿主应让协调器接纳为新工单、关联到别的工单或忽略，且不能再交回原 Worker。

实际运行结果：`handedBack=true`，工单数仍为 1，模型研判调用次数为 0，记录错误 `Candidate links refused: source-revision-retired`。源评论没有修改，当前作者仍获授权。

原因是 [index.mjs:851](../src/index.mjs#L851) 为退回该请求的工单保存 `input:retired:<domainId>:<triggerId>`；[candidate-links.mjs:45](../src/runtime/candidate-links.mjs#L45) 却将任意工单的退休标记当作整条来源失效，且在模型研判之前执行。应该区分“这条原文已被新修订取代”与“这个工单不再拥有它”。

这是真实回归，不是旧测试断言：同一个 [Issue 多工单回归](../test/issue-subscriptions.test.mjs#L24) 在 `8eebf0ad`（0.10）原始包通过，在 `24816475`（0.11）原始包及当前 0.12 均失败。三个版本分别在临时目录解包并重建 core 验证，没有改写产品文件。

上游 [dispatch.md:2](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/prompts/dispatch.md#L2) 明确要求退回后可接纳、关联到别处或忽略；[evals.ts:176](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/evals.ts#L176) 保留原始 Trigger 并重新排入研判。

建议恢复按工单限定的退休语义：旧 Worker 仍不得重收或答复退回输入，当前有效原文则可以重新研判。真实评论修订、撤权及手动取消的检查继续保留，不通过删除所有退休检查来修复。

## 2. PR 关联决策应先满足执行条件，或明确交接等待关联

场景：已启用未绑定 PR 行内来源；该 PR 的授权真人评论明确引用 Issue #1 的已有工单。协调器找到目标并成功 attach，但目标工单并未拥有该 PR 的本地显式绑定。

实际结果：接收状态为 `queued-for-assessment`，研判结果 `applied=attach`；Worker 执行次数仍为 1，PR 绑定数为 0。随后追加原 Issue 的合法输入后，两个输入都留在待投队列，执行错误为 `PR feedback is no longer authorized; inspect its association and configuration`。

本地 [coordinator.mjs:129](../src/coordinator.mjs#L129) 在确认来源/目标授权后直接 attach；执行时 [index.mjs:3321](../src/index.mjs#L3321) 又要求每个待处理 PR 输入都有目标工单的明确绑定。两层要求都各有理由，但当前缺少连接它们的待办或拒绝路径，导致一条不可执行的输入阻塞整个工单。

上游 [main.ts:106](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/tools/main.ts#L106) 将 attach 交给领域；[tickets.ts:121](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/tickets.ts#L121) 订阅原来源并添加输入，[dsh.ts:290](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/executor/dsh.ts#L290) 将其交给现有 Worker，没有本地额外的 PR 负责人绑定条件。

本地固定 SHA 和显式关联是合理的项目边界。建议在提交 attach 前核验执行条件；条件不足时留下明确的“需要关联此 PR”交接，或保持该输入待处理且不阻塞原有合法工作。不能默默自动采用外部 head、抢占其他工单的 PR，也不能把“收到关联请求”视为代码执行授权。该差距与 0.12 已修的“明确重关联后补投”是两条不同路径。

## 3. 定向澄清字段尚未贯穿内置报告入口

场景：Issue #1 的 Worker 收到 Issue #2 的关联问题，需要先问一句澄清。共享 `js_superagent_report` 只有 `state, summary, question, artifacts, answers`；携带原提问 `triggerId` 会被拒绝。因此普通 waiting/question 最终发到 Issue #1。

离线对照结果：共享工具路径 `questionSourceIssue=2, replyIssue=1, status=sent`；直接使用公开 v2 `attention.triggerId` 的控制组则为 `replyIssue=2`。领域和宿主的定向追问能力已存在，不能笼统称为“不会追问”或“原问题答案回传未完成”。

具体缺口在 [agent-tools.mjs:20](../src/runtime/agent-tools.mjs#L20)、[index.mjs:3723](../src/index.mjs#L3723) 的工具报告组装，以及 [codex-app-server.mjs:17](../src/drivers/codex-app-server.mjs#L17) 的最终报告 schema。DSH 最终 JSON 已允许 `attention.triggerId`，但共享业务工具同样未暴露它。

上游 [executor.ts:81](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/tools/executor.ts#L81) 有 `question_for_trigger_id`，在 [94 行](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/tools/executor.ts#L94) 转为 `askedBy`。

建议把原问题定向追问标识接通共享工具、Codex 解析和恢复路径，复用实际来源归属、当前授权、版本及发送前重验。允许模型选择它已获派的原问题，不允许任意指定收件人。

## 4. 新待办应在全量排序后进入首屏

本轮使用真实 ProjectRuntime 创建并运行 101 个临时工单，再访问真实管理 HTTP：

```json
{"total":101,"firstPageLoaded":100,"firstPageStatuses":["completed"],"includesNewestWaiting":false,"nextOffset":100,"secondPageHasNewest":true,"searchHasNewest":true}
```

原因链是 [store.mjs:155](../src/store.mjs#L155) 按保存顺序列出、[index.mjs:1850](../src/index.mjs#L1850) 直接投影视图、[management.mjs:397](../src/management.mjs#L397) 先分页，最后 [ui/app.js:188](../src/ui/app.js#L188) 仅对已加载的 100 条局部排序。上游 [tickets.ts:35](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/views/tickets.ts#L35) 在分页前按阶段筛选和时间排序。

这不是数据丢失；搜索和更多页面仍可找到新待办。应在服务端先按业务阶段和更新时间全量排序/筛选，再分页，让需要人的工作自然出现在首屏，无需扩展为跨项目中央控制台。

## 可选增强及边界

| 项目 | 当前事实与适用边界 |
| --- | --- |
| 在线修改后续新 Worker 模型 | 实际临时后台空闲时 `running=true, active=false`，仍报 `Stop work before configuring executor`。本地 [configureExecutor](../src/index.mjs#L1447) 与 [owner-controls.mjs:3](../src/runtime/owner-controls.mjs#L3) 尚未接入；上游 [settings.ts:160](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/settings.ts#L160) 可在线保存后续模型。只影响新会话，旧会话和凭据边界保持。 |
| 逐规则准入审计 | 本地 [coordinator.mjs:19](../src/coordinator.mjs#L19) 仍主要保存总体 reason 与命中 rule ID；上游 [policy.ts:40](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/policy.ts#L40) 要求逐规则 matched/reason 和 intent_evidence。更多自主接单时值得补，不照搬代码实施专属准入限制。 |
| 有界只读原生会话日志 | 本地 [context.mjs:26](../src/context.mjs#L26)、[coordination-context.mjs:4](../src/runtime/coordination-context.mjs#L4) 仍提供业务状态而非原生消息；上游 [resources.ts:271](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/resources.ts#L271) 可 inspect transcript/message。可作为按工单脱敏、分页的排障入口，不开放原生会话写入。 |

- W18 和飞书继续暂缓；没有重试原生 pending 唤醒或新增飞书配置。
- 0.12 只对有持久原负责人证明的新事件做 PR 补投，不推断回放 0.11 旧收据，这是迁移边界。
- 原问题答案与正常任务结果是不同报告用途；使用 progress 答疑后再提交最终结果即可，不将 ready+answers 仅回原问题误记为丢失所有结果回传。
- GitHub 截图研判、没有明确指向的语义关联、原生子任务宿主差异仍按[前一轮边界](project-runtime-gap-review-0.11-2026-11-03.md)处理。多项目中央管理、多机高可用、完整原生插件市场、默认自动合并不是当前必需能力。

## 验证与交付状态

实现保留 [0.12 交付记录](worker-answers-and-pr-redelivery.md) 的 195/195 Node 定向验证、153/153 领域核心及同组 SQLite 153/153、类型、构建和干净安装包检查。本次提交前再次通过来源清单、类型与 diff 检查，独立审查另复跑答案/补投窄组 35/35。

上述四项差距都有临时隔离项目/模拟渠道的实际运行结果，主 agent 独立重跑相同结果；定向澄清同时运行了公开协议控制组。handback 另以 0.10、0.11 原始包及当前包对照。复现脚本和日志保存在本地 `/tmp/js-superagent-012-{routing-gaps,panel-gap,live-model-gap,clarification-gap.test}.mjs` 及相应日志；本文保留关键场景、结果和代码证据，不依赖临时文件作为唯一依据。

完整套件仍未通过：此前记录的适配器 3 项、PR runtime 3 项及轮询 4 项旧回归尚未处理；本次新确认的 handback 是实际产品回归，应优先修复，不能当作“旧断言”跳过。未做固定包的真实 GitHub/外网模型、长期双项目后台及故障巡检验收；旧版本真实证据不自动覆盖本轮。

比较记录完成后，根项目 `npm run check`（含工作流与技能检查）及 `npm run store:bootstrap` 已通过；仍有 24 条既有溯源提醒和媒体检查列出的 3 个历史缺失视频，与本包无关。本轮只提交、推送源码与比较记录；不部署、不启动生产后台、不迁移生产库、不发布 npm 或发送真实 GitHub 评论。
