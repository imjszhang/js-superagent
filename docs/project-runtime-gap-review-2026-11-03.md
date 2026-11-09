# 项目级后台运行时：公开原型对齐复核

当前结论已更新至 [0.10 提交后的复核](project-runtime-gap-review-0.10-2026-11-03.md)：跨讨论工单关联和合批答疑为后续重点。本文保留改造前基线。

后续实现更新（2026-11-03）：下文前两项已在 `0.10.0-alpha.0`／schema 11 工作区补齐，并完成相关离线验证，详见[交付记录](coordinator-answers-and-code-context.md)。W18 和飞书继续暂缓。下文保留 `582c6f44` 时的原始差距判断，不能再将这两项计为当前源码缺失；新包真实模型/GitHub 持续验收仍未完成。

日期：2026-11-03（Asia/Shanghai）。本地实现基线为已推送的 [`582c6f44`](https://github.com/imjszhang/x-pkm-research/commit/582c6f44c95e27bfba8d1ee6f5d5a19fc10e1283)，`0.9.0-alpha.0` / schema 10。通过 GitHub API 重新核对，公开 `deepseek-ai/dsh-superagent-prototype` 的 main 仍为 [`6337fc8`](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/6337fc823ce20251c8de8085948165c81aaa701e)。源码比较使用相同提交的本地副本；没有把文章中的未来设计当作已发布能力。

## 判断边界

目标是每个项目独立安装、保存状态和管理后台的持久 Agent 运行时，保留 CLI/SDK、Codex app-server、DSH SDK，以及本地/GitHub 工作流程。参见[多项目定位](multi-project-runtime.md)。本次只检查实际工作链路的差距，不实施下一轮功能，不部署或启动服务。

结论：接单、授权、工单、隔离工作区、持续协调、反馈续作、审阅交付、多轮子 Agent、预览、恢复诊断和管理已具备主体实现。本轮新增的暂停反馈保留、新 Issue 请求、PR 旁观上下文、在线设置和巡检也不能再列为整块缺失。优先补齐下面两项协调能力；其他项分别属于受 SDK 限制、可选增强或验收缺口。

## 应优先补齐的两项能力

### P1：协调器直接回答 GitHub 问题，不必创建工单

场景：授权人在 Issue 中问“当前为什么暂停”“这条请求会由谁处理”。上游的 `orchestrator_reply` 可用 `purpose=answer` 和原始 `trigger_id` 直接回答，由领域回复 gate 限定收件对象和用途，不必创建执行任务。依据：[上游 main.ts:223–239](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/tools/main.ts#L223)。

本地[协调器](../src/coordinator.mjs)第 15–22、67–86 行只接受 `accept / attach / stop / ignore / unavailable`（另有只读请求）；[工作事件协调](../src/runtime/coordination.mjs)第 89–105 行的 `reply` 仅接受本地 operator 事件。Worker 可以回答、已有工单可以报告，但这不等于候选阶段的直接答疑。影响是简单问答也可能需要派工，或被归为无需工作后没有回答。

建议：增加绑定原始真人事件的受控 `answer` 动作，复用现有 Outbox、身份核验、去重与回执；限定回答原问题，不授予实施权限，不允许主动进度刷屏。验收应证明零新工单/Worker 执行、原处送达一次，以及失权/旧事件/写入结果未知时正确处理。

### P1：普通 Issue 研判前的仓库代码补读

场景：Issue 描述“这个功能是否已经实现”，协调器应先检查相关代码再决定忽略、关联或新建任务。上游评估读取支持 `file / directory`，通过配置仓库的 Contents API 读取（未指定 ref 时为默认分支）。依据：[assessment.ts:225–269](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/assessment.ts#L225)、[github-read.ts:48](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/sources/github-read.ts#L48)。

本地[候选来源上下文](../src/runtime/source-context.mjs)第 65–84 行只从触发事件的 `headSha` 或 PR head 建立仓库读取引用；普通 Issue 没有 SHA，只提供讨论正文和评论。第 110–117 行还要求相应提交已存在于本地 Git。已经派工的 Worker 可读代码，但无法弥补“派工前判断”缺少代码证据。

建议：由可信宿主为普通 Issue 解析并固定配置仓库默认分支的提交，提供有界、只读、可追溯的 tree/file 引用；缺少本地对象时支持受控读取或清楚标为不可用。保持仓库归属、版本、路径与读取额度检查，不开放任意文件系统或 URL。验收覆盖无 SHA Issue、读取后不派工、默认分支变化、对象缺失和跨仓库拒绝。

本次离线最小复核确认：普通 Issue 的初始引用为两个 `sources`、零个 `repository`；`validateAssessment({kind:'answer', ...})` 被拒绝。没有调用网络或模型。两项结论同时结合了上述实际接线，非仅凭类型缺少某个名称推断。

## 已知限制及可选增强

| 优先级/性质 | 当前差距及影响 | 证据与建议 |
| --- | --- | --- |
| P1，外部依赖，继续暂缓 W18 | DSH 崩溃时已接受但未读取的原生输入只能核对并保留，无法无人值守自动唤醒原队列。 | 本地 [dsh-history.mjs:155–165](../src/drivers/dsh-history.mjs) 返回 `native-pending-wakeup-unsupported`。上游 [executor/dsh.ts:424–448](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/executor/dsh.ts#L424) 与 [524–535](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/executor/dsh.ts#L524) 可在原生宿主内协调 inbox/派工；不能据此假定独立 SDK 已提供等价接口。等待安全公开接口，不插入重复消息或改原生日志绕过。 |
| P2，可选决策审计增强 | 自主接单保留总理由和命中 rule ID，但缺少每条启用规则的匹配/不匹配理由及明确意图证据结构。调试“为何接/不接”时信息较少。 | 本地 [coordinator.mjs:67–86](../src/coordinator.mjs)、[policy.mjs:126](../src/policy.mjs)；上游 [policy.ts:18–59](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/policy.ts#L18) 要求逐规则评估和 intent evidence。可以增强可解释性，但不能把上游“只接受方向已定的代码实施”硬编码为所有项目任务的边界。 |
| P2，可选运维便利 | 后台运行时，不能只更改后续新 Worker 会话的模型；即使空闲，也要停后台后修改。 | 本地 [index.mjs:1328–1338](../src/index.mjs)；上游 [settings.ts:160–195](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/app/settings.ts#L160) 支持在线核验保存模型。可把“新会话模型设置”纳入控制收据，旧会话继续固定配置；账号、凭据、程序路径不必因此开放热更。 |
| 已暂缓，可选渠道 | 飞书已有 SDK 来源及连接工厂，但还没有标准 CLI/service 装配、面板来源配置和成员名单同步；不仅是少一次实测。 | 本地 [feishu.mjs](../src/channels/feishu.mjs)与 `registerSource`；上游 [feishu.ts:73–115](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/src/sources/feishu.ts#L73)。明确选择飞书时再补完整链路，目前不阻碍 GitHub/本地使用。 |

上游能从工单跳到 DSH 原生 Session；本地以业务轨迹、会话元数据和替换入口为主。可按排障需要补有界只读执行日志，但不为界面对齐复制完整聊天宿主，也不允许绕过工单给原生会话追加工作。

## 验收缺口，不是功能尚未实现

当前提交完成了离线定向及独立安装检查，详见[提交前复核](background-continuation.md#2026-11-03-提交前复核)。历史版本真实验收不能自动转移到当前包。下一阶段优先用同一固定包验证：

1. 真实 GitHub + 模型的暂停→重试/替换→恢复，同一输入不丢失、不重复。
2. 旧 Issue owner 取消后的新接单、PR owner 与旁观者并存、原处回传闭环。
3. 常驻后台实际接收在线设置，新增/已有执行槽和来源开关一致。
4. 两个独立项目长期运行，以及真实 launchd 故障下巡检只恢复已证明空闲的实例，人工停止始终优先。

这是验收建议，本次没有启动这些场景，也没有升级生产数据库、发布 npm 或安装定时任务。

## 不列为本轮功能缺口

- 中央多项目控制台、跨机器高可用和分布式租约：超出当前项目级及同用户本机协调范围。
- 完整 DSH 插件市场、聊天宿主、所有原生工具：执行端能力与本包业务能力分开维护。
- 默认自动合并、强推或替人做团队决策：属于显式项目策略，不是基础接续能力。
- Linux/Windows 服务安装器、固定 HTTPS、npm 正式发布：既定独立扩展，不阻碍当前 macOS、本地/GitHub 子集。
- 自动重启有未结业务、未知副作用或 W18 pending 的实例：巡检刻意保守，不能以“上游会修复”为由放开。

建议顺序：优先补两项协调能力并验证对应链路；需要自主接单时增加规则审计；确有不停收件切模型的需求再扩展在线设置。W18 和飞书保持各自的依赖/暂缓状态，不阻塞其他工作。
