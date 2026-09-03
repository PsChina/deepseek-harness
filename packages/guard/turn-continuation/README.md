---
description: "Loop-hygiene guard that resumes turns cut off at the model output token limit, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-turn-continuation

English | [中文](README.zh.md)

## Summary

A long answer that outgrows the model output token limit ends its turn mid-work, and without help the agent just stops: the model has nothing more to say because it was never told to continue. `dsh-turn-continuation` treats a truncation as an interruption, not a stop. When a turn ends at the output token limit, the guard queues one fixed continuation prompt at the next whole-agent idle point, so the model resumes exactly where it stopped without a human nudge. By default a chain of back-to-back truncations keeps earning continuations — the runaway lever is the optional `maxConsecutive` cap. Any other turn ending — completion, abort, error, rejection, or interrupt — resets the chain, so a fresh start begins a fresh count. The guard tracks each agent separately in memory and ships enabled in the `dsh` base bundle.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a truncated answer should finish itself instead of waiting for a human to say "continue". There is nothing to learn or wire: the `dsh` base bundle already runs it, and the unbounded default works for most sessions — set the cap below when token cost matters more than one-shot completion.

### When to choose it

Choose it for long autonomous turns — big edits, generated files, long answers — where an output-limit cut is a common ending and the right response is "keep going". Avoid it when a truncation should instead be treated as a hard stop that a human must review; the guard only adds one plugin-attributed prompt per truncation and never edits the truncated output itself.

### Setting the runaway lever

When you want a ceiling on how many auto-continuations one truncation chain may earn, mount the plugin with configuration:

```yaml
- name: '@deepseek-ai/dsh-turn-continuation'
  config:
    maxConsecutive: 5        # stop chaining after 5 back-to-back continuations
```

| Field | Default | Meaning |
|---|---|---|
| `maxConsecutive` | unbounded | Maximum auto-continuations per chain of back-to-back max-tokens endings; when the chain reaches the cap the guard logs a warning and stops, and the count resets |

A chain counts only back-to-back max-tokens endings: a completed, aborted, errored, or rejected turn breaks it, so later truncations start from a fresh count. A non-integer or sub-1 `maxConsecutive` fails at startup with a clear error, never a silent change of behavior. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-turn-continuation) documents every accepted value.

### What you get

When a turn ends at the output token limit, the next whole-agent idle point delivers the continuation prompt below, attributed to the plugin, and the model resumes the same work in a new turn. The continuation renders in the transcript as a collapsed plugin line with the one-line summary "previous response hit the output token limit". If the resumed turn itself is cut off, the chain continues until it completes, aborts, or reaches the cap.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the guard detects truncations and delivers continuations, and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The guard is built on four commitments:

- **A truncation is not a stop.** The turn's work is unfinished; the missing piece is a nudge, so the guard supplies exactly one per truncation and never more.
- **Queue at whole-agent idle.** Continuations are queued from `agent/status` only while the agent is idle, so a continuation never competes with work that already holds the next turn; the pending flag makes the queue idempotent across any idle transitions one truncation produces.
- **The session log is the outcome record.** Truncation detection reads the durable `turn/end` reason, never model text or adapter signals, so a `max-tokens` ending is detected exactly once per turn.
- **Fail loud, fail contained.** Misconfiguration throws at plugin load; a failure to queue a continuation clears the agent's chain and warns instead of crashing the loop.

### The truncation chain

Each agent's chain is `{ consecutive, pending }` in a `WeakMap<Agent, ChainState>`, pre-recorded on `agent/session-start` and started lazily for agents that were already running when the guard mounted.

- **Only max-tokens endings count.** `session/event` watches durable `turn/end` events; every reason other than `max-tokens` — completed, aborted, errored, rejected, interrupted — resets `consecutive` and clears `pending`.
- **The cap stops and resets.** With `maxConsecutive` set, a chain at or past the cap logs a warning naming the agent and the cap, resets, and queues nothing.
- **Per-agent, in-memory only.** One agent's truncations never disturb another's chain, and a session resumed from persistence starts with a fresh chain.

### Continuation delivery

The guard queues a `user/message` with the pinned continuation text and the plugin source `{kind: 'plugin', plugin: 'turn-continuation', form: 'notice', summary: 'previous response hit the output token limit'}`. The source label is load-bearing: an unlabeled injected message would render as an ordinary user prompt in derived history. A queue failure — the agent already torn down, an inbox rejection — clears the chain and warns with the rendered error, so the loop itself never sees the exception.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `Config` schema, fail-loud validation, chain listeners, delivery |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant: the chain is private to the guard's own listeners) |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They cover the decision rationale and the guard's interaction with the goal machinery.

- [Turn-continuation Agent Note](../../../.agents/notes/implemented/feature/2026-08-28-turn-continuation-after-truncation.md) — the "truncation is not a stop" decision and the alternatives considered.
- [Goal round driver](../../goal/goal-round-driver/README.md) — why a max-tokens ending no longer stops automatic goal rounds: the resumed turn is still the same round.
- [guard group map](../README.md) — the sibling guard packages and the loop-hygiene family.

-----

<a id="model-experience"></a>
## Model Experience

### Continuation prompt

#### What the model sees

After any turn that ends at the output token limit, the model receives the fixed prompt below at the agent's next idle point, attributed to the plugin. No tool schema or other text is added.

##### Continuation prompt

```markdown
Your previous response was cut off by the output token limit before you finished. Continue exactly where you stopped; do not repeat anything you already sent.
```

#### Token effect

One small fixed message per truncation, plus the model's resumed output; with the unbounded default a repeatedly truncated answer keeps growing turn by turn until it finishes, which is the runaway the optional `maxConsecutive` cap bounds.

#### KV Cache effect

Append-only; each continuation follows the reusable request prefix of the truncated turn and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **One fixed prompt** — the continuation text is a protocol constant, not per-task or per-model configurable; the model is told only that it was cut off and where to resume.
- **Unbounded by default is a product decision** — a model that keeps hitting the limit is continued until it finishes unless the deployment sets `maxConsecutive`; token spend on a pathological loop is the lever's job.
- **In-memory chain state** — a session resumed from persistence starts with a fresh chain, so a truncation straddling a process restart is not continued.
- **Idle-point delivery only** — a continuation is never queued mid-turn; if the agent never reaches idle (a hung step), the continuation waits for that step to settle.
- **No deduplication of truncated output** — the guard asks the model to "not repeat anything you already sent" but does not compare or rewrite; a model that resumes from a slightly earlier point is the model's error, visible in the transcript.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers; it is explicitly non-authoritative. Shipped behavior and limits live in the sections above and the code.

The [turn-continuation Agent Note](../../../.agents/notes/implemented/feature/2026-08-28-turn-continuation-after-truncation.md) records the decision and alternatives, including the unbounded default and its runaway lever. Its interaction with the [goal round driver](../../goal/goal-round-driver/README.md) is deliberate: the driver stopped disarming rounds on max-tokens endings once this guard shipped, because the resumed turn continues the same round.

</details>
