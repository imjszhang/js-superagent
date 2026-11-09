# 第四阶段：项目配置与工作区

本阶段为现有 CLI/SDK 增加可持久化的执行端配置和按工单保存的工作目录。目标项目不需要使用 Node.js，也不要求 Git。上游领域内核与对应测试保持原样，数据库仍使用 v2。

## 启用

以下命令适用于已从本项目 tarball 安装的包；从源码运行时将 `js-superagent` 换成 `node bin/js-superagent.mjs`。

```bash
# 新项目：选择自动隔离并保存执行端设置
js-superagent --project /path/to/project init --workspace auto --driver codex-app-server
js-superagent --project /path/to/project doctor --driver codex-app-server
js-superagent --project /path/to/project submit "修复失败测试并提供验证结果"
js-superagent --project /path/to/project run
js-superagent --project /path/to/project workspace <ticket-id>

# 已初始化的项目：显式更新设置
js-superagent --project /path/to/project config set --workspace auto --driver codex-app-server --timeout-ms 300000
js-superagent --project /path/to/project config

# 单次覆盖模型，不改保存的配置
js-superagent --project /path/to/project run --model <available-model>
```

`serve`、`reply`、`retry`、`cancel` 等原有命令继续可用。为保持已有项目行为，不指定工作区模式时仍为 `in-place`；启用隔离须选择 `auto`、`worktree` 或 `copy`。项目运行中拒绝 `config set`，先停止当前执行再修改。

SDK 同样可以读取保存的设置，不再必须每次注入 Codex Driver：

```js
import { createProjectAgent } from 'js-superagent';

const agent = createProjectAgent({ projectRoot: '/path/to/project' }).init();
agent.configure({ workspace: { mode: 'auto' }, execution: { driver: 'codex-app-server', timeoutMs: 300000 } });
const ticket = agent.submit({ text: '修复测试并记录验证结果' });
try {
  await agent.runNext();
  console.log(agent.getWorkspace(ticket.id));
  console.log(agent.inspectWorkspace(ticket.id));
} finally {
  await agent.stop();
  agent.close();
}
```

`getConfig()` 返回有效配置。构造时传入 `workspace` 或 `execution` 只覆盖本次实例；`configure()` 才持久化。执行端优先级是：显式注入的 SDK Driver → 本次调用的执行参数 → 项目保存的参数。CLI `run/serve` 在未保存执行器时仍默认使用 Codex；SDK 既未注入 Driver、也未配置执行器时继续报错，不因导入或初始化调用模型。

## 配置文件

新配置保存在项目状态目录的 `config.json`（`~/.js-superagent/projects/<路径编码>/`），格式如下。旧 v1 配置读取时转换为内存中的 v2，原文件不改写；显式设置时才写入 v2，项目 ID 保持不变。

```json
{
  "schemaVersion": 2,
  "projectId": "project-uuid",
  "concurrency": 1,
  "workspace": { "mode": "auto" },
  "execution": { "driver": "codex-app-server", "timeoutMs": 300000 }
}
```

可保存 `execution.executable`、`model`、`timeoutMs`、`killGraceMs`；对应 CLI 选项为 `--codex-path`、`--model`、`--timeout-ms`、`--kill-grace-ms`。不保存账号、密钥、环境变量或任意 shell 命令。保存的相对可执行路径以源项目为基准，执行器的工作目录变为隔离目录后仍能找到原安装路径。

`workspace.baseRef`（CLI `--base-ref`）指定 worktree 的起点，默认为 `HEAD`。`workspace.exclude` 是复制模式额外排除的相对路径前缀，可重复传 `--exclude path`；它不支持 glob，也不能放宽内置排除。写入采用校验后的原子替换，未知字段、错误模式、超限配置和不安全的状态路径会被拒绝。

## 工作区策略

| 模式 | 行为 | 基线与边界 |
|---|---|---|
| `in-place` | 在原项目目录运行，保持旧行为 | 没有目录隔离和独立基线 |
| `worktree` | 从指定提交建立独立 Git 分支和 worktree | 必须是 Git 工作区根目录且已有提交；源项目未提交和未跟踪内容不带入 |
| `copy` | 将当前项目的普通文件复制为独立副本 | 复制当前文件内容，按排除规则保存基线摘要；不使用硬链接 |
| `auto` | Git 根目录选 worktree，普通目录及 Git 子项目选 copy | 子项目只复制自身，不扩展到父仓库；Git 根目录没有提交时明确报错 |

路径为项目状态目录下的 `workspaces/<public-ticket-id>`；Git 分支为 `js-superagent/<public-ticket-id>`。首次执行时固定实际模式、路径、提交或复制基线，之后回复、失败重试、取消后新授权都复用该目录。不同工单从各自首次执行时的源基线开始，不接续另一工单的修改。更改项目配置只影响尚未固定工作区的工单。

Git 模式不会暂存、清理、提交或合并源目录，源项目可以保留已暂存、未暂存和未跟踪文件。元数据会标记 `sourceDirty`，提醒工作区基线取自提交。需要以未提交内容为起点时可显式选择 `copy`。Git 原生 checkout 规则和项目已有过滤器仍可能执行，适用对象是可信本地项目。

复制模式默认排除 `.git`、旧版状态目录 `.js-superagent`、`.env`、`.env.*`、`node_modules`、`.venv`、`venv`、`__pycache__`、`.cache`、`coverage`；跳过符号链接和特殊文件并记录原因。每个普通文件上限 32 MiB，总文件内容上限 256 MiB、普通文件数量上限 20,000。依赖不会自动安装；项目需要的环境由执行任务和本机工具决定。排除规则不构成通用秘密识别器，其他命名的私密文件仍应由用户额外排除。

隔离是工作目录与 Git 状态的隔离，不是对恶意程序的完整安全边界。Codex 仍使用其 `workspace-write` 权限；自定义 Harness 适配器 应遵守传入的实际工作目录。Git worktree 共享 Git 对象与配置，需要更强隔离的任务应使用容器等独立环境。

## 审阅与恢复

`workspace <id>` / `inspectWorkspace(id)` 返回工作区身份和相对基线的新增、修改、删除列表。Git 比较保存的提交，复制模式比较保存的内容及权限摘要，不受后来源目录变化影响。复制排除路径和 Git 忽略的未跟踪文件不在变更清单内，原地执行会明确返回缺少独立基线。建议在任务完成或停止后审阅；运行中的检查不是并发文件修改的原子快照。

本阶段保留工作区供检查，没有自动合并、复制回源目录或删除工作区的流程。成果路径以 `getWorkspace(id).path` 为基准；用户审阅后自行决定如何采纳文件。`cancel` 不回滚已经写入隔离目录的文件。

准备工作先保存身份记录，再创建目录。复制使用 staging 目录、准备日志和原子发布；准备或落库中断后可在显式重试时核对并接续已完成的准备。无法确认归属的目录、已有同名分支、丢失或被替换的工作区都明确失败，不覆盖文件，也不降级到源目录执行。

已有第三阶段原地原生会话会固定到原目录，避免启用隔离后在另一目录误用旧会话。驱动参数 `projectRoot` 是实际执行目录，`sourceProjectRoot` 是原项目，`workspace` 提供身份；运行时自身的 `projectRoot` 始终是原项目。Codex 运行日志仍保存在原项目状态目录的 `runs`，会话、工单和所有权记录仍在原数据库。

## 验收

常规 `npm run check` 不调用模型，覆盖配置迁移与优先级、真实 Git/复制操作、准备中断、路径身份、取消后复用及已安装包的 CLI/SDK。显式真实验收命令：

```bash
npm run test:workspaces:real -- --output /absolute/path/to/new-evidence-directory
```

脚本从 tarball 离线安装，在 Git 与普通 Python 项目中使用真实 Codex，分别完成提问、CLI 回复、SDK 重开后恢复原会话、实际修改及独立复跑测试；再运行第二工单，核对它使用独立的原始基线。Git 场景检查源 HEAD、暂存内容和脏文件不变；复制场景检查人工 `.env` 哨兵及外部符号链接未被复制。实际结果与实现哈希见 [phase4-acceptance.json](phase4-acceptance.json)，原始日志留在本地验收目录。

2026-11-01 在 macOS、Node.js 24.22.1、Codex CLI 0.166.0-alpha.5.1 上完成两轮真实验收。最终包的两个场景、合计六轮真实模型执行全部通过，安装包实现哈希与源码一致。113 项 Node 测试、144 项内存领域测试、144 项 SQLite 领域测试、类型／来源校验、离线安装包及仓库整体检查通过。准备过程故障和取消恢复边界由自动化测试覆盖；本轮未在 Node 22、Linux 或 Windows 上实测。

语义 Assessor、并发多工单执行、自动采纳变更、工作区清理、依赖环境编排、外部渠道和面板不在第四阶段完成范围。后续新增的 GitHub 接入见[第五阶段渠道说明](github-channel.md)。
