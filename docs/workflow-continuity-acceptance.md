# W15–W23 有限验收与剩余边界

日期：2026-11-02。此页记录本轮实际证据；不以计划、接口存在或旧版本验收替代新实现结果。对应[实施计划](workflow-continuity-plan.md)。

## 原生执行端结果

| 执行端与脚本 | 实际环境 | 已验证结果 | 未覆盖或未完成 |
| --- | --- | --- | --- |
| [Codex 短脚本](../test/codex-native-continuity.mjs) | Codex `0.166.0-alpha.5.1`，真实 app-server，临时 CODEX_HOME，loopback Responses provider，4 次本地请求 | 动态业务工具实际调用；native 历史与 host receipt 一致时收取 completed；不匹配收据被拒绝；进程丢失后只读检查并在同 thread 接续；新规约出现在实际高优先级请求项；原生终态观察；注册的进程全部退出 | 未调用真实外网模型；未制造真实账户限流；此脚本的工具结果为临时受控事实，不代表实际 GitHub 网络补读 |
| [DSH 短脚本](../test/dsh-native-continuity.mjs) | DSH `0.2.1-rc.5`，真实 SDK CLI，临时隔离 profile，loopback Anthropic provider，4 次本地请求 | 提交反馈并等待 native pending 持久化后中断；只读识别其原 message/input ID；拒绝不支持的采用且未启动新进程；原生日志字节保持不变；健康会话的真实 `js_superagent_read` 桥接到受控异步 GitHub 读取 fixture，2 次事务外模拟 GET 后保存完成收据，结果进入下一实际请求的 tool_result；同一健康会话后续轮次实际收到新规约；原生终态观察；注册的进程全部退出 | **未实现原 pending 自动采用**；未证明恢复期间提前到达的消费事件、重复中断或队列自动消费；未读取真实 GitHub 网络、调用真实外网模型或制造真实预算错误 |

两个脚本均使用临时目录、虚构本地 provider 凭据，不读取生产业务数据库，不启动生产后台，不发送远端 GitHub 消息。脚本结束时关闭本地 HTTP listener、终止受管临时进程并删除临时状态。失败定位时保留的临时协议证据不提交仓库。

## W17/W18 定向检查

[小型 fixture](../test/w17-w18-native-continuity.test.mjs) 的 5 个检查通过：

1. 已完成 host receipt 不能遮盖未结算的 child adoption 或宿主 operation；owner 退出不冒充操作完成。
2. Codex completed dynamic tool 必须同时匹配原生参数、结果和宿主收据；未完成或不匹配拒绝。
3. DSH 旧 run 的任务使用原 run 的工具身份核对；普通 run 以已消费消息作为边界，避免 resume 前序号为 `-1` 时错误归属。
4. 已知 pending 只在授权输入集合中提供只读事实，未知队列不自动认领；通用 `adopt-pending` 合同仍检查原投递 run 和稳定身份，但当前 DSH 不产生可执行采用证明。
5. 当前 rc.5 在任何原生启动前拒绝采用，且不修改 native pending 日志。

补充 [W17 任务终态表驱动 fixture](../test/w17-job-recovery.test.mjs) 已通过：command job 在 `execution` 终态已经持久化、外层 completion 尚未写入时中断，可只读核对并结算。核对绑定 job/token、parent、原 profile/实际命令摘要、workspace 和已退出的 owner/guardian；保留通过、失败和超时的实际状态，不把进程消失当成功。缺少新执行绑定的旧记录、丢失 supervisor 退出结果、身份不符及缺少 child Agent 完整终态证据时，保存结构化原因到 job 的 `recoveryInspection` 和工单的 `recovery.jobInspections`，不重启任务。

另保留并通过了已有的 3 个 Codex 历史检查，以及选定的 3 个 DSH checkpoint/live input 检查。未运行完整历史测试套件。失败后只复测受修复影响的检查。

## DSH 队列接续的协议限制

实际版本公开实现的调用链为 `dsh-sdk-jsonrpc-server` 的 `resume → openSession`，再进入 `dsh-agent-loop` 的 `resumeWith → setupAndPublish → runMaintenance`。从持久化 inbox 恢复不会设置 `wakeRequested`，而 `runMaintenance` 仅在该标记存在时释放等待中的唤醒。公开 `Agent` 类型提供的 `send/followup/steer` 均插入消息；`ReactLoopAgent.wakeDriver` 在类型中是私有方法。

因此当前返回：`kind: inspection`、`safeToResume: false`、`reason: native-pending-wakeup-unsupported`，同时保存 `pendingInputs` 的只读身份事实。普通手动 retry 也不能绕过这一限制。此结论来自真实 SDK 行为和本机安装源码核对，不是 fixture 推断。

原 pending 自动采用、消费早于 resume 返回以及采用后再次中断的完整流程仍属 **W18 未完成项**。未来须有公开的原队列唤醒能力，且重新验证原消息仅消费一次、取消/撤权优先和无重复提示，才可启用。

## 规约与等待事实

Codex 恢复会话的新规约通过公开 turn collaboration mode 的 developer instructions 传递；真实请求确认最新高优先级项含新版本、不混入旧版本。保留原 mode/model/effort，不因规约保存改变模型设置。旧历史中的旧规约仍是历史事实，不改写会话日志。

DSH 采用正常新轮次的 `session/prompt` 承载带版本的当前业务规约，健康同会话验证通过。禁止的 pending 采用不标记新规约已应用。

原生脚本只证明生命周期观察和实际规约送达。等待原因、重复/乱序事件和结束清理由 [W21/W22 定向检查](../test/w21-w22-policy-observation.test.mjs) 处理；是否存在真实预算等待取决于原生事件，缺失字段保持未知。此处不宣称做过真实账户限流验收。

## 交付范围

当前包为 `0.6.0-alpha.0`，新语义存储版本为 schema 7。领域内核保持上游摘要，没有引入 js-agent-runtime 或运行时第三方依赖。

[0.6 操作说明](workflow-continuity-operations.md) 提供 schema 7 升级、回退暂存与安装边界、旧规约绑定处理和异常处置步骤，并列出留存安装包及源码/包摘要的位置。

| 阶段 | 实施结果与定向证据 |
| --- | --- |
| W15 故障隔离 | 对象观察、失败退避、freshness 与 Webhook selector 门禁持久化。健康工单可继续，仓库鉴权失败全局阻挡并反映在状态展示；纯 skip 轮次不会清除全局故障。默认分支 CI 的 check/status 也逐对象隔离，已知失败单独重试，未知 ID 保留游标。`w15-w16-continuity-runtime.test.mjs`、单个混合 CI fixture 和渠道/仓库局部场景通过。 |
| W16 回传 | 同工单同目的地顺序、三次实际失败后的有记录放行、gone 终结、发送前授权与 marker 对账；domain/public 工单 ID 统一归组。定向收据和撤权检查通过。 |
| W17 恢复 | 普通连接异常自动进入只读核对；显式 retry 复用同一合同，即使 autoResume 关闭。`w23-runtime-continuity.test.mjs` 证明重开后收取 completed，不再次调用 Worker。interrupted command job 核对持久 execution 终态；旧记录缺绑定、child 缺完整终态和未知宿主副作用保留结构化检查原因。 |
| W18 队列 | **部分完成：只读识别和安全拒绝，自动采用未完成。** 详见上文协议限制。 |
| W19 行内讨论 | 已验证根评论、有限上下文、原处回传和删除后的受控回退；旧 pending 只有来源证明充分才迁移。两个宿主场景验证多 root 分别回传、丢响应重试不重跑 Worker。 |
| W20 补读 | 宿主提供工单范围内 GitHub 引用，网络等待在 SQLite 事务外；读取前后复核身份、配置和版本。6 个定向场景及直接受影响的原工具场景通过，包含取消与预算。没有进行真实远端 GitHub 补读验收。 |
| W21 规约 | 固定执行绑定与业务规约分离；普通下一轮采用新修订，保存不唤醒 Worker；原 run 恢复沿用原快照；应用事实记录所属 run 与时间。已验证宿主两轮、旧绑定精确迁移以及双方原生实际请求。无法证明的旧拼接保留 legacy-unresolved。 |
| W22 等待 | 可信原生 waiting/active/ended 事实进入 details、trace、health 和面板，停止/结束清理当前等待。分类与乱序场景通过；没有真实账户预算故障验收。 |
| W23 升级与交付 | 类型、CLI 说明、文档及 schema 7 更新。旧 schema 5/6 查询、升级备份、状态保留、历史读者兼容防线和回退准备的限定场景通过。生产库未迁移。 |

补充完成的检查：`check:core` 校验 18 个上游摘要、15 个 core 文件边界；类型检查、构建、diff/语法检查通过；一次干净目录打包安装证明 CLI/SDK、第三方注册适配器、历史读取与包独立性。根项目要求的 `npm run check` 和索引刷新通过，它们是项目资料结构检查，未运行本包的完整测试套件。

生产服务只读复核为 `loaded=false`、`running=false`、`pid=null`、`childPid=null`。没有启动后台、外网模型、GitHub 实际写入、长期验收或跨平台矩阵。当前改动未提交、未推送、未发布。W18 自动采用保留为明确未完成项，不能把本轮表述为九阶段全部完成。
