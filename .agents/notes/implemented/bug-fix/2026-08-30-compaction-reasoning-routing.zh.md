# Agent Note: Compaction reasoning follows the routed request

Status: implemented

[English](2026-08-30-compaction-reasoning-routing.md) | 中文

## Problem

默认压缩摘要器只用已路由的提供方与模型重建辅助模型请求，因此最新请求标头中记录的显式 reasoning 档位会丢失；适配器的提供方默认值随即占用当前会话并未选择的生成空间。

## Decision

当摘要目标与最新请求使用相同的提供方／模型时，`dsh-compaction-basic` 会从最新请求标头继承显式 reasoning 档位，同时忽略由适配器物化的默认标记。没有更新的持久请求标头时，如果 `AgentOptions` 匹配目标，也会继承其中的显式档位。`llm-pi-ai` 会通过 `X-DSH-Purpose` 发送辅助调用 purpose 标记，使兼容网关无需检查模型可见消息就能识别压缩请求。

Qwen 兼容代理会把没有显式档位的压缩请求按 `none` 处理，也会把显式关闭 thinking 的标记按 `none` 处理。显式 `reasoning_effort` 仍具有优先权，因此用户选择的 `minimal` 请求继续使用 `minimal` 预算，而没有限定的辅助请求不会再回退到提供方的高推理默认值。

## Alternatives considered

**继续让压缩目标只包含提供方／模型。** 否决：辅助调用会悄悄改变持久且用户可见的请求控制，并可能在摘要生成前耗尽大部分剩余上下文。

**在 Harness 中强制每个压缩调用为 `off`。** 否决将其作为唯一修复：pi-ai 会把 `off` 表示为关闭 thinking 且省略 reasoning 字段，而旧网关可能把省略字段解释成普通默认值。因此网关也必须识别 purpose 或关闭标记。

**只修网关默认值。** 否决将其作为主要修复：Harness 请求仍然语义不完整，其他适配器或网关仍可能重新引入丢失。网关处理保留为纵深防御。

## Consequences

当压缩目标与活动会话路由一致时，压缩使用同一个显式 reasoning 选择。兼容的 Qwen 网关可以安全地以零 reasoning 预算运行未限定的压缩请求，同时保留调用方有意选择的档位。线协议 purpose 标头属于适配器元数据，不会进入模型输入或会话记录。
