# W6 本地连续工作验收

2026-11-02，真实 Codex `0.166.0-alpha.5.1`，沿用本机 ChatGPT 登录及原生默认模型。仅一个隔离项目、一个工单、两次 Worker 执行和一次协调者查询；未启动后台、未发送 GitHub 消息。

脚本：[real-workflow-local-smoke.mjs](../examples/real-workflow-local-smoke.mjs)。原始记录位于仓库本地 `working/agent-runs/js-superagent-workflow-local-20261102-w6-actual/acceptance.json`，临时项目保留用于复核。

## 通过的实际流程

1. 工单要求只写 `greeting.txt`，先询问精确问候语。真实 Worker 返回 “Which greeting should greeting.txt contain?”，状态 waiting，文件尚不存在。
2. 在等待期间提交一次项目协调消息。真实协调者正确答复任务在等待问候语，只产生 reply，没有创建工单、代替人回答或改变 Worker。
3. 关闭并重新打开宿主，回答 “Use exactly: Hello workflow”。Worker 恢复同一原生会话，写入 `Hello workflow\n` 并报告完成。
4. 独立宿主验证命令逐字核对文件内容，通过且文件树未在验证中变化。再次调度无新任务；协调消息仍只处理一次。

工单 ID：`4ee6af0d08dc32ce1aff4b149b763457`。Worker 会话：`01a19aa0-aae1-78c3-a999-21c37492b380`，恢复前后相同。协调者使用独立 `codex-app-server-assessor` 命名空间。

## 证据范围

实际模型运行时间：04:59:42–05:00:27 UTC，共约 45 秒。两次前置脚本配置错误均发生在创建工单和模型调用之前，修正后复用同一个空项目，没有扩张业务场景。

记录包含基线提交、Node/Codex 版本、关键源码 SHA-256、报告、会话、协调动作与宿主验证。运行期间其他实施工作修改了 `src/index.mjs`，开始和结束摘要分别保留；本记录证明当时进程加载的实现，不宣称整个最终工作树均已真实模型验证。后续变更使用受影响定向检查，不重复扩大模型验收。

本轮是实际模型验收；DSH 的 W3 原生检查使用模拟 provider，二者证据不能互相替代。GitHub 组合验收另行记录。
