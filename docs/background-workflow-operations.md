# 项目后台控制、上下文与健康检查

本轮补齐项目级后台运行的四个工作流程缺口。js-superagent 继续独立维护工单、存储与调度，使用 Codex app-server 或 DSH SDK 执行，不依赖 js-agent-runtime。CLI/SDK 工单入口保留。

代码基于 `0.9.0-alpha.0` / schema 10；使用既有本地元数据存储，不新增数据库版本。源码更新不替换已安装的后台包。本轮没有部署、启动或升级生产状态，W18 继续暂缓，飞书暂不配置。

## 1. 向工单的后台进程提交操作

后台正在持有项目执行权时，另一个 CLI/SDK 实例或本机面板会把以下操作写入本项目控制队列，由原后台执行：

- 受管理任务的消息、回复、接续、取消、预览续期和关闭。
- DSH 原生预览续期和关闭。
- 宿主验证、结果交付、已登记的 PR 审阅动作、关联 PR。
- 子任务成果采纳/恢复、会话替换。

原有命令和 SDK 方法仍可调用；跨进程时返回包含 `operationId` 的控制收据，`status: queued` 仅表示排队。没有其他后台持有项目时，原方法仍按既有方式直接执行。显式 `requestControl` 必须有支持控制协议的运行中后台；不会为了处理请求自动启动它。

```sh
js-superagent --project /path/to/project control list
js-superagent --project /path/to/project control show <operationId>
js-superagent --project /path/to/project control request /path/to/request.json
```

例如，`request.json` 中使用稳定的请求标识：

```json
{
  "requestId": "verify-ticket-2026-11-03-1",
  "method": "verifyTicket",
  "args": ["ticket-id"]
}
```

SDK 提供 `requestControl(request)`、`controlStatus(operationId)` 和 `listControls({limit})`。同一个 `requestId` 与相同参数返回原收据；参数不同会被拒绝。需要执行新操作时使用新的标识，并先核对前一次结果。

| 收据状态 | 含义 |
| --- | --- |
| `queued` / `running` | 原后台尚未处理 / 正在处理 |
| `completed` | 方法调用结束；仍需检查 `result` 的业务结果，不能直接等同验证通过或交付成功 |
| `failed` | 工单、会话、工作区或设置已变化，前置核对未通过 |
| `cancelled` | 原后台已退出，未开始的操作不转交给新后台 |
| `unknown` | 执行后未能确认结果，须先核对工单及外部副作用；不自动重放 |

请求绑定本项目、本次后台运行及目标工单快照。最多保留 128 个当前后台的待处理请求，单请求参数上限 32 KiB。停止后台后不再领取后续操作。业务暂停时，明确的人工控制仍可处理；停止服务与暂停业务是不同操作。

本机面板已有操作按钮复用该通道，“后台健康与操作记录”可查看收据。HTTP 的 `/api/controls` 和单条查询使用原有本机认证、来源校验和脱敏规则，交付仍要求本地可信交付策略。此通道不是任意 SDK 方法调用入口。

## 2. 把讨论线索交给已有工单

已订阅且授权仍有效的活跃 GitHub 工单，可以收到未列名真人、工具机器人等提供的范围内上下文。处理使用领域 `note`，保留原事件和原文读取入口，与明确委托的接单归属分别记录；Worker 不能将这些上下文确认成自己接下的新请求。

只作用于排队、运行或普通等待中的工单。暂停、撤权、取消、结束、失败、阻塞、等待人决定或待交付的工单不会因此被唤醒。暂停期间已有收件流程保留事件，恢复后重新核对资格。

每条摘要最多 4,000 字，单工单未读上下文最多 100 条 / 64 KiB，单机器人每工单 5 分钟最多 5 条。保留事件去重和修订退役；PR 仍核对关联及当前 head，审阅机器人仍要求已有审阅轮次预算，CI 仍要求配置中的可信身份。这些讨论线索不能扩大原工单授权范围。

## 3. 区分进程状态与业务健康

```sh
js-superagent --project /path/to/project service status
js-superagent --project /path/to/project service health
```

`status` 保留原进程/启动状态；新增的 `health` 为外部只读诊断。新版服务中的 CLI 每 5 秒发送精简心跳，20 秒未收到有效心跳即报告 `stalled`。心跳绑定本次运行 ID、序号、父子进程及进程启动身份，旧记录和 PID 复用不能证明当前服务正常。

报告区分未安装、停止、启动中、重试、配置阻塞、未观测、失活、业务异常、业务暂停和正常。同步过期、模型等待和未处理故障会反映在业务健康中。旧服务没有新版心跳时显示 `unobserved`，不会假定健康。SDK 使用 `createServiceManager({projectRoot}).health()`。

心跳不保存任务正文、模型输出、凭据或原始错误正文。检查只报告状态，不自动启动、重启或结束进程；用户手动停止的服务继续保持停止。面板“后台健康与操作记录”提供同样的只读检查。

## 4. 统一检查项目设置

```sh
# 本地静态检查，无模型和远端访问
js-superagent --project /path/to/project setup check

# 明确请求执行端元数据、登录状态和 GitHub 只读访问检查
js-superagent --project /path/to/project setup check --check-connections
```

SDK：`await checkProjectSetup({projectRoot, checkConnections:false})`。报告按本地、GitHub、后台服务给出 `ready`、`needs-check`、`blocked` 或未配置状态，以及可操作的下一步。CLI 存在阻塞时退出码为 1。

检查覆盖 Node 版本、配置、数据库版本、实例身份、重叠目录、仓库归属、实际持久化执行端、程序可用性、凭据引用、工作区及服务状态。不会初始化未配置项目、创建机器登记、迁移数据库、申请执行权或启动服务。面板“项目设置检查”只执行静态检查。

显式连接检查也不调用付费模型、不发 GitHub 测试评论。GitHub App 的写权限、模型供应商实际可用性、服务独立安装版本及私有环境仍可能显示待检查；不能把本地程序存在或仓库可读当作全链路验收通过。

## 验证范围

只运行本轮相关的离线定向检查、类型检查和仓库要求的资料一致性检查，覆盖独立 Node 进程提交控制、原后台领取、停止后不重放、上下文资格与预算、心跳身份和过期、只读设置检查、HTTP 权限与面板状态。

未运行完整测试套件、真实模型或远端 GitHub 写入验收，未进行生产服务切换。两个原有 W27 测试 fixture 缺少当前 GitHub 身份探测所需的 `/user` 响应，在进入接单逻辑前失败；本轮未扩大修改这些旧 fixture。

## 2026-11-03：接续修复与事件排障

本次继续修复四处已识别的行为缺口：

1. **在线 PR 关联。** 原后台在没有执行、同步或回传占用的安全空档领取关联操作；忙碌时收据保持 `queued`。读取和写入关联期间持有同步锁，保留 PR 身份、当前 head、授权及取消核对。同一后台实例的 SDK 调用也返回控制收据；停止状态的原调用方式保留。解除 PR 关联仍要求原有停止条件。
2. **同一 Issue 的多个工单。** 根据真实线程订阅逐工单检查并投递，旧单值映射仅用于历史兼容。一个工单被取消或撤权，不再挡住另一个合法工单的反馈；暂停时先保存事件，恢复后按当前状态重新核对。保留上下文与任务归属的区别。
3. **上下文与主动候选分别处理。** 已关注讨论的消息可以同时成为原工单的上下文和当前准入策略允许的新候选。未获准入的消息仍不产生新工作；显式命令和真实 @mention 路径保留。
4. **人工状态请求优先。** `request-status` 可以使用预留的人工交互槽，并按人工输入优先排序；普通笔记、上下文和自动恢复输入不因此获得优先权，总并发上限不变。修复了纯文本输入在 PR 反馈检查中被误作事件 ID 查询的问题。

领域内核只增加限定既有订阅投递的必要本地扩展，来源版本和原始哈希仍保留；精确差异见[内核提取记录](core-extraction.md)。没有引入 DSH 运行时依赖，没有新增数据库版本，W18 继续暂缓。

### 查看为什么没有接单或回传

本机面板新增“事件处理与回传排障”，支持按来源、内容/编号/原因搜索，以及仅显示需要检查的记录。收到的事件可以展开查看：

- 接收、过滤或暂停原因，以及逐工单处理结果。
- 正在等待/进行的研判、已有判断及其理由。
- 到达的工单、只作上下文、接单确认或交回原因，以及执行端是否已读取。
- 直接回复与同工单/讨论的相关回传，分别标明。回传展示等待、失败重试、发送成功或丢弃，以及已有的失败原因和重试时间。

“发出的回复”也可以独立查找没有对应原始事件的回复。相关工单、判断、原事件及讨论记录可继续打开。旧记录缺少原文或原因时明确说明，不把没有记录当成成功；没有回传也不表示系统必须发送回复。

CLI 与 SDK 使用同一只读投影：

```sh
js-superagent --project /path/to/project diagnostics events
js-superagent --project /path/to/project diagnostics event <event-id>
js-superagent --project /path/to/project diagnostics replies
js-superagent --project /path/to/project diagnostics events /path/to/filters.json
```

过滤文件示例：`{"source":"github","problemsOnly":true,"query":"locked","limit":20}`。后续页把返回的 `nextCursor` 作为 `cursor` 传入；切换项目、查询或筛选条件时重新读取第一页。

SDK 对应 `eventDiagnostics(options)`、`eventDiagnostic(id)`、`replyDiagnostics(options)`。列表最多每页 100 条，正文及关联集合有界；详情通过现有原始记录入口继续读取。HTTP 入口沿用本机认证和脱敏，搜索在脱敏之后进行，避免通过搜索命中泄漏被隐藏的内容。

所有诊断只读取既有事件、判断、投递和回传记录，不重试、不重新判断、不启动模型或后台。没有另建事件存储系统。此次只做新增及直接相关的离线定向检查、类型和来源校验；原有一条关闭 PR 测试在隔离的修改前版本中也因旧行为预期失败，未扩大修改。没有真实模型、远端写入或生产切换验收。

仓库资料索引刷新成功；根目录 `npm run check` 中技能、工作流及配置检查通过，在 `topics:check` 因现有选题表未更新而停止。本次不修改这些包外资料。后台只读检查结果为 `loaded: false`、`running: false`、`health: stopped`。
