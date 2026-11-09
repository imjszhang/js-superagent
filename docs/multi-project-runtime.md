# 多项目独立运行：0.9 操作与交付说明

工作区版本：`0.9.0-alpha.0`，项目数据库 schema 10，本机登记协议 1。M0–M6 已完成实现与有限定向验证，范围见本文末尾。本文描述代码行为，不代表已安装版本、生产状态或自动启动已经升级。主仓库后台保持停止，W18 继续暂缓。

后续版本：`0.11.0-alpha.0` 的当前升级目标为 schema 12；本机登记协议不变。`0.10` 新增协调器答案的持久发送语义，见[答疑与代码补读](coordinator-answers-and-code-context.md)；`0.11` 增加跨讨论关联与单条处置，见[本轮记录](candidate-routing-and-batched-answers.md)。本文的 `0.9` 验证记录保留为阶段快照。

## 定位和隔离范围

js-superagent 是项目级的持久 Agent 运行时。每个项目保存自己的配置、工单、数据库、执行会话、工作区、日志和服务定义。CLI/SDK、Codex app-server、DSH SDK、GitHub App、专用账号、轮询与 Webhook 继续保留，不依赖 js-agent-runtime。

同一操作系统用户下，各项目共用一个轻量的本机登记库，用来登记身份、GitHub 仓库归属、端口、执行租约和可选的模型执行槽位。没有新增中央后台进程，也没有把工单或秘密集中存储。位置为：

- macOS：`~/Library/Application Support/js-superagent/coordination.sqlite`。
- Linux：`$XDG_STATE_HOME/js-superagent/coordination.sqlite`，未设置时使用 `~/.local/state/js-superagent/coordination.sqlite`。

该目录仅当前用户可访问。正常命令不提供修改登记位置的开关；导入包、查看 `machine status` 和 `projects list` 不创建登记库。项目内 `instance.json`、状态数据库和本机登记相互核对；把一个项目的状态目录复制给另一个路径后，不能直接以旧身份运行。

**保证范围是同一机器、同一操作系统用户、采用新协议的实例。** 不同机器、不同系统用户和仍在运行的旧版本不受这份登记约束。同一个远端仓库应只部署一个自动执行者；本轮没有分布式租约、同仓库多项目分区接单或跨机器高可用。

## 已接入的变化

| 阶段 | 当前行为 |
| --- | --- |
| M0 | 使用本地实例/状态身份与公共运行租约；CLI、SDK、后台和宿主副作用入口共用保护；普通查看与纯本地提交仍可用 |
| M1 | GitHub 仓库持久归属一个项目，按规范化仓库名和核验后的 repository ID 防冲突；停止服务不自动释放归属 |
| M2 | Webhook 安装可一次选择稳定端口；占用冲突可诊断；启动就绪、阻塞和有限重试分别展示 |
| M3 | 专用账号按配置仓库读取通知，持久保存扫描窗口/续页和重试，避免其他仓库的通知占满本项目扫描页数 |
| M4 | 提供复制后重新初始化、搬迁接管、过程继续与受限回退；未知原生会话保留历史并要求检查 |
| M5 | 可显式设置当前用户的模型执行总上限，各项目继续使用自己的调度策略 |
| M6 | 新 CLI/SDK 类型、旧库升级门槛、只读诊断和操作说明接通；运行验证限于本轮相关范围 |

已有 `projectId`、工单 ID 和远端回传收据不因普通升级重建。执行租约核对随机所有权 token、代次、进程身份和受管子进程，不能仅凭心跳超时抢占。请求已经送到模型或 GitHub 后，本机租约不能撤销它，仍沿用既有收据与未知结果核对。

父目录与子目录也属于重叠执行范围。例如 `/repo` 和 `/repo/packages/foo` 可以各自初始化、查看和入队，但不能同时取得执行或维护权。存活或无法核验的租约/受管执行会阻止另一个项目进入，返回 `PROJECT_ROOT_OVERLAP`；原项目停止并确认受管进程退出后才可继续。为避免工作区准备、交付和 Git 操作同时影响源目录，这条规则也适用于使用 copy/worktree 的父子项目。互不包含的兄弟目录不因此互斥。搬迁期间同时保护源与目标目录。

这是宿主执行协调，不是文件系统沙箱：手工命令、执行端越出项目路径的操作、目录内指向外部的链接和不同 worktree 共用的 Git 元数据不因这条规则自动隔离。

## 旧项目升级与新项目初始化

先停止该项目的服务、前台运行时和活跃子任务；不是只关闭终端窗口。随后用新版 CLI 执行：

```sh
js-superagent --project /path/to/project project inspect
js-superagent --project /path/to/project upgrade
js-superagent --project /path/to/project doctor
```

`upgrade` 核对旧写者、备份并升级到当前 schema 12，建立本地实例与本机登记。旧项目没有实例标记时，直接 `run`、`serve` 或启用相关副作用会被拒绝，要求先显式升级；不会偷偷收养旧状态。只读查询不代替升级，也不自动恢复执行。数据库已在别的目录使用、进程归属不明或旧副本状态冲突时，先处理相应阻塞。

新目录继续使用原入口：

```sh
js-superagent --project /path/to/new-project init --workspace auto
js-superagent --project /path/to/new-project submit "检查指定模块并报告结果"
js-superagent --project /path/to/new-project status
```

初始化和提交都不启动后台。配置 Codex 或 DSH 的方式见 [Harness 接入](harnesses.md)。普通 `run/serve/github listen` 不传执行端参数时，沿用持久设置；不会默认把 DSH 改成 Codex。

本轮没有升级主仓库的生产数据库或安装包。实际部署仍须单独执行；schema 10 写入后不能让旧写者继续运行，回退前需停止新版并检查其远端动作，不能只恢复数据库就声称撤销了 GitHub 写入。

## 查看项目、仓库归属和容量

```sh
js-superagent projects list
js-superagent machine status
js-superagent --project /path/to/project doctor
js-superagent --project /path/to/project github binding status
```

`projects list` 显示已登记项目、仓库和端口；`machine status` 显示限制、租约和槽位；项目 `health` 还包含本项目等待原因和协调状态。doctor 只读检查本地身份、已知仓库归属和 `directoryOverlap`，不发起模型或网络核验。重叠项目仍有活跃/未知执行时诊断退出码为 1；仅有停止的重叠登记会展示出来，不阻塞。`sharedResources` 说明共用程序、模型账号额度、命令端口和 App Webhook 的边界；这类说明不表示已经逐一探测外部资源。

同一仓库即使用不同 App、用户账号、slash 命令或 Issue 白名单，也不能当成完全独立的两个自动接单者。一次启动会在宿主执行/回传前核对归属；一个项目内的轮询和 Webhook 仍共用原有事件去重。

仓库身份缓存最多有效 60 秒；长驻调度和渠道读取到期后重新核验，不再整个进程期间永久信任首次结果。宿主的 Issue 回传、PR 审阅写入，以及分支推送和 PR 创建/更新会在写边界强制重新读取仓库 ID。网络错误、身份不明或同名仓库 ID 已改变时，暂停该次写入，不使用过期结果放行。`machineStatus().githubIdentity` 展示核验状态与时间；旧自定义渠道没有身份探测能力时仍可兼容使用，但显示 `verified:false`，不能宣称获得稳定 ID 保护。这些检查不能原子锁定 GitHub 的远端仓库生命周期，也不拦截模型自行执行的任意网络命令。

需要将仓库交给其他项目时，先停止原项目、结算活跃工单和待发送/未知结果，然后查看并执行释放：

```sh
js-superagent --project /path/to/original github binding release --plan
js-superagent --project /path/to/original github binding release --apply
```

也可用 `--repository owner/repo` 明确指定原仓库。存在未结工作时拒绝释放。释放只改变本机归属，不删除远端讨论，不迁移工单，也不自动启动新项目。若要保留接续历史，使用下述搬迁流程。

## 后台与 Webhook

轮询仍是默认方式，没有监听端口，不需要域名或隧道。安装与启动继续分离：

```sh
js-superagent --project /path/to/project service install --mode poll
js-superagent --project /path/to/project service status
```

安装保持禁用；这里只准备服务，没有执行 `service start`。旧版无条件 KeepAlive 服务可由新版查看、停止和卸载；同一安装代码目录内更新重启策略时，先停止，再执行 `service install`。服务若固定在另一个旧安装包中，仅更新源码不会替换它实际使用的包装器和 CLI，应按 [后台服务说明](background-service.md) 卸载旧服务并从新包重装；不能删除正在使用的安装包。

已经配置 Webhook `secretPath` 的项目，可以一次选择并保存端口；后台仅有 `secretEnv` 不够。若已有轮询服务，切换模式前先停止并卸载原服务，再安装 Webhook 服务：

```sh
js-superagent --project /path/to/project service install --mode webhook --port auto
js-superagent --project /path/to/project service status
```

`webhookEndpoint` 是安装后固定的实际地址；重启和重复安装沿用它。`--port <数字>` 明确选择端口，`github listen --webhook-port <数字>` 只覆盖本次前台监听，均不偷偷改共享项目配置。旧端口被占用不会自动换成另一个地址，需要重新选择并同步外部 HTTPS 转发。预检之后仍可能发生抢占，实际 socket 绑定是最终判定。

`ready` 表示当前 CLI 完成启动收据；`startupState` 区分启动中、就绪、重试、阻塞和停止。端口、身份或凭据等永久问题保存到 `blocked`，不继续快速重启；短暂/未知退出有限重试并退避。修复后显式 `service start/restart` 重新核验。故障时仍可查看和停止。

共用一个 App 不会自动把事件分发到各项目的 Webhook。多项目默认使用轮询；必须使用 Webhook 时，采用已有的仓库路由入口或独立 App。本轮没有新增共享入站网关，也不改远端 App 设置。

## 复制为新项目与搬迁原项目

这两个操作的结果不同，不能用普通 `init` 混过去。

**复制代码后建立新项目：** 在复制后的目录中先查看计划，再明确应用。

```sh
js-superagent --project /path/to/copy project reinitialize --as-new --plan
js-superagent --project /path/to/copy project reinitialize --as-new --apply
```

项目状态不在项目目录里，复制目录本身不会带走状态；新目录直接 `init` 即是新项目。只有把另一项目的状态目录也复制过来时，才需要这条命令。该操作归档旧本地状态，建立新的 project/instance/state 身份，保留允许的非秘密执行端和工作区设置；不继承工单、会话或 GitHub 自动接单，后台保持未安装。复制品不会卸载原项目的服务。归档可能含原有本地私有文件，应继续放在 Git 忽略范围并保留原权限，不把归档当成可公开模板。

**同一个项目换目录：** 先停用旧运行者，自行移动项目目录，再在目标执行：

```sh
js-superagent --project /new/location project relocate --from /old/location --plan
js-superagent --project /new/location project relocate --from /old/location --apply
```

状态目录按项目路径编码，移动项目后它仍留在旧编码下。`--apply` 先把它整体移到新编码下（`--plan` 的 `stateMove` 字段列出两端），再接管路径；移动之后若提示 `PROJECT_WORKTREE_REPAIR_REQUIRED`，用 `git -C /new/location worktree repair <新工作区路径…>` 修复后重跑同一命令。命令不负责搬运整个源码目录。若事先把状态目录也复制到了新编码下，则按原流程处理：目标必须保留原实例标记；新旧目录都存在时，身份和数据库逻辑指纹须一致，避免旧副本覆盖新状态。命令取得维护锁、暂停所有本地写入口、建立一致备份，再更新宿主已知路径及归属。

仍需续作的 Git worktree，其底层关系需要事先在新位置修复；已结束工单保留历史路径。计划只读核对工作区根、gitDir/commonDir 和归属，遇到 `PROJECT_WORKTREE_REPAIR_REQUIRED` 时先修复再重跑；不会全库替换路径或自动改写未知 `.git` 结构。外部共享目录不会被移走。

原生 Codex/DSH 会话保留历史。不能证明路径变化后可以恢复的工单会标记待检查，阻止自动继续，需通过 `session inspect <工单>` 核对，再以 `session replace <工单> <JSON文件>` 明确替换。JSON 包含 `reason` 和核对后的 `expectedSessionId`（原来没有会话时为 `null`）。协调者旧会话归档后重新建立；DSH pending 队列仍受 W18 限制。

成功搬迁后业务保持暂停；原有服务在新位置重新安装时保持禁用。替换会话不会解除业务暂停，还须明确执行 `resume`；`resume` 也不会绕过工单的待检查标记。新后台、模型任务和 GitHub 接单都不会自动启动。过程失败保留维护记录，修复原因后重复同一 `--apply` 继续；需要回退时先检查：

```sh
js-superagent --project /new/location project relocate --from /old/location --rollback --plan
js-superagent --project /new/location project relocate --from /old/location --rollback --apply
```

回退要求原路径编码下仍有原状态，而且目标在完成搬迁后没有新的状态写入；由本命令移动过状态时不支持回退，需要把项目移回原处后反向再搬迁一次。原目录已被删除或发生新工作时，先恢复/核对资料，不强行覆盖。原来有服务时会按原配置恢复服务定义，但保持禁用，不自动启动。

## 可选的模型执行总上限

每个项目的 `maxWorkers` 继续有效；默认不另设本机上限。显式设置后，采用新协议的项目共同参与：

```sh
js-superagent machine limits set --max-active-executions 2
js-superagent machine status
js-superagent machine limits clear
```

该上限约束 Worker、协调者和受管子 Agent 的模型执行回合，按项目轮转等待。排队不算模型失败，读取消息、本地提交、查看和取消仍可用。父子执行只有能够安全交接时才释放父槽位；无法安全交接会返回资源限制原因，不能通过隐藏并行调用绕过上限。

存活或无法核验的受管进程会保守计入容量。原父进程退出或心跳过期，不代表可以立即回收槽位；先核对所属子进程，不要删除登记库来解除等待。这个数字不是整机 CPU/内存、预览/普通后台命令数量或模型服务商额度的硬上限。

Codex 的用户登录/全局设置仍可能由多个项目共用；各项目工单和线程归属独立，但退出全局登录、改变全局设置或升级共用执行程序可能同时影响它们。DSH 继续使用隔离的会话目录，没有复制统一凭据来假装完全独立。

开发服务器、预览或普通托管命令的端口不在 Webhook 登记范围内。多项目使用时应为这些命令显式配置不同端口，或使用工具支持的动态端口并读取实际地址；不通过终止其他项目进程腾出端口。共用的执行程序和模型账号也意味着升级、凭据变更与服务商额度仍可能互相影响，本机模型回合上限不替代服务商限额。

## SDK 与有限验证

原 `createProjectAgent()` 和工单方法保留。新增的管理入口包括：

```js
import { createMachineCoordinator, inspectProject, reinitializeProject, relocateProject } from 'js-superagent';

const machine = createMachineCoordinator();
const status = machine.status();
const projects = machine.listProjects();
// 可传入 { projectRoot, projectId } 构建 coordinator，检查该项目的目录重叠。
const overlaps = machine.overlapStatus();
machine.close();

const facts = inspectProject('/path/to/project');
const clonePlan = await reinitializeProject({ projectRoot: '/path/to/copy', apply: false });
const movePlan = await relocateProject({ projectRoot: '/new/location', fromRoot: '/old/location', apply: false });
```

运行时提供 `machineStatus()`、`githubBindingStatus()`、`releaseGitHubBinding({ apply })` 和监听前的 `prepareExecution()`；后台服务 SDK 的 `port` 接受数字或 `'auto'`。普通 `start()` 入口保留，只有完成准备后才会执行任务。

2026-11-03 的定向验证使用临时项目/登记库、模拟 GitHub/模型传输、模拟 launchctl 和本地短进程。相关检查通过，覆盖范围如下：

| 验证组 | 已验证内容 |
| --- | --- |
| 本机协调（18 项） | 身份、租约、进程归属、仓库改名/重建、端口声明、登记库被替换后的拒绝执行，以及搬迁旧目录写保护 |
| 运行时（8 项）与执行槽位（4 项） | 同项目多入口互斥、本地入队、复制只读、维护锁、跨项目容量限制、父子交接与孤儿进程保守占位、旧库显式升级、搬迁后检查/替换会话再执行 |
| 项目维护（13 项） | 复制新建、搬迁、Git worktree 修复门槛、中断继续、受限回退、服务归属，以及已有写事务完成后的配置/数据库一致备份 |
| 专用账号与通知（27 项） | 仓库范围、持久续页、时间边界去重、条件请求、限流/退避和旧游标迁移 |
| CLI（5 项）及服务定向检查 | 只读命令、参数约束、仓库释放、持久 DSH 配置、启动收据、稳定端口/冲突、有限重试、旧安装包升级门槛与搬迁服务处理 |
| 静态检查 | 公开 SDK 类型、所有改动 JavaScript 文件语法、差异格式 |

这些检查按修改范围分组执行，没有重新运行包的完整测试套件。仓库要求的 `npm run store:bootstrap` 与 `npm run check` 通过；后者仍报告既有的 24 条资料追溯警告和 3 个缺失本地视频，不属于本包改动。主仓库服务状态已只读核对为 `startupState: stopped`、`loaded: false`、`running: false`，没有自动升级它的生产数据库或固定安装包。

后续冲突加固另做了小范围验证：父子目录互斥、兄弟目录并行、未知进程保守占用、搬迁中断恢复/回退仍保护源目录，以及 CLI/服务预检均通过。GitHub 身份专项 10 项通过，覆盖缓存到期、同名仓库替换、网络失败、授权回调期间变化、Issue/PR/推送写边界和旧自定义渠道；相关渠道、运行时接线及原生预览定向回归通过。类型、语法、差异格式与仓库检查通过。W34 原生预览测试改用隔离登记库；本轮测试临时登记已精确清理，未部署生产服务。

没有运行大规模套件、真实 GitHub 写入、付费模型任务或整机登录/重启测试。没有提交推送、发布 npm、自动切换账号或部署主后台。真实双项目长期运行仍需在允许启动后单独验收。
