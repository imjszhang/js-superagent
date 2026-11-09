# 0.6 / schema 7 操作与恢复说明

适用于本轮 W15–W23；[验收范围与剩余限制](workflow-continuity-acceptance.md) 中明确列出的 W18 自动采用仍未完成。以下是以后部署时的操作说明，本轮没有执行生产升级或启动服务。

## 查询与显式升级

以下查询不会运行模型，也不会将旧数据库升级到 schema 7：

```sh
js-superagent --project /path/to/project service status
js-superagent --project /path/to/project status
js-superagent --project /path/to/project github status
js-superagent --project /path/to/project recovery status
js-superagent --project /path/to/project session inspect <ticket-id>
```

以后明确决定部署时，先停止该项目所有前台/后台执行，确认 owner、工具进程、预览和子任务均已收尾。业务 `pause` 只暂停派工和回复，不能代替进程停止。保留原安装包、项目配置和凭据位置，然后使用新包的命令显式升级：

```sh
js-superagent --project /path/to/project upgrade
```

命令检查停止状态，取得维护锁，保存一致性备份与旁边的 `.backup.json` 清单，再原子迁移到 schema 7。成功返回 `{"schemaVersion":7}`；失败保留旧 schema，不能删除 owner/锁记录绕过检查。首次写入新版执行或收件语义也会要求同样的升级保护，部署时建议先显式完成升级。

升级不会更换会话、开启自动恢复、重放旧评论或重排历史失败记录。新库中的对象健康记录需要下一次实际同步建立；旧整轮成功时间不能作为每个 Issue/PR 的新鲜度。旧包必须拒绝读取 schema 7。

## 回退准备与安装边界

先停止所有执行，核对备份生成之后已经发生的 GitHub 回复、提交/PR、工具动作及工作区修改。数据库回退无法撤销这些外部动作，不能仅恢复旧库然后直接重新执行工单。

使用 SDK 导出的 `inspectDatabase(path)` 查看版本和维护记录，再调用 `prepareDatabaseRestore()`：

- `path` 指向当前数据库；`backupPath` 指向本次升级保留的 `.backup`，其旁边的清单必须完整。
- `expectedVersion` 使用备份真实旧版本；本轮 schema 6→7 回退为 `6`，不能填当前的 `7`。
- `reconciliation.backupId` 必须等于备份清单的 `id`；`note` 记录已核对的外部动作及后续处理。
- `assertStopped` 必须依据实际服务/前台/工具进程状态确认停止，不能无条件返回真。内部仍会检查数据库中的所有权。
- `destination` 可选，且必须是新的暂存路径，不能覆盖当前数据库。

这个 API 验证来源、摘要和版本后，**只生成 staged 副本**；返回清单中的 `installRequired` 和 `oldPackageRequired` 均为真。它不安装副本、不切换包、不启动服务。实际恢复属于单独的部署动作：保留当前库及 WAL 等完整状态、在无连接状态下安装核对后的副本、配套原版本包和配置，先只读检查，再决定是否重新执行。不得手工降低 `PRAGMA user_version` 或让旧包强读新库。

## 故障与恢复

`github status` 中 `synchronization.objects` 区分各对象状态、最后成功时间和下一次重试。单对象失败只阻止相关工单；仓库身份/权限故障会阻止相关仓库工作。恢复后需要可信成功读取才能解除阻挡，空轮询或跳过重试不能冒充恢复。

`details <ticket-id>` 和 `trace <ticket-id>` 显示恢复检查、输入消费与原生等待事实。普通连接故障先只读检查；completed 结果收取不再次运行 Worker。自动检查服从已有开关，手动 `retry` 也遵守同一证据要求：

```sh
js-superagent --project /path/to/project details <ticket-id>
js-superagent --project /path/to/project trace <ticket-id>
js-superagent --project /path/to/project retry <ticket-id>
```

`retry` 可能只排入检查，不能把返回成功理解成已重新执行。有未收尾的任务、外部动作或交付时，先核对对应记录；无法证明时继续保留检查状态。DSH 的 `native-pending-wakeup-unsupported` 表示原队列保留、尚未消费；不能靠重复 retry 或发空消息解决。明确决定放弃旧会话时，先检查其副作用，再使用已有会话替换入口，不能把替换当成旧消息已读的证据。

## 团队规约的后续生效

`prompts status` 查看当前修订；`prompts set <file> <expected-revision>` 保存新修订但不主动唤醒 Worker。下一次正常业务轮次采用新规约，模型、工具、工作区及基础执行设置继续固定。恢复原 run 时沿用原快照，不使用新规约解释旧结果。

详情区分选择、原生接收和应用，记录实际应用时间及所属 run；此前运行的应用记录不会显示成当前轮次已应用。子任务在启动时固定父轮次的规约快照。

旧 `executionConfig.prompt` 保留原始摘要；只有历史 assembly 和拼接结果精确一致才拆出业务规约。`legacy-unresolved` 表示缺少这种证据，原会话继续使用旧设置。需要切换时先核对交付与任务状态，再通过 `session replace` 的 JSON 提供准确 `expectedSessionId`、原因和明确的 `adoptCurrentSettings` 选择；替换保留 lineage 和旧输入收据，不自动解决未知副作用。

## 本地安装包与摘要

本轮留存位置为仓库下 `working/reports/js-superagent-w23-20261102/`：

- `js-superagent-0.6.0-alpha.0.tgz`：独立安装包，不包含生产状态或凭据。
- `manifest.json`：包 SHA-256、按实际文件生成的源码摘要、基线提交和文件清单。

这些产物仅留本地，不代表 npm 发布、GitHub 推送或生产部署。安装检查在一次性消费目录进行，使用已注册的本地 fixture 验证 CLI/SDK；不需要安装 DSH 或 js-agent-runtime，不调用外网模型。
