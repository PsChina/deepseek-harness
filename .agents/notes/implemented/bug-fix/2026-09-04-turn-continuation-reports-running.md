# Agent Note: The turn-continuation guard must report its continuation turn as running to status observers

Status: implemented

English | [中文](2026-09-04-turn-continuation-reports-running.zh.md)

## Problem

[Auto-continuation after output-token truncation](../feature/2026-08-28-turn-continuation-after-truncation.md) queues its continuation through `Agent.followup()` while handling the agent's `agent/status` idle edge. `followup` wakes the driver synchronously, and `wakeDriver` transitions the idle agent to running, which emits `agent/status` running — a nested emit inside the still-in-flight idle dispatch. The guard's idle listener and the session-controller's status forwarder are both plain `agent/status` listeners, and a Cordis emit is synchronous: a nested emit interleaves with the outer dispatch in listener order.

In the shipped bundle the guard mounts before the session-controller, so on the outer idle dispatch the forwarder would have already run — but in the buggy version the guard's synchronous `followup` fired the nested running emit *before* the outer dispatch reached the forwarder. The forwarder therefore observed the nested running edge first and the outer idle edge second, netting to idle. A status observer registered after the guard — the Web session controller — reported the continuation turn as idle, so the composer's Stop affordance disappeared for the whole duration of a turn that was actually running. The model-visible output and the session events were correct; only the propagated running state was wrong.

## Decision

The guard defers its continuation wake past the current `agent/status` dispatch by scheduling `Agent.followup()` on a microtask. The `pending` flag is still cleared synchronously in the idle handler, so delivery stays idempotent across whatever idle transitions one truncation produces; only the `followup` call moves off the dispatch path. Once the outer idle dispatch unwinds, the microtask runs `followup`, the agent transitions to running, and that running edge is emitted after the idle edge — so every listener, including the forwarder, observes the continuation turn as running and the observer's final state is running, not a masked idle. A queue failure in the deferred call still clears the chain and warns, exactly as before. The deferral is a single microtask tick: it changes no model-visible output and no session event, only the order in which the running edge reaches listeners.

## Alternatives considered

- **Rely on listener registration order** (mount the guard's listener after the forwarder, or the forwarder first) — rejected because registration order is not an enforcement mechanism and differs by bundle layering; the fix must hold regardless of mount order.
- **Make the status forwarder ignore the idle edge that follows a continuation** — rejected because it pushes the truncation's idle/running accounting into the session-controller and couples that consumer to the guard's internals.
- **Emit a distinct status event for the wake** — rejected because the agent already emits the running transition; the defect is only the re-entrant interleaving, so deferring the wake fixes it without a new event surface.

## Consequences

- A status observer registered after the guard — including the Web session controller — sees a truncated turn's continuation as running, so the composer keeps offering Stop for the duration of the resumed turn.
- The continuation still queues at whole-agent idle and stays idempotent; the deferral changes no model-visible output, session event, or snapshot.
- A queue failure in the deferred wake is still contained in the guard and reported with the rendered error.

## Testing

The unit suite in `packages/guard/turn-continuation/tests/turn-continuation.spec.ts` adds a regression that drives the real agent loop and guard, subscribes a status observer after the guard, and asserts the observer records `[running, idle, running, idle]` for a truncated turn that earns one continuation — proving the running edge is not masked by the outer idle edge. The package retains per-file 100% statement, branch, function, and line coverage on `src/`.
