# W6 GitHub 连续工作验收

2026-11-02，既有私有验收仓库 `imjszhang/js-superagent-acceptance`；真实 DSH SDK 执行、真实 GitHub 接单与回传。仅一个 Issue、一个 draft PR、一条关联反馈，未启动常驻后台。

执行脚本：[real-workflow-github-smoke.mjs](../examples/real-workflow-github-smoke.mjs)。原始本地证据：仓库内 `working/agent-runs/js-superagent-workflow-github-20261102-w6-actual/acceptance.json`，状态 `passed`，运行时间 05:01:06–05:02:43 UTC。

## 已验证流程

1. [Issue #29](https://github.com/imjszhang/js-superagent-acceptance/issues/29) 接单，创建工单 `1abdc79e24d5dccbb291aed3ee8474ff`。修改范围仅为 `packages/js-superagent/examples/acceptance-target/diagnostic.mjs`，使 `formatDiagnostic(input)` 的 `text` 为 `String(input).trim()` 并保留大小写。
2. 首轮宿主验证 `scripts/host-verify.mjs` 通过，宿主交付状态为 delivered，创建 [draft PR #30](https://github.com/imjszhang/js-superagent-acceptance/pull/30)。提交、推送、PR 与消息由宿主处理，Worker 没有自行发布。
3. 在同一 PR 的[关联反馈](https://github.com/imjszhang/js-superagent-acceptance/pull/30#issuecomment-6569478845)要求返回对象增加 `level: 'info'`。第二轮仍属于原工单、原 PR，原生会话继续使用 `dsh-sdk / js-39d7a83f-205e-46c5-a33f-701f6677ebfd`。
4. 脚本直接导入第二轮工作区模块，断言 `formatDiagnostic('  Ready  ')` 精确返回 `{ text: 'Ready', level: 'info' }`；同一 PR 的交付状态为 delivered，并取得[结果回传](https://github.com/imjszhang/js-superagent-acceptance/pull/30#issuecomment-6569486393)。
5. 宿主通知收据 ID 无重复。再次同步相同远端事件并调度后，工单报告数不增加，证明相同反馈没有触发重复执行。记录中的 PR Bot 结果评论只有一条。

两轮执行 ID 分别为 `0a6e324d-c13b-47b6-9f22-3b4a5080c0a4`、`783d3d85-349b-4772-a653-d40b7119f4b7`。原始记录包含 Issue/PR/反馈/结果链接、会话、运行 ID 和四个已发送通知收据。

## 清理与证据边界

本轮结束时关闭了 Issue #29 和 PR #30，**PR 未合并**。只清理本轮对象；隔离项目保留用于复核，没有部署或启用生产后台。

这是实际模型与远端 GitHub 的组合验收，不是模拟 provider 结果，也不是完整 App/Webhook、CI 故障或全部 PR 状态矩阵验收。

证据基线提交为 `991b4573824095847567a5afe1994a6117457b24`，并保存启动时四个关键源码摘要。记录整理时，DSH 适配器、Harness 注册表和恢复模块摘要仍与启动记录相同；`src/index.mjs` 已因并行收尾修改而变化，启动摘要为 `16f013a1bbd3827aa129de3be2602b975fcdecbe3418b931d32b65c76632b6e6`，整理时摘要为 `96c1d6a575308df040a02d1bedb8e54028add3220db718f9bf4e78349552765d`。

因此本记录证明当时进程加载实现的接单、同会话续作、交付与去重链路，不能据此声称最终整个工作树已重新执行真实 GitHub 验收。后续代码变更以相应定向检查记录为准，不扩大本轮真实验收次数。
