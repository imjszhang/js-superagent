# 第五阶段第三部分：GitHub App 与 Webhook

GitHub 渠道现已支持 App installation 身份，以及经过签名校验的 HTTP Webhook 入口。原有 `gh` 轮询、Issue 接单、PR／CI 关联、本地 CLI/SDK 继续可用。App 认证和 Webhook 可以分别启用；配置和导入 SDK 都不会自动监听网络。

**后台持续运行不要求 Webhook 或公网地址。** 可以只用 App 身份轮询，并在 macOS 上通过 `service install --mode poll`／`service start` 保持后台接单；需要 GitHub 主动推送时才配置 HTTPS 和 `webhook` 模式。后台生命周期及重启边界见[后台运行与重启恢复](background-service.md)。

**当前状态：实现、本地回归及真实 GitHub App／Webhook 验收均已通过。**2026-11-01 从本地 tarball 安装，在 [Issue #5](https://github.com/imjszhang/x-pkm-research/issues/5) 跑通真实签名接单、两轮 Codex 修改与验证、同工单反馈续作和 App Bot 回传，证据见 [App／Webhook 验收记录](phase5-app-webhook-acceptance.json)。此前使用 `gh` 的 [Issue 验收](phase5-acceptance.json) 与 [PR／CI 验收](phase5-pr-ci-acceptance.json) 分别保留。

早先网页注册阻塞保存在 [阶段状态记录](phase5-app-webhook-status.json)，用于说明历史过程；当前以完成后的实际验收记录为准。

## 事件如何进入原工单

Webhook 是“请重新核对 GitHub 状态”的持久化提示，不直接把 payload 正文交给 Worker：

1. 接收原始字节，先用 HMAC-SHA256 核对 `X-Hub-Signature-256`，再解析 JSON。
2. 检查配置仓库、App installation、Issue 范围、PR 绑定或 CI 来源和当前提交范围。
3. 在同一 SQLite 事务中保存 delivery ID、事件类型、正文 SHA-256、来源、接收时间、路由选择条件和配置指纹，并排入重新核对动作。**不保存原始 payload、签名或凭据。**
4. 落盘后返回 `202`。后台下一轮立即调用既有 `syncGitHub()`，不等待正常轮询间隔；HTTP 请求自身不调用 GitHub REST 或模型。
5. REST 重读沿用现有身份、命令、授权和版本检查；事件以同一套 Issue／评论／审阅／CI 原生 ID 去重。最终结果仍通过 Outbox 回传。

这里的“立即”指下一次运行时调度，不承诺抢占正在执行的 Worker。多个提示可以合并为一次同步；当前同步读取整个配置范围，选择条件还不是单资源增量抓取。轮询继续补充检查漏送或延迟事件，启用 Webhook 不会产生第二套工单。

相同 delivery ID、相同事件和正文哈希返回 `200 duplicate`；相同 ID 对应不同事件或字节返回 `409`。不同 delivery ID 重送同一远端事件，也会在 REST 原生 ID 层去重。网络失败时提示保持待处理，持久化动作按退避重试；重启后可以继续。配置变化后，旧配置下尚未处理的提示会记为忽略，后续同步依据新配置重新检查。

尚有待处理 Webhook、同步失败或其他实例正在同步时，新一轮 GitHub 工单会等待重新核对完成；本地任务仍可执行。启动远端 Worker 前会在同一事务内再次检查，避免 App 撤销权限事件到达后，另一实例提前启动已排队的工作。

接收事件包括 Issue 开关／新评论、已关联 PR 的状态／审阅／行内评论、显式可信 CI，以及当前 App 的安装状态变更。`ping` 和范围外事件记为忽略。安装变更只要求重新核对，不自动授予新仓库或新权限。编辑 Issue／评论正文不会成为新委托；REST 快照仍无法证明每一次编辑者，签名提示模式不改变这一边界。

## App 认证与权限

配置 `github.app` 后，原生 HTTP transport 使用 RSA 私钥签发 RS256 JWT，换取指定 installation 的短期 token。token 请求明确限定当前仓库；响应还要核对仓库和权限范围。token 只在内存缓存，在过期前刷新，并合并并发换取请求。GET 的 `401` 最多刷新后重试一次；评论 POST 不盲目重试，交由 Outbox 对账。

| 仓库权限 | 用途 |
|---|---|
| Metadata：read | 仓库元数据 |
| Issues：write | Issue 接单与 Issue／PR 会话评论回传 |
| Pull requests：read | PR 元数据、审阅、行内评论 |
| Checks：read | 启用 `ci.checkApps` 时读取检查 |
| Commit statuses：read | 启用 `ci.statusContexts` 时读取状态 |

注册 helper 申请表中权限；运行时 token 的 Checks／Statuses 权限仅随配置的 CI 功能请求。现有评论回传使用 Issues comments API，其写权限接受 Issues 或 Pull requests 二者之一，因此无需为此申请 Pull requests：write。[GitHub 官方接口权限](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)

App 使用自己的 Bot 账号发送评论。对账核对不可变 Bot ID，并在评论携带 `performed_via_github_app` 时核对 App ID。请求固定到 `api.github.com`，拒绝重定向及配置仓库之外的请求；App 模式不回退到 `gh`。目前不支持 GitHub Enterprise 自定义 API 地址。

## CLI 配置与监听

下列命令用于已安装的本地 tarball；从源码使用 `node bin/js-superagent.mjs`。先创建和安装 App，准备私钥文件及与 GitHub Webhook 设置完全一致的 secret 文件：

```bash
js-superagent --project /path/to/project config set \
  --github-repo owner/repository --github-actor trusted-login --github-issue 123 \
  --github-app-id 123456 --github-installation-id 789012 \
  --github-private-key-path /private/path/app-key.pem \
  --webhook-secret-path /private/path/webhook-secret \
  --webhook-host 127.0.0.1 --webhook-port 8787 --webhook-path /github/webhook

# 可先进行一轮 REST 接单和回传，不调用模型
js-superagent --project /path/to/project github sync

# 前台接收 Webhook，持续调度任务，保留正常轮询
js-superagent --project /path/to/project github listen

# 另一个终端查看已落盘的交付和错误
js-superagent --project /path/to/project github webhook-status
js-superagent --project /path/to/project github status
```

GitHub 主动投递 Webhook 需要可访问的 HTTPS 地址。由部署者配置 HTTPS 反向代理或固定隧道，转发到本机监听地址；临时隧道只用于验收。包不自动创建公网入口或管理 TLS。`github listen` 会执行已授权任务并回传评论；Ctrl+C 关闭接收器并等待运行时停止。原 `serve` 仍持续轮询，不会自动启动 HTTP 接收器，也不要求公网地址。macOS 后台服务可显式选择 `poll` 或 `webhook` 模式，见[后台服务](background-service.md)。

私钥也可用 `--github-private-key-env JS_SUPERAGENT_APP_KEY` 引用环境变量；Webhook 可用 `--webhook-secret-env JS_SUPERAGENT_WEBHOOK_SECRET`。每种凭据的 env／path 恰选一种，参数接收的是变量名或路径，不是秘密正文。私钥必须是至少 2048 位、未加密 RSA PEM。配置文件保存引用；相对路径按源项目目录解析。secret 文件按原始字节读取，避免意外添加末尾换行。

`app` 和 `webhook` 每次更新都替换各自完整子配置，不进行字段拼接。改端口时须同时给出 secret 引用；改 App 时须同时给出 App ID、installation ID 和私钥引用。SDK 中分别传 `null` 可移除；CLI 对应 `config set --github-app-disable` 与 `config set --webhook-disable`。前者回到原生 `gh` 登录，后者只移除 Webhook 配置。执行或同步期间不修改配置。

默认 CLI 监听为 `127.0.0.1:8787/github/webhook`，请求体默认上限 1 MiB、可配置至 25 MiB。HTTP 接收器限定未压缩的 JSON、单值关键请求头、请求时限和并发数。无效签名返回 `401`，超限返回 `413`，待处理提示达到上限时返回 `429`；失败响应不回显请求正文、凭据或内部异常。

## 尚未创建 App 时的注册入口

本地 helper 生成 GitHub manifest 表单。它只监听 loopback，不自动打开浏览器，也不自动注册 App；用户在 GitHub 页面确认创建和安装：

```bash
node examples/github-app-setup.mjs \
  --repository owner/repository \
  --webhook-url https://your-public-host/github/webhook \
  --output /absolute/path/to/new-private-control-directory \
  --port 18377
```

打开终端打印的 `setupUrl`，点击前往 GitHub，创建私有 App；返回本机后进入安装页，选择 **Only select repositories** 并仅勾选目标仓库。注册页面使用随机路径和 state；一次性 code 仅在固定 GitHub API 兑换。私钥和 webhook secret 分别以 `0600` 权限、不覆盖方式写入 `.env.github-app-key.pem`、`.env.webhook-secret`，`app.json` 只记录公开标识与文件路径。安装回调会用 App JWT 查询目标仓库的 installation，核对 App、账号、安装编号及 selected repository 模式后才保存 `installationId`。

默认 `--owner-type user` 面向当前登录账号自己的个人仓库。组织仓库必须追加 `--owner-type organization`，由组织所有者或获准管理组织 Apps 的成员注册；helper 将使用对应组织的 App 设置入口。私有 App 只能安装到所属账号或组织。[GitHub 官方 manifest 注册流程](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)

manifest 订阅七个业务事件：`issues`、`issue_comment`、`pull_request`、`pull_request_review`、`pull_request_review_comment`、`check_run`、`status`。`installation` 与 `installation_repositories` 由 GitHub 自动发送，不能手工订阅。[GitHub 官方事件说明](https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation)

注册和安装必须在 helper 仍运行的本机完成。临时隧道地址变化后，需要在 GitHub App 设置同步更新 Webhook URL。已有 App 可以直接配置，helper 不是运行时依赖。

如果 GitHub 提示 `Unable to load App Manifest`，可在已正常登录 GitHub 的常规浏览器中重新打开本机入口。若仍失败，可改用 GitHub 的标准 New GitHub App 表单，按本页权限、事件及 Webhook 设置手工创建，再下载私钥并配置安装编号和 Webhook secret。该提示本身不能确定是 Cookie、浏览器还是服务端问题；当前没有证实本次失败的具体原因。手工注册不会经过 helper 的凭据保存回调，需要自行将凭据保存到受保护的文件或指定环境变量。

## SDK

```js
import { createProjectAgent, listenGitHubWebhook } from 'js-superagent';

const agent = createProjectAgent({
  projectRoot: '/path/to/project', execution: { driver: 'codex-app-server' }, workspace: 'auto',
}).init();
agent.configure({ github: {
  repository: 'owner/repository', allowedActors: ['trusted-login'], issues: [123],
  app: { appId: '123456', installationId: 789012, privateKeyPath: '/private/path/app-key.pem' },
  webhook: { secretPath: '/private/path/webhook-secret', host: '127.0.0.1', port: 8787 },
} });
const config = agent.getConfig().github.webhook;
const receiver = await listenGitHubWebhook(agent, config);
agent.start();

// 宿主结束服务时调用：
await receiver.close();
await agent.stop();
agent.close();
```

宿主自行维护服务生命周期和信号处理。`listenGitHubWebhook()` 只启动接收器；不调用 `agent.start()` 时，可以手动 `await agent.processGitHubWebhooks()` 重新核对，再由 `runNext()` 执行任务。`receiveGitHubWebhook({ body, headers })` 同步验签并落盘，`body` 必须保留原始 `Uint8Array` 字节，不能先解析再序列化。`githubWebhookStatus()` 查看持久化交付；`githubStatus().webhook` 提供同一视图。旧 `receiveGitHubEvent()` 仍是可信适配器入口，不应直接挂到公网。

## 凭据与工作区边界

App 私钥和 Webhook secret 引用在项目内时，普通副本准备会同时排除配置路径与解析目录软链接后的真实路径；Git worktree／auto 遇到已被 Git 跟踪的凭据路径会拒绝执行。已有隔离工作区中出现对应文件也会拒绝继续。推荐把凭据保存在源项目之外，并由部署者维护文件访问权限。

运行时将配置的秘密环境变量名传给 Driver，内置 Codex 驱动会在启动监督器、CLI 及其继承环境前移除这些变量，不修改宿主 `process.env`。自定义 Harness 适配器 需自行遵守该约定。这些措施减少意外复制和继承，不是 OS 权限隔离：原地模式仍能访问源项目，同一用户的进程仍可能读取其他可访问路径。包没有新增容器或独立系统账号边界。

## 验证与实际验收

本地测试覆盖 JWT 签名与权限收敛、token 缓存／并发刷新／401、Bot 回执核对、注册／安装回调、原始字节 HMAC、重复与冲突交付、HTTP 限额及退出、持久化重启／退避、Webhook 与轮询去重、原工单续作和凭据工作区排除。默认检查使用注入 API／渠道及本机 HTTP，不调用真实 GitHub 或模型。

2026-11-01 的真实验收使用已注册并安装到目标仓库的私有 App。验收将常规轮询间隔设为一天，确认最初委托和关联反馈由真实签名交付触发；两轮执行复用同一工单、Codex 原生会话与 Git worktree，独立验证分别通过 3 项和 4 项 Python 测试。源目录文件、HEAD 和暂存区保持不变。

| 验证项 | 结果与证据边界 |
|---|---|
| GitHub 真实首次交付 | 两次 `issue_comment.created` 均返回 `202`；GitHub 记录的接收响应耗时为 0.67 秒、0.50 秒，不代表 Worker 完成耗时 |
| GitHub 官方重投 | 调用官方重投接口后，同一 delivery GUID 返回 `200`，接收器记录重复，没有新增执行或评论 |
| App 身份回传 | 接单确认与两轮结果共 3 条评论，均由注册 App 的 Bot 发送，收据中的 Bot ID 和 App ID 与远端一致 |
| 本机 HTTP 负例与去重 | 捕获交付原样重放返回 `200`；篡改原始字节返回 `401`；同 ID 不同内容返回 `409`；新 delivery ID 的同事件不会重复执行 |
| 重启与轮询兼容 | 重启后交付去重仍有效，额外轮询不新增工单／执行／评论；本地 CLI/SDK 入口及安装包回归继续通过 |

完整时间、交付元数据、收据链接、独立测试结果和源码摘要保存在 [phase5-app-webhook-acceptance.json](phase5-app-webhook-acceptance.json)。首次专用 [Issue #4](https://github.com/imjszhang/x-pkm-research/issues/4) 尝试因验收脚本将 GitHub delivery 数值 ID 当成 JavaScript 安全整数而断言失败；这是证据采集脚本的问题，运行时使用的 delivery GUID 未受影响。脚本改为按精确字符串处理后，在新 Issue #5 完整复跑通过。

验收收尾已关闭专用 Issue #4／#5、临时公网隧道和本机注册服务，App 与 installation 保留。长期使用 Webhook 仍需持续运行的 HTTPS 入口和运行时；只用轮询可以不部署 HTTPS。本次记录不代表已完成生产部署，后台服务单独说明与验收。复跑入口为：

```bash
npm run test:github:webhook:real -- --write \
  --repository owner/repository --actor trusted-login \
  --app-id 123456 --installation-id 789012 \
  --private-key-path /private/path/app-key.pem \
  --webhook-secret-path /private/path/webhook-secret \
  --public-url https://your-public-host/github/webhook --port 8787 \
  --output /absolute/path/to/new-evidence-directory
```

该脚本从本地 tarball 安装，默认创建专用验收 Issue（也可传 `--issue`），使用真实 Codex 修改隔离工程、验证并处理关联反馈，核对 App Bot 评论、真实签名交付、重送、篡改拒绝和轮询去重。需已配置的公网 HTTPS 转发、已安装的 App，以及用于测试者创建 Issue／发送反馈的 `gh` 登录；正常 App 渠道不依赖该人类测试账号。脚本会写测试 Issue 和评论，不发布代码、不合并 PR。详见 [真实验收脚本](../examples/real-github-webhook-smoke.mjs)。

持久化交付目前没有自动保留期清理；固定 HTTPS、集中监控、数据库扩容和跨主机多实例协调仍需后续部署工作。macOS 持续运行入口见[后台服务](background-service.md)，不能据此推定已有持续在线的公网入口。
