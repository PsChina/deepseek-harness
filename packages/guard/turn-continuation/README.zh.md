---
description: "在模型输出 token 上限处截断的轮次自动续行的循环卫生守卫，供选择、配置或调试该插件的用户与维护者参考。"
kind: "package-reference"
---

# @deepseek-ai/dsh-turn-continuation

[English](README.md) | 中文

## 概述

超长的回答一旦超出输出 token 上限，轮次就会在未完工时结束，智能体就此停下。`dsh-turn-continuation` 把该截断当中断而非终点：当轮次因输出 token 上限结束时，守卫在下一次整个 agent 空闲时排入一条固定的续行提示词，从停下的位置准确续行。默认情况下，每个 agent 在一条连续截断链中最多获得三次自动续行；之后再次触顶时会记录警告并停止。部署可以提高 `maxConsecutive` 上限。任何其它轮次结局——完成、中止、错误、拒绝或打断——都会重置计数链。守卫在内存中跟踪每个 agent，并随 `dsh` 基础 bundle 默认启用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与遗留工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当被截断的回答应当自行完成、而不是等人说"继续"时，挂载此插件。无需学习或接线：`dsh` 基础 bundle 已经运行它。默认允许自动续行三次；较长任务可配置更高的有限上限。

### 何时选用

当长自主轮次——大改动、生成文件、长回答——容易以输出上限截断收场，且正确反应是"接着干"时，选它。当截断应当作为需要人工审查的硬停顿时，避开它；守卫对每次截断只追加一条插件署名的提示词，从不改动被截断的输出本身。

### 设置失控杠杆

默认值允许每条链自动续行三次。需要更长的续行链时，可配置更高的有限上限：

```yaml
- name: '@deepseek-ai/dsh-turn-continuation'
  config:
    maxConsecutive: 5        # stop chaining after 5 back-to-back continuations
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxConsecutive` | `3` | 一条背靠背 max-tokens 结局链内允许的最大自动续行次数；这些续行用完后再次触顶，守卫会记录警告并停止 |

链只对背靠背的 max-tokens 结局计数：一次完成、中止、出错或被拒绝的轮次会打断它，因此之后的截断从全新计数开始。非整数或小于 1 的 `maxConsecutive` 会在启动时以清晰错误失败，绝不静默改变行为。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-turn-continuation)记录了所有接受的取值。

### 你会得到什么

当轮次因输出 token 上限结束时，下一个整个 agent 空闲点会送达下方的续行提示词（插件署名），模型在新轮次中继续同一份工作。续行在会话中以插件折叠行渲染，单行摘要为"previous response hit the output token limit"（上一次响应触及输出 token 上限）。若续行轮次持续触及上限，守卫默认最多再自动续行三次；之后再次截断时会记录警告并停止。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

本节解释守卫如何检测截断并投递续行，并指向实现它的代码；可观察行为已在[使用本包](#use-this-package)中完整覆盖。

### 设计哲学

守卫建立在四项承诺之上：

- **截断不是终点。** 轮次的工作尚未完成，缺的只是一个提示，因此守卫对每次截断恰好供给一条续行，绝不多给。
- **在整个 agent 空闲时排队。** 续行只在 `agent/status` 空闲时排队，因此续行绝不会与已占据下一轮次的工作争抢；pending 标记使一次截断产生的任何空闲过渡下的排队保持幂等。
- **会话日志即结局记录。** 截断检测读取持久化的 `turn/end` 原因，从不读取模型文本或适配器信号，因此每个轮次恰好检测一次 `max-tokens` 结局。
- **响亮失败，收敛失败。** 错误配置在插件加载时抛出；排队续行失败时清空该 agent 的链并告警，而不是让循环崩溃。

### 截断链

每个 agent 的链是 `WeakMap<Agent, ChainState>` 中的 `{ consecutive, pending }`，在 `agent/created` 时预先记录；对守卫挂载前已在运行的 agent 则惰性建立。

- **只有 max-tokens 结局计数。** `session/event` 监视持久化的 `turn/end` 事件；除 `max-tokens` 外的所有原因——完成、中止、出错、拒绝、打断——都重置 `consecutive` 并清除 `pending`。
- **上限即停且重置。** 设置 `maxConsecutive` 后，达到或超过上限的链记录点名 agent 与上限的警告、重置并不再排队。
- **按 agent、仅内存。** 一个 agent 的截断绝不打扰另一个 agent 的链；从持久化恢复的会话从全新链开始。

### 续行投递

守卫排入一条携带固定续行文本与插件来源 `{kind: 'turn-continuation', form: 'notice', summary: 'previous response hit the output token limit'}` 的 `user/message`。来源标注至关重要：未标注的注入消息会在派生历史中渲染成普通用户提示。排队失败——agent 已销毁、收件箱拒绝——会清空链并以渲染后的错误告警，使循环本身永远看不到这个异常。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` schema、响亮失败校验、链监听器、投递 |
| [`src/invariant.ts`](src/invariant.ts) | 不变量伴生插件（无运行时不变量：链私有于守卫自身监听器） |

</details>

-----

<a id="further-exploration"></a>
## 深入探索

当包级契约不够时阅读这些页面。它们覆盖决策依据与守卫同 goal 机制的交互。

- [Turn-continuation Agent Note](../../../.agents/notes/implemented/feature/2026-08-28-turn-continuation-after-truncation.zh.md) — "截断不是终点"的决策与考虑过的替代方案。
- [Goal round driver](../../goal/goal-round-driver/README.zh.md) — 为什么 max-tokens 结局不再停止自动 goal round：被续行的轮次仍是同一轮。
- [guard 组地图](../README.zh.md) — 同组的守卫插件与循环卫生家族。

-----

<a id="model-experience"></a>
## 模型体验

### 续行提示词

#### 模型会看到什么

在任何因输出 token 上限结束的轮次之后，模型会在 agent 下一次空闲时收到下方固定提示词（插件署名）。不会附加任何工具 schema 或其它文本。

##### 续行提示词

```markdown
Your previous response was cut off by the output token limit before you finished. Continue exactly where you stopped; do not repeat anything you already sent.
```

#### Token 影响

每次自动续行会增加一条小而固定的消息和模型输出。默认上限将一条连续截断链限制为三次自动续行；配置更高的上限会允许更多次续行。

#### KV Cache 影响

仅追加；每条续行跟在被截断轮次可复用的请求前缀之后，不会使既有 KV-cache 条目失效。

## 已知限制与遗留工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定了守卫不适用的场合。它们是当前包的约束，而不是任务待办。

- **单一固定提示词** — 续行文本是协议常量，不能按任务或模型定制；模型只知道被截断了、该从何处继续。
- **续行链有有限默认值** — 默认自动续行三次，并在之后再次截断时停止；部署可以配置更高的有限 `maxConsecutive` 值。
- **内存态链条** — 从持久化恢复的会话从全新链开始，因此跨进程重启的截断不会被续行。
- **仅在空闲点投递** — 续行绝不在轮次中途排队；若 agent 永远达不到空闲（挂起的步骤），续行会等该步骤落定。
- **不比对被截断输出** — 守卫请模型"不要重复已发送的内容"，但从不比对或改写；若模型从略早处续写，那是模型的错误，且会在会话中可见。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

此 Dev Note 为维护者工作上下文，明确不具权威性。已交付行为与限制以各节正文与代码为准。

[Turn-continuation Agent Note](../../../.agents/notes/implemented/feature/2026-08-28-turn-continuation-after-truncation.zh.md) 记录了 max-tokens 结局会自动续行的依据；[有界默认值 Agent Note](../../../.agents/notes/implemented/bug-fix/2026-09-25-bounded-default-turn-continuation-chain.zh.md) 记录了有限默认值。守卫与 [goal round driver](../../goal/goal-round-driver/README.zh.md) 都把续行轮次视为同一轮。

</details>
