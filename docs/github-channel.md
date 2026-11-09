# 第五阶段首部分：GitHub Issue 渠道

GitHub 是可选渠道，接到现有领域 Engine、SQLite、工作区与执行端。首版通过本机 `gh api` 拉取 Issue 和普通评论，将明确委托变成工单，再把接单确认、问题、结果及失败通知写回同一个 Issue。本地 CLI/SDK 继续可独立使用，包没有增加运行时依赖。

本页记录 Issue 渠道及第一部分验收；显式 PR 关联、审阅与 CI 反馈见 [PR 审阅与 CI 续作](github-pr-ci.md)。现已新增 App installation 认证和签名 Webhook，仍使用本页的 REST 接单与回传规则，并通过 Issue #5 的真实签名交付、同工单续作和 App Bot 回传验收，见 [GitHub App 与 Webhook](github-app-webhook.md)。

## 启用与操作

默认使用本机已登录的 GitHub CLI，账号须可读取目标仓库并写 Issue 评论；配置 App 后改用其 installation 身份，不再依赖 gh。当前只支持 github.com。执行 Codex 仍使用单独的 Codex 原生登录。

以下命令适用于已安装的本地 tarball；源码入口是 `node bin/js-superagent.mjs`。

```bash
js-superagent --project /path/to/project init --workspace auto --driver codex-app-server
js-superagent --project /path/to/project config set \
  --github-repo owner/repository \
  --github-actor trusted-login \
  --github-issue 123
js-superagent --project /path/to/project github sync
js-superagent --project /path/to/project github status
js-superagent --project /path/to/project run
# 或在前台持续拉取与执行
js-superagent --project /path/to/project serve
```

`--github-actor` 和 `--github-issue` 可重复指定。Issue 列表是可选的；省略时扫描仓库的打开 Issue，并继续检查已关联的 Issue。建议初次启用时限定 Issue 编号。持久化参数还有 `--github-command`（默认 `/js-superagent`）、`--github-poll-ms`（默认 30000，最小 1000）和 `--gh-path`。配置不保存秘密正文；App／Webhook 配置仅保存指定环境变量名或文件路径。

允许账号在 Issue 正文或评论的开头发送明确命令：

```text
/js-superagent 修复这里描述的问题，并运行相关测试。缺少决定时先向我提问。
```

接单后，同 Issue 中允许账号的普通评论会送入原工单，不必重复命令。已完成的工单可被相关反馈重新唤起，保持原授权范围、会话和工作区。Issue 正文编辑或评论编辑不被当成新事件；追加说明请发新评论。

`github sync` 会拉取、接单并发送队列中的回复，**会写 GitHub 评论，但不会调用模型**。`github status` 只读取本地状态。`run` 最多执行一轮 Worker；`serve` 按配置的轮询间隔持续工作。手工回复后可先执行 `github sync`，立即接收最新反馈，不必等待轮询周期。

关闭渠道使用 `config set --github-disable`。关闭后本地任务仍可运行，既有远端待发消息保留；它们只有在目标再次符合配置时才可能发送。修改配置前须停止当前执行和渠道操作。

## SDK

```js
import { createProjectAgent } from 'js-superagent';

const agent = createProjectAgent({ projectRoot: '/path/to/project' }).init();
agent.configure({
  workspace: { mode: 'auto' },
  execution: { driver: 'codex-app-server' },
  github: { repository: 'owner/repository', allowedActors: ['trusted-login'], issues: [123] },
});
try {
  await agent.syncGitHub();
  await agent.runNext();
  console.log(agent.githubStatus());
  console.log(agent.notifications());
} finally {
  await agent.stop();
  agent.close();
}
```

`flushNotifications()` 单独推进发送队列，网络恢复后无需重新执行已经完成的 Worker。`createGitHubChannel()` 可单独创建适配器；`githubChannel` 构造参数用于宿主注入实现或测试替身。`receiveGitHubEvent()` 是可信适配器入口，不是可直接暴露给公网的 webhook；它仍执行项目范围、允许账号及消息类型检查。

## 授权与关联

接单至少同时满足：仓库匹配、Issue 编号在配置范围内、作者是允许列表内的真实用户、Issue 打开、文本以完整命令和非空请求开头。PR、机器人、未列出的账号、关闭 Issue 和未明确委托的消息不会自动建立任务。

反馈在进入已有订阅前也检查权限，避免仅检查初次接单却放任后来评论绕过授权。接单记录保留 GitHub 来源、账号、Issue 地址及授权依据；执行前重新核对当前配置。Issue 原文可为后来的命令评论提供明确标记为不可信的上下文，但不会替代命令发送者，也不会扩大保存的授权范围。

事件以仓库及原生 Issue／评论 ID 去重，跨重启和重复拉取仍只处理一次。一个 Issue 固定关联一个公开工单。执行中的评论保留到下一轮，已完成工单的允许反馈恢复同一个工单；已取消、失败或中断的工单需要本地检查并显式 `retry`。本地 `reply` 和取消后 `retry` 继续保留该工单的 GitHub 回传地址。

任何实例生成的有效 js-superagent 回传标记都不会成为新工作，因此同一人同时作为请求者和发送账号也不会产生回声循环。不同实例监听同一个 Issue 仍会各自接单和发结果，部署时应指定单个负责实例；消息标记只防止它们相互触发。

REST 快照给出原作者，无法可靠判断首次拉取前由谁编辑过正文；原作者不能被当成每次编辑者。此版面向由可信维护者管理的仓库。新增 Webhook 只以签名事件触发 REST 重新核对，不保存或直接执行 payload 正文，因此也不改变上述编辑者边界。修改允许列表不会把已经忽略的旧事件重新解释为新授权，应发送新的命令评论。

## 持久化回传

Engine 在存储事务中产生接单确认、问题和结果；实际网络发送在事务之外执行。每条回传带固定的项目与收据标记。发送前遍历评论，只有标记匹配且作者是当前发送账号时才复用已有评论；这能处理“GitHub 已接受，但本地没收到成功响应”的常见重试情况。

`notifications()` / `github status` 显示 `pending`、`sent` 或 `dropped`，成功送达还记录远端评论 ID 与 URL。发送失败由动作队列退避重试，不重放 Worker 的代码修改。队列错误和下一次尝试时间可从 SDK `status().effects` 查看。消息在发送途中被撤回时，GitHub 已接受的评论无法撤回，收据仍保留远端送达事实。

这仍是可核对的至少一次发送，不承诺所有网络与服务端竞态下严格恰好一次。结果评论包含执行摘要、相对工作区文件名及运行／工单 ID，不上传代码、原始日志或工作区内容。已知项目绝对路径被替换为 `[project]`；这不是通用敏感信息检测器。成果仍留在隔离工作区供用户检查与采纳。

拉取失败时不导入半个批次，也不默默跳过截断页。GitHub 任务暂缓执行，本地任务仍可推进，失败轮询同样受间隔限制。停止会等待正在进行的拉取／发送，并停止领取后续回传。单次请求超时与页面上限用于限制等待，无法撤销服务端已经接受的发送。

## 实现范围与验证

第一部分验收覆盖 Issue 正文、普通评论、显式委托、同 Issue 反馈、问题与结果回传。PR／CI 与 App／Webhook 的后续实现及验收分别记录；自动提交／推送／创建 PR、自动关闭 Issue 和语义 Assessor 仍未接入。关闭 Issue 不等于运行时取消；停止执行仍使用本地 `cancel` / `stop`。允许账号的反馈也受原始委托范围约束，语义范围判断目前由执行端负责。

传输按 [GitHub Issues API](https://docs.github.com/en/rest/issues/issues) 与 [Issue comments API](https://docs.github.com/en/rest/issues/comments) 实现，显式区分 Issues 接口中的 PR，完整读取分页。首版每个列表最多 100 页，每轮最多 1000 个 Issue、10000 个事件及 8 MiB 事件文本；超限应缩小配置范围，不会静默截断。单条正文上限 256 KiB、回传内容上限 60 KiB。

真实验收使用专用 Issue、明确允许的测试账号和隔离 Python 工程。从 tarball 离线安装后，依次完成：Issue 接单 → Codex 提问回传 → GitHub 回复 → 同会话实际修改与测试 → 完成结果回传 → GitHub 追加关联反馈 → 原工单再次执行并回传。验收脚本独立复跑测试，检查源目录不变、回传评论与收据一一匹配、多次拉取没有回声或重复任务。

2026-11-01 的[实际测试 Issue](https://github.com/imjszhang/x-pkm-research/issues/1)已通过上述闭环：三轮真实 Codex 执行、4 条远端回传收据、最终 8 项 Python 测试通过，源目录未修改。专用 Issue 在验收完成后关闭。包级检查通过 143 项 Node 测试及内存、SQLite 各 144 项领域测试，安装包检查覆盖 CLI/SDK、类型、工作区及 GitHub 协议；仓库整体检查通过。

显式验收入口会使用当前登录调用真实模型并写测试评论：

```bash
npm run test:github:real -- --write \
  --repository owner/repository --issue 123 --actor trusted-login \
  --output /absolute/path/to/new-evidence-directory
```

脚本要求预先准备标题以 `[js-superagent acceptance]` 开头、没有评论的专用测试 Issue，具体任务文本见脚本及本次验收 Issue。脚本不自行创建或关闭 Issue。实际结果与源码哈希见 [phase5-acceptance.json](phase5-acceptance.json)。默认 `npm run check` 不访问 GitHub 或模型。
