# 0.10：项目级后台运行时差距复核

后续实现更新：本文第 1、2 项已在 `0.11.0-alpha.0`／schema 12 工作区补齐，详见[跨讨论关联与合批逐条答疑](candidate-routing-and-batched-answers.md)。以下缺口描述和排序保留为 `0.10` 比较快照；可选增强、真实验收缺口以及 W18、飞书暂缓状态不变。

日期：2026-11-03（Asia/Shanghai）。本地基线为已提交并推送到 `main` 的 [`8eebf0ad`](https://github.com/imjszhang/x-pkm-research/commit/8eebf0adc7888b5432a2b660c22aba4b7a66638d)，`0.10.0-alpha.0` / schema 11。本次通过 GitHub API 和远端引用重新核验，公开上游 main 仍是 [`6337fc8`](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/6337fc823ce20251c8de8085948165c81aaa701e)，本地只读比较副本与其一致。

## 判断范围与结论

目标仍是每项目独立安装、保存状态和管理后台的持久 Agent 运行时，支持 CLI/SDK、Codex app-server、DSH SDK 和本地/GitHub 工作流程。本文比较实际公开源码及接线，不把上游文章中的未来设计、完整 DSH 聊天宿主或跨项目控制平台列为本包应补能力。

上一轮两项主体能力已经补齐：协调器可以绑定原始真人问题直接回传，零新工单/Worker；普通 Issue 可以在研判中读取固定默认分支提交的目录和文件。实现、授权边界和 138 项定向验证见[交付记录](coordinator-answers-and-code-context.md)，不再将其整块列为缺失。

新的最优先差距是**同项目跨讨论的既有工单发现与关联**。其次是**多条问题合批时的逐条答疑**。逐规则审计、在线修改后续 Worker 模型和有界会话日志属于可选增强。执行、持久协调、任务/子任务、预览、输入回执、恢复核对和会话替换在本次检查范围内未发现新的整块缺失；这不替代当前固定包的真实长期验收。

## 1. 优先：跨 Issue/PR 的既有工单发现与关联

场景：Issue #1 已有工单，授权人在 Issue #2 明确说“把这个补充交给 #1 的现有任务”。这仍是同一项目内的授权工作，不涉及跨项目协调。

上游会解析消息里的 `#编号` 和 URL，从已保存线程的订阅找到工单，将最多四个引用工单加入候选卡；主协调器也能分页读取项目工单，并通过 `attach` 把输入送入既有工单。证据：[links.ts:47](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/links.ts#L47)、[resources.ts:119](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/resources.ts#L119)、[main.ts:106](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/tools/main.ts#L106)。

本地候选工单来自当前线程的订阅集合；普通 Issue 消息只登记自身线程，没有将正文中的同仓库引用转为候选工单。模型既不能读取集合外的工单，也不能将其作为 `attach` 目标。持续协调的本地 operator 搜索虽已有项目级读取，尚未接入 GitHub 候选研判。证据：[evals.ts:241](../src/core/evals.ts#L241)、[github-intake.mjs:67](../src/github-intake.mjs#L67)、[context-requests.mjs:16](../src/context-requests.mjs#L16)、[coordinator.mjs:90](../src/coordinator.mjs#L90)、[index.mjs:959](../src/index.mjs#L959)。

离线最小确认使用内存 Store 和真实 Engine：先建立 #1 工单，再输入 #2 的明确关联请求，得到 `candidate.tickets=[]`；`attach` 因目标不在候选上下文中被拒绝，读取目标工单也返回 `unavailable`。因此这是实际接线缺口，可能导致需要人工关联、无法处理或模型另建任务，不能只通过改善提示词解决。

建议优先补同配置仓库内的明确引用解析、有界相关工单读取和受控路由集合；提交时重验目标工单当前授权、归属与版本。不要仅移除候选集合校验，也无需开放任意工单 ID 或跨项目搜索。

## 2. 其次：多条问题合批后的逐条答疑

场景：同一 Issue 中先问一个问题，紧接着补充条件；后台尚未研判时两条消息进入同一个候选。本地 `answer` 明确要求候选只有一个 Trigger，即使每条消息都获准且不属于 Worker，也不能直接答复该候选。证据：[coordinator.mjs:77](../src/coordinator.mjs#L77)。

上游的回复工具按原始 `trigger_id` 调用，没有“整个候选必须只有一条消息”的要求：[main.ts:223](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/tools/main.ts#L223)。本次用内存 Engine 连续接收 `question` 和 `clarification` 后统一研判，确认候选包含两条，当前宿主 `validateAssessment(answer)` 拒绝；同一领域内核可对两个原始 ID 分别产生回复，工单数仍为零。

这是当前单问题答疑已完成之后的场景覆盖差距。建议增加逐 Trigger 的受控结果或宿主拆分：各自保留当前授权、原地址、幂等键和处理状态，避免回答其中一条时把整批其他请求静默收尾。不能简单删除单条校验。

## 3. 可选增强

| 能力 | 实际差距与影响 | 边界及证据 |
| --- | --- | --- |
| 逐规则判断和意图证据 | 本地有总体理由和命中 rule ID，缺少每条启用规则的匹配/不匹配理由，以及明确的意图证据结构；开启自主接单后更难解释误接/漏接。 | 本地 [coordinator.mjs:93](../src/coordinator.mjs#L93)、[policy.mjs:126](../src/policy.mjs#L126)；上游 [policy.ts:40](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/policy.ts#L40)。可借鉴审计结构，不把上游“仅接受方向已定的代码实施”硬编码成所有项目任务的范围。 |
| 在线修改后续新 Worker 模型 | 本地后台循环存在时，哪怕没有活动工单也必须停后台才能修改执行端配置；上游可在线核验保存新会话模型。 | 本地 [index.mjs:1376](../src/index.mjs#L1376)；上游 [settings.ts:160](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/settings.ts#L160)。仅考虑新会话模型的控制收据；旧会话保持绑定，账号、凭据和程序路径不必开放热更。本地策略/协调器设置已有在线路径，不能泛称所有配置都需停机。 |
| 按工单有界只读会话内容 | 已有业务轨迹、会话元数据、恢复证据及原始日志落盘，但排查模型具体说了什么、执行卡在哪一步，仍需查文件。 | 本地 [coordination-context.mjs:7](../src/runtime/coordination-context.mjs#L7) 明确不提供原生 transcript；上游 [resources.ts:114](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/resources.ts#L114) 提供只读 transcript/message。可以按权限脱敏分页，不需要复制聊天宿主，更不应绕过工单给原生会话追加工作。 |

## 共同限制、配置取舍及继续暂缓项

- **纯旁观订阅可能阻断直接答疑，但不是落后于上游。** 本地新 gate 提前拒绝已到达旁观工单的输入；上游领域回复同样以包含 context 的 `reaches` 找工单，没有对应 Worker answer 时拒绝。内存 Engine 确认 `owners=[]`、`reached=true`、回复失败码 `noAnswer`。两边领域实现一致，见本地 [coordinator-answers.mjs:76](../src/runtime/coordinator-answers.mjs#L76) 与上游 [replies.ts:64](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/core/replies.ts#L64)。若改善，需要单独明确旁观与回复权，不能只删外层检查。
- **深目录/长文件的读取预算需按项目调整。** 默认 3 次、32 KB，从根目录逐级进入深层文件可能耗尽；已有 `contextLimits` 可调，耗尽返回 `unavailable`。这是预算及检索便利问题，不是普通 Issue 无法补读代码，也不构成开放任意路径的理由。
- **W18 继续暂缓。** 本包当前精确支持的 DSH 版本仍按现有证据保留 pending 并返回 `native-pending-wakeup-unsupported`；本轮未重新验证其他 SDK 版本。上游原生宿主内部能力不能直接当作独立 SDK 的公开接口，见 [dsh-history.mjs:155](../src/drivers/dsh-history.mjs#L155)。
- **飞书继续暂缓。** SDK 来源工厂存在，但标准 CLI/service 装配、面板配置和成员同步仍未补全；不阻碍当前本地/GitHub 使用。
- 中央多项目控制台、跨机器高可用、完整原生插件市场、默认自动合并及不核对未知副作用就恢复，均不列为当前项目级后台运行时的必需差距。

## 验收与回归状态

代码提交保留上一轮 138 项定向、上游内核哈希、类型、构建及干净安装包验证。本轮比较未修改产品实现，没有部署、启动后台、迁移生产或发送真实 GitHub 评论。跨讨论关联与多条候选限制另做了内存级最小确认，不冒充真实模型验收。

四项既有轮询测试失败进一步核查为过时断言/fixture：前三项分别漏了 PR 快照、仍禁止关闭后的讨论接续、仍预期未配置的 CI 来源；在隔离副本仅更新这些预期后通过。第四项缺少当前必需的默认分支 commit 请求 mock，在实际读取 CI 之前就失败，旧完整故障隔离场景需要更新。当前默认分支基线/故障恢复/去重的 W25 定向测试通过。暂未发现这四项对应产品功能缺失；它们是待恢复的回归覆盖，不能记为完整套件通过，也不能以“历史失败”长期跳过。

当前包仍待真实固定版本验收：模型读取代码后在 GitHub 原处回答、发送结果未知后的重启去重、暂停/恢复及工单接续，后台在线设置实际生效，以及两个独立项目持续运行和真实服务故障下的保守巡检。历史版本的真实结果不自动覆盖 0.10。

建议顺序：先补跨讨论工单关联，再扩展合批问题答疑；准备启用自主接单时补逐规则审计，在线换模型和会话日志按实际运维需求安排。与这些源码增强并行，应恢复过时回归并完成同一固定包的真实验收。W18、飞书不因此恢复实施。
