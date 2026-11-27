# DSH 0.2.2-rc.5 兼容与迁移

2026-11-27，js-superagent `0.15.0-alpha.17` 候选。本文记录接入层兼容，不代表 npm 发布、远端模型验收或生产部署。

## 保持执行边界

精确支持 `0.2.1-rc.5`、`0.2.2-alpha.2`、`0.2.2-rc.5`；不按 0.2.2 的版本范围推断其他版本兼容。新版本继续使用 SDK 的 `session/prompt`，文本中的斜线命令保持普通输入，不切换到新版 `session/query` 的原生命令入口。会话、输入消费证据、工具桥和 v4 原生日志沿用现有合同。

新版 base 启用了 `agent-team` / `tool-agent-team`，SDK app 引入 `office-kit` / `tool-office` 并重新启用插件管理工具。因此仅给 `0.2.2-rc.5` profile 追加四个团队与 Office 禁用项，同时延续 `plugin-manager` / `tool-plugin-manager`、原生调度、goal、问答、文件展示、web、原生子任务和工作流的限制。

协调者没有原生执行或文件工具；host-only Worker 通过宿主授权材料入口读取。可写 Worker 的 shell/文件能力仍由既有 permission 和受管工作区决定。原生交接和预览只对精确核对的 `0.2.2-alpha.2` / `0.2.2-rc.5` 开放，保留任务、会话、进程、job、报告与归属证据检查。不改变 Core、longrun 回合、人工审核、Outbox、预算或自动重试策略。

## 项目固定执行程序

DSH 是宿主选择的可选外部执行程序，不是本包的运行依赖。安装 `js-superagent` 不会安装或替换全局 DSH。采用项目本地 DSH 时，应固定精确版本和锁文件，并将后台直接使用的 DSH 归入 `dependencies`，避免 `npm ci --omit=dev` 后后台缺少程序。也可使用独立工具目录，但该目录需有自己的精确锁文件、安全检查与回滚记录。

DSH `0.2.2-rc.5` 要求 Node.js `>=24.9.0`；js-superagent 本包未使用 DSH 时仍保持 `>=22.13.0`。部署环境必须满足实际执行程序要求。

适配成功不等于 DSH 传递依赖不存在安全告警。宿主应分别核对实际安装锁图与 npm 审计；如需临时 overrides，应限定具体上游父包，并以相同锁图完成回归。不要将归类为 devDependencies、关闭审计或选择全局程序当成修复。本包不替宿主写入 overrides，也不更换执行架构。

## 保留会话与记录

两个旧版本的 profile 生成字节保持不变。同版本继续原会话；跨版本在启动前拒绝，不改写 binding、原生日志或输入收据。只读历史检查不把 pending 消息标记成已消费。公开 `session/resume` 仍无无消息唤醒选项，`session/wait` 只等待；原 pending 队列自动采用仍返回 `native-pending-wakeup-unsupported`。

先记录旧配置与精确 executable，核对无活动执行、预览、未核对交付或在途外部动作，再按既有公开接口切换：

1. 停止所属后台，保留旧 DSH 程序和状态目录；独立验证候选安装，不原地覆盖唯一可恢复的旧程序。
2. 对新的 Worker 使用 `configureExecutor` 设置新的精确路径。历史工单保留冻结配置；不要批量替换会话。确实需要升级未完成工单时，先 `session inspect`，再明确提供 `reason`、`expectedSessionId`、`adoptCurrentSettings` 调用 `replaceSession`，继续遵守已有静止和交付检查。
3. 协调者通过 `configureCoordinator({assessor: {...originalAssessor, executable: newPath}}, {expectedRevision})` 切换，保留 policy、workflowMode、模型、后端与授权。`assessor` 参与设置版本摘要，**路径改变会得到新的协调者会话键**；旧会话与配置修订留存，新会话从保存的项目事实、工单、事件及授权 reader 重建上下文。
4. 原路径上的程序被直接覆盖不改变配置摘要，不能据此得到新会话，仍可能遇到原生版本绑定冲突。不要修改数据库或重置历史解决；本次部署使用不同且可追溯的程序路径。
5. 需要回滚时恢复原精确路径与对应配置。原版本协调者 session key 可再次被选中；这保留历史，但不撤销升级期间已经授权执行的业务动作。恢复前仍要核对这些动作及当前权限。

此过程没有迁移长期任务数据。任何实际部署必须额外核对宿主所保存的任务、回合和审核状态。

## 验证入口

常规 `npm run check` 覆盖精确 probe、旧 profile 字节、同版本恢复、跨版本拒绝、工具桥授权、取消清理、原生 lease、两种协调路径的配置切换与回滚。

以下测试需要显式指向独立候选安装；只连接本地模拟 provider，不调用远端模型。每次使用独立测试状态目录，不能省略状态隔离入口：

```bash
DSH_EXECUTABLE=/absolute/path/to/isolated/node_modules/.bin/dsh \
  node --import ./test/helpers/state-home.mjs test/dsh-native-profile.mjs
```

相同命令入口可运行 `test/dsh-native-continuity.mjs`、`test/dsh-native-reliability.mjs`、`test/dsh-native-final-report.mjs`、`test/w28-dsh-native-handoff.mjs`、`test/w34-dsh-native-preview.mjs`。分别检查实际模型工具清单、受控异步读取和 pending 保留、取消及原会话恢复、缺失终态报告恢复不重复副作用、后台收取与预览续期。它们不包含生产飞书发信、长期任务结算或真实模型质量评估。

2026-11-27，macOS / Node.js 24.22.1 验收结果：

| 检查 | 结果 |
| --- | --- |
| 完整 `npm run check` | 1726 个运行时测试、154 个 Core 测试、154 个 SQLite 测试，及类型、版本、独立包消费者检查通过 |
| 实际 SDK profile | 6 次 loopback 请求，三角色分别同会话续接；协调者工具清单为空，host-only 仅 `js_superagent_read` / `todo_write`，可写 Worker 为既有 11 个工具，无团队、Office 或插件安装入口 |
| 原输入与工具桥 | 4 次请求，pending 原日志不变、拒绝自动采用、异步宿主读取被消费、同会话更新业务规约通过 |
| 中断、恢复与取消 | 8 次请求，已完成证据、输入消费收据、崩溃后同会话恢复和所属 shell 清理通过 |
| 缺少终态报告 | 3 次请求，同会话补报告，已执行临时操作次数仍为 1 |
| 原生交接 / 预览 | 分别 4 / 2 次请求，原进程回复、无模型唤醒收取、预览续期越过原运行期限、所属进程退出通过 |

上述 SDK 验收使用独立 DSH 候选锁图，在 `@deepseek-ai/dsh@0.2.2-rc.5` 子树内限定覆盖 `@modelcontextprotocol/client=2.3.0`、`fflate=0.8.3`、`undici=8.12.2`；锁文件 SHA-256 为 `0e34e95880d91813c22c36a2086f6bbba39a2ed156c995def72f811552feff84`。这是已测候选环境的记录，不是向所有宿主自动添加 overrides 的要求，也不替代宿主安装及完整安全审计。原生验收只使用临时目录、假凭据和本地 provider。
