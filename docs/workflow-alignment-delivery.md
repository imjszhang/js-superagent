# dsh-superagent 工作流程对齐交付记录

2026-11-02。对应 [W0–W6 实施计划](workflow-alignment-plan.md)，基线提交 `991b457`，包版本 `0.4.0-alpha.0`。本轮源码实现与限定范围验收完成，未提交、推送、发布或部署。生产后台保持停止，生产库未迁移。

后续状态：本记录形成后，用户已授权将改造以 `f814f11` 提交并推送到 main；未发布或部署。验收时的源码/安装包摘要不变。后续差距已按 [W7–W14 计划](workflow-reliability-plan.md) 在工作区实现，见 [新交付记录](workflow-reliability-delivery.md)；本页保留 W0–W6 当时的支持范围。

## 当前实现

| 单元 | 实现结果 | 主要证据 |
| --- | --- | --- |
| W0 统一适配器 | Codex app-server、DSH SDK 共用实例级 Registry；Worker/Child/Coordinator 保持角色边界；移除 exec/headless 和直接旧 Driver 注入；保留 CLI/SDK 及明确的数据迁移 | [W0 记录](w0-adapter-consolidation.md)、`test/w0-adapters.test.mjs`、Registry/协议/类型及干净目录安装检查 |
| W1 人类反馈 | 普通业务 failed/blocked 后，原授权人的补充继续同工单、会话与工作区；bot 不解除失败；未知原生/验证/交付结果保留消息并要求检查 | `src/runtime/feedback.mjs`、`test/w1-feedback.test.mjs` 五项 |
| W2 持续协调 | 持久收件、稳定事件 ID 和动作收据；操作员消息、工作报告及状态事实共用原协调会话；受限 note/requestStatus/reply/request/stop；提交前重查政策和状态 | `src/runtime/coordination.mjs`、W2 模块六项与宿主七项；本地真实协调查询 |
| W3 DSH 实时反馈 | 同会话入队回执与原生消费事件分别记录；精确校验 run/input/session/messageId/事件序号；旧报告不能吞新输入 | [W3 记录](w3-dsh-input.md)、SDK/live-input 定向检查、真实 rc.5 + 模拟 provider |
| W4 有限恢复 | 显式开启、有证据才恢复、最多三次宿主尝试、跨重开计数与总期限；退避释放槽位；人工操作使旧计划失效 | [W4 记录](w4-recovery.md)、虚拟时钟与隔离 Store 七项；DSH 错误证据协议检查 |
| W5 PR 生命周期 | 来源、手动及自建 PR 接入 follows；close/merge/reopen、待处理真人输入、取消关联按原核心规则处理；head 改变仍需核对 | `test/w5-pr-lifecycle.test.mjs` 四项及 originating PR 定向回归；真实 DSH PR 反馈 |
| W6 入口与交付 | 现有 CLI/SDK 保留；新增协调消息/记录、恢复设置及输入/检查状态；独立包可安装 | 类型/core 摘要、包安装、受影响 API/UI 检查及下述两条真实流程 |

领域内核未修改，18 项上游来源摘要核对通过。包无 js-agent-runtime 依赖，不加载上游 dsh-superagent 插件来管理工单。配置、存储、授权、工作区、渠道和交付仍归本包负责。

## 如何使用新增流程

普通业务失败或缺信息时，继续使用已有 `reply <ticket-id> "补充说明"` 或 SDK `reply(id, text)`；GitHub 则在原 Issue/关联 PR 回复。输入先保存，只有原授权仍有效且旧执行已停止才续作。取消的任务不会被一条评论复活；未知外部结果显示检查原因，核查后使用明确的 retry/session replace。显式重试前保存的有效反馈会被释放，授权已撤销的远端消息不会重放。

持续协调默认关闭。已有协调者设置可通过 SDK 显式启用；下面只展示配置与入队，不自动运行服务：

```js
const current = agent.coordinatorStatus().settings;
agent.configureCoordinator({
  assessor: current.assessor ?? { driver: 'codex-app-server' },
  workflowMode: 'continuous',
}, { expectedRevision: current.revision });

const event = agent.coordinate({ id: 'project-progress-1', text: '现在有哪些任务在等待我？' });
console.log(event.id, agent.coordinationStatus());
// 用户明确执行时再调用 await agent.runNext()，或使用既有 run/serve。
```

CLI 对应 `coordinator status`、`coordinator set <json-file> <revision>`、`coordinate "现在有哪些任务在等待我？"` 和 `coordination status`。设置文件使用相同的 assessor/workflowMode 字段；DSH 继续使用已配置的 SDK assessor。管理面板也提供模式选择、消息输入和处理记录。

候选继续走原 `assess(candidate)`；工作事件使用可选 `handleEvent()`。普通进度、问题及已回传结果只更新上下文，不重复调用模型或发送结果。只有操作员消息或明确需要协调的报告唤醒协调者。新任务仍经过原准入与授权；停止已有任务须有明确的 `/stop <公开工单ID> <原因>` 操作员消息。查询进度不能被解释成停止授权。

自动恢复也默认关闭，可使用现有恢复设置入口或面板显式开启：

```js
const recovery = agent.getRecoverySettings();
agent.configureRecovery({
  autoResume: true,
  maxAttempts: 3,
  initialDelayMs: 15_000,
}, { expectedRevision: recovery.revision });
```

只有显式 run/serve 才推进恢复。导入 SDK、init、查询、保存协调消息均不启动模型或常驻服务。重试采用同会话与工作区，恢复说明要求核查既有改动和交付；次数/截止时间跨重开保留，不无限循环。details/trace 与面板显示等待、检查原因和尝试记录。

## 真实验收与证据边界

- **一个本地 Codex 工单：**先提问，一次真实协调查询正确报告等待人；重开宿主并回复后恢复同一原生会话，写入精确文件内容，宿主验证通过。两次 Worker、一次协调者调用，见 [本地记录](w6-local-acceptance.md)。
- **一个 DSH GitHub 工单：**[Issue #29](https://github.com/imjszhang/js-superagent-acceptance/issues/29) 接单、修改、宿主验证及 [草稿 PR #30](https://github.com/imjszhang/js-superagent-acceptance/pull/30) 交付；一条 PR 反馈触发同工单、同会话续作，更新同一个 PR，重复同步未重复执行。两者已关闭，未合并，见 [GitHub 记录](w6-github-acceptance.md)。
- **DSH 实时输入：**真实 `0.2.1-rc.5` CLI 加本机模拟 provider，验证入队与消费的因果关系；不是外部真实模型验收。
- **故障与竞态：**使用协议 fixture、隔离数据库及虚拟时钟；没有制造真实服务故障或长期轮询。未跑完整历史套件、模型/平台矩阵、默认分支故障或完整浏览器验收。

真实运行期间其他阶段仍有源码修改；原始记录保存启动及结束摘要。真实结果证明各进程加载的版本，后续修正由受影响定向检查覆盖，不能称最终 tarball 的全部路径均真实模型实测。干净目录安装检查验证当前包的导入、CLI/SDK、自定义 Registry 和包内容；不重复调用模型。

本机原始记录在 `working/agent-runs/js-superagent-workflow-local-20261102-w6-actual/`、`working/agent-runs/js-superagent-workflow-github-20261102-w6-actual/`。日志、临时项目和凭据不进入分发包。安装包及最终摘要放在 `working/agent-runs/js-superagent-workflow-delivery-20261102/`，未发布 npm。

## 仍保留的差距

| 范围 | 真实状态 |
| --- | --- |
| 未知原生中断 | 内置 Codex/DSH 尚无足够可靠的只读历史核对，保持 `native-history-unavailable` 人工检查；自定义适配器的 `inspectRecovery()` 合同已受控验证，不代表内置原生中断自动恢复已完成 |
| DSH 跨进程未确认反馈 | 回执与业务消息保留；不能证明原生是否已消费时要求检查/替换，不自动重发，也不把取消当已读 |
| 瞬时自动恢复范围 | DSH 仅在明确瞬时错误、无工具/任务或未知输入、进程已收尾时提供证据；Codex 没有凭 HTTP 文本新增自动重跑 |
| 未重测的组合 | DSH 真实协调分类、完整子成果采纳/预览、其他 provider/登录方式及平台组合，不用既有 Codex 证据替代 |
| 产品范围 | 未引入通用 provider/技能/联网平台、上游原生 UI 接管或自动合并；这些不属于本计划的工作流程补齐目标 |

历史 exec/headless 配置仅保留解释和明确迁移入口；旧会话不能证明可恢复时需显式替换。当前生产服务仍是原安装，未启用本轮源码，查询不会自动切换。
