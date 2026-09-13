---
description: "Package map for the loop-hygiene guard family: the truncation auto-continuation, the advisory repeat-tool reminder, and the per-call tool-call timeout policy, for users and maintainers choosing or composing the guards."
kind: "package-group"
---

# guard/ — loop-hygiene guard family

English | [中文](README.zh.md)

## Summary

The `guard/` group watches the agent loop for three failure patterns. `turn-continuation` treats a turn cut off at the output token limit as an interruption rather than a stop, resuming the work at the next idle point so a truncated answer finishes unaided. `repeat-tool-reminder` reminds the model to change approach or finish when it repeats an identical tool call, so a stuck loop stops burning tokens. `timeout-policy` times out tool calls that declare a limit, returning a timed-out error instead of stalling the session. All three ship enabled in the `dsh` base bundle; a composition can tune or remove them.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Three small plugins cover the three patterns; each README below explains when to keep, tune, or remove it.

| Package | What it provides |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Reminds the model when it repeats the same tool call, so it changes approach or finishes |
| [`timeout-policy/`](timeout-policy/README.md) | Times out tool calls that declare a limit, so the model gets a clear error instead of waiting forever |
| [`turn-continuation/`](turn-continuation/README.md) | Resumes a turn cut off at the model output token limit, so a truncated answer can finish |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tools subsystem reference for the tool-call pipeline, then the reminder's configuration and the timeout-library decision behind the policy.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the tool-call pipeline and decisions both guards build on.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted field of the repeat-call reminder.
- [Timeout deadline library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the timing/termination split `timeout-policy` enforces.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
