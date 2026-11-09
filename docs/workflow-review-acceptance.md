# W30–W35：审阅交付与使用体验交付记录

日期：2026-11-03。基线 `5b83cdad`；工作区版本 `0.8.0-alpha.0`，schema 9。实现对应 [完整计划](workflow-review-plan.md)，不依赖 js-agent-runtime，不改变 CLI/SDK 工单入口和 Codex app-server／DSH SDK 的选择方式。

## 本轮能力

| 项目 | 已接通的行为 | 主要验证证据 |
| --- | --- | --- |
| W30 PR 交付和审阅 | 同一 PR 更新当前报告、验证结果和限制；保留人工正文段落与标题冲突。持久化请求审阅、解决原线程和转为正式待审意图，写前重验授权/head/工作区，未知结果先对账 | 临时真实 Git 与模拟 GitHub 的两轮交付；动作重放、线程映射、描述冲突和 App 固定操作检查 |
| W31 bot 收敛 | 每 PR ID＋bot ID 默认三轮；同一原生 review 多个 finding 共用一轮，跨重开/工单/会话保留。未知 run/旧历史、超额消息只观察；有限人工追加有修订与原因 | 持久账本、数据库重开、第四轮拒绝、真人和 CI 混合续作、候选准入与派工门禁 |
| W32 原生 mention | 核验个人账户或 App bot 后识别明确寻址，与 slash 共存；专用发现不要求开启普通评论流。原始消息/修订、原授权、原处回复与重复去重保留 | 普通流全部关闭的新 Issue/PR 正文和行内请求接单、回复、Webhook/轮询去重和重开 |
| W33 草稿 | 项目隔离的 sessionStorage 草稿；同标签页刷新恢复，字段三方合并，冲突逐字段选择；保存/发送期间新输入保留 | 定向状态转换检查；内置浏览器实际刷新、并发修改、冲突选择和保存 |
| W34 原生预览 | DSH alpha.2 通过可信 profile 启动并登记原生 job，核验进程/端口后 ready 留存，独立租约、续期和静默结果收取；取消、到期、停止回收 | 假 SDK 与宿主场景；一次真实本机 alpha.2＋loopback 短验收，续期跨原 run 期限，关闭后 guardian 全部退出 |
| W35 兼容收口 | schema 8→9 明确升级和备份、旧写者拒绝、CLI/SDK/UI 公开入口、原生预览的维护锁/恢复证据 | 临时旧库与恢复备份准备、局部 CLI/API 配置检查、公开类型、构建和上游摘要 |

这些证据不等于真实 GitHub 远端写入或外网模型验收。本轮没有启动生产服务、打开或迁移生产数据库、发布 npm、提交或推送。

## 配置与使用

新审阅动作默认全部关闭。在既有交付设置中明确增加：

```json
{
  "review": {
    "ready": true,
    "requestReviewers": true,
    "resolveThreads": true,
    "reviewers": ["allowed-reviewer"],
    "teams": []
  }
}
```

此片段须合并到现有 `draft-pr`／验证设置，不是完整交付配置。GitHub App 还须已获相应远端权限，并在本地配置 `github.app.pullRequestReviews:true`；本包不自动修改 App 权限或改用其他身份。只开放固定、仓库绑定的操作，不给模型任意 GitHub/GraphQL 写入。

```sh
js-superagent review status <ticket-id>
js-superagent review request <ticket-id> /absolute/path/to/review-request.json
js-superagent review run <request-id>
js-superagent github bot-review status
js-superagent github bot-review set <pr-number> <actor-id> /absolute/path/to/budget.json
js-superagent github bot-review associate <pr-number> <actor-id> /absolute/path/to/association.json
```

审阅 JSON 以 `kind` 选择 `requestReviewers`、`resolveThread`、`ready`；收件人必须来自允许名单。解决线程需要原始 `commentId`、`triggerId` 和具体修复 `reason`，宿主读取真实 thread ID，核对已读输入、当前验证及已推送 head。Worker 用同一宿主工具提交意图，实际执行在交付完成后；新 PR 尚未同步时等待，不凭空假定来源健康。动作结果与工单待审状态分别显示。

预算 JSON 为 `{"remaining":1,"reason":"明确允许再处理一轮","expectedRevision":3}`，以当前记录 revision 为准；单次显式设置剩余 0–3 轮，不把普通“继续”当成追加。未知 run 可用 `{"runId":"operator-verified-run","eventIds":["原始事件 ID"],"reason":"核对依据"}` 明确关联。初始化/关联本身不自动重放历史 ignored 输入；随后明确重新评估，仍须通过当前授权与预算门禁。

在仓库来源设置中开启 `enabled` 和 `streams.mentions`。启动本轮同步后才能得到可信账号身份，状态页显示识别失败原因。首次开启建立新基线，不补发历史任务；关闭再开启增加代次，旧 Webhook selector 不重新授权。引用、代码、错误账号不能构成明确寻址。仅一个 mention 没有具体要求时进入研判/澄清。旧正文编辑无法核验编辑者时只观察，应由授权人发新评论提出任务。

管理页为上述设置、审阅请求、预算关联及原生预览提供同一宿主路径。表单草稿按项目和工单分开保存；合并后仍需点击保存，不自动发送或执行。存储不可用时退回页面内存并提示；关闭标签页后的恢复不在保证范围。

## DSH 预览边界

需要 DSH `0.2.2-alpha.2`、可写 Worker、可信命令 profile 和 Assignment 生命周期任务配置。`js_superagent_native_preview_start` 仅选择宿主注册的 profile；启动命令前登记监督进程，核验 loopback endpoint 属于该 job。公开 JobView 不提供可核验的任意进程归属，因此不收编随意启动的 bash job。rc.5 和只读角色不声明此能力。

非预览工作全部结算、当前输入已读、宿主验证匹配当前内容后才可 ready。PR 待审时保留预览并释放 Worker 名额，验证与受控审阅操作仍可用。普通构建/测试 job 不能提前 ready；验证未通过不会掩盖为成功。

```sh
js-superagent native-preview renew <ticket-id> <lease-id> <job-id> [ttl-ms]
js-superagent native-preview close <ticket-id> <lease-id> <job-id>
```

默认续期 30 分钟，单次最多两小时，并受项目时长配置和 Assignment 生命周期约束。续期更新原生计时器和宿主记录，保留等待期间已收取的结果；关闭会释放该交接记录的整组预览。取消/撤权/替换会话/工单结束/宿主停止均清理；崩溃重开只核对和回收，不重启服务器。工具回执不足以证明进程已经结束。Codex 继续使用已有受管预览路径。

W18 原待处理队列自动采用仍暂缓：不伪造新输入、不发空消息、不调用私有唤醒接口。

## 迁移、回退和运行状态

schema 9 写入语义阻止旧包忽略审阅预算和预览归属。只读查询旧库不升级；显式 `upgrade` 或新写入沿用维护锁和一致性备份。旧 PR 的实际处理轮数无法证明时设为历史未知，需本地明确初始化剩余预算，不能伪造零轮。旧配置不自动获得审阅动作权限或 mention 入口；旧工单、会话、评论、CI、交付收据保留。

回退须先停止所有运行者与原生预览，使用升级前备份准备恢复，并明确核对备份之后已发生的远端动作。恢复数据库不会撤销 GitHub 操作。持有活跃/无法核验的原生 owner 或 guardian 时拒绝数据库维护。

生产安装仍未切换；本轮只读服务状态为 `loaded=false`、`running=false`、`pid=null`。内置浏览器使用独立临时库和前台管理页面，结束后关闭。未跑本包完整 `npm test`／`npm run check` 或大规模 pack/模型矩阵。

## 有限验证记录

- W30：5 个动作模块场景、描述同步与既有相关场景、独立 App 权限检查；一个约 8 秒的临时 Git＋模拟 GitHub 宿主闭环。
- W31：账本同轮/未知历史检查，宿主重开/额度/真人和 CI 混合场景；候选合并和等待人工的预算边界仅做对应局部检查。
- W32：mention 识别、专用来源与宿主接单/回复/重开；对应旧来源和准入定向回归。
- W33：字段冲突、储存隔离、保存中继续输入等局部检查；真实内置浏览器把本地并发草稿 3 与远端 4 的冲突明确保留本地，同时自动合并远端预留槽位 1，保存成功。截图仅在本地临时文件保留。
- W34：短协议/归属检查及 3 个宿主场景；真实 alpha.2＋loopback 仅执行一次，2 次本机 provider 请求，续期跨原 12 秒期限，无新模型唤醒，关闭后全部 guardian 退出。
- W35：3 个临时迁移/CLI 场景；静态构建和 18 项上游摘要检查通过，公开类型、差异检查及根项目 `npm run check` 通过；`npm run store:bootstrap` 已刷新索引。根项目另报告 3 份既有本地渲染缺失和 24 条资料追溯提醒，均不属于本包本轮错误。Codex 和 DSH 各一个宿主工具合同短检查通过。

最终预算复核补齐：等待人工时记录的 bot 消息不消耗轮次，也不进入后续 Worker 的自动任务快照；合并候选若包含超额轮次，连同工单范围和预算预留整体回滚，供人工拆分。对应两个宿主场景通过。


## 本轮后续补齐

2026-11-03 后续审计发现的实际接续缺口已在当前未发布版本修复，详见[工作流程补齐记录](workflow-completion.md)。该记录更新审阅重试/逐线程处置、出站预算、托管预览、子任务多轮、管理和 UI 证据边界；本页较早的验证记录仍保留作为当时证据。
