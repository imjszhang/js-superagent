# DSH 0.2.2-alpha.2 适配与 W18 复核

日期：2026-11-02。在 `43eb149` 已提交版本上增加新版兼容；本页描述当前工作区增量，不代表生产部署。包继续独立，CLI/SDK、Codex 及 DSH 业务入口不变。

## 版本与会话

适配器精确支持 `0.2.1-rc.5` 和 `0.2.2-alpha.2`，未知版本仍拒绝。probe、run 锚点和详情记录实际执行版本，历史解析允许两个已核对版本的 session v4。没有将全部 0.2.2 或未来版本视为兼容。

新 alpha.2 会话可正常执行、在同一版本下恢复会话及继续后续轮次。rc.5 的配置文件生成保持原字节；旧会话绑定不因全局程序升级而改写。用 alpha.2 运行 rc.5 绑定的会话会在启动原生执行前明确拒绝。

需要继续旧会话时，选择其原版本的独立 executable；需要切换时，先核对旧会话的输入、工作区和外部动作，再通过现有 `session inspect` / `session replace` 显式处理。只读历史核对不升级或改写旧日志，不能把替换会话当成旧输入已消费的证据。

## 保留宿主管理边界

alpha.2 的 SDK bundle 新增原生调度、客户端交互与文件展示相关插件，base 新增 goal 工具。alpha.2 专属 profile 禁用 `schedule`、`tool-schedule`、`tool-ask-user`、`present`、`connection`、`file-upload`、`workspace`、`file-reference-local`、`deliverable-file-references` 和 `tool-goal`。

工单提问仍使用现有业务报告，调度、子任务、成果回传与权限继续由 js-superagent 管理；不新增第二套原生任务系统。实际模型请求已检查，未出现 `schedule_*`、`ask_user_question`、`present` 或 goal 工具。

## W18：仍不能自动采用原 pending 队列

本机 alpha.2 公开源码与类型核对结果：

- `dsh-sdk-jsonrpc-server` 的 `session/resume` 仍恢复会话而不插入提示；`session/wait` 只等待，不唤醒。
- `dsh-sdk-protocol` 的 `SessionResumeParams` 仍只有 `sessionId`，没有无消息唤醒选项。
- `dsh-agent-loop` 的恢复 maintenance 初始化 `wakeRequested=false`；公开 `send(..., wakeup=true)` 仍先插入消息。
- `ReactLoopAgent.wakeDriver` 仍声明为 private。新版调度插件的会话恢复协调并不是原队列无消息唤醒接口。

因此继续返回 `native-pending-wakeup-unsupported`，保留原输入身份和未消费状态。没有调用私有方法、重发原消息、发送空提示或修改原生日志。W18 自动采用仍暂缓，不能宣称已解决。

## 有限验收

| 检查 | 结果与范围 |
| --- | --- |
| rc.5 基线 fixture | 原 checkpoint、同版本恢复及配置绑定检查通过；本轮未重新安装或运行真实 rc.5 |
| alpha.2 版本 fixture | 新会话执行、同会话恢复通过；未知版本拒绝；旧 rc.5 绑定跨版本执行被拒绝，原绑定保持不变 |
| alpha.2 历史 fixture | completed 结果核对、已知 pending 只读识别和未知绑定拒绝通过 |
| `test/dsh-native-continuity.mjs` | 本机真实 alpha.2 SDK，一次短脚本、4 次 loopback provider 请求：待处理消息持久化后中断、只读识别与拒绝采用、原日志字节不变、异步宿主工具桥、同会话规约更新、终态观察与所属进程退出 |

工具桥场景使用受控 GitHub 读取 fixture，2 次模拟 GET 在事务外完成，结果进入下一实际原生模型请求；没有读取真实 GitHub 或调用外网模型。本轮未运行完整测试套件、长期后台或模型矩阵。生产后台保持停止，生产库未迁移，旧安装包未替换。
