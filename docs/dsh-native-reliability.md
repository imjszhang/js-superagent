# DSH SDK 原生恢复、规则与长命令

此实现固定支持本机 `@deepseek-ai/dsh 0.2.1-rc.5`，不依赖 `js-agent-runtime`，不改变 CLI/SDK 工单入口，也不启动常驻服务。

## 原生证据合同

rc.5 SDK 只有 `initialize`、`session/prompt`、`session/resume`、`session/wait`、工作目录和 `shutdown` 等方法，没有读取完整历史或精确撤回 inbox 消息的方法。适配器因此只读自身隔离 DSH home 中的 `sessions/<workspace>/<sessionId>/session.v4.jsonl`，不修改原生日志、pending inbox 或任何恢复占位结果。

读取前检查原生版本、v4 header、会话 ID、真实工作目录、模型/后端/权限/角色提示词绑定、连续事件序号和完整行尾。文件最多 16 MiB；不支持的格式、压缩/打包记录、残缺文件与目录越界均停止自动核对。每个新 run 在发送初始 prompt 前保存宿主锚点，并在收到原生 message ID 后原子补全；最新 run 指针避免把后续结果关联回旧执行。升级前没有锚点的历史不会据此自动恢复。

核对依据为原生事实：

- `user/message` 是反馈进入原生模型历史的证据；`session/prompt` 的返回值只证明接收。
- `agent/inbox/spliced` 重建 next-turn/next-step 队列。仍在原生队列或发送结果未知的输入不重发；rc.5 无法精确撤回这一分支，继续要求人工检查。
- `tool/call` 与 `tool/result` 必须配对，`TOOL_OUTCOME_UNKNOWN` 不是收尾证明。
- `job/registered` 与 `job/settled` 必须匹配归属。进程退出本身不算作业结果。
- 可关联的 `assistant/message` 与 `turn/end(kind=completed)` 才能恢复结构化报告。宿主继续验证和交付，不再开启模型轮次。
- 没有报告但初始输入已消费、工具/作业已配对、没有排队或未知输入时，可沿原生会话续作。明确取消、其他无法解释的终态和未知动作不进入自动续作。

`inspectRecovery()` 返回 `outcome: completed | resume`、原生序号、已读输入 ID 和已交付上下文引用。读取确认丢失时，凭原生 message ID 或带稳定 input ID 的完整文本摘要补确认；不存在记录不能证明消息未发送。只有适配器尚未就绪等确定未发送情况返回 `deliveryState: not-sent`，由宿主在同一 run 有限重试。

宿主业务工具的 `js_superagent_job_start` 返回的是启动收据，不证明外部作业已经结束；出现这种调用的历史目前不凭原生记录自动恢复。开启该能力但尚未调用不受此限制。宿主任务、原生 shell 作业和本地模型进程的归属语义不混用。

原生自身重试结束后的 `RATE_LIMIT` / `SERVER` / `TIMEOUT` 保留类型。Worker 只有在没有工具调用、没有未确认反馈、进程收尾已完成时附带 transient 恢复证据；不从报错正文猜测可重试类型。

## 工作区规则

DSH 使用单一宿主装配路径；原生 `agent-instructions` 继续关闭，避免重复加载祖先或 home 文件。只收集实际 worktree/目录副本内的 `AGENTS.md`，以相对路径和目录作用域标注，子目录规则只细化相应后代。新一轮明确声明当前快照替代旧快照，避免旧会话静默累积冲突规则。

规则文件不接受符号链接。目录符号链接不遍历，记录被跳过的路径；`.git`、`.js-superagent`、`node_modules`、`.venv`、`venv`、`dist`、`build` 不遍历。最多 4096 个目录、128 个规则文件、合计 64 KiB；超限失败并提示缩小工作区，不静默截断正文。

每轮 `harness-context/<runId>/project-rules.json` 和 `checkpointNative()` 保存原生版本、根目录、文件路径、作用域、SHA-256 摘要及跳过链接。项目规则不能扩大授权、发布权、工具或进程权限。协调角色不加载这组 Worker 规则；Codex 保留自身项目规则读取机制。

## 长命令

Worker/Child 的单次启动 overlay 将 bash/pwsh 前台等待及 job wait 默认值和上限设为 5000 ms，沿用原生超时转后台与完成唤醒。这个值是前台等待，不是整条命令的执行期限。原有会话的 profile 和绑定文件保持兼容。

适配器跟踪原生 job 生命周期；`session/wait` 只观察 Agent idle，不能单独代表后台作业已结束。适配器持续接收反馈，直到反馈轮次和全部普通原生作业均已收尾才接收最终报告；反馈本身启动新作业时也重复核对。相同命令不会因转后台再执行一次。原生 shell 作业不提供跨 run 的预览保留，需保留预览时使用已有宿主 preview lease。

既有 guardian 负责所有原生进程及后代，取消、超时和宿主丢失时回收；没有开放原生子 Agent 或常驻 daemon。

## 有限验收

`node --test test/dsh-driver.test.mjs`：8 条原有定向协议检查通过。

`node test/dsh-native-reliability.mjs`：真实固定 rc.5 加本机模拟 provider，8 次本地请求，无外部模型调用。单个脚本证明：

- 根/子目录规则实际进入原生 prompt，外部链接规则被排除。
- 9 秒临时命令在约 5 秒后转后台，运行中反馈进入后续模型上下文；同一命令和最终结果各一次。
- 原生已完成结果直接恢复；宿主读回执丢失后精确补回，未知输入与错误 run 被拒绝。
- 模型生成期间原生进程被终止后，核对未结动作并沿同一 session 恢复。
- 转后台后取消收回 shell/guardian，未产生取消后的文件；未知作业历史不自动恢复。

脚本结束关闭本机 provider 并删除临时状态；不启动业务后台、轮询或 Webhook。
