# 后台接续、在线设置与可选巡检

本轮继续补齐项目级后台运行时的接续和运维闭环。js-superagent 独立维护状态、调度和执行端适配，不依赖 js-agent-runtime；CLI/SDK、Codex app-server、DSH SDK 保留。沿用 `0.9.0-alpha.0` / schema 10，不新增数据库迁移。W18 原生 pending 队列自动唤醒继续暂缓。

源码更新不替换已安装的后台包。本轮没有部署或启动生产后台；下述命令是使用说明，不表示已经执行。

## 暂停期间恢复工单

失败工单可能持有尚未交给执行端的 GitHub 反馈。先暂停，再重试或替换会话时，只记录这次人工操作明确准许释放的反馈与工单/Assignment 代次；暂停不再被当成撤权，也不清空反馈。

恢复业务后重新检查授权、订阅、取消、修订退役和 PR 版本，符合条件才投递一次。普通 `resume` 不放行仍需检查的其他反馈；期间再次失败或代次变化时，需要重新核对。PR head 已变化的反馈继续持有并显示原因，不能借恢复向旧版本执行。

## 同一 Issue 中发起新的工作

当所有原有 owning 工单已经人工取消或失去授权时，当前授权人的新明确命令或已核验的 @mention 可以进入现有接单路径。配置了协调器时交给研判；未配置时保留原有明确命令接单方式。旧工单保持取消，新的任务记录独立授权。

普通闲聊、未授权发送者、机器人和取消命令不因此创建新工作。只要还有合法 owner，包括失败后持有反馈、等待人工检查的工单，仍沿用原工单，不拆成新任务。暂停期间继续先保存，恢复后按届时状态判断。

## 关注其他 PR 的讨论

Worker 的 `follow` 和 SDK `followForContext` 可使用同一配置仓库的 `owner/repo#pr:123`。轮询会读取这些 PR 的讨论；原有绑定工单与旁观工单分别处理各自可接收的输入。旁观订阅保持 context 语义，不取得 PR 归属、代码续作或交付权，不能将其确认成自己接下的新请求。

```js
runtime.followForContext(ticketId, {source:'github', id:'owner/repo#pr:123'});
```

保留订阅时间基线、逐工单去重、暂停、取消与撤权检查，以及 PR 版本、可信 CI、机器人预算和上下文额度限制。旁观消息通过 note 接入，不能让相关 PR 的关闭结束本工单。

## 后台在线设置

现有 `scheduler set`、`recovery set`、`repository set`、SDK 对应方法及面板入口保持可用。检测到支持本轮协议的后台时，设置排入本项目控制队列；原后台在执行、同步、研判和回传空闲时核对版本并应用。业务暂停期间也可以处理明确的本地设置指令，不启动模型。后台忙碌时保持 `queued`。

允许的设置是工作容量、有限恢复参数和仓库读取流。仍不能通过此通道改变账户、凭据、可执行程序、工作区或模型会话身份。降低容量不会中断任务；增加容量会在运行中的后台建立所需执行槽，总并发继续受当前设置和本机上限限制。

```sh
js-superagent --project /path/to/project scheduler status
js-superagent --project /path/to/project scheduler set /path/to/scheduler.json 0
js-superagent --project /path/to/project control show <operationId>
```

`scheduler.json` 例如 `{"maxWorkers":3,"humanReserve":1}`；末尾版本必须使用 status 返回的当前 revision。普通目录原地执行仍只能使用一个 Worker。

SDK 保存方法仍同步返回：后台停止时返回已保存设置；后台运行时返回 `OwnerControlReceipt`。`queued` 不表示已保存，须查看最终 `completed` 收据和结果。竞争修改会返回版本冲突；原后台退出后队列不会自动交给新后台。旧后台未声明在线设置能力时拒绝排队，须先停止并部署新版。

显式本地 `/settings` 指令也复用此通道，其协调事件表示指令已记录，实际应用以关联控制收据为准。面板排队后保留草稿，直到服务端新版本实际到达，不提前显示为已保存。

来源开关同时更新已创建的 Worker。专用账号的基本通知收件继续保留；关闭额外仓库流后，不再因进程内旧配置继续扫描 Issue/PR 等额外流。身份、账户与凭据仍由本地可信配置管理。

## 可选独立巡检

提供单次巡检入口，由外部调度器按项目调用，不依赖被检查的运行时仍能响应。当前服务管理继续使用 macOS launchd；本轮没有新增中央后台或自动安装定时任务。

```sh
# 默认仅检查；健康和重复故障无输出
js-superagent --project /absolute/project service patrol

# 仅在明确接受下述恢复边界后，在巡检调用中选择开启
js-superagent --project /absolute/project service patrol --recover

# 随时查看完整健康状态
js-superagent --project /absolute/project service health
```

SDK：`createServiceManager({projectRoot}).patrol({recover:false})` 同步返回 `changed`、`notify`、`action`、`health`、`reason` 和观察时间。CLI 仅在 `notify:true` 时输出 JSON：新故障、故障恢复、首次出现的恢复拒绝原因或恢复尝试结果。正常巡检退出码为 0；巡检自身异常为 1。它不发送邮件、GitHub 评论或聊天消息；通知投递由调用者明确配置。

定时接法：使用现有 launchd 定时任务或其他本机调度器，每 5 分钟执行一次上述完整命令；选择 `StartInterval: 300`，使用 Node、CLI 和项目的绝对路径。例如调度器的参数数组为：

```json
["/absolute/node", "/absolute/js-superagent/bin/js-superagent.mjs", "--project", "/absolute/project", "service", "patrol"]
```

每个项目使用独立的任务名称和输出位置。默认数组不含 `--recover`；如需恢复须显式加入。调度器负责接收输出及日志保留，不需要执行 `serve` 或重复 `service start`。本轮没有向本机注册这些定时任务。

巡检在项目状态目录的 `service/patrol.sqlite` 保存一条有界状态，用于故障去重、确认次数和恢复尝试记录；主工单数据库只读打开，不迁移。没有安装服务时不创建服务目录。新版服务的明确 start/stop 保存 `control-intent.json`；旧安装没有启动意图时只观察，不擅自视为允许恢复。

启用 `--recover` 也只处理**可证明空闲的失活服务**：同一运行及进程身份须有两次至少相隔 20 秒的失活观察，且没有未结工单、宿主操作、回传、原生输入、任务或需要人工处理的业务故障。每次运行身份最多尝试一次，巡检之间串行，并在动作前持久记录，未知结果不自动重放。

恢复请求先向核验过的包装进程发送 `SIGTERM`；5 秒内不能确认父子进程均已退出便停止，不强杀。确认退出后仍重验状态和人工意图，再走现有服务重启流程。`action: restarted` 表示已发起重新启动，实际就绪须继续查看 `health`。人工停止、业务故障、身份不明和 W18 pending 问题不会被自动启动或盲目重发来“修复”。

## 验证边界

仅执行新增和直接相关的离线定向检查、类型/语法及来源校验，不跑完整套件，不调用真实模型或写入 GitHub。生产后台保持停止，没有启用巡检、改动现有服务安装或迁移生产状态。

### 2026-11-03 提交前复核

本次提交复核通过内核来源哈希、公开 API 类型、构建，以及新增功能和 W1 反馈的 44 项定向测试。另检查服务、健康、环境、owner controls、HTTP 管理和来源接续共 87 项：首次有两处测试设施/旧合同断言失败，已补全模拟安装目录的服务模块依赖，并把运行中 repository 设置的 HTTP 断言更新为排队、最终完成及 revision 前进；受影响的两个测试文件重新通过，其余 85 项首次通过。

独立安装包 CLI/SDK 冒烟通过。根目录 `npm run check` 通过（包含 workflows/skills 检查），仍报告既有的 24 条追溯警告及 3 个缺失本地视频；与本包改动无关。没有重跑整个包的全部测试，也没有调用真实模型、部署后台、启用巡检或进行 GitHub 业务场景验收。提交与推送源码不代表运行包或生产状态已切换。
