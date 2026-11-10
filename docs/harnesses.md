# 独立 Harness 接入

js-superagent 自己维护执行端注册、配置、会话和进程归属。没有 js-agent-runtime 包依赖、类型依赖或运行桥接；目标项目不需要安装它。CLI/SDK 的工单操作保留；执行扩展统一通过实例级注册表，不再直接注入旧 Driver 或协调者。

## 内置入口

| 用户选择 | 配置 ID | 连接与会话 |
| --- | --- | --- |
| Codex | `codex-app-server` | app-server；支持原生恢复、运行中反馈与读取确认 |
| DSH | `dsh-sdk` | SDK 协议；精确原生恢复、运行中反馈与原生消费证据 |
| Cursor | `cursor-agent` | 每轮一次 print 模式；按工作区续接原会话，运行中的消息排到下一轮 |

2026-11-05：新的 Codex thread 使用项目状态目录下的 `harness/codex-app-server/homes/<id>` 作为 `CODEX_HOME`，不写入用户 Codex 的会话列表。登录和设置只符号链接到账号目录里的 `auth.json` 与 `config.toml`，不复制内容。还没有项目绑定的旧 thread 仍从原来的账号目录恢复。

Worker、子任务与协调者都由这三个适配器创建；角色权限不同，连接管理复用。`codex`（exec）与 `dsh-headless` 已退出执行路径，不作为隐藏降级方案。Cursor 的配置、隔离和限制见 [Cursor 接入](cursor-agent.md)。

DSH 精确支持 `@deepseek-ai/dsh@0.2.1-rc.5` 与 `0.2.2-alpha.2`，不使用其他版本尚未核对的接口。DSH 全局程序升级不会升级本包，也不会启动后台。旧会话保留原生版本绑定，跨版本执行需原版本 executable 或核对后显式替换会话。新版边界和 W18 结论见 [alpha.2 适配记录](dsh-alpha2-compatibility.md)。

## 配置 DSH

CLI 和原生 DSH 由用户分别安装。以下 JSON 作为 `executor set` 的输入；它不含密钥内容。先使用可用的模型与认证变量：

```json
{
  "driver": "dsh-sdk",
  "executable": "/absolute/path/to/dsh",
  "model": "deepseek-flash",
  "backend": {
    "auth": "api-key",
    "provider": "deepseek-official",
    "protocol": "anthropic-messages",
    "baseURL": "https://api.deepseek.com/anthropic",
    "apiKeyEnv": "DEEPSEEK_API_KEY"
  },
  "permission": "workspace-write",
  "timeoutMs": 180000
}
```

```sh
js-superagent harness list
js-superagent harness doctor /absolute/path/to/dsh-settings.json
js-superagent harness doctor /absolute/path/to/dsh-settings.json --check-executable
js-superagent --project /path/to/project executor status
# 使用 status 返回的当前 revision，首次配置为 0
js-superagent --project /path/to/project executor set /absolute/path/to/dsh-settings.json 0
```

`doctor` 默认只验证配置；显式 `--check-executable` 检查原生版本，不调用模型。模型和 API 可用性仍需一次真实执行确认。凭据由启动进程明确提供，包不自动读取项目 `.env`。已有 `.env` 的用户可以自行用 Node 的 `--env-file` 启动本包 CLI，但不能将密钥内容写入配置或聊天。

现有 `submit/run/reply/retry/cancel` 和 SDK `createProjectAgent()` 不变。新执行设置不会自动更换旧工单的原生会话。需要切换已有任务时使用显式 session replace；跨 Codex/DSH 不冒称原生续作。

DSH 的标准提问通过业务报告持久保存到工单；回复后恢复原会话。没有持久化原生 RPC 问题句柄。运行中消息先保存，再通过同会话原生接口入队；只有匹配的消费事件才能标记已读。跨进程未确认输入保留人工检查边界，详见 [DSH 执行中反馈](w3-dsh-input.md)。

### 可选工具和协调者

SDK Worker 可设置 `enableAgentTools:true`，启用受限上下文读取、确认、退回、订阅和报告工具。`enableManagedJobs:true` 还要求通过现有 `configureJobs()` 配好可信任务目录；模型只能选择这些命令/子任务配置，不能传入任意宿主命令。预览和子成果继续归现有宿主任务管理器所有。两个开关默认关闭，协调者拒绝开启。

工单提交参数 `managedJobs:false` 会进一步把该工单的有效 `enableManagedJobs` 收为 false（从 `0.14.0-alpha.1` 起），不改变项目配置。原生执行与恢复使用同一份冻结配置；已有会话的权限绑定仍须核验，不能通过重试静默更换。

包内 `dsh-tool-plugin.mjs` 是薄协议桥接插件，不是上游 dsh-superagent 插件。它在本轮受控 profile 中注册工具，经 loopback 的短期凭据调用宿主；没有自己的工单、数据库或收件循环。每次调用核对会话、运行代次、工具名和授权，重复调用复用同轮结果，结束后关闭入口。密钥及桥接凭据不写入插件配置。

协调者通过 `configureCoordinator({assessor:{driver:'dsh-sdk',...},policy:...})` 配置，使用独立会话命名空间和只读角色，移除原生文件/命令工具。需要更多上下文时输出受限 read 请求，由宿主提供指定记录，再恢复同一协调会话。它不能自行启动 Worker 或扩大授权。`workflowMode:'continuous'` 可显式开启工作事件与项目消息处理；默认仍仅研判候选。具体操作见 [本轮交付与用法](workflow-alignment-delivery.md)。

## SDK 扩展

`createHarnessRegistry()` 创建独立注册表。受信任的宿主代码通过 `register()` 注册适配器，并把 `harnessRegistry` 传给 `createProjectAgent()`。不从配置 JSON 自动加载 JS 模块，也没有全局可变注册表。

适配器声明 `id`、`version`、`roles`、配置验证和 `createDriver()`；协调者使用独立 `createAssessor()`。工厂和验证必须同步且无执行副作用，真正工作只在 Driver.run/Assessor.assess 内开始。Driver 必须声明 `reportVersion: 2`，使用统一的结构化报告；自定义适配器不会绕过会话、授权或进程归属检查。外部适配器不能覆盖内置 ID。版本和能力检查在运行前生效。

```js
import { createHarnessRegistry, createProjectAgent } from 'js-superagent';

const harnessRegistry = createHarnessRegistry({ adapters: [myTrustedAdapter] });
const system = createProjectAgent({ projectRoot, harnessRegistry }).init();
try {
  console.log(system.listHarnesses());
  system.configureExecutor({ driver: myTrustedAdapter.id }, { expectedRevision: 0 });
  // 提交任务和执行仍使用现有 SDK。
} finally {
  await system.stop();
  system.close();
}
```

`requiredCapabilities` 表达任务必须拥有的功能。不支持时在启动前拒绝，禁止自动切到其他身份、模型、权限或执行端。静态目录是支持上限；实际能力还取决于目标配置和原生程序版本。未安装 DSH 的用户仍可导入 SDK 并使用 Codex。

## 新 Harness 的文件范围（2026-11-06）

新增一种内置执行端时，增加三样文件：`src/harness/adapters/<id>.mjs` 适配器描述、`src/drivers/` 里的驱动，以及合同测试。把它加入 `src/harness/builtin.mjs` 的 `BUILTIN_ADAPTERS`。工单、授权、工作区、GitHub、调度、注册表、管理面板和观察器保持不动。Codex app-server 与 DSH SDK 的协议、版本钉死和 profile 留在各自驱动里。配置 JSON 不能加载 JS 模块；外部适配器通过 `createHarnessRegistry({ adapters })` 注册，且不能覆盖内置 ID。未配置时的默认执行端仍是 Codex。`config set` 简写和 CLI `--driver codex-app-server` 继续是 Codex 快捷方式；子任务缺省 driver 使用 `DEFAULT_DRIVER`。完整执行配置走 `executor set`，由注册表校验。

协调者的研判、工作事件和接续判断共用 `createTurnAssessor({ config, runTurn, assessmentPrompt })`。新执行端只提供一轮模型调用 `runTurn`，以及研判提示词里仍须保持的措辞。运行状态的通用发送在 `src/runtime/execution-observation.mjs`；各执行端的事件解析放在自己的 `src/drivers/*-observation.mjs`。

会话不能跨执行端续作。切换已有任务仍走显式 session replace，不把旧会话认作新适配器的会话。

运行时按能力位和钩子询问注册表，不按内置 ID 分支。这些钩子必须同步、无副作用，直到 `Driver.run` 或 `Assessor.assess`：

| 钩子 | 合同 |
| --- | --- |
| `supervised` | Codex 与 DSH 均为 true。`describeExecution()` 返回该标志；`registry.supervised(id)` 只做查找，不构造 Driver。运行前重试和未确认输入的核对只对声明了监督进程的执行端生效。 |
| `serviceLaunch(execution, processEnv)` | 返回 `{ executable, environment, credentialEnvNames }`。环境值只放路径等非密钥项。`credentialEnvNames` 只列变量名，不读取密钥值。Codex 在存在 `CODEX_HOME` 时带上它；DSH 返回 `backend.apiKeyEnv`。安装服务前仍先 `validateExecution`。 |
| `loginProbe(execution, context)` | 可选。Codex 用调用方注入的 `execFileSync` 执行 `login status`。DSH 不提供，因此安装检查不会出现这项。 |
| `coordinatorExecution(execution)` | 去掉 `enableAgentTools`、`enableManagedJobs`、`requiredCapabilities` 和 `permission`。DSH 再把协调器权限收成 `read-only`。结果不能改 `driver`。没有该方法时原样返回。 |
| `validateLease(record)` | 按 `record.session.driver ?? record.driver` 分发给对应适配器。宿主在持有租约和原生预览控制时调用它。DSH 的实现仍只接受 `dsh-sdk` 与 `0.2.2-alpha.2`。进程关闭、job id 预算和证据收据留在运行时。 |
| `nativeBackgroundOwnership` | Driver 实例上的能力位。DSH 可写 Worker 为 true；协调器、只读 DSH、子任务角色和 Codex 为 false。为 true 时，宿主装载租约、拒绝中断租约、过滤已消费结果并传入预览 profile。alpha.2 能否真正交接仍由 DSH 驱动的 `canHandoff` 判断。 |
| `label` / `settingsFields` / `preserveOnSave` | `list()` 返回显示名、管理接口额外接受的配置字段，以及同一执行端再次保存时保留的字段。面板用 `label`，不再按 ID 写显示名。未声明的字段会被管理接口拒绝。 |

内置 ID 可以继续出现在 `src/drivers/`、`src/harness/adapters/`、`src/harness/builtin.mjs`、`src/harness/migration.mjs`、`src/config.mjs` 和 `bin/js-superagent.mjs`。`src/coordinator.mjs` 只再导出适配器里的协调者工厂。注册表、工单主循环、服务安装、安装检查、管理接口、面板、子任务缺省、恢复、通用观察器和宿主工具恢复不再写这两个名字。W18 的 `native-pending-wakeup-unsupported` 仍由 DSH 的 `inspectRecovery` 返回，运行时只消费恢复结果。拆分记录见 [Harness 解耦](harness-decoupling.md)。

## 状态与升级

保存新 Harness 配置会在停止工作后以一致性备份迁移至 schema5。旧 0.3 包拒绝打开该状态库。既有 Codex 设置不因导入本包自动迁移至 schema5。修订冲突及非法配置不应触发迁移。

历史 `DriverSession` 的 `{driver,id}` 不改写；适配器版本、工作区与执行配置指纹保存于独立绑定记录。临时日志和持久原生会话目录分别管理，正常关闭不删除会话。恢复前核对身份/工作区/配置。

### 旧配置与记录

先用 `executor status` 查看 `migration` 提示。已有 app-server/SDK 配置继续沿用；旧 exec/headless 配置可读取和查看工单，但不能执行。使用 `executor set <json> <revision>` 或 SDK `configureExecutor()` 明确保存新适配器配置，应用前进行校验、修订检查及必要备份。协调者和子任务设置分别通过现有配置入口更新。

工单历史、交付收据和原生会话 ID 保留。切换连接方式不会自动把旧会话认作新适配器会话；未完成工单根据提示显式 `session replace`，检查工作区后再继续。若没有证明旧会话可恢复，不声称原生续作。生产后台及状态库不会由导入 SDK 或查询命令自动切换。

旧自定义 Driver 应改为 `HarnessAdapter.createDriver()` 返回现代协议实现；最小无模型示例见 [local-demo.mjs](../examples/local-demo.mjs)。仅保留旧数据解释和迁移，不维护第二套旧执行引擎。

Driver 必须在输入发给原生进程前登记监督者与执行进程，取消后等待其退出；取消一个 DSH Worker 不应影响另一个 Worker。目录副本、worktree 和独立 DSH home 不是 OS 容器安全边界。

## 验证范围

本轮只运行接入层及受影响配置/会话/管理/类型的针对性回归。`examples/real-dsh-local-smoke.mjs` 是显式真实 provider 检查：SDK 提问→关闭并重开宿主→同会话回复→修改与宿主内容断言。它不启动或更新已安装服务，也不执行远端 GitHub 操作。

`examples/real-dsh-tools-smoke.mjs` 的历史真实模型记录核对业务上下文读取和受管命令回调。取消、异常协议、工具去重与授权使用针对性受控回归；不把模拟 provider 或进程 fixture 写成真实模型验收。本轮 W6 已通过 [DSH GitHub 闭环](w6-github-acceptance.md) 和 [Codex 本地连续工作](w6-local-acceptance.md)；DSH 子任务采纳/预览组合和真实协调者分类没有重新执行。

当前限定 DSH `0.2.1-rc.5` / `0.2.2-alpha.2`、显式 `deepseek-official / anthropic-messages` API backend；其他原生版本、登录账号模式和 provider 组合会明确拒绝，不会静默换用身份。当前实测环境为 macOS + Node.js 24.22.1。包本身的 Node.js 22.13 下限保留，但本轮没有据此声明 DSH 在所有平台和 Node 版本均已通过。

上述早期接入验收时后台保持停止，不能据此推断当前部署。2026-11-03 已按用户授权切换主项目后台到 DSH，并完成[项目指令范围修复与主仓库真实验收](dsh-project-rules-acceptance.md)。当前范围见 [W0 与工作流程计划](workflow-alignment-plan.md)，最终证据及限制见 [实施状态](implementation-status.md)。

## 原生预览留存（0.8）

DSH alpha.2 可写 Worker 可从可信 Assignment 命令 profile 启动原生预览；进程与 loopback 端口经宿主核验、其余任务结算及当前内容验证通过后，可在 ready 后独立留存和续期。不会收编任意已有 shell job，也不会自动采用原生 pending 输入。rc.5 不暴露此能力，Codex 保留受管预览；宿主审阅工具和 bot 预算由同一运行时执行。详见 [配置、租约与验证边界](workflow-review-acceptance.md#dsh-预览边界)。
