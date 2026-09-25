# Agent Note: Bounded default for automatic turn continuation

Status: implemented

English | [中文](2026-09-25-bounded-default-turn-continuation-chain.zh.md)

## Problem

When a model repeatedly reaches its output token limit, the turn-continuation guard can queue another request after every truncation. An unbounded default lets a model that cannot finish within the configured output limit consume tokens indefinitely without a new human decision.

## Decision

`@deepseek-ai/dsh-turn-continuation` defaults `maxConsecutive` to three automatic continuations per chain of consecutive max-tokens endings. The fourth truncation in that chain logs a warning and queues no continuation. Any other turn ending resets the count; a later truncation can start a new chain. Deployments can configure a higher finite integer limit.

The cap counts continuation prompts, not truncation events: the first three max-tokens endings each earn one continuation, and the next max-tokens ending stops the chain. This policy applies to every agent using the guard, including subagents. The [original turn-continuation Agent Note](../feature/2026-08-28-turn-continuation-after-truncation.md) retains the rationale for resuming truncated turns and the independent delivery semantics.

## Alternatives considered

- **Keep the unbounded default** — rejected because a model that repeatedly exhausts its output budget can trigger an indefinite chain of model requests and token charges without user input.
- **Allow only one automatic continuation** — rejected because one continuation can itself reach the output limit while the model is still completing ordinary long-running work; three retries allow several resumptions while placing a finite ceiling on a stuck chain.
- **Disable automatic continuation after any truncation** — rejected because a single output-limit cut should still resume without requiring a human to send "continue".

## Consequences

- A chain receives at most three automatic continuation prompts by default; the following truncation remains visible as an incomplete turn and produces a warning.
- A deployment that needs longer chains can raise `maxConsecutive`; every accepted value remains finite and must be an integer >= 1.
- The count stays in memory per agent and resets on every non-max-tokens ending, preserving the existing chain lifecycle.
- The unit regression and keyless SDK snapshot pin the default count and the stopping transcript.
