# 第五阶段：后台运行与重启恢复

后台持续接单不要求公网地址。默认使用系统后台服务运行现有 `serve`：定期读取 GitHub、处理授权工单、调用配置的 Codex 或 DSH，再通过 Outbox 回传结果。已有 App installation 也可以只用于轮询；只有启用 GitHub 主动投递的 Webhook 时，才需要可访问的 HTTPS 入口。

目前的服务管理器面向 **macOS 当前用户的 launchd 登录会话**。本地 CLI、SDK 和前台 `serve`／`github listen` 保留。导入包或初始化项目不会安装、启动服务，也不会创建公网地址。

**2026-11-01 已通过真实后台轮询与进程恢复验收。** 从本地安装包运行，在 [Issue #7](https://github.com/imjszhang/x-pkm-research/issues/7) 完成三轮真实 Codex 工作、App Bot 回传、停止期间反馈补收，以及空闲和执行中两种进程崩溃恢复。证据见[后台服务验收记录](phase5-background-acceptance.json)。本轮未配置固定 HTTPS，也未重启整台 Mac 或注销再登录。

## 与上游后台方式的关系

上游 `dsh-superagent-prototype` 的启动脚本在 `tmux` 会话中运行独立 DSH profile。GitHub Source 通过专用机器人账户的 `gh` 登录轮询通知和关联讨论，默认约一分钟；Runtime 内部每两秒推进已持久化的动作和到期评估。进程重启后恢复任务状态；另一个持续运行的 DSH profile 可按部署文档配置每小时健康检查，在异常退出后重新启动服务。`tmux` 自身不提供崩溃拉起或开机启动。[启动脚本](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/scripts/dsh-superagent)、[部署说明](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md)、[架构说明](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md)

`js-superagent` 采用同样的“常驻运行时＋轮询＋持久化状态”组织方式，去掉 DSH 宿主依赖。macOS 由 launchd 管理独立 Node 进程，负责登录启动和异常退出后的拉起；工单、会话、工作区、待执行动作及回传仍保存在该项目的状态目录 `~/.js-superagent/projects/<路径编码>/` 中。

## 安装与日常操作

以下命令用于已安装的本地 tarball；从源码运行时将 `js-superagent` 换成 `node bin/js-superagent.mjs`。包尚未发布 npm。后台服务会记录当前安装入口的绝对路径，因此应将包安装在长期保留的位置，避免临时 `npx` 缓存或测试目录被清理后服务无法启动。

先完成项目初始化、执行端登录及 GitHub 接单范围配置：

```bash
js-superagent --project /path/to/project init --workspace auto --driver codex-app-server \
  --codex-path /absolute/path/to/codex
js-superagent --project /path/to/project config set \
  --github-repo owner/repository --github-actor trusted-login --github-issue 123 \
  --github-poll-ms 30000
js-superagent --project /path/to/project doctor --driver codex-app-server

# 安装服务定义；默认 poll，不立即启动
js-superagent --project /path/to/project service install --mode poll

# 显式开始后台接单
js-superagent --project /path/to/project service start
js-superagent --project /path/to/project service status

# 停止／重新启动后台进程
js-superagent --project /path/to/project service stop
js-superagent --project /path/to/project service restart

# 移除后台服务；保留项目工单、工作区和配置
js-superagent --project /path/to/project service uninstall
```

已初始化的项目使用 `config set` 更新设置，无须再次初始化。新委托仍须由允许账号在配置范围内发送 `/js-superagent 任务说明`，后续允许的反馈继续进入原工单。后台服务不会扩大授权账号、Issue 或 CI 范围。

`install` 与 `start` 分开：安装只准备服务定义；启动后关闭当前终端不会停止接单。显式 `stop` 表示保持停用，不能被异常恢复机制立即拉起；再次 `start` 或 `restart` 才恢复工作。修改项目配置前应先停止服务。服务状态与业务状态分开检查：

```bash
js-superagent --project /path/to/project service status
js-superagent --project /path/to/project github status
js-superagent --project /path/to/project status
```

`service status` 用于确认进程是否运行；`github status` 显示最近同步、错误和回传；`status` 查看工单。进程存在不等于 GitHub 登录、模型调用或任务执行成功。

`service status` 返回项目服务标签、安装状态、模式、LaunchAgent 和 manifest 路径、是否已加载／运行、服务进程 `pid`、CLI 子进程 `childPid`、最近退出码及日志路径。服务标签由项目真实路径和项目 ID 派生，同一用户的多个项目分别管理。新增 `ready` 只在当前包装进程及 CLI 子进程完成监听/运行时启动并发回收据后为真；`startupState` 区分 `starting`、`ready`、`retrying`、`blocked` 和 `stopped`，不以 PID 存在代替业务就绪。

LaunchAgent 位于 `~/Library/LaunchAgents/<label>.plist`；项目状态目录下的 `service/` 保存 `manifest.json`、运行进程记录和日志。`stdout.log`、`stderr.log` 默认各限制为 5 MiB，各保留一份 `.log.1` 备份。卸载只移除服务定义与安装 manifest，日志及项目状态保留。管理器核对文件归属，不覆盖或删除其他程序创建的服务文件。

首次安装保持禁用，直到显式 `start`；启动后会在下次登录时运行，并由 launchd 在异常退出后拉起。`stop` 同时从当前会话卸载并禁用服务，下一次登录也保持停止。更换服务模式、安装路径或执行程序时，先停止并 `service uninstall`，再安装新配置；不要先删除正在使用的安装包目录。新版本 CLI 可以管理同项目的既有服务，改变 Codex／gh 执行路径后须重新安装，启动时会检查路径是否与安装记录一致。

### 多项目端口与启动失败

新安装使用按失败重启的策略。端口占用、身份/仓库归属冲突、配置或凭据错误会保存为 `blocked`，停止继续拉起；`status` 的 `blocked.code` 指明原因。包装进程在这种情况下以成功退出阻止 launchd 再次重启，因此退出码 `0` 不等于业务可用，应查看 `ready` 与 `blocked`。未知进程异常或明确的短暂网络错误最多连续重试 8 次，5 秒起指数退避、最长 5 分钟；稳定运行 5 分钟后重新计算连续失败次数。

修复后显式 `service start` 或 `service restart` 重新检查并清除阻塞。只改文件或删除错误记录不是重新启用步骤。旧安装仍能查看、停止和卸载；同一包装器/CLI 安装路径内，无条件 KeepAlive 的旧安装需先停止，再执行 `service install` 更新策略，操作保持禁用，不启动服务。如果旧服务固定在另一个安装包中，拒绝只改 plist 的原地升级，应停止、卸载并从目标新包重装，避免继续执行旧包装器。新策略安装更换 `--env-file` 不改 plist；允许的旧策略升级会同时更新 plist 的重启条件。

多个项目同时首次建立本机登记时，`MACHINE_REGISTRY_INITIALIZING` 走有界退避，等待创建者完成；不会删除创建证据或登记库。登记缺失、身份改变或协议不兼容仍按持久阻塞处理，需要检查原因。

轮询不占用监听端口，管理面板和内部工具继续使用动态端口。多个项目需要 Webhook 时，可在已配置 Webhook secret 的项目里执行：

```sh
js-superagent --project /path/to/project service install --mode webhook --port auto
js-superagent --project /path/to/project service status
```

SDK 对应 `createServiceManager({ projectRoot, mode: 'webhook', port: 'auto' })`；`port` 也接受明确的 `1..65535` 数字。自动选择会检查实际监听与当前用户的本机端口登记，将具体地址保存到安装 manifest 的 `webhookEndpoint`，重启及重复安装沿用它，不改项目的共享配置。已有配置的显式端口默认保留。改安装端口需先停止，重新 `service install --port <新端口>`，并由用户同步外部 HTTPS 转发。

安装/启动前的检查不能消除抢占竞态，CLI 的实际监听仍是最终判定。被另一个项目声明或被外部程序占用时拒绝启动，不终止对方。停止保留声明，卸载只释放本项目的端口。未纳管的旧项目需先完成显式项目身份升级，服务安装不自动收养旧状态。一个 App 的回调不会自动分发到多个监听器；默认继续轮询，需要 Webhook 时使用已有的仓库路由入口或独立 App。

本轮用隔离项目、模拟 launchctl、短 Node 子进程和本地监听验证端口持久、跨项目冲突、安装后占用、ready 收据、错误阻塞及旧策略升级；未启用主仓库后台、未写 GitHub、未执行真实模型或注销/重启机器。历史真实验收记录保留，不替代本轮新行为的验证。

### DSH 密钥在登录或重启后的加载

DSH 后台可从独立的本地 dotenv 文件加载 `execution.backend.apiKeyEnv` 指定的密钥。安装 manifest 只保存 `environmentFile` 路径，LaunchAgent 不保存密钥内容；服务每次启动重新读取文件，不依赖终端或临时 `launchctl setenv`。

文件必须属于当前用户，权限为 `0600` 或更严格，不可为符号链接或硬链接，最大 64 KiB。只将执行端需要的密钥传给子进程；文件中其他变量（包括 `PATH`、`NODE_OPTIONS`）不会加载，不执行 shell 展开。已有文件来源缺失或缺键时直接失败，不回退可能过期的环境变量。文件内密钥轮换后，下次启动会读取新值。

```sh
# 准备好仅保存所需密钥的本地文件后：
chmod 600 /absolute/path/service.env
js-superagent --project /path/to/project service install --env-file /absolute/path/service.env
js-superagent --project /path/to/project service status
```

dotenv 的键名应与 `apiKeyEnv` 一致，例如 `DEEPSEEK_API_KEY`。文件应置于被 Git 忽略的私有目录，不要写入示例或提交到仓库。`ServiceOptions.environmentFile` 提供等价 SDK 配置，要求绝对路径。

对已安装且停止、未加载的服务，`install --env-file` 可原地补充或更换引用，保留原 plist、代理和执行程序设置；操作不会启动服务，自动启动继续禁用。运行中的服务必须先停止才能更换引用。凭据文件失效时仍可执行 `status`、`stop` 和 `uninstall`；卸载不删除凭据文件。`start` 在启用 launchd 前校验凭据，避免明知缺失仍反复拉起。旧安装未配置文件时仍兼容 launchd 环境变量，但这种方式不保证跨登录持久有效。

2026-11-03 本机已将所需 DSH 密钥单独保存为 `.js-superagent/service/credentials.env`（0600，Git 忽略），并更新停止中的服务引用。没有启动主后台。针对性验收使用无密钥继承环境的隔离短子进程，验证加载、过滤、轮换和失败脱敏；既有后台测试与新增测试共 24 项通过。没有注销或重启整台机器，也没有执行真实模型任务。

### 后台网络与代理

launchd 不自动继承当前终端的完整环境。安装服务时会记录运行所需的路径与目录设置，并只从网络代理变量中选取 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及其小写形式，以及 `NO_PROXY`／`no_proxy`；这些值可以在安装 manifest 和 LaunchAgent 中检查。不会把整个终端环境或其他秘密变量复制进去。

代理地址只接受不含用户名、密码、查询参数或 fragment 的 HTTP(S)／SOCKS URL。若本机访问模型服务依赖代理，安装时应使用已验证可用的代理设置，并保证代理程序也在后台持续运行。仅 GitHub 同步成功不能证明 Codex 能连接模型服务。

代理设置在安装时固定。之后修改终端变量或单独执行 `service restart` 不会更新已安装服务的代理；应先停止、卸载，再在正确环境下重新安装并启动。需要代理身份凭据的 URL 不会被持久化，应另行配置适合该环境的网络出口。

## 轮询与 Webhook 两种模式

| 模式 | 后台运行入口 | 公网要求 | 用途 |
|---|---|---|---|
| `poll`（默认） | `serve` | 不需要入站地址；机器能访问 GitHub 和模型服务即可 | 本机持续接单，沿用现有轮询 |
| `webhook` | `github listen` | GitHub 可访问的 HTTPS URL 转发到本地监听器 | 实时提示接单，同时保留轮询补漏 |

App 身份与事件接收方式独立：可以用 App 认证轮询，也可以继续使用本机 `gh` 登录。后台进程不依赖当前终端中临时导出的秘密；长期运行的 App 使用受保护的私钥文件引用，Webhook 使用 secret 文件引用。凭据内容不应写入服务定义或提交到仓库。

若需要 Webhook，先按 [App／Webhook 配置](github-app-webhook.md) 准备配置，使用固定监听端口和 secret 文件引用，再安装对应模式。已有 `poll` 服务须先卸载再更换模式：

```bash
js-superagent --project /path/to/project service uninstall
js-superagent --project /path/to/project service install --mode webhook
js-superagent --project /path/to/project service start
```

HTTPS 可由服务器反向代理或已配置的固定隧道提供，Cloudflare 不是运行依赖。固定域名／隧道还需要单独保持在线，并将准确 URL 写入 GitHub App 设置。临时隧道只适合验收；地址重启后变化时，后台进程正常也不代表 GitHub 仍能投递。尚未配置可持续使用的地址时，采用 `poll` 即可持续接单。

## 重启后的任务处理

服务管理器恢复进程，运行时恢复持久化状态，两者承担不同职责：

- 尚未开始的授权工单、待处理反馈、待核对 Webhook 和待回传结果保存在 SQLite 中，恢复后继续调度。
- 服务停止期间产生的 GitHub 事件，可在启动后的轮询中重新读取；沿用远端原生事件 ID 去重。
- 已经完成的执行不因重启重复运行；Outbox 根据已保存的收据及远端标记核对回传。
- 正在执行时被停止或崩溃打断的工单标记为 `interrupted`。先检查工作区和外部动作，再执行 `retry <ticket-id>`，复用原会话与工作区继续；不会无条件重做可能已经发生的外部操作。

最后一项与上游的自动创建替代 Assignment 不同：当前非 DSH 执行端采用显式恢复边界。`service restart` 恢复后台进程，不代表批准重试所有被打断的任务。

## 运行边界与验收

当前实现是用户登录后的本机后台服务。退出登录、关机、睡眠或断网时不保证接单；launchd 也不会让睡眠中的 Mac 持续执行。需要全天候运行时，应将运行时部署在持续在线的主机，或另行明确机器的运行策略。当前未提供 Linux systemd／Windows 服务安装器，也不提供跨主机多实例调度。

本轮从本地 tarball 安装后，由真实 launchd 服务运行 `poll` 模式；GitHub App 每 3 秒轮询仅用于验收的 Issue #7，模型使用真实 Codex CLI。结果单独记录，没有用替身渠道或之前的 Webhook 验收代替：

| 验证项 | 实际结果 |
|---|---|
| 持续接单与反馈 | 首次修复和两次关联反馈完成三轮执行；第二轮不中断服务，第三轮反馈在停止期间发送，启动后自动补收 |
| 实际修改与验证 | 独立运行 Python 测试，依次通过 3、4、5 项；工单、Codex 会话和 Git worktree 复用，源文件、HEAD 与暂存区不变 |
| App 身份与回传去重 | 接单确认加三次结果共四条 Bot 评论，每份收据恰好匹配一条远端评论；核对 Bot ID 与 App ID |
| 空闲进程崩溃 | 对服务发送 `SIGKILL` 后 launchd 拉起新进程；随后自动轮询成功，已完成的三轮工作没有重复执行 |
| 执行中进程崩溃 | 真实 Python 长任务退出且 heartbeat 停止；工单保持 `interrupted`，没有自动重放。检查后显式 `retry`，复用原会话完成恢复文件及独立断言 |
| 验收收尾 | 临时 LaunchAgent 已卸载，专用 Issue #7 已关闭；保留本地证据，长期项目部署另行记录 |

完整时间、结果回执、独立测试输出、崩溃恢复记录和实现摘要见 [phase5-background-acceptance.json](phase5-background-acceptance.json)。本次验证覆盖进程停止／启动及异常拉起，**没有实际重启整台 Mac、注销再登录，或验证机器睡眠期间在线**。登录启动配置不能当作这些场景的实测结果。

复跑需现有 App 与 Codex 登录，以及以允许用户身份创建专用 Issue 的 `gh` 登录；脚本会安装临时用户服务、发送测试评论并在收尾时移除服务及关闭 Issue：

```bash
npm run test:service:real -- --write --mode poll \
  --repository owner/repository --actor trusted-login \
  --app-id 123456 --installation-id 789012 \
  --private-key-path /private/path/app-key.pem \
  --codex-path /absolute/path/to/codex \
  --output /absolute/path/to/new-evidence-directory
```

使用 `--local-only` 可单独检查本地提交与进程恢复，但不能替代真实 GitHub 接单证据。固定 HTTPS 的验收还需真实 GitHub 投递和重启后的 URL 连续可用，不能用本地 HTTP、模拟投递或临时地址代替。本轮没有配置或验证这部分；此前的 [App／Webhook 记录](phase5-app-webhook-acceptance.json) 保留独立事件链路证据。

## 本仓库的常驻部署

2026-11-01 已在 `x-pkm-research` 仓库根目录安装并启动独立的本地安装包，采用 App 身份、30 秒轮询、`imjszhang` 允许名单和 `/js-superagent` 明确接单命令。安装位置为 `.js-superagent/installation/20261101-background/`，项目状态及安装包均在本地 Git 忽略范围内。配置引用已有受保护的 App 私钥文件，服务使用安装时记录的本机代理。

正式服务已再次执行停止／启动，核对新进程完成 GitHub 同步、无渠道错误，核对时没有待执行工单。此服务保留运行；验收用的临时服务已移除。时间与状态是核对时的快照，见 [部署记录](phase5-background-status.json)。日常可在仓库根目录执行 `node packages/js-superagent/bin/js-superagent.mjs service status` 或 `service stop` 管理。

工作区使用 Git worktree，从已提交的 Git 修订建立；当前未提交的文件和改动不会自动复制进去。`js-superagent` 改造已在 `f7468ba` 提交并推送，新工单可以访问包源码。通过 Issue #8 完成了包自身 CLI 版本选项的真实修改、提问回复和结果回传，见 [自身代码验收](phase5-self-host-acceptance.json)。固定 HTTPS 未部署，当前服务不启用 HTTP 监听；持续接单依靠主动轮询。

### 当前安装：0.2.0-alpha.0

2026-11-01 已将上述常驻服务升级到固定的 `0.2.0-alpha.0` 安装包，当前安装位置是 `.js-superagent/installation/20261101-v02-complete/`。包 SHA256 为 `c5714956a7ceeca1ad1d221324388fa3f7f7054516c7e321af5643c5601c1bcd`。服务仍以原 GitHub App 身份、30 秒轮询、原允许名单和 `/js-superagent` 命令接单，保留单 Worker、Codex 执行端、Git worktree 及原代理设置；没有启用主动接单策略或自动 PR 交付。

升级先核对空闲状态并停止服务，保存受保护的原服务定义、配置及一致性 DB2 备份，再升级到 DB3。随后观察两次真实 App 轮询，显式重启并核对再次同步成功。最后安装包含交付恢复约束与完整角色设置的固定包，并再次核对 App 同步；现有配置没有启用自定义 Worker 提示词，默认执行方式保持不变；原工单、报告、通知及业务表摘要保持一致，没有重复执行或回传。旧安装目录、DB2 备份及最终替换前的 DB3 备份保留在本地 Git 忽略目录内。

核对时最终服务进程为 `21552`，CLI 子进程为 `21554`，服务保持运行。进程号和运行状态是验收时的快照；以 `service status` 与 `github status` 查询当前情况。脱敏摘要见 [phase12-deployment-acceptance.json](phase12-deployment-acceptance.json)。本次没有重启整台机器或注销再登录。
