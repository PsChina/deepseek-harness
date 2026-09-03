/**
 * Automatic continuation of turns cut off at the model output token limit.
 * A truncation is not a stop: the plugin queues one fixed continuation
 * prompt at the next whole-agent idle point, so the model resumes the same
 * turn's work without a human nudge. Configuration, the truncation-chain
 * semantics, and known limitations live in the package README; the rationale
 * lives in the turn-continuation Agent Note.
 * @module @deepseek-ai/dsh-turn-continuation
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

export const name = 'turn-continuation'
export const inject = ['agents']

/**
 * Plugin config, validated by the same-named schemastery schema plus the
 * load-time check in `apply` (misconfiguration fails loud: a non-integer or
 * sub-1 `maxConsecutive` throws at plugin load, never a silent fall-back).
 */
export interface Config {
  /**
   * Maximum auto-continuations per consecutive-truncation chain (default
   * unbounded). A chain counts back-to-back max-tokens endings; any other
   * turn outcome — completion, abort, error, rejection, or an interrupt —
   * breaks the chain and resets the count, so later truncations start fresh.
   */
  maxConsecutive?: number
}

export const Config: z<Config> = z.object({
  maxConsecutive: z.number().min(1),
})

/**
 * The `{kind:'plugin'}` source stamped on every continuation this guard
 * injects — the label is load-bearing (an unlabeled context would render as
 * a user prompt in derived history).
 */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'turn-continuation' }

/** The model-facing continuation prompt, pinned verbatim in the tests. */
const CONTINUATION =
  'Your previous response was cut off by the output token limit before you '
  + 'finished. Continue exactly where you stopped; do not repeat anything '
  + 'you already sent.'

/** One-line transcript account rendered on the continuation's collapsed row. */
const SUMMARY = 'previous response hit the output token limit'

/** One agent's truncation chain: back-to-back max-tokens endings and the queued flag. */
interface ChainState {
  consecutive: number
  pending: boolean
}

/** Human-readable unexpected values for log lines. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Validate the optional chain cap per the fail-loud contract.
 * @param value - raw config value, if the deployment set one.
 * @returns the cap, or `undefined` for the unbounded default.
 */
function validateMaxConsecutive(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`turn-continuation: invalid maxConsecutive ${value} — must be an integer >= 1`)
  }
  return value
}

/**
 * Install the truncation continuation guard.
 * @param ctx - plugin context; all listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; `maxConsecutive` is re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config): void {
  const cap = validateMaxConsecutive(config.maxConsecutive)
  const chains = new WeakMap<Agent, ChainState>()

  /** Read or start the calling agent's chain. */
  function stateFor(agent: Agent): ChainState {
    let state = chains.get(agent)
    if (state === undefined) {
      state = { consecutive: 0, pending: false }
      chains.set(agent, state)
    }
    return state
  }

  ctx.on('agent/session-start', ({ agent }) => {
    chains.set(agent, { consecutive: 0, pending: false })
  })

  // The session log is the authoritative outcome record: a turn ends on
  // max-tokens exactly once, and every other ending closes the chain.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'turn/end') return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    const state = stateFor(agent)
    if (event.data.reason.kind !== 'max-tokens') {
      state.consecutive = 0
      state.pending = false
      return
    }
    if (cap !== undefined && state.consecutive >= cap) {
      state.consecutive = 0
      state.pending = false
      ctx.logger.warn(`turn-continuation: agent "${agent.id}" stopped at ${cap} consecutive continuations`)
      return
    }
    state.consecutive += 1
    state.pending = true
  })

  // Queue at whole-agent idle so a continuation never competes with work
  // that already holds or owns the next turn; `pending` makes the queue-on-idle
  // idempotent across any idle transition the agent reports for one truncation.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const state = stateFor(agent)
    if (!state.pending) return
    state.pending = false
    // Defer the wake past this dispatch: `followup` re-enters `agent/status`
    // synchronously (idle -> running), and a nested emit interleaves with the
    // in-flight idle dispatch in listener order. Queued after the dispatch, the
    // running edge always lands after the idle edge, so status observers see
    // the continuation turn as running (the Web composer keeps offering Stop).
    queueMicrotask(() => {
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: CONTINUATION }],
          source: { ...PLUGIN_SOURCE, form: 'notice', summary: SUMMARY },
        }))
      } catch (error: unknown) {
        state.consecutive = 0
        ctx.logger.warn(`turn-continuation: could not queue continuation for agent "${agent.id}": ${renderThrown(error)}`)
      }
    })
  })
}
