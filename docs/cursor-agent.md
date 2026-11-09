# Cursor 接入

日期：2026-11-06 22:32 CST。适配器 ID 为 `cursor-agent`，显示名为 Cursor，可承担 Worker、子任务和协调者三种角色。精确支持 `cursor-agent 2026.11.05-86047df`，其他版本一律拒绝。CLI 由用户自行安装并登录；本包不安装、不升级，也不启动后台服务。

## 配置

以下 JSON 作为 `executor set` 的输入，不包含密钥内容：

```json
{
  "driver": "cursor-agent",
  "executable": "/absolute/path/to/cursor-agent",
  "model": "grok-4.7-high-fast",
  "apiKeyEnv": "CURSOR_WORKER_API_KEY",
  "timeoutMs": 900000
}
```

- `model` 可省略，省略时使用 `grok-4.7-high-fast`。显式写成 `Auto` 会被拒绝，免得由 Cursor 在配置之外替你选模型。
- `apiKeyEnv` 填专用 Cursor 账号 API key 所在的环境变量名，推荐使用。不填时退回本机的个人登录：安装检查会给出提示，执行记录里也会写入 `accountRules: personal-account`。
- `permission` 可选，取值为 `workspace-write` 或 `read-only`，协调者固定为 `read-only`。
- 不支持业务工具、受管理任务和运行中追加输入；配置里写了这些字段会被拒绝。

## 运行方式

每一轮执行一次：

```text
cursor-agent -p --output-format stream-json --trust --sandbox enabled --model <model> --workspace <工作区> [--mode ask] [--resume <chatId>]
```

- 提示词通过 stdin 传入，不出现在进程参数里。
- 任何情况下都不加 `--force`、`--yolo` 或 `--approve-mcps`。实测中，不加 `--force` 时沙箱会拒绝写到工作区以外的位置，工作区内的编辑和 shell 命令仍会自动执行；加了 `--force` 就能写到工作区以外。
- 只读角色和协调者另加 `--mode ask`。协调者在项目状态目录下空的 `assessment-context` 目录里运行，需要更多事实时由宿主读取并提供。
- 第一轮从 `system/init` 事件读取会话 ID，立刻上报 checkpoint。不使用 `create-chat`：实测中它打印 ID 后进程不会自行退出。
- 最终报告只取最后一条 assistant 消息。`result` 字段会把整轮的所有 assistant 文本拼在一起，不能直接作为报告。退出码非 0、缺少 `result success` 事件、或最后一条消息不是 v2 JSON 报告，都按失败处理。未登录会标为 `AUTH`，模型被拒绝会标为 `BAD_REQUEST`。
- 每轮结束后，CLI 会在同一进程组里留下 `worker-server` 和 TypeScript 语言服务器。看守进程按进程组清理，不会让它们留到下一轮。

## 隔离

每个会话有自己的私有 HOME：项目状态目录下的 `harness/cursor-agent/homes/<homeId>`。Cursor 在这里生成全新的默认配置，所以本机 `~/.cursor` 里的权限白名单、模型设置、MCP、hooks、本地 skills 和会话历史都不会被带入。

- 使用 API key 时，只注入 `CURSOR_API_KEY` 和 `AGENT_CLI_CREDENTIAL_STORE=memory`，私有 HOME 里没有任何账号文件。实测中，只给 key 不设这个变量，CLI 换到令牌后仍会调用 macOS `security` 写钥匙串；私有 HOME 下没有钥匙串，系统会弹出“找不到钥匙串”并卡住这一轮。设为 `memory` 后令牌只留在进程内存里，不碰钥匙串也不写 `auth.json`。
- 安装检查的登录探测在 API key 模式下调用 `models`：key 被拒时退出码非 0。`status` 只反映本机保存的登录，对 API key 始终显示未登录，所以只在个人登录模式下使用。
- 使用个人登录时，只把 `Library/Keychains` 软链接进私有 HOME，因为令牌存放在 macOS 登录钥匙串里。
- 环境变量只放行 `PATH`、语言、代理和证书设置，GitHub 令牌不会传入。
- 不设置任何 `XDG_*` 变量。真实冒烟测试中发现：一旦设置了 `XDG_CONFIG_HOME`，Cursor 会把会话存到 `$XDG_CONFIG_HOME/cursor/chats`，不再放在 `HOME/.cursor/chats`，续接检查就会找不到会话文件。

账号层面的内容在本地隔离不掉。实测中，即使换了私有 HOME，Cursor 仍会从服务端下发该账号的用户规则，以及 Cursor 内置的 skills 和默认插件里的 skills。个人账号里的规则会改变 Worker 的行为，例如回答语言、执行命令前的习惯。CLI 没有关闭它们的开关。所以要让 Worker 不受个人规则影响，只能给它一个干净的专用账号，并通过 `apiKeyEnv` 传入该账号的 key。

## 会话续接

Cursor 按 `md5(工作区真实路径)` 分目录保存会话。如果换一个目录用同一个 ID 续接，它会在新目录下建一个空白会话，而且仍然返回成功。所以驱动在续接前会核对三件事，任何一项不符都拒绝运行，并要求显式 `session replace`：

1. 绑定记录里的工作区、登录方式和 CLI 版本都与本次一致；
2. 会话文件 `chats/<md5>/<chatId>/store.db` 确实存在；
3. CLI 输出的 `system/init` 里的会话 ID 等于请求续接的 ID。

运行时的会话绑定本身也会记录工作区路径，工作区变化时同样要求替换会话。

## 限制

- 不支持运行中追加输入，新消息排到下一轮处理。
- 不检查中断前的原生历史，中断的工单交给人工检查。
- 实测每轮耗时 24 到 95 秒，大部分是冷启动，默认超时设为 15 分钟。
- 沙箱依赖 Cursor 自带的 macOS 沙箱，不等于操作系统容器。
- 只在 macOS 上实测过；Windows 会被直接拒绝。

## 验证

- `test/cursor-agent.test.mjs` 用一个假的 CLI 覆盖以下内容：启动参数、stdin 传入提示词、只取最后一条消息、按工作区和登录方式拒绝续接、API key 模式、未登录、缺少 `result`、取消时清理进程组、协调者只读运行，以及适配器的登录检查。
- `examples/real-cursor-local-smoke.mjs` 是手动执行的真实检查：先打冻结安装包；Worker 第一轮提问，宿主关闭并重新打开后回复，同一会话续接写入文件，宿主再核对文件内容。设置 `JS_SUPERAGENT_CURSOR_API_KEY_ENV` 时使用专用账号，否则使用个人登录。

2026-11-06 22:41 CST 的结果：使用 `composer-2.5` 和个人登录（本机没有专用账号 key），冒烟测试通过，耗时约 2 分 40 秒，结束后没有残留进程。第一次运行在续接时失败，原因是当时驱动设置了 `XDG_CONFIG_HOME`，会话文件被存到了别的位置；去掉 `XDG_*` 变量后重跑通过。

2026-11-06 23:17 CST 的结果：API key 模式真实冒烟测试通过，耗时约 3 分 40 秒；私有 HOME 里没有钥匙串链接或 `auth.json`，运行目录中没有 key 原文，结束后没有残留进程。此前未设 `AGENT_CLI_CREDENTIAL_STORE` 时，同样的调用会弹出“找不到钥匙串”并卡住。注意：这次用的 key 属于个人账号，服务端仍下发了该账号的用户规则（例如回答语言），所以它验证的是“API key 登录不依赖钥匙串”，不是“规则隔离”；要隔离规则仍需换成专用账号的 key。
