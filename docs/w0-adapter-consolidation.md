# W0 交付记录

日期：2026-11-02。状态：源码已实现，未提交/推送/发布，未部署生产。本文件保留 W0 阶段的交付快照；随后 W1–W6 的实现与验收见 [完整交付记录](workflow-alignment-delivery.md)。

## 实现结果

- 两个正式执行端：Codex（`codex-app-server`）、DSH（`dsh-sdk`）。Worker、Child 与 Coordinator 通过实例级 Registry 创建；自定义 Harness 使用同一扩展合同。无 js-agent-runtime 依赖。
- Codex 协调者复用 app-server 连接、进程归属与会话恢复，使用独立 `codex-app-server-assessor` 命名空间、只读角色及工具限制；DSH 保留 SDK 与独立协调命名空间。
- 删除独立 Codex exec、DSH headless 执行实现和旧工厂导出；删除运行时直接 Driver/Assessor 注入以及 v1 执行报告转换。`AgentDriverV2` 只是现代合同的类型别名，未保留另一套引擎。
- 保留 `submit/runNext/reply/retry/cancel` 等 SDK 工单操作、对应 CLI 入口、公共工单状态与历史报告投影。`codex-supervisor.mjs` 仍被宿主验证使用，因此保留共享进程监督代码。
- 清理旧选项、示例与专属测试；业务测试使用测试目录内的注册适配器夹具，生产包不包含旧输入兼容层。当前面板只展示两种正式 Agent，另有可信 SDK 扩展入口。

## 数据与安装迁移

`executor status` / `executorStatus()` 只提供迁移提示。已有 app-server/SDK 标识保持不变；旧 exec/headless 配置可以读，执行会明确要求迁移。通过 `configureExecutor()` / `executor set` 应用前检查配置、修订及停止条件；旧设置迁移按需创建 SQLite 一致性备份，原设置进入修订记录，原工单会话与配置保持固定。

没有原生会话 ID 的旧 headless 工单同样可通过显式替换迁移。旧未完成工单通过现有 `session replace` 明确选择采用新设置，替换前的会话与配置进入历史；不会把新会话写成原生恢复。已完成工单仅保留读取，不要求替换。旧协调者、子任务设置分别显式更新。生产状态库没有迁移。

后台安装定义升级为通用执行端标识；旧安装仍可查询/停止/卸载，启用新代码需明确重新安装。DSH 只保存凭据环境变量名，不将值写入安装文件；此运行组合未进行真实服务验收。

## 本轮有限验证

- Registry 10 项、W0 集成 5 项、DSH SDK 协议 5 项；覆盖角色创建、旧入口拒绝、绑定、提问/回复、重开恢复、取消与迁移。
- Codex app-server/协调者相关检查，包含同一协调会话恢复、只读设置及越权工具事件拒绝；服务定义使用假 launchctl/假程序检查，未操作真实服务。
- 公共报告状态投影、既有会话/协调业务夹具及 CLI/工作区的受影响路径定向检查。未运行完整历史测试集。
- TypeScript 类型检查、18 项上游文件摘要核对通过；领域内核无修改。
- 一次干净目录安装验证包的 CLI/SDK、可信自定义适配器及历史读取，检查无 js-agent-runtime 依赖、无旧 exec 文件，并保留共享监督模块。没有模型调用。

上述 W0 原生协议测试使用模拟程序或受控事件，不冒称真实模型验收。真实 Codex/DSH 业务组合随后在 W6 完成；DSH 实时输入和分级恢复随后在 W3/W4 实现，具体限制见完整交付记录。

本机后台只读状态：`loaded=false`、`running=false`、`pid=null`、`childPid=null`。未启动、重装或切换服务，未发送 GitHub 消息。
