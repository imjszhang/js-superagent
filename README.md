# js-superagent

项目级持久 Agent 运行时，提供 CLI 和 SDK，支持隔离工作区、工单排队、人工审核与续接、后台服务，以及可选的 GitHub 和飞书渠道。

支持通过注册表接入 Codex、DSH 和 Cursor 等执行端。状态保存在项目独立的 SQLite 数据库中；初始化不会自动启动执行或后台服务。

当前版本为 **0.14.0-alpha.1**，已于 2026-11-10 发布至 npm 的 `alpha` 渠道。本仓库从 x-pkm-research 的同名包独立导出；应用层的 longrun 业务系统不在本仓库。历史设计和验收文档记录各自当时的状态，不代表用户安装后的部署状态。

```bash
git clone https://github.com/imjszhang/js-superagent.git
cd js-superagent
npm ci
npm run build
node bin/js-superagent.mjs --help
```

项目采用 [MIT 许可](LICENSE)，上游核心的版权及 MIT 许可原样保留，见 [第三方声明](THIRD_PARTY_NOTICES.md)。npm 首发版本 [`0.14.0-alpha.0`](https://www.npmjs.com/package/js-superagent/v/0.14.0-alpha.0) 已于 2026-11-09 发布，使用 `alpha` 渠道。版本与发布流程见[发布指南](docs/releasing.md)。

## 环境与本地使用

需要 Node.js **22.13 或更高版本**，使用 ESM 和内置 `node:sqlite`，无运行时第三方依赖。部分 Node 版本会显示 SQLite 实验性提示。从源码运行前，在本包目录执行：

```bash
npm ci
npm run build
```

使用 `--version` 或 `-v` 输出本包 `package.json` 中的版本号并成功退出，不会初始化项目；可从未初始化的目录运行，无需 `--project`。安装后可直接运行 `js-superagent --version`，从源码调用其他目录中的 CLI 时使用脚本的绝对路径。

现有命令保持可用：

```bash
node bin/js-superagent.mjs --version
node bin/js-superagent.mjs -v
node bin/js-superagent.mjs --help
node bin/js-superagent.mjs --project /absolute/path/to/project init
node bin/js-superagent.mjs --project /absolute/path/to/project doctor
node bin/js-superagent.mjs --project /absolute/path/to/project submit "检查测试并记录失败原因"
node bin/js-superagent.mjs --project /absolute/path/to/project status
node bin/js-superagent.mjs --project /absolute/path/to/project show <ticket-id>
node bin/js-superagent.mjs --project /absolute/path/to/project reply <ticket-id> "补充要求或回答问题"
node bin/js-superagent.mjs --project /absolute/path/to/project retry <ticket-id>
node bin/js-superagent.mjs --project /absolute/path/to/project cancel <ticket-id>

# 执行一轮真实任务；需要安装 Codex CLI 并先完成 codex login
node bin/js-superagent.mjs --project /absolute/path/to/project doctor --driver codex-app-server
node bin/js-superagent.mjs --project /absolute/path/to/project run
# 在前台持续接单；Ctrl+C 等待当前执行及所属工具退出
node bin/js-superagent.mjs --project /absolute/path/to/project serve

# 新项目启用隔离，或在已有项目保存设置
node bin/js-superagent.mjs --project /absolute/path/to/new-project init --workspace auto --driver codex-app-server
node bin/js-superagent.mjs --project /absolute/path/to/project config set --workspace auto --driver codex-app-server
node bin/js-superagent.mjs --project /absolute/path/to/project config
node bin/js-superagent.mjs --project /absolute/path/to/project workspace <ticket-id>
```

目标可以是 Python、Go、Rust、JavaScript 工程或普通目录，不要求拥有 `package.json` 或 Git。项目目录里不写任何 js-superagent 文件。配置、状态、工作区、执行记录和迁移备份都放在当前用户的状态目录 `~/.js-superagent/projects/<路径编码>/`，路径编码与 Claude Code 的 `~/.claude/projects` 相同：项目真实路径中的非字母数字字符都换成 `-`。设置 `JS_SUPERAGENT_HOME` 可以改用其他根目录，后台服务安装时会记住这个设置。

CLI 提交后保存待执行工单，调用 `run` 执行一轮，或用 `serve` 持续调度。执行命令可指定 `--codex-path /path/to/codex`、`--model <name>`、`--timeout-ms 600000`。模型默认沿用本机 Codex 配置。创建、导入和初始化均不会自动开始工作。Codex 驱动目前支持 macOS/Linux；核心和自定义 Driver 不受此限制。

macOS 可用 `service install --mode poll` 安装项目后台服务，再通过 `service start` 启动。默认保持现有轮询，不需要域名或隧道；`service status/stop/restart/uninstall` 管理生命周期。已通过真实 App 三轮接单、停止补收、进程崩溃拉起和显式重试恢复验收；未实测整机重启／重新登录，固定 HTTPS 未配置。操作与证据见[后台运行与重启恢复](docs/background-service.md)。

`auto` 在 Git 仓库根目录创建独立 worktree，在普通目录或仓库子项目中创建副本。默认 `in-place` 保持旧行为，须显式选择隔离模式。工作区首次执行时固定，回复和重试复用；`workspace <id>` 查看实际路径与变更清单。结果保留在工作区供审阅，采纳到源项目由用户决定。配置、排除规则和恢复说明见[第四阶段记录](docs/workspaces.md)。

GitHub 渠道默认使用本机 `gh` 登录，也可使用 App installation。现已支持与上游一致的[专用用户账号与通知轮询](docs/github-account-notifications.md)：通过 `gh-agent` 登录，授权用户在讨论中 `@账号` 接单，无需公网 Webhook。显式配置仓库、允许账号和可选 Issue 范围：

```bash
node bin/js-superagent.mjs --project /absolute/path/to/project config set --github-repo owner/repository --github-actor trusted-login --github-issue 123
node bin/js-superagent.mjs --project /absolute/path/to/project github sync
node bin/js-superagent.mjs --project /absolute/path/to/project github status
```

允许账号在 Issue 正文或评论开头写 `/js-superagent 任务说明` 后接单，后续允许的评论进入同一工单。`github sync` 会接单并回传队列中的评论，不调用模型；`run/serve` 执行任务并回传结果。详见[GitHub 渠道与验收](docs/github-channel.md)。

已有工单可以显式关联同仓库 PR 的当前提交。先检查工单工作区与 PR 内容的对应关系，再执行：

```bash
node bin/js-superagent.mjs --project /absolute/path/to/project github link <ticket-id> 456
# CI 默认关闭；显式信任指定 App 的检查
node bin/js-superagent.mjs --project /absolute/path/to/project config set --github-check-app github-actions
node bin/js-superagent.mjs --project /absolute/path/to/project github sync
node bin/js-superagent.mjs --project /absolute/path/to/project run
# 停止接收该 PR 的反馈及尚未发送的结果
node bin/js-superagent.mjs --project /absolute/path/to/project github unlink 456
```

关联不执行 checkout、fetch、push 或 merge。允许的审阅与评论、可信 CI 的当前提交失败可以请求原工单继续修复；运行中及恢复观察作为活跃工单的上下文接续，已完成工单只更新观察。远端提交改变后须检查工作区并显式重新关联。关闭讨论的来源回复与新执行目标分别检查；未绑定行内接单须启用仓库来源的 `streams.reviewComments`。当前行为和操作见 [0.7 交付记录](docs/workflow-followup-acceptance.md)，原有配置与历史验收见 [PR 审阅与 CI 续作](docs/github-pr-ci.md)。

已有 App 可切换认证并启用 Webhook；凭据只通过文件路径或环境变量名引用：

```bash
node bin/js-superagent.mjs --project /absolute/path/to/project config set \
  --github-app-id 123456 --github-installation-id 789012 \
  --github-private-key-path /private/path/app-key.pem \
  --webhook-secret-path /private/path/webhook-secret --webhook-port 8787
node bin/js-superagent.mjs --project /absolute/path/to/project github listen
node bin/js-superagent.mjs --project /absolute/path/to/project github webhook-status
```

`github listen` 在前台接收签名事件并持续执行，仍保留轮询。Webhook 落盘后触发既有 REST 同步，与轮询共享原生事件 ID；签名不会扩大任务授权。只有 Webhook 主动投递需要公网 HTTPS，后台轮询和 App 认证本身不需要；此前临时隧道仅用于验收。尚未创建 App 时可使用本机注册 helper；配置、SDK、凭据边界与 [Issue #5](https://github.com/imjszhang/x-pkm-research/issues/5) 的真实验收证据见 [GitHub App 与 Webhook](docs/github-app-webhook.md)。

## SDK

包安装后可以这样执行真实任务，沿用本机 Codex 登录，不复制凭据：

```js
import { createProjectAgent } from 'js-superagent';

const agent = createProjectAgent({
  projectRoot: '/absolute/path/to/project',
  execution: { driver: 'codex-app-server', timeoutMs: 600_000 },
}).init();

try {
  const ticket = agent.submit({ text: '修复失败测试并说明修改和验证结果' });
  await agent.runNext();
  console.log(agent.get(ticket.id));
  console.log(agent.getDomainTicket(ticket.id));
  console.log(agent.getSession(ticket.id));
} finally {
  await agent.stop();
  agent.close();
}
```

Codex 与 DSH 都通过同一注册表创建适配器。扩展接口只接受现代结构化报告 `{ version: 2, state, summary, artifacts? }`；`waiting` 表示等待人的回答，`ready` 表示执行结果已可供宿主验证。`reply()` 保存回答，后续执行继续原工单。

适配器使用 `checkpoint({ driver, id })` 保存原生会话，使用 `registerProcess(pid)` 登记进程归属，取消后须等所属工作停止才能返回。新增 Harness 的最小示例见 [local-demo.mjs](examples/local-demo.mjs)，配置、迁移和能力边界见 [Harness 接入](docs/harnesses.md)。不再支持 `createProjectAgent({ driver })` 或直接注入协调者。

| API | 用途 |
|---|---|
| `init()` | 打开项目，按需备份和迁移旧工单，检查中断执行 |
| `submit({ text, scope?, attentionSnapshotPaths?, operatorNotifications?, managedJobs? })` | 建立本地事件、授权、领域工单与派工 |
| `list()` / `get(id)` | 读取兼容格式的工单视图 |
| `getDomainTicket(id)` | 按公开工单 ID 查看当前领域工单、授权、输入和派工 |
| `getSession(id)` | 读取持久化的执行端名称及原生会话 ID |
| `getConfig()` / `configure(patch)` | 读取有效配置／保存项目执行端、工作区与 GitHub 策略 |
| `getWorkspace(id)` / `inspectWorkspace(id)` | 读取固定工作区身份／比较相对基线的文件变更 |
| `reply(id, text)` | 在关联本地话题中追加消息 |
| `coordinate({ text, id? })` / `coordinationStatus()` | 入队项目协调消息／读取处理状态与动作收据；不启动执行 |
| `retry(id)` | 核查后重试失败、中断或已取消的工单 |
| `cancel(id)` | 撤回当前领域授权并请求取消执行 |
| `runNext()` | 处理队列，最多执行一轮 Driver；空闲或项目已占用时返回 `null` |
| `start({ intervalMs: 100 })` | 启动 SDK 内部轮询调度；不创建独立后台进程 |
| `stop()` | 停止调度、请求中止当前执行并等待其退出 |
| `status()` | 查看此运行时的调度状态、最近错误和持久化动作队列 |
| `notifications()` | 查看各渠道 Outbox 收据；GitHub 送达记录包含远端评论链接 |
| `syncGitHub()` / `githubStatus()` | 拉取并接单／查询本地 GitHub 同步与回传状态 |
| `receiveGitHubWebhook({ body, headers })` | 验证原始字节签名，持久化交付并排入重新核对队列 |
| `processGitHubWebhooks()` / `githubWebhookStatus()` | 处理待核对交付／查询持久化 Webhook 状态 |
| `linkGitHubPullRequest(id, { number })` | 读取并显式关联已有工单与 PR 当前提交 |
| `unlinkGitHubPullRequest(number)` | 删除本地 PR 关联，停止该 PR 的反馈及待发回传 |
| `flushNotifications()` | 单独重试到期的回传，不重新执行 Worker |
| `close()` | 关闭数据库；有执行中的工作时拒绝关闭 |

持续运行时由宿主调用 `agent.start()`，退出前 `await agent.stop()` 再 `agent.close()`。Webhook HTTP 接收器由宿主显式调用导出的 `listenGitHubWebhook(agent, options)`，退出时先关闭接收器。SDK 不注册全局信号处理器，不修改 `process.env` 或全局当前目录。

本地业务任务可在提交时传 `operatorNotifications: false`，关闭该工单的操作者卡片及 Worker 完成／失败私信；默认仍为 true。`managedJobs: false` 禁止该工单获得受管子任务工具和配置，默认仍为 true。两者均为宿主提交时校验并持久化的布尔值，只缩小单工单能力，不修改项目设置，不授予其他执行权限。`0.14.0-alpha.1` 修复了 DSH 项目启用受管子任务、单工单禁用时的配置衔接：执行与恢复使用相同的工单有效配置，禁用工单不会加载 jobs 工具或索取可信任务目录。没有宿主快照文件时省略 `attentionSnapshotPaths`，不要传空数组。

## 状态与授权边界

公开工单继续使用 `queued`、`running`、`waiting`、`completed`、`failed`、`cancelled`、`interrupted`，由领域工单、派工、执行所有权与队列推导。代码 ready 但当前 PR 仍开放时增加 `awaitingReview: true`，界面显示“等待审阅”，保留旧 `completed` 状态的兼容性；现行政策允许的审阅反馈仍可续作。`getDomainTicket()` 返回更完整的上游领域对象；两种 `Ticket` 类型不能直接互换。

已绑定工单的 Issue、PR 普通评论及行内评论均支持授权真人发送 `/js-superagent cancel`（如配置了自定义命令则使用该命令）。配置协调者后，真人跟进中的明确自然语言停止请求也可停止原工单；无需开启持续协调模式。宿主核对原始评论的当前版本、绑定和现行权限，bot 不能取消，解释结果不能改停其他工单。未配置协调者时使用显式取消命令；超过 16,000 字符的跟进保留普通输入，不通过截断文本推断取消。`details`／`getDetailed()` 保留 GitHub 取消来源。

本地 CLI/SDK 的调用者是可信的 `local/operator`。GitHub 则检查显式配置的账号与 Issue 范围，反馈进入已有工单前也验证权限。PR 需本地显式关联；CI 需额外配置可信 App，或同时限定 status context 与创建账号。PR 关联和 CI 策略形成该工单的持续修复委托，真实机器人事件仍保留非人类身份。请求产生正式领域授权记录；当前政策不接纳主动推断任务。`scope` 仍是委托范围文本，不具备自动语义越界判断或操作系统权限隔离。取消后的显式 `retry()` 会创建新的领域授权，保留公开 ID、历史和已停止的领域记录。

默认单 Worker，工作目录由配置与工单固定的工作区决定；v2 可在独立工作区显式提高并发。执行中追加的消息先持久化，Codex app-server 可实时投递并记录模型确认；DSH SDK 通过原生消息回执与消费事件区分已接收和已读取。跨进程未确认输入仍需检查，不盲目重投。普通业务失败后的授权人回复可以继续；原生错误、验证或外部结果不明时保留反馈并提示检查。自动恢复默认关闭，显式开启后也仅处理有可靠证据的故障，详见 [反馈、协调与恢复](docs/workflow-alignment-delivery.md)。

## 旧数据与迁移

旧版本把状态写在项目内的 `.js-superagent/`。新版本发现这个目录时会拒绝打开项目，提示先迁移：停止项目、卸载后台服务后运行 `project migrate-state --plan` 查看计划，再用 `--apply` 执行。迁移把整个目录移到状态目录，修复其中的 Git worktree，改写记录和数据库里的路径；仍未结束、又在独立工作区里有原生会话的工单，需要检查后显式替换会话。项目目录移动后，用 `project relocate --from <旧路径>` 把状态从旧路径编码搬到新路径编码。

打开 v1 数据库前会通过 SQLite 一致性导出生成 `state.sqlite.v1-backup`，已有备份不覆盖。旧 `tickets` 表保留；新领域对象、兼容元数据与待执行动作原子导入，公开工单 ID、消息和报告保留。

正在运行的旧任务只有在确认同主机旧进程退出后才可迁移，并转为中断状态。活进程或不能确认的 owner 会阻止迁移。详细转换、恢复限制及备份说明见 [运行时迁移记录](docs/runtime-migration.md)。

## 独立领域入口

```js
import { Engine, MemoryRepositories, ticketStage } from 'js-superagent/core';
// 根入口也提供：import { core } from 'js-superagent';
```

`/core` 仍是可独立嵌入的领域 API。直接使用 `Engine` 时，调用者负责提供各端口；`MemoryRepositories` 仅供测试或临时实例使用。`createProjectAgent()` 现在为该内核组装本地 SQLite 和运行时。

## 开发与来源

```bash
npm run check
npm pack --dry-run
npm pack
```

`npm pack` 只生成本地安装包，不会发布。已发布版本可通过 `npm install js-superagent@0.14.0-alpha.0` 安装；CLI 可通过 `npx js-superagent@0.14.0-alpha.0 --help` 查看。

核心与对应测试原样提取自 [deepseek-ai/dsh-superagent-prototype 固定提交](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/6337fc823ce20251c8de8085948165c81aaa701e)，来源摘要和 MIT 许可见 [来源清单](docs/upstream-core.json)与[第三方声明](THIRD_PARTY_NOTICES.md)。本阶段的存储、队列、迁移和运行时适配独立编写，未新增复制上游应用层源码。

[架构与边界](docs/architecture.md) · [实施路线](docs/roadmap.md) · [后续完整实施计划](docs/implementation-plan.md) · [第一阶段提取记录](docs/core-extraction.md) · [第二阶段迁移记录](docs/runtime-migration.md) · [第三阶段执行端记录](docs/codex-driver.md) · [第四阶段配置与工作区](docs/workspaces.md) · [GitHub 渠道与验收](docs/github-channel.md) · [PR 审阅与 CI 续作](docs/github-pr-ci.md) · [GitHub App 与 Webhook](docs/github-app-webhook.md) · [后台运行与重启恢复](docs/background-service.md)
