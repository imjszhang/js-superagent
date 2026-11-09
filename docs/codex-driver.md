# Codex 适配器

当前执行路径是 Codex app-server，通过与 DSH SDK 相同的 Harness 注册表和结构化报告合同接入。CLI/SDK 工单操作不变。包不包含 Codex 本身，也不依赖 js-agent-runtime；需要用户安装并登录原生 Codex。

## 使用

```sh
js-superagent init --driver codex-app-server
js-superagent doctor --driver codex-app-server
js-superagent submit "修复测试失败并报告验证结果"
js-superagent run
js-superagent show <ticket-id>
js-superagent reply <ticket-id> "对具体问题的回答"
js-superagent run
```

SDK 使用 `createProjectAgent({projectRoot, execution:{driver:'codex-app-server'}})`。`createCodexAppServerDriver()` 是适配器工厂，不再通过 `createProjectAgent({driver})` 绕过注册表。配置与自定义适配器入口见 [Harness 接入](harnesses.md)。

## 执行与恢复

Worker、子任务和协调者复用 app-server 连接管理。Worker 在工单工作区执行；协调者使用只读角色处理有限上下文，不继承 Worker 的修改权限。宿主统一负责工单、授权、验证和交付。

保存原生会话 ID 后，后续轮次使用该 ID 恢复，不使用“最近会话”，也不因失败静默新建会话。运行中反馈的入队、原生接收与模型确认分别记录；不能把写入数据库等同于已经读取。

进程必须在任务交付前登记，取消及超时后等待所属进程退出再结算。`stop()` 中断当前执行，`cancel()` 撤回工单授权；未知结果须检查后再恢复，不自动重放外部操作。该机制不是 OS 容器安全边界。

## 旧 exec 配置

`codex`（exec）、旧 `createCodexDriver()` 和直接 Driver 注入已退出当前执行路径。旧工单和会话 ID 保留可读。通过 `executor status` 查看迁移提示，明确保存 app-server 配置；旧任务若需要更换会话，使用 `session replace`，不把连接方式变更冒充原生续作。后台不会随迁移查询启动。

## 验证记录

[phase3-acceptance.json](phase3-acceptance.json) 记录旧 exec 的历史真实验收，不能作为本轮 app-server 改造的验证结论。当前验收范围见 [实施状态](implementation-status.md)；W0 只执行适配器、迁移和受影响入口的定向检查，未运行的真实模型场景单独说明。
