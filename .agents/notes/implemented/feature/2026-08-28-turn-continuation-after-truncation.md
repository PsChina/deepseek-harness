# Agent Note: Auto-continuation after output-token truncation

Status: implemented

English | [中文](2026-08-28-turn-continuation-after-truncation.zh.md)

## Problem

When a model's output hits the provider max-tokens limit, the turn ends mid-work: the assistant message is incomplete, a tool call may be cut between arguments, and the agent goes idle with an unfinished task. That idle is indistinguishable in shape from a completed turn, so every consumer had to treat the truncated output as final. A parent agent received partial text as the child's answer; an armed goal round stopped; an ordinary conversation simply waited for a human to type "continue".

The stop was a defect in three ways. The work was not done — the model was cut off, not finished. The same truncation was interpreted differently by different parts of the shipped system, so "what does a max-tokens ending mean" had no single answer. And the fix is mechanical: the missing piece is a nudge, and the harness sits exactly where the nudge can be delivered.

## Decision

`@deepseek-ai/dsh-turn-continuation` in `packages/guard/turn-continuation/` is a loop-hygiene guard that treats a max-tokens ending as an interruption, not a stop. It applies to every agent — main session, subagent, goal round, one-shot — because it keys off the durable `turn/end` reason, not off any particular consumer.

### Detection and the truncation chain

`session/event` watches durable `turn/end` events. A reason of kind `max-tokens` for a live agent increments that agent's chain, `{ consecutive, pending }`, held in a `WeakMap<Agent, ChainState>` and pre-recorded on `agent/session-start` (started lazily for agents that were already running when the guard mounted). Every other ending — completed, aborted, errored, rejected, interrupted — resets the chain to a fresh count. Detection reads the durable reason only; model text and adapter signals are never consulted, so a truncation is detected exactly once per turn.

### Delivery

At the next whole-agent idle edge, if the chain is pending, the guard queues one `user/message` through `Agent.followup()` carrying the pinned prompt:

```
Your previous response was cut off by the output token limit before you finished. Continue exactly where you stopped; do not repeat anything you already sent.
```

The message source is `{ kind: 'plugin', plugin: 'turn-continuation', form: 'notice', summary: 'previous response hit the output token limit' }`, so the injected nudge stays attributable and renders as a collapsed plugin line instead of an ordinary user prompt. A queue failure — the agent already torn down, the inbox rejecting — clears the chain and warns with the rendered error; the loop itself never sees the exception. The pending flag makes delivery idempotent across whatever idle transitions one truncation produces, and only whole-agent idle is used, so a continuation never competes with work that already holds the next turn.

### The runaway lever

The chain is unbounded by default: back-to-back truncations keep earning continuations until the work completes or is aborted. That is an explicit product decision — a truncation is not a stop, and a model that keeps hitting the limit should keep going. The runaway-token lever is the optional `maxConsecutive` (integer >= 1): a chain at or past the cap logs a warning naming the agent and the cap, resets, and queues nothing. A non-integer or sub-1 value fails loud at plugin load.

### Interaction with the goal-round driver

The [same-session goal-round driver](2026-07-19-same-session-goal-round-driver.md) no longer treats a max-tokens ending as a stopping outcome. Its `turn/end` handler ignores everything but `aborted`, because the guard resumes the same turn and the round's work therefore continues; the next goal round is scheduled when the resumed work settles. The base bundle mounts the guard before the driver. The driver note's settlement table was rewritten in place to match.

## Testing

The unit suite drives the real agent loop and session service with the shared scripted model adapter. It covers: one continuation completing a truncated turn with the pinned prompt and plugin source asserted verbatim; a back-to-back chain earning two continuations; the `maxConsecutive: 1` cap warning and stopping; the cap resetting after a completed turn so the next truncation earns a fresh continuation; an aborted continuation breaking the chain; lazy chain creation for an agent running before the guard mounted; an orphan session ending at max-tokens producing no request; a throwing `followup` clearing the chain with the rendered error (both Error and non-Error throws); and load-time rejection of `maxConsecutive` values of 0 and 1.5 with the exact error text. The package reaches per-file 100% statement, branch, function, and line coverage on `src/`.

Keyless recorded-session snapshots replay the shipped profile: `sdk/max-tokens-continue` shows a top-level truncated turn resumed and completed; `session/subagent-max-tokens-continue` shows a child cut off mid-step, resumed by the guard, and returning its finished output through the parent's tool result; `sdk/multi-turn` keeps the ordinary multi-turn behavior intact.

## Alternatives considered

- **Retry inside `dsh-agent-loop`** (auto-resume the truncated step) — rejected because the loop cannot know the work is resumable, and re-running a step re-issues everything in it; a fresh, model-visible turn keeps the transcript honest, replayable, and independent of the concrete loop.
- **A model-facing "continue" tool** — rejected because a truncated model has already stopped and cannot be asked to call a tool it was never told about; the nudge must be deterministic and external.
- **Configurable continuation text** — rejected because the prompt is a protocol constant, pinned verbatim; per-task or per-model wording adds a tunable with no current consumer.
- **Persistent chain state reconstructed from the session log** — rejected because the chain is process-local liveness accounting, and a resumed session is a fresh conversation whose first truncation should start a fresh count.
- **A bounded-by-default chain (for example three)** — rejected as an explicit product decision: unbounded is the default and `maxConsecutive` is the deployment's runaway lever, so token spend on a pathological loop is a policy the deployment owns rather than a behavior the harness hides.
- **Letting each consumer keep its own truncation policy** (goal rounds stop, subagents surface partial text) — rejected because it left the same event with three different meanings; one guard at the event source makes "truncation is an interruption" the single system-wide answer.

## Consequences

- A truncated turn continues automatically for every agent kind; a human "continue" is no longer required anywhere.
- The [subagent output selection rule](../bug-fix/2026-08-10-subagent-empty-terminal-message-output.md) still governs runs where no continuation happens — cancelled children, ACP backends, guard-less compositions — but under the shipped profile a max-tokens child now typically finishes and returns full output.
- A goal round truncated mid-work no longer stops the driver; the resumed turn continues the same round.
- The session log gains one plugin-attributed message form per truncation; the summary line is a protocol constant.
- Token spend on a repeatedly truncated answer is unbounded by design; `maxConsecutive` is the only lever.

## Known limitations and deferred work

- The continuation text is a single fixed prompt; per-task or per-model wording is deferred.
- Chain state is in-memory; a truncation straddling a process restart is not continued.
- Delivery waits for whole-agent idle; a hung step delays the continuation until the step settles.
- The guard asks the model not to repeat itself but does not compare or rewrite resumed output.
