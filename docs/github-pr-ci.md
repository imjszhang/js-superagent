# 第五阶段第二部分：PR 审阅与 CI 续作

在可选的 GitHub Issue 渠道上，新增把已有工单与 PR 当前提交显式关联的能力。允许的审阅、行内评论和 PR 会话评论可以交给原工单；显式信任的 CI 失败也可以请求修复。工单、原生会话和工作区继续复用，结果回传到原始渠道（Issue 或本地通知）和关联 PR。

本页的真实 PR／CI 验收使用已登录的 `gh` 轮询 github.com。当前也支持 App installation 认证和签名 Webhook 触发同一套 REST 重新核对；App 的真实 Issue 接单、反馈续作、结果回传和官方重投已另行验收，详见 [GitHub App 与 Webhook](github-app-webhook.md)。只支持源分支与目标分支位于配置仓库内的 PR。PR 不会自行建立新工单；关联操作也不会 checkout、fetch、push 或 merge。操作者须先检查该工单工作区与 PR 内容的对应关系。

## 关联与继续工作

以下命令适用于已安装的本地 tarball；源码入口是 `node bin/js-superagent.mjs`。沿用 [Issue 渠道配置](github-channel.md)，先通过本地提交或 Issue 接单建立工单：

```bash
js-superagent --project /path/to/project workspace <ticket-id>
js-superagent --project /path/to/project github link <ticket-id> 123
js-superagent --project /path/to/project github status
js-superagent --project /path/to/project github sync
js-superagent --project /path/to/project run
```

`github link` 从远端读取 PR 元数据，检查仓库、开放状态和当前 head SHA，保存本地关联。重复关联同一工单与同一提交保持幂等；一个 PR 不能同时属于两个工单。`github status` 和 `show <ticket-id>` 只读取本地关联、已观察到的状态和发送收据。

PR 会话评论、`COMMENTED`／`CHANGES_REQUESTED` 审阅以及行内评论，须来自 `github.allowedActors` 中的用户。审阅本身还须对应关联提交；批准、无正文的审阅和系统回传不会请求新一轮修改。行内评论保留文件、行号及左右侧信息；文件级评论可以没有行号。所有反馈都受原工单的委托范围约束，不会扩大任务范围。

`github sync` 拉取反馈并发送到期的回传，不调用模型；`run` 最多执行一轮 Worker，`serve` 持续轮询与处理。配置 Webhook 后，`github listen` 在前台同时接收签名交付和调度；交付落盘后触发 REST 重读，与轮询共享原生事件 ID，不新增 PR 绑定或 CI 授权。`sync` 和执行后的回传会写 GitHub 评论。取消、失败或中断的工单仍需操作者检查后显式 `retry`，远端反馈不会绕过这一要求。

## 显式启用 CI

默认不订阅 CI。可以信任指定 GitHub App 产生的 check run，或同时限定 commit status 的 context 与创建账号：

```bash
# 信任 github-actions App 的 check runs
js-superagent --project /path/to/project config set \
  --github-check-app github-actions

# 或同时配置 check run 与 commit status 的来源
js-superagent --project /path/to/project config set \
  --github-check-app github-actions \
  --github-status-context 'ci/tests' \
  --github-status-actor 'build-bot[bot]'

# 清除 CI 订阅，保留 Issue 与 PR 配置
js-superagent --project /path/to/project config set --github-ci-disable
```

三个 allowlist 参数均可重复。App 使用 `app.slug`，账号使用 status 的创建者 login；context 按原文区分大小写。`statusContexts` 与 `statusActors` 必须一起配置，只有同时匹配才接纳。数组必须非空，不接受通配符 App／账号、任意环境变量或凭据字段。

每次提供 CI 参数都替换完整的 CI 策略，未提供的 CI 子字段会移除；完全省略 CI 参数则保留现有策略。修改前可通过 `config` 查看配置，修改后通过 `github status` 查看关联和已观察到的检查。

| 事件 | 对原工单的影响 |
|---|---|
| 可信 check run 已完成，结论为 `failure`、`timed_out` 或 `action_required` | 当前关联提交上的失败可请求修复，失败说明进入上下文 |
| 同时匹配 context 与创建账号的 commit status 为 `failure` 或 `error` | 当前关联提交上的失败可请求修复 |
| 成功、待运行、进行中的检查，或其他非修复结论 | 记录观察结果，不单独启动 Worker |
| 未信任的 App／创建账号、其他提交或未关联 PR | 不作为修复请求 |

本地显式 PR 关联与 CI 策略共同表达持续处理该 PR 失败的委托。运行时保留 CI 的真实机器人事件和非人类身份，另外记录这项本地策略产生的续作意图，因此第一次 CI 失败也能唤醒已经完成的工单。没有把机器人伪装成人类请求，也没有修改提取的上游领域内核。

## 提交版本与停止关联

关联固定的是具体 head SHA。每轮 PR 工作开始前，运行时重新读取远端当前提交及状态；读取失败、PR 关闭或提交改变时暂缓执行。一旦观察到 PR 关闭或 head 改变，即使远端后来恢复开放或回到原提交，也须显式重新关联才能解除阻塞。远端提交改变不会自动移动工作区，也不会自动授权新版本。操作者检查并准备好工作区后，需要再次执行 `github link <ticket-id> <pr-number>` 明确关联所选提交；关联本身不调用模型。

重新关联新提交会作废尚未执行的旧提交反馈；同一 CI 检查的新状态会取代旧状态，最新成功不会继续执行此前排队的失败修复。被替代的消息仍留在公开历史中，带 `superseded` 原因、时间和事件 ID，后续 Driver 快照不再包含它们。作废输入不会伪造已读确认或执行报告；没有当前有效反馈时不会仅为清理旧派工而启动 Worker，后续有效反馈仍可继续原工单。

已完成执行产生的结果带有对应 SHA。显式关联新提交后，已经排队的旧版本结果仍可按历史授权回传，避免把旧版本的执行结论误当成新版本验证。历史提交记录用于结果回传，不是继续执行旧反馈的许可。

```bash
js-superagent --project /path/to/project github unlink 123
```

取消关联会停止后续 PR 反馈，并撤回尚未发送的 PR 结果；已经送达的评论保留。原工单、Issue 关联、工作区和本地历史仍保留。取消关联不是中止正在执行的 Worker；如需停止执行，另用 `cancel` 或 `stop`。

## SDK 与适配器

```js
import { createProjectAgent } from 'js-superagent';

const agent = createProjectAgent({ projectRoot: '/path/to/project' }).init();
try {
  agent.configure({ github: { ci: { checkApps: ['github-actions'] } } });
  const binding = await agent.linkGitHubPullRequest(ticketId, { number: 123 });
  await agent.syncGitHub();
  await agent.runNext();
  console.log(binding.headSha);
  console.log(agent.get(ticketId).pullRequests);
  console.log(agent.githubStatus().trackedPullRequests);
  // agent.configure({ github: { ci: null } });
  // agent.unlinkGitHubPullRequest(123);
} finally {
  await agent.stop();
  agent.close();
}
```

`linkGitHubPullRequest()` 返回包含 PR、提交、原工单、关联时间和历史提交的绑定。`unlinkGitHubPullRequest()` 返回是否删除关联。绑定还提供最后观察到的提交／状态、阻塞原因和 CI 结果；配置仍为 v2，不要求数据库升级。配置和关联变更须在执行、同步及发送停止后进行。

自定义 `GitHubChannel` 可增加 `getPullRequest(number)`，`poll()` 接收 `trackedPullRequests`。旧的 Issue-only 适配器仍可使用；只有调用 PR 关联才需要新增方法。根入口导出 PR、CI、事件联合与绑定类型。`receiveGitHubEvent()` 仍是可信适配器入口，不能直接当作未鉴权的公网 webhook。

## 验证与实际验收状态

配置／CLI 测试覆盖 allowlist 校验、CI 策略替换与清除、显式关联及更新提交、本地状态查询和取消关联。安装包验收已跑通替身渠道中的 Issue → PR 审阅 → CI 失败 → 原会话与工作区继续执行 → 双话题结果回传，并验证外部 TypeScript 消费端。默认检查不调用真实模型或 GitHub。

过期输入处理回归已通过：关联新提交后不执行旧提交反馈；同一检查的最新成功结果不再触发旧失败修复；旧输入保留审计且不标为 Worker 已读，后续有效反馈仍能执行。启动前远端 head 检查、停止等待在途关联、跨实例关联锁也已通过验证。

2026-11-01 已从本地 tarball 安装后完成真实验收：[Issue #2](https://github.com/imjszhang/x-pkm-research/issues/2) → [PR #3 的真实审阅](https://github.com/imjszhang/x-pkm-research/pull/3#pullrequestreview-5727171405) → 同工单修复并回传 → [真实 Actions 失败](https://github.com/imjszhang/x-pkm-research/actions/runs/41288835692/job/124795633280) → 再次修复并回传 → [Actions 成功](https://github.com/imjszhang/x-pkm-research/actions/runs/41288947574/job/124795971915)。

三轮真实 Codex 使用同一工单、原生会话和 Git worktree，测试分别通过 3、4、5 项；最后独立验证负数数量抛出 `ValueError`。6 条远端收据与实际评论一一对应，重复同步不产生新执行或评论，源项目文件、HEAD 与暂存区保持不变。两次发布仅更新专用分支的两个 Python fixture 文件，PR 没有合并。完整结果、源码哈希和测试资源收尾记录见 [phase5-pr-ci-acceptance.json](phase5-pr-ci-acceptance.json)；之前的 [Issue 验收记录](phase5-acceptance.json) 保持原样。

最终包级检查通过 174 项 Node 测试，以及内存、SQLite 各 144 项上游领域测试；安装包协议、外部类型消费、仓库整体检查均通过。真实入口为 `npm run test:github:pr:real`，默认 `npm run check` 不访问 GitHub 或模型。

复跑需要新的专用 Issue、同仓库草稿 PR、`codex/js-superagent-pr-*` 分支和固定验收工作流；具体 fixture 内容与前置校验见 [real-github-pr-smoke.mjs](../examples/real-github-pr-smoke.mjs)。

```bash
npm run test:github:pr:real -- --write \
  --repository owner/repository --issue 2 --pull-request 3 \
  --actor trusted-login --branch codex/js-superagent-pr-example \
  --output /absolute/path/to/new-evidence-directory
```

此显式验收脚本会调用真实 Codex，发送测试审阅及结果评论，并将恰好两个 fixture 文件发布到指定测试分支，以验证真实 Actions 从失败变为成功；它不合并 PR，也不关闭 Issue／PR。发布动作属于专用验收脚本，不是 `github link`、常规 `run/serve` 或 AgentDriver 自动具备的功能。证据目录必须是新目录，保留此前结果。

App 安装认证与签名 Webhook 已通过本地回归及真实 Issue 闭环验收，证据与本页的 gh PR／CI 验收分别记录。本页的真实 PR／CI 验证路径仍为 gh，本轮 App 实测范围为 Issue 接单和反馈闭环。后续范围仍包括 fork PR、语义 Assessor、自动创建／推送／合并 PR 与生产环境部署。当前结果仍留在固定工作区，是否采纳由操作者决定。
