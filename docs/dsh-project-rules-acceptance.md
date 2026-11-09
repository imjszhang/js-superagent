# DSH 项目指令范围修复与主仓库真实验收

日期：2026-11-03。适用于 `0.8.0-alpha.0`，保留独立 CLI/SDK、Codex app-server 和 DSH SDK；W18 继续暂缓。

## 问题与修复

此前 DSH 在启动前递归读取整个工作区所有 `AGENTS.md`。本仓库验收 worktree 中有 22 份、共 167,689 字节，多数属于历史内容项目，超过原 64 KiB 注入预算。任务在原生模型调用前失败，并非 DSH API 或后台进程不可用。

现在按工作目录加载工作区内的祖先链，启动默认仅根目录。本次根指令为 3,969 字节。内部 helper 的显式 `directory` 可选择更深目录的祖先链；这只是上下文选择，不从自然语言工单推断文件授权，也不扩大可操作范围。不会递归扫描兄弟目录、归档目录或目标目录的全部后代。

manifest 升为 v2，记录 `directory-chain`、请求目录、实际存在的目录、已注入文件及其摘要。每轮恢复重新读取并记录当前快照；适用指令本身仍受 64 KiB／128 文件限制，拒绝路径越界、目录或指令符号链接及读取期间变化。未改动 DSH 的原生会话、身份、工具与恢复授权。

进入尚未覆盖的子目录前，提示词要求使用文件工具逐层检查并读取其适用 `AGENTS.md`。**这是 Agent 执行规约，不是宿主强制文件访问门禁。** manifest 仅证明已注入的文件，不能充当延迟读取的回执。此次任务的 `packages`、`packages/js-superagent`、`packages/js-superagent/examples` 均由宿主独立核对不存在子目录指令；根文件摘要与原生快照一致，因此本次没有遗漏实际适用指令。不将本次结果解释为任意深层目录自动发现能力均已验收。

## 验收结果

| 检查 | 结果 |
| --- | --- |
| 加载器定向测试 | 4 项通过：无关超限子树、现存及未来目录祖先链、越界／符号链接拒绝、适用链预算 |
| SDK wrapper 测试 | 1 项通过：无关内容不进入 prompt，同会话恢复刷新指令摘要，checkpoint 与落盘 manifest 一致 |
| 类型检查 | 通过 |
| 主仓库真实后台 | macOS launchd，DSH `0.2.2-alpha.2`，真实 DeepSeek `deepseek-flash` API |
| 原失败工单 | `e869ff49a9493c23dcfd5b41ea1208ed`，保留之前超限失败记录，修复后显式重试 |
| 工作流 | 接单 → 提问且不提前写文件 → 主后台重启 → 同会话回复 → 写入／读取验证 → ready |
| 原生会话 | `js-8273e765-fe4d-44cf-8af0-fde33562b96b`，前后相同 |
| 产物 | worktree 内 `packages/js-superagent/examples/dsh-acceptance.txt`，精确内容 `Hello DSH main repository` 加一个 LF，共 26 字节 |
| 变更范围 | 仅指定验收文件；另有宿主原有 `.js-superagent/workspace-owner.json`，已通过工作区归属校验 |

机器可读本地证据为主项目 `.js-superagent/dsh-main-repository-acceptance.json`，包含时间、两轮 run ID、会话、指令摘要、文件 SHA-256、独立核对及服务状态。产物保留在该工单的独立 worktree，未写入主检出目录，未提交或推送。

主项目后台当前保持运行，执行端为 DSH，交付模式为 local。本次没有真实 GitHub 写入，没有重跑大规模测试；实际完成的是主仓库本地后台任务闭环。此前 schema 3 状态已在切换服务前备份并迁移至 schema 9；本轮不再做迁移。
