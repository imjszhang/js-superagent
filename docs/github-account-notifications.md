# 专用 GitHub 账号与通知轮询

对齐 dsh-superagent-prototype 的 GitHub 工作方式：专用用户账号通过 GitHub CLI 登录；后台轮询该账号的通知，读取原始讨论、识别授权真人的 @提及，经现有协调者和工单流程交给 Codex 或 DSH 执行，再以同一专用账号回传。js-superagent 仍独立运行，不依赖 DSH 插件或 js-agent-runtime。

## 配置

准备专用 GitHub 用户账号，并授予目标仓库写权限。账号必须与 `allowedActors` 中的真人操作者分开。建立独立 CLI wrapper，例如：

```sh
mkdir -p ~/.local/bin
cat > ~/.local/bin/gh-agent <<'SH'
#!/bin/sh
GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
SH
chmod +x ~/.local/bin/gh-agent
~/.local/bin/gh-agent auth login
~/.local/bin/gh-agent api user --jq .login
```

登录需由账号持有人完成，不在聊天、项目配置或日志中粘贴 token。新模式由宿主清除环境中的 GitHub token，固定核验预期账号；身份不符时拒绝继续，不回退个人 `gh`。

新项目可用：

```sh
js-superagent init --github-repo owner/repo --github-actor human-login \
  --gh-path /absolute/path/to/gh-agent --github-agent-login agent-login
```

已有项目使用同样的选项执行 `config set`；从 App 切换时同次添加 `--github-app-disable`。运行中的项目需先等活跃工作结束，再停止并重载服务；不要只改配置文件绕过运行时检查。切换前用专用 CLI 确认仓库可访问及具有写权限，保留原配置以便恢复。

等价 SDK 配置：

```js
const github = {
  repository: 'owner/repo',
  allowedActors: ['human-login'],
  executable: '/absolute/path/to/gh-agent',
  account: { login: 'agent-login' },
  pollIntervalMs: 60_000,
};
```

`account` 与 `app` 互斥。移除专用账号模式用 `config set --github-account-disable` 或 `configureV2({ github: { account: null } })`。已有 App、普通 gh、CLI/SDK 工单、Codex app-server、DSH SDK 的配置继续有效，无需升级数据库。

通知进入现有来源与协调者流程：需配置有效的协调者 assessor 来研判接单，可继续使用既有 Codex/DSH 配置。`coordinator status` 查看当前配置；SDK 使用 `configureCoordinator`，CLI 使用 `coordinator set <JSON文件> <当前revision>`。未配置协调者时，候选会保留，不会凭空调用执行端。

## 接单与接续

启用后首轮建立时间基线，不重放以前的通知。之后在新 Issue、PR 或新的评论中写：

```text
@agent-login 请修复这个问题，并运行相关测试。
```

通知只是发现讨论的线索；后台重新读取原文，核对仓库、账号、发起人、提及位置、PR 当前版本及授权范围。同轮多个评论均会读取，不只读取通知中的最后一条评论。正文编辑不能证明编辑者身份，不能通过修改旧正文替代新的授权评论。代码块、引用或机器人的文字不构成真人委托。

绑定工单后，Issue、PR 审阅和配置允许的 CI 反馈仍由原有接续流程跟进。专用账号模式不为了发现新任务扫描全部开放 Issue；显式 `issues` 范围和已绑定讨论继续轮询。取消等既有命令仍可使用。

通知轮询最少 60 秒，并尊重 GitHub 返回的更长间隔。游标、基线、身份和失败线程保存到独立存储，重启后继续；同一原文事件沿用现有去重。单个线程读取失败保留有限重试，不阻塞其他线程；不修改用户通知的已读状态。其他显式启用的仓库观察流保留。账号模式自动启用提及来源；退出该模式后恢复原仓库来源设置。

用 `github status` 查看 `intake: account-notifications`、配置账号和已核验提及身份，用来源状态查看游标与错误。SDK 的 `createGitHubChannel(config).probe()` 校验身份、仓库写权限和通知读取权限。`github sync` 只同步原有显式/关联讨论；通知来源随 `run`/`serve` 的来源轮询推进。

## 本次验证与本机状态

新增认证、通知和 CLI/SDK 集成的定向测试：身份隔离、HTTP 响应头、分页、多条提及、失败重试、旧事件基线、账号固定、工单执行回传及重启去重。测试使用隔离项目，不调用付费模型或写 GitHub。

历史环境曾完成专用账号的只读通知 API 核对，但当时对目标私有仓库无访问权，因此未切换原配置。该记录不表示当前安装具备仓库权限；使用前请核对专用账号的实际授权。

上游依据：[部署账号说明](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/006-deployment.md)、[通知轮询实现](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/sources/github.ts)。

验证中还运行了现有 config 测试文件：其 GitHub 配置用例通过；4 个旧执行端用例仍写入已退役的 `driver: codex`，在原有校验处失败，本次未修改执行端迁移规则或这些历史用例。


## 多项目通知隔离（M3）

各项目现在读取 `GET /repos/{owner}/{repo}/notifications`，不再获取整个账号的通知后过滤。认证传输仅允许配置仓库的通知 GET，连通性检查使用同一端点；不同仓库仍共享账号的 GitHub 配额，但不会互相消耗通知扫描页数。不改变账号、App 模式、授权范围或通知已读状态。

通知游标格式升级为 3，首次运行自动接续格式 2 的启用时间、已处理水位、重试线程和仓库来源游标；不重置基线。每轮扫描固定时间窗口，单轮达到页数/线程预算后保存窗口和续页。下次继续旧窗口，读完后才推进水位；按通知更新时间缩小范围并保留一秒重叠，同一时间戳的多页继续翻页，由既有事件 ID 去重。源状态中的 `cursor.scan` 显示窗口、当前页与已读取页数，`retries` 和 `nextAt` 分别显示待重试线程及下次允许读取时间。

首次启用增加不超过 15 秒的小幅错峰；后续遵守至少 60 秒及服务器的 `X-Poll-Interval`。服务器提供 `Last-Modified` 时，对固定的仓库通知检查端点使用条件请求；304 不重读已处理线程，待重试线程仍处理。动态分页端点不会复用其他 URL 的条件请求头。限流保留扫描水位，并按 `Retry-After`／配额重置时间和有限指数退避推迟请求，错误不回显响应正文或凭据。

GitHub 通知列表不是不可变快照，持续修改的同时间戳大页仍依赖后续通知及原有绑定讨论轮询补读；这些措施不构成跨系统“恰好一次”保证。单个讨论超过读取预算时保留重试，不用截断结果推进授权。后台仍保持停止，本阶段只用本地模拟传输和短测试进程验证，未作真实账号切换或远端接单验收。
