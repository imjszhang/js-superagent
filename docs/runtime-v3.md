# 独立运行时 v3（0.3 alpha 候选）

本文件描述阶段 13–18 已实现的合同。旧 CLI、SDK 和默认单 Worker、明确命令接单、本地交付仍保持。实现、固定候选 8 的真实验收和生产启用分开记录，见 [实施状态](implementation-status.md) 与 [机器可读证据索引](phase18-candidate8-acceptance.json)。Node.js 下限 22.13.0，当前 W0 工作区默认使用 Codex app-server，另支持 DSH SDK；旧 exec 退出执行路径，当前配置迁移见 [Harness 接入](harnesses.md)。

## 升级与保留

阶段 13–18 的历史升级在服务停止、所有者退出后备份并将状态升级至 schema 4；旧 0.2 包拒绝打开 schema 4。启用需要 schema 4 的高级设置时也会检查并执行迁移。先保存旧包及一致性备份；回退前核对升级后已发生的评论、提交和 PR。安装新源码或新 tarball 不会更新已绑定固定路径的后台服务。

```
js-superagent --project /path/to/project service stop
js-superagent --project /path/to/project upgrade
js-superagent --project /path/to/project health
```

升级不会自动开启主动接单、多 Worker、远端交付或新工具。worktree/目录副本不是 OS 隔离边界；宿主执行和访问凭据仍按本地权限运行。

## Worker 业务工具与上下文

通过 `executor set <json-file> <revision>` 显式选择 `codex-app-server`，可配置 `enableAgentTools: true`。工具按当前 session/assignment/运行代次绑定，提供受限资源读取、业务确认、退回、上下文订阅、无关话题移除及报告。会话创建时固定工具集，旧会话须明确替换才能获得新增工具。不能通过消息扩大授权，也不能通过工具获取通用 SDK 或直接交付权限。

内置驱动按预算装配上下文：完整范围、最近消息和报告、可追溯资源引用；完整记录由版本化工具分页读取。默认初始 32 KiB、单页 8 KiB、每轮读取 128 KiB/16 次，可在可信执行设置中调整 `contextLimits`。预算无法容纳必要授权时明确失败；未确认读取的输入不应被标为已处理。自定义适配器通过注册表接入；未声明有界上下文时收到完整工单快照，不保留旧 Driver 执行分支。

协调者可在当前候选范围内读取受控 GitHub 线程及同仓库本地固定 commit 的内容。项目级 `repository` 设置可显式启用 `fetchPullHead`；宿主仅从匹配的 GitHub 仓库获取已核对 SHA、验证远端 head 并清理临时 ref，不切换当前分支。默认仍要求操作者先获取缺失 commit；fork PR 不支持。

### Codex 宿主集成隔离

内置 Worker 和协调者启动前验证 Codex 支持相关能力开关，关闭继承的 Apps、插件、hooks、浏览器、计算机操作、自动 MCP 安装及原生多 Agent。通过只读 `config/read` 解析当前执行目录的用户及项目配置，在内存中枚举 MCP 身份，再逐项禁用；不会将端点、环境变量或令牌复制到命令参数、日志或模型上下文。空 `mcp_servers` 表不能清除继承项，因此不作为隔离手段。配置探针不创建线程或执行模型，任何无法验证的版本、配置或服务器标识均拒绝启动。模型/provider 配置和原生登录仍由原 Codex 配置提供，用户配置及凭据文件不被改写。官方配置说明见[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

实际 app-server 在新建或恢复线程之前再次核对有效配置与指纹，配置响应不写入事件或诊断日志。业务 dynamicTools 仍由当前派工显式注册。旧 exec 的启动路径已移除；当前机制仍不替代 OS 隔离。旧会话恢复同样重新应用当前禁用规则。

## 任务、预览与子成果

`jobs set` 中显式使用 `lifecycle: "assignment"`，受管理任务可跨模型轮次运行；`childWorkspace: "parent-snapshot"` 将允许范围内父工作区当前内容复制给子任务。可信 profile 决定具体命令、路径和预算，模型不能指定任意宿主命令。任务完成会记录结果并在合适时唤醒所属工单；业务暂停期间不派发新轮次。

受信任的 command profile 可以声明 loopback `preview` 地址和租约；只接受显式端口的回环 HTTP 地址，并核对监听进程属于该受管理命令。默认租约 30 分钟，每次最多 2 小时。工作台或 CLI 可查看、续期、关闭：

```
js-superagent job list <ticket>
js-superagent job renew <ticket> <job> 300000
js-superagent job close <ticket> <job>
js-superagent adoption plan <ticket> <child-job>
js-superagent adoption apply <ticket> <child-job> <plan-digest>
js-superagent adoption list <ticket>
js-superagent adoption recover <ticket> <adoption-id> rollback
js-superagent adoption recover <ticket> <adoption-id> finish
```

无 PR 的审阅以 waiting 和具体问题保持工单；审阅后再结束。当前派工已关联自己拥有且仍开放的 PR，并存在相应领域跟进时，可以 ready 交回审阅并保持有效预览。外部文字不能冒认这种状态。预览释放 Worker 槽位，租约到期、取消、派工结束或服务停止时按归属清理；只停止自己拥有的进程。业务暂停保持收件，不派发任务完成后的新轮次。

子任务不能直接写父目录；采纳要求检查父快照基线、允许路径和计划摘要，先使验证失效，再应用差异，之后必须重新验证。有活动预览时先关闭预览再采纳，避免沿用旧代码摘要。崩溃留下的采纳 journal 可通过 SDK `listChildAdoptions()`、`recoverChildAdoption()`、CLI 或工作台检查并明确选择 rollback/finish；工单归属、当前授权、执行状态、唯一操作 owner 与文件冲突都会重查。恢复不会自动重放 Worker，也不会覆盖崩溃后更新的文件。

## 恢复、健康和工作台

会话查看、替换和工单追溯：

```
js-superagent trace <ticket>
js-superagent session inspect <ticket>
js-superagent session replace <ticket> <replacement.json>
js-superagent recovery status
js-superagent incidents list
js-superagent prompts status
```

替换会话需要原因和预期旧 session ID；保留工单、工作区与新旧 lineage，未核对的交付意图会阻止替换。默认不自动重跑有未知外部副作用的动作；可选自动重试仅针对可证明未启动的受限资源失败。

健康状态区分进程与渠道；按真实同步尝试记录连续失败，超过 `max(3 × pollInterval, 120 秒)` 未成功同步会报告停滞，事件和恢复状态持久保存。业务暂停仍接收来源，来源失败不会被暂停掩盖；默认只在本机展示，不自动对外发送健康消息。

工作台可以搜索全部工单、事件、决策和线程，再由服务端分页；关联导航使用实际记录及公共工单 ID，不靠模型文本推测关系。认证后的完整记录读取先脱敏，再按版本分段返回，单页 100–16000 个字符、完整记录最多 2 MiB；记录改变返回 409，要求从第一页重读。搜索也使用脱敏投影，不按隐藏秘密字段返回命中。`actionAvailability()` 提供状态报告和会话替换的可用性及阻断原因；实际命令仍在执行时重查授权和状态。

回复草稿按工单保存于当前页面状态，刷新详情、切换工单和迟到的响应不会覆盖新输入；发送成功只清除已经发送的版本。设置编辑器首次取得服务端版本后才可编辑，远端版本和未保存草稿分别维护。遇到修订冲突，可保留本地草稿、核对远端版本并明确选择重新基于新版本保存，或加载远端内容；不静默覆盖。该草稿机制不承诺关闭页面或整页刷新后的持久恢复。

分段提示词支持默认内容/旧 base/本地 override 三方差异和修订历史；恢复历史内容会产生新的 revision。已有会话继续固定原模型、提示词及工具版本，新工单使用当前组合；已有会话升级需明确替换。提示词、摘要和工具声明不会扩大代码执行授权。

GitHub App 的 `pullRequestComments: true` 是显式选项，用于请求 PR 评论读写权限；App 安装本身也必须拥有该权限。App 收件/评论与 native-gh 的受控提交/PR 交付是独立身份，失败不会静默切换。

飞书真实闭环、固定公网 HTTPS、Linux/Windows 服务、整机重启和 npm 正式发布不属于当前已验证声明。
