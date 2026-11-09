# W3：DSH 执行中反馈

2026-11-02，固定 `@deepseek-ai/dsh@0.2.1-rc.5`；源码实现已接入，未部署生产。

## 实现与事实边界

DSH SDK 适配器现在提供 `sendInput()`，沿用同一原生会话的 `session/prompt` 接口。`messageId` 是入队回执；只有同一会话随后发出的 `user/message` 事件匹配该回执，才生成 `native-user-message` 消费证据。原生实现是在将消息加入下一次模型请求的历史时写入该事件，因此界面消费状态表示消息已进入 Worker 模型上下文，不是只写进待处理队列。

宿主检查运行代次、工单输入、会话、原生消息 ID 与事件序号，并调用适配器的 `validateInputRead()` 核对真实记录。Codex 的 `model-final-ack` 合同保持不变。消费事件早于入队 RPC 返回时，也不会把已读状态降回已接收。

同一 host Input 在一次执行中重复发送会复用同一个 Promise/回执，不重复投递；不同文本使用相同 ID 会拒绝。最终报告必须晚于所有已消费反馈；原生空闲边界上接收的新输入再次等待处理完毕，不能用上一轮报告覆盖它。

会话目录的 `input-receipts.json` 保存 sending/accepted/read 及对应原生证据，不保存反馈明文。运行中断后若存在未确认输入，自动恢复会明确要求检查原生回执，不能盲目重发或换会话冒充原生续作。**自动核对这类跨进程未确认输入仍有限制**：需要显式检查/替换；消息和回执保留，不会静默丢弃。取消不等于已读取。

## 实际验证

执行 `node packages/js-superagent/test/dsh-native-live-input.mjs`，使用本机真实 rc.5 CLI 和 loopback 模拟 provider，没有访问外部模型：

1. 首次 provider 请求尚在执行时追加 `human-followup-1`。
2. 入队回执返回 `read:false`，此时没有消费确认。
3. 第二次 provider 请求的历史包含同一反馈标识。
4. 原生 `user/message` 的消息 ID 与回执相同，事件序号为 20。
5. 最终返回第二次请求的报告，只有一次消费确认，共两次模拟 provider 调用。

测试项目、进程和临时 loopback 服务在结束时清理。该证据是“真实 CLI + 模拟 provider”，不是实际模型业务验收。

定向协议检查覆盖稳定 ID 去重、送达/读取区别、伪造证据拒绝、取消后保留未确认回执及禁止盲目重投；宿主 live-input 检查覆盖原有 Codex 确认和新原生确认提前到达的竞争情况。不跑全量或长时间负载测试。

## 供 W4 使用的有限恢复证据

仅在 rc.5 明确发出 `turn/end.reason.kind=error`，错误码为 `RATE_LIMIT`、`SERVER` 或 `TIMEOUT`，原始消息已入历史、没有任何工具派发、没有受管任务、没有未确认反馈且进程已退出时，错误携带 `recoveryEvidence`。认证错误、任意文本里的 429/5xx、工具结果不明和人工取消都不产生该证据。突然宿主退出后的任意原生历史检查未作泛化实现，仍按 W4 人工检查边界处理。

后台服务保持停止。本轮未操作 GitHub、未修改生产状态。
