# 工作流程差距补齐记录

2026-11-03，延续 W30–W35，只补齐与 `dsh-superagent-prototype` 的实际工作流程差距。保持独立包、现有工单 CLI/SDK、Codex app-server 和 DSH SDK；W18、飞书真实接单继续暂缓。未扩展为通用 DSH 宿主，也未添加自动合并等团队策略。

## 已完成

| 范围 | 行为 |
| --- | --- |
| 审阅故障接续 | 持久保存有限重试、下次执行时间和最终检查状态。重启后继续处理；不确定的写操作只读回核对，不盲目重复发送。 |
| 每条审阅意见 | `fixed` 验证并推送后静默解决；`declined` 在原线程发送独立解释并核对回执，机器人线程随后可解决；人工线程保留。`unresolved` 记录未解决状态。停止向每个审阅线程重复发送总报告。 |
| 机器人额度 | 在实际请求审阅前，重新核对当前接收人稳定身份、允许名单和同一 PR 的预算；普通 User 类型的配置机器人也受约束。 |
| 托管预览 | 续期同时改变命令监督计时器与宿主租约，可超过原启动期限；仍受有限 TTL、原 Assignment、撤权、取消及停止清理约束。 |
| 子 Agent | 原任务、原会话、原工作区多轮追加与答复；运行中消息串行排队，正常结束后再开始下一轮。每轮有 run ID、消费回执及结果记录。 |
| 管理 | SDK、CLI、HTTP 和面板接通解除讨论订阅与关闭 unavailable 研判。明确本地协调指令可重试、解除订阅、关闭研判及修改受限设置。 |
| 准入与提示词 | 范围内未列名真人明确寻址支持 `explicit / inferred / ignore`；旧布尔值保留原意。面板可编辑矩阵，并在保存前对比草稿、已保存及默认版本的完整组装提示词。 |
| UI 交付 | 可信宿主步骤采集 Before/After，绑定工作区、来源内容、拍摄条件及文件摘要；缺失或过期时不宣告完整交付。面板通过认证入口读取图片。 |

## 审阅与子任务入口

`review request <ticket> <json-file>` 仍是原入口，新请求示例：

```json
{"kind":"finding","disposition":"declined","commentId":123,"triggerId":"original-trigger-id","reason":"该改动会破坏已明确要求保留的兼容行为。"}
```

`fixed` 仍要求原始评论已读、当前树验证通过且已推送到绑定 head；旧 `resolveThread` 兼容 fixed。只填写 reason 不构成修复证据。解释写入后响应丢失时通过原线程读回确认；无法确认会交给人检查。旧版未完成的请求如果没有稳定接收人身份，也不会仅按旧 login 补授新写权限；可读回确认已完成的动作，否则检查后明确新建请求。

```sh
js-superagent job message <ticket> <child-job> message.json
js-superagent job reply <ticket> <child-job> message.json
# message.json: {"text":"问题的答案或追加要求","requestId":"stable-request-id"}
```

相同请求重试必须复用 `requestId`。`message` 可在运行中排队，`reply`/`resume` 用于已正常完成或提问的子任务。不会扩大原路径范围、重置总时长或无限增加回合。子任务 profile 的 `maxTurns` 默认 4；执行端必须声明会话续接能力。崩溃、未知副作用、冷重开失去原 owner、取消和撤权不走这条续作路径。它不解决 W18 的原生未消费输入唤醒问题。

## 管理入口与协调权限

```sh
js-superagent management
js-superagent unsubscribe '<thread-key>' '<revision>'
js-superagent dismiss '<decision-id>' '<revision>'
js-superagent coordinate '/retry <ticket-id>'
js-superagent coordinate '/unsubscribe <thread-key>'
js-superagent coordinate '/dismiss <decision-id>'
js-superagent coordinate '/settings {"target":"recovery","settings":{"retryBeforeStart":false},"expectedRevision":0}'
js-superagent coordinate '/prompts {"settings":{"sections":{"delivery":"团队交付要求"}},"expectedRevision":0}'
```

协调指令先进入持久收件箱，随后由显式 `run` 或已经运行的宿主处理，不自动启动服务或调用模型。SDK 也接受 `coordinate({text, management:{kind,target,expectedRevision,settings?}})`。这个本地明确意图不可被模型输出、GitHub 评论或来源上下文替换。普通自然语言仍走现有协调流程；涉及这些新增管理动作时，使用上述明确指令或 SDK 参数，不从模糊文本推断权限。

配置目标限定为 `scheduler / recovery / repository / prompts`，复用各自的版本及停止要求；不开放任意命令或执行端修改。解除订阅作用于整个讨论的全部工单订阅，已接收的输入仍依领域内核规则处理，不能等同于取消工单。

## Before/After 配置

`delivery.uiEvidence.mode` 默认 `auto`：检测 HTML、样式、JSX/TSX、Vue/Svelte 及常见 UI 目录的改动；项目可指定 `paths`、选择 `required`，或明确 `off`。自动检测不是所有语言 UI 的完整分类器；非典型目录应显式配置路径。

在任务首次执行前配置可信截图步骤，例如已有项目的浏览器截图脚本：

```json
{
  "mode":"local",
  "uiEvidence":{
    "mode":"auto",
    "paths":["src/ui"],
    "scenario":"设置页：打开高级选项",
    "viewport":{"width":1280,"height":800},
    "theme":"light",
    "capture":{
      "id":"ui-screenshot","version":"1",
      "command":"node","args":["scripts/capture-ui.mjs"],
      "environment":"host","allowHostExecution":true,"timeoutMs":120000
    }
  }
}
```

该脚本由项目维护，必须真实打开指定 UI、应用同一场景/视口/主题，将 PNG 写到 `JS_SUPERAGENT_CAPTURE_PATH`，并在退出前清理它启动的服务器和浏览器。条件通过 `JS_SUPERAGENT_CAPTURE_CONDITIONS` JSON 传入；`JS_SUPERAGENT_CAPTURE_PHASE` 为 `before` 或 `after`。脚本不应改写被验证的源码。

宿主在 Worker 修改前采集基线，ready 前采集 After，校验 PNG、内容摘要、相同条件和当前来源树。记录包含来源内容摘要和已有工作区的基线版本；普通目录使用内容摘要，不伪造 Git commit。证据留在本机项目状态目录的 `ui-evidence/`，不会自动上传 GitHub。面板可打开两张图片，CLI `details` 和 SDK `uiEvidenceStatus` 可读完整记录。

没有可信截图步骤、旧工作没有 Before、条件或来源树变化，都会明确标为 incomplete；UI 改动不会被当作 ready。宿主能证明配置的截图命令运行及内容绑定，不能代替人判断画面是否正确，也不会从报告中的图片路径推断“已视觉验收”。

## 验证及运行边界

本轮采用临时项目、临时 Git、模拟 GitHub、原生短命令和契约 fixture 的定向验证，未调用外部模型或写入真实 GitHub。子会话分别覆盖 Codex/DSH 合同；预览实际越过原截止时间仍可访问，并检查关闭和到期回收。截图测试使用有效测试 PNG 验证绑定、过期与篡改拦截，不宣称完成真实项目视觉审查。

生产后台保持停止；未打开或升级生产 SQLite，未提交或推送本轮工作。schema 9 / `0.8.0-alpha.0` 保持不变，这是尚未发布改造的后续完善。
