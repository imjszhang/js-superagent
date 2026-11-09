# 领域内核提取记录

## 来源与范围

- 上游：[deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)。
- 固定提交：`6337fc823ce20251c8de8085948165c81aaa701e`。
- 提取日期：2026-11-01。
- 原样提取：上游 `src/core/*.ts` 全部 15 个文件，以及 `tests/core-engine.spec.ts`、`tests/stage.spec.ts`。
- 逐文件来源路径、目标路径和 SHA-256：[upstream-core.json](upstream-core.json)。
- 版权和许可：[第三方声明](../THIRD_PARTY_NOTICES.md)及[上游 MIT 原文](../THIRD_PARTY_LICENSES/dsh-superagent-prototype-LICENSE)。

初始提取保持领域源码与两个测试文件的上游内容不变；后续最小本地扩展及其来源清单维护见文末。构建产物由 TypeScript 编译生成，JavaScript 导入与类型声明以实际发布文件为准；不把编译结果当作逐字提取的源文件。

## 保留的领域能力

| 文件组 | 提取内容 |
|---|---|
| `model.ts`、`ports.ts` | Trigger、Thread、Decision、Mandate、Ticket、Assignment、输入和报告；仓库、政策、来源、研判、执行、Outbox 端口 |
| `engine.ts`、`part.ts` | 统一事务入口、按调用者角色收窄的接口、共享领域逻辑 |
| `intake.ts`、`evals.ts` | 事件去重、话题关联、订阅分发、候选评估与决策 |
| `tickets.ts`、`assignments.ts` | 工单与派工生命周期、后续输入、交回路由、投递和读取确认、恢复与停止 |
| `replies.ts` | 根据领域规则将消息交给 Outbox |
| `stage.ts` | 工单展示状态和可重试判断 |
| `memory.ts` | 测试和嵌入验证用的内存仓库 |
| `ids.ts`、`errors.ts`、`reasons.ts`、`index.ts` | 标识、错误和原因、公用导出 |

`core-engine.spec.ts` 覆盖接收、准入、评估、授权、订阅、后续消息、事务、派工、报告、停止与恢复等领域行为。`stage.spec.ts` 覆盖状态优先级和可重试条件。这些测试使用受控端口和内存状态，没有真实模型、DSH 宿主、GitHub 或飞书调用。

## 使用与验证入口

从包目录运行：

```bash
npm ci
npm run build
npm run check
node examples/core-demo.mjs
```

安装本地打包产物后，独立导入：

```js
import { Engine, MemoryRepositories, ticketStage } from 'js-superagent/core';
```

根 SDK 也暴露 `core` 命名空间；`createProjectAgent()` 保留原有调用方式。内核源码只导入同目录模块和 `node:crypto`，编译后的内核无需 TypeScript 运行器或 DSH。开发依赖用于构建与测试，不是模型执行底座。

`Engine` 并非单独导入即可工作的后台服务。创建实例需要提供仓库、政策、来源范围、研判、执行和 Outbox 端口。端口在领域事务中排队，实际外部工作应在提交后执行。内核示例只演示协议，不执行真实项目任务。

## 本阶段没有迁移的部分

- 上游具体 `policy.ts`：内核保留 `Policy` 接口及使用规则，但来源准入表、政策配置等具体实现仍待适配。
- SQLite 领域仓库、持久化 Effects 队列、生产 Outbox 和运行时调度。
- DSH 主协调会话、Worker 会话、工具注册、模型调用、后台任务及子 Agent。
- GitHub、飞书来源与消息渠道、工作区准备、管理 API 和界面。
- 旧 SQLite 工单向领域对象的迁移和 CLI/SDK 的内部切换。

因此，现有 CLI 的 `scope` 仍是原运行时保存的文本；它没有因为包内新增 Engine 自动获得来源身份验证、订阅或授权重新验证。两个入口的 `Ticket` 类型和状态含义不同，调用者不能直接互换对象。

## 验证记录（2026-11-01）

本机 Node.js 24.22.1；TypeScript 6.0.3；Vitest 4.1.12。Vitest 相对上游开发依赖做了补丁升级，提取的源码及测试未修改。

- 18 个来源文件（15 个核心文件、2 个测试文件、许可证）的 SHA-256 与固定上游一致。
- 静态依赖检查确认核心仅引用内部模块和 `node:crypto`；严格类型检查通过。
- 原样提取的 144 项领域测试通过；原有 13 项 CLI/SDK 回归测试通过。
- tarball 在临时消费者中离线安装，不安装开发依赖；独立核心、根 SDK、CLI 和普通 Python 目录中的工单流程通过。
- 已安装包的 JavaScript 演示和 TypeScript 消费端类型检查通过；第三方许可随包包含。

测试中使用协议替身，没有调用真实模型。`npm run check` 会重做来源检查、类型检查、构建、两组测试和隔离打包验证。尚未在 Node 22 或 Windows 上实测。

## 后续维护

内核变更应记录对应上游提交或本地理由，并同步检验来源清单。采用上游新版本时先比较领域行为及测试，再评估存储和适配器兼容性。保留原版权和许可，不把包整体的 `UNLICENSED` 元数据解释为取消上游文件的 MIT 许可。

## 2026-11-03：限定投递的本地扩展

`Engine.receive` / `Intake.receive` 增加可选的 `ticketIds` 与 `evaluateUnowned`：宿主在逐工单检查 GitHub 授权、暂停和故障持有后，可以限制本次输入的订阅投递集合，并禁止将被持有的反馈误当新候选。它们不能创建新的订阅；省略参数时保持上游原有行为。

`deliverSubscribed(triggerId, ticketIds)` 从仓库读取原输入，在宿主解除持有后补发给仍有授权的原订阅工单。它合并原有 disposition，不重复排队研判，不接受调用方替换正文或身份，不重投已接收、确认或交回的输入；工单专属的退休标记由宿主在调用前检查。

这项限定投递扩展涉及 `engine.ts`、`intake.ts`。提取清单保留原始 `sourceSha256` 和上游版本，另外记录当前 `targetSha256` 与 `localModification`；原上游测试不改写。`check:core` 继续逐文件核对精确哈希和依赖边界。

## 2026-11-03：合批候选的单条收尾

项目后台 Coordinator 可以在同一 Issue 的合批候选里逐条答疑。上游 `decide` 会收尾整个 Eval，不能直接用于这个场景；本地在 `engine.ts`、`evals.ts` 增加 `decideTrigger(triggerId, outcome)`，原 `decide` 的整批语义保持不变。

新命令只接受 `ignore`、`unavailable`，要求明确的当前 `evalId` 和未变化的策略版本。它记录目标输入自己的 Decision，释放旧 Eval，将其余输入与后续到达的 pending 输入按原顺序重新排队；新 Eval 重新检查各输入的原身份和策略，已处理的目标不会自动回到队列。目标 Decision 使用从原 Eval 和 triggerId 派生的 ID，`audit.triggerDecision` 保存来源 Eval、目标、该目标自己的 gate 结果和 worker owner，不能借整批最强权限收尾另一人的请求。

`ignore` 要求目标自身准入且没有仍决定该输入的 worker。`unavailable` 可记录某个目标失权、未准入或已归 worker 的失败，不改 worker 输入、授权或状态，也不把同批其余输入一起关闭；准入失败时 Decision 只记录 `inferred` 和失败证据，不生成授权。旧 Eval、重复收尾或策略版本变化均拒绝且不改状态。

命令使用同一同步仓库事务，允许宿主把答复入队和单条收尾包在同一事务里；任一步失败可完整回滚。新增 `tests/core-single-trigger.spec.ts` 覆盖不同人的合批权限、暂停恢复、未准入/worker 接管、旧 Eval/策略变化、重复收尾、后到输入、单条输入和嵌套事务回滚；保留原上游测试不修改。
