# Agent Note: 输出 token 截断后的自动续行

Status: implemented

[English](2026-08-28-turn-continuation-after-truncation.md) | 中文

## 问题

当模型输出触及提供方 max-tokens 上限时，轮次在未完工时结束：assistant 消息不完整，工具调用可能在参数之间被截断，agent 带着未完成的任务进入空闲。这种空闲在形态上与完成态无法区分，因此每个消费方都不得不把被截断的输出当成最终结果：父 agent 拿到的是子 agent 的部分回答，已启用的 goal round 就此停止，普通会话则只能等人输入"继续"。

这种停止在三方面都是缺陷：工作并未完成——模型是被截断，而不是做完；同一次截断在被发布系统的不同部分以不同方式解读，"max-tokens 结局意味着什么"没有唯一答案；而且修复是机械的：缺的只是一个提示，而 harness 恰好站在能投递这个提示的位置。

## 决策

位于 `packages/guard/turn-continuation/` 的 `@deepseek-ai/dsh-turn-continuation` 是一个循环卫生守卫，把 max-tokens 结局当中断而非终点。它适用于所有 agent——主会话、子 agent、goal round、一次性调用——因为它以持久化 `turn/end` 原因为准，不绑定任何特定消费方。

### 检测与截断链

`session/event` 监视持久化的 `turn/end` 事件。对实时 agent 报出 kind 为 `max-tokens` 的原因时，守卫递增该 agent 的链条 `{ consecutive, pending }`；链条存于 `WeakMap<Agent, ChainState>`，在 `agent/session-start` 时预先记录（对守卫挂载前已在运行的 agent 惰性建立）。其它所有结局——完成、中止、出错、拒绝、打断——都会把链条重置为全新计数。检测只读持久化原因，从不参考模型文本或适配器信号，因此每次截断恰好被检测一次。

### 投递

在下一个整个 agent 空闲边沿，若链条处于 pending，守卫通过 `Agent.followup()` 排入一条 `user/message`，携带固定的提示词：

```
Your previous response was cut off by the output token limit before you finished. Continue exactly where you stopped; do not repeat anything you already sent.
```

消息来源为 `{ kind: 'plugin', plugin: 'turn-continuation', form: 'notice', summary: 'previous response hit the output token limit' }`，使这条注入的提示保持可归因，并渲染为插件折叠行而非普通用户提示。排队失败——agent 已销毁、收件箱拒绝——会清空链条并以渲染后的错误告警；循环本身永远看不到这个异常。pending 标记使投递对一次截断产生的任何空闲过渡保持幂等；且只使用整个 agent 空闲点，因此续行绝不会与已占据下一轮次的工作争抢。

### 失控杠杆

链条默认无上限：背靠背的截断会不断换取续行，直到工作完成或被中止。这是明确的产品决策——截断不是终点，持续触及上限的模型就应继续下去。失控 token 杠杆是可选项 `maxConsecutive`（整数且 >= 1）：达到或超过上限的链记录点名 agent 与上限的警告、重置并不再排队。非整数或小于 1 的值在插件加载时响亮失败。

### 与 goal-round 驱动器的交互

[同会话 goal-round 驱动器](2026-07-19-same-session-goal-round-driver.zh.md) 不再把 max-tokens 结局当作停止结果。它的 `turn/end` 处理器除 `aborted` 外一律忽略，因为守卫会续行同一轮次、Round 的工作因此继续；下一轮 goal round 在续行工作落定时调度。基础 bundle 把守卫挂载在驱动器之前。驱动器笔记的结算表已就地改写以保持一致。

## 测试

单元测试以共享脚本化模型适配器驱动真实 agent loop 与会话服务。覆盖：一次续行完成被截断轮次并逐字断言固定提示词与插件来源；背靠背链条换取两次续行；`maxConsecutive: 1` 上限的警告与停止；完成轮次之后上限重置、使下一次截断获得全新续行；被中止的续行打断链条；对守卫挂载前已在运行的 agent 惰性建立链条；以 max-tokens 结束的孤儿会话不产生任何请求；`followup` 抛错时清空链条并携带渲染后的错误（Error 与非 Error 抛错各一）；以及加载时以精确错误文本拒绝 `maxConsecutive` 取值 0 与 1.5。包内 `src/` 达到逐文件 100% 语句、分支、函数与行覆盖率。

无密钥录制会话快照回放已发布 profile：`sdk/max-tokens-continue` 展示顶层被截断轮次被续行并完成；`session/subagent-max-tokens-continue` 展示子 agent 在步骤中途被截断、被守卫续行，并把完成的输出经父侧工具结果返回；`sdk/multi-turn` 保持普通多轮行为不变。

## 考虑过的替代方案

- **在 `dsh-agent-loop` 内重试**（自动续跑被截断的步骤）——不予采纳，因为循环无法知道工作是否可续，且重跑步骤会把其中的一切重新发起；一个全新的、模型可见的轮次让会话保持诚实、可回放，并与具体循环解耦。
- **模型可见的"继续"工具**——不予采纳，因为被截断的模型已经停止，无法被要求调用一个它从未被告知存在的工具；提示必须确定且来自外部。
- **可配置的续行文本**——不予采纳，因为提示词是协议常量、逐字固定；按任务或模型定制措辞只会引入一个没有当前消费方的可调值。
- **从会话日志重建的持久链条状态**——不予采纳，因为链条是进程内的活性记账，而从持久化恢复的会话是一段新对话，其首次截断应从全新计数开始。
- **默认有界的链条（例如三次）**——作为明确的产品决策不予采纳：无上限是默认值，`maxConsecutive` 是部署侧的失控杠杆；病态循环的 token 开销是部署拥有的策略，而非 harness 替它隐藏的行为。
- **让各消费方保留各自的截断策略**（goal round 停止、子 agent 呈现部分文本）——不予采纳，因为它让同一事件拥有三种不同含义；在事件源处设一个守卫，使"截断是中断"成为全系统唯一的答案。

## 后果

- 被截断的轮次对所有 agent 类型自动续行；任何地方都不再需要人工"继续"。
- [子 agent 输出选取规则](../bug-fix/2026-08-10-subagent-empty-terminal-message-output.zh.md) 仍然管辖没有续行发生的运行——被取消的子 agent、ACP 后端、无守卫的组合——但在已发布 profile 下，max-tokens 子 agent 如今通常会完成并返回完整输出。
- 中途被截断的 goal round 不再停止驱动器；被续行的轮次延续同一 Round。
- 会话日志每次截断新增一条插件署名消息；摘要行是协议常量。
- 反复被截断回答的 token 开销在设计上无上限；`maxConsecutive` 是唯一杠杆。

## 已知限制与遗留工作

- 续行文本是单一固定提示词；按任务或模型定制措辞已延期。
- 链条状态仅存内存；跨进程重启的截断不会被续行。
- 投递等待整个 agent 空闲；挂起的步骤会推迟续行，直到该步骤落定。
- 守卫请模型不要重复自己，但不对续行输出做比对或改写。
