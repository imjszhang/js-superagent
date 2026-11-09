# 独立运行时 v2（0.2 alpha）

本文记录阶段 6–12 的新增使用合同；实际验收与未验证边界见 [实施状态](implementation-status.md)。领域内核仍为原样提取版本，不依赖 DSH。CLI、`submit`、`get/list` 保留；W0 起执行扩展统一使用现代 Harness 适配器，旧 Driver 不再直接注入。配置迁移见 [Harness 接入](harnesses.md)。

## 启动与升级

在稳定目录安装 tarball，先停止旧服务，再使用新包升级项目状态：

```bash
js-superagent --project /path/to/project service stop
js-superagent --project /path/to/project upgrade
js-superagent --project /path/to/project health
```

阶段 6–12 的历史升级将数据库从 2 升至 3；当前版本与迁移边界见 [Harness 接入](harnesses.md)。升级先创建一致性备份及摘要清单，并记录迁移。新功能首次执行时也会检查迁移条件；已有后台服务必须停止。升级不会自动启用并发、主动接单、远端交付或新执行端。旧包拒绝打开新数据库。项目 JSON 配置仍为 v2；数据库版本和公开 API 版本各自独立。

服务绑定固定安装入口，升级源码不等于升级服务。更换包需要先 `service uninstall`，用新包 `service install --mode poll` 后 `service start`。保留旧包与升级前备份；恢复工具 `prepareDatabaseRestore` 仅生成经过身份、摘要和外部动作核对的恢复候选文件，不覆盖正在使用的数据库。核对升级后新增的提交、PR、评论及工单，再停服务进行恢复，避免重复执行远端动作。

普通目录仍可只用本地 `submit/run/serve`；轮询不需要域名或隧道。调用 `start()` 不会启动管理 HTTP 服务，`panel` 也不会自动启动 Worker。

## 收件、控制和报告

来源、协调、Worker 和回传分别推进；模型长任务不会占住来源同步。一个项目只有一个常驻循环所有者，跨进程 Worker 领取、渠道租约和迟到回调均核对持久令牌。

```bash
js-superagent --project /path/to/project pause
js-superagent --project /path/to/project resume
js-superagent --project /path/to/project details <ticket-id>
js-superagent --project /path/to/project panel
```

业务暂停继续保存输入，停止新的研判、派工及业务回传；正在运行的轮次仍可保存结果。取消仍有效。暂停持久化，重启不解除；已发出的网络操作无法撤回，成功收据仍保存。`stop()` 则停止循环并等待归属进程退出。

工单历史视图仍使用 `completed/waiting/failed`；适配器统一声明 `reportVersion:2`，返回 `{version:2,state,summary,artifacts?,attention?}`；`state` 为 `progress/waiting/ready/blocked/failed/dropped`。`attention:{question}` 与等待事件分开。`getDetailed()` 展示领域 stage、outcome、提问、验证、交付、实时输入证据；PR 尚在审阅时不会把领域工单称为完结，旧 `get()` 的 completed 仍表示一轮工作准备好供审阅。

## 协调和政策

`submit()` 保留明确委托直接建单；`request()`／CLI `request` 将请求交给协调器。协调器与 Worker 分别配置，按需读取有范围和大小限制的工单、话题、决策及原始事件。

```json
{
  "assessor": {"driver":"codex-app-server","timeoutMs":120000},
  "policy": {"mode":"off","rules":[],"sourceRows":[]}
}
```

```bash
js-superagent --project /path/to/project coordinator status
js-superagent --project /path/to/project coordinator set coordinator.json 0
js-superagent --project /path/to/project request "判断这项改动应继续原任务还是新开工单"
```

最后的数字是当前 revision，过期保存会被拒绝。`off` 保留明确授权入口；`observe` 记录拟议动作，不启动主动工作；`auto` 仅处理明确配置的规则与来源范围。sourceRows 使用稳定来源身份与范围，例如 `{id,source,scope,actors,bots,admission:{listedUnaddressed:true}}`。显示名不等同于身份。模型输出必须经过当前政策和代次校验，不能通过消息修改政策。

设置及提示词有版本历史；现有会话固定创建时的执行配置。`handback`、`followForContext`、`note` 为可信 SDK 操作；上下文订阅不等于授权。策略变更会重查未执行动作并使旧研判失效。

## 验证和交付

默认交付为本地成果。可信操作者可以保存 prepare／verify 命令；自然语言“测试通过”不会替代宿主捕获的验证事实。

```json
{
  "mode":"local",
  "automatic":true,
  "verify":{
    "id":"tests","version":"1","command":"npm","args":["test"],
    "environment":"host","allowHostExecution":true,"timeoutMs":600000
  }
}
```

```bash
js-superagent --project /path/to/project delivery set delivery.json 0
js-superagent --project /path/to/project verify <ticket-id>
js-superagent --project /path/to/project deliver <ticket-id>
```

宿主命令是明确授权的本机执行，不是容器或 OS 隔离。它保存命令退出码、受限日志、超时／取消、验证配置版本及工作树摘要。验证后修改代码会使结果失效。大型仓库可以给 profile 配置 `paths`，但所有交付变更必须落在验证覆盖范围内。

远端模式须显式设为 `draft-pr`，同时配置 `automatic:true`、`credentialMode:"native-gh"`、`repository`、`base`、`allowedPaths` 和 verify。仅 worktree 支持远端交付。宿主持有本机 gh 身份并核对权限、工单拥有的分支与远端 head；不会默认合并、强推或写默认分支。现有只读 App 仍可负责收件，交付身份是单独声明的 native-gh。Worker 环境剥离常用 GitHub token 及配置中的 App/Webhook 秘密变量，但目录隔离不代表完整凭据隔离。

创建 PR 后绑定原工单；审阅和受信 CI 失败续作仍用原会话／工作区。宿主推送更新可信 head，过期反馈退役；他人修改 head 会阻止自动执行。关闭／合并通过真实远端事实推进领域完结。交付故障应先检查 journal，使用 `deliver` 恢复原意图，避免另起 Worker 改写尚未核对的提交。

## 并发、实时输入和后台任务

```json
{"maxWorkers":3,"humanReserve":0}
```

通过 `scheduler set scheduler.json <revision>` 保存，默认仍为 1；`in-place` 拒绝多 Worker。worktree／copy 每工单独立，同一工单只有一个活跃执行者。人类反馈优先，队列老化避免饥饿；可显式预留只处理反馈的槽位。

```json
{"driver":"codex-app-server","timeoutMs":600000,"enableManagedJobs":true}
```

通过 `executor set executor.json <revision>` 选择 app-server。它经真实原生协议验证实时插话、会话续用和取消；`accepted` 仅为运输回执，模型最终报告确认输入 ID 后才记录 `read`。未确认输入保留至下一轮。W0 起默认使用 Codex app-server；DSH SDK 的追加输入目前在下一轮处理。

app-server 的 dynamicTools 属于实验性协议，当前验证版本见验收记录；旧会话不能悄悄获得新工具权限。需要后台任务时还须保存可信 profiles，例如：

```json
{
  "paths":["src"],
  "profiles":{
    "check":{"kind":"command","id":"check","version":"1","command":"npm","args":["test"],"environment":"host","allowHostExecution":true},
    "helper":{"kind":"agent","version":"1","instruction":"只处理委托范围并给出验证证据","paths":["src"]}
  },
  "limits":{"maxJobs":8,"maxActive":2,"maxDepth":2,"maxDurationMs":1800000},
  "childExecution":{"driver":"codex-app-server"}
}
```

`jobs set jobs.json <revision>` 后，支持的父 Driver 得到 `job_start/status/wait/cancel` 工具。模型只能选择已配置 profile，不能传任意宿主命令。子 Agent 有独立副本，来自项目源目录；不会自动包含父工作区未提交修改，也不会自动将子改动合并给父工单。等待可释放隔离工作区的 Worker 容量；原地工作区保留占用。取消、超时和父派工结束会回收归属进程；崩溃恢复只记录中断，不自动重放不明外部动作。

高级 SDK 使用 `getConfigV2()/configureV2()`；旧 `getConfig()/configure()` 遇到其类型无法表达的高级设置时要求改用 v2，保留 `ProjectConfig.concurrency:1` 的旧类型合同。

## GitHub 仓库入口与管理

```json
{"enabled":true,"observe":false,"streams":{"pulls":true,"issues":false,"comments":false,"defaultBranchCI":false}}
```

`repository set repository.json <revision>` 启用仓库事件来源，复用 GitHub 身份及政策。初次读取建立基线，不回放所有历史任务；后续新 PR 可经允许账号的明确命令接单，并记录非自建 PR 归属及固定 head。主动观察与默认分支 CI 都要显式启用；已有 Issue／PR 绑定由原渠道跟进，避免重复分流。

直接从 PR 接单的任务只支持同仓库 PR 与 `worktree` 模式；每次执行前重新核对远端 head，首次工作区固定在该 PR 的 commit。`copy`、`in-place` 可保存收件与研判记录，但会明确拒绝执行。若本地没有该 commit，需要可信操作者先 fetch 后显式重试；系统不自动改用项目 HEAD，也不执行 fork PR。关联已有 PR 不授予推送或合并权限。

本机面板提供工单检索、问题回复、重试／取消、业务暂停、协调设置、Worker 模型／提示词及仓库来源设置。Worker 和来源变更前需要停止后台服务；暂停业务不等于停止服务。Worker 角色提示词作为可信设置保存，不改变宿主固定的授权、工作区及工具限制。空白提示词恢复内置默认。Worker 历史可比较并载入草稿，保存仍核对当前 revision。已有会话固定原模型、提示词和版本；升级前缺少历史版本的旧会话在修改前保留有效设置，并明确显示这一来源。使用启动输出的一次性链接，登录后 token 不留在 URL。管理 API 限 loopback，写入需要身份、同源标记和修订检查，输出过滤秘密及本地路径。进程运行、渠道健康和业务待办分别展示。

飞书适配器保留 SDK 可选入口，按用户决定暂不配置；真实飞书接单／跨渠道闭环尚未验收。Linux／Windows 服务安装器、固定 HTTPS、整机重启及 npm 发布也不属于本次已验证声明。
