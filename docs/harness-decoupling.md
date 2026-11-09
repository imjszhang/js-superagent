# Harness 解耦拆分

日期：2026-11-06 21:26 CST。包版本仍是 `0.14.0-alpha.0`，数据库 schema 不变。这次只调整 Codex 与 DSH 的接入位置，不新增执行端，也不改它们的协议、提示词、会话命名空间或默认执行端。

## 范围

- 内置执行端各有一份适配器描述：`src/harness/adapters/codex-app-server.mjs`、`src/harness/adapters/dsh-sdk.mjs`。`src/harness/builtin.mjs` 列出它们，并提供默认 driver 和已退出 driver 的迁移目标。注册表只遍历这份列表。
- 协调者的研判、工作事件和接续判断进入 `createTurnAssessor`。Codex 与 DSH 只保留自己的一轮调用和研判提示词。`src/coordinator.mjs` 继续导出原来的工厂和校验函数。
- 运行状态观察器只负责发送和合并通用状态。Codex 与 DSH 的事件解析分别在 `src/drivers/codex-observation.mjs` 和 `src/drivers/dsh-observation.mjs`。
- 管理接口按适配器声明的 `settingsFields` 接受配置，按 `preserveOnSave` 在同一执行端再次保存时保留字段。面板使用 `label`。
- Codex 隔离握手移到 `src/drivers/codex-isolation.mjs`。DSH 宿主调用标识移到 `src/drivers/dsh-history.mjs`。

## 未改动的行为

- 默认执行端、子任务缺省和 CLI 的 Codex 快捷参数仍指向 Codex。
- 旧 `codex` 与 `dsh-headless` 配置仍只读，并提示迁移到现有两个执行端。
- 两家协调者提示词文本保持原样。会话目录名 `codex-app-server-assessor` 和 `dsh-sdk-assessor` 不变。
- 公开导出保持：`createHarnessRegistry`、`createCodexAssessor`、`createDshAssessor`、`createCodexAppServerDriver`、`createDshSdkDriver`、`validateDshOptions`。
- 没有调用真实模型，没有安装或启动后台服务，没有发布 npm。

## 验证

2026-11-06 21:29 CST：拆分前和拆分后，包内 `npm run check` 都通过。仓库根目录 `deliverable:check` 通过。`media:check` 因既有视频素材未纳入 git 而失败，这些文件不在本次改动里。从 `skills:check` 到 `traceability:final:dry`，以及 `store:bootstrap`，都通过。没有调用真实模型，也没有启动后台服务。
