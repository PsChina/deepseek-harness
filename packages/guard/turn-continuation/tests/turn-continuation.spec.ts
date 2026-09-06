/**
 * Unit suite for @deepseek-ai/dsh-turn-continuation: chain semantics (one
 * continuation per truncation, back-to-back chaining, the optional
 * `maxConsecutive` cap, and reset on every non-max-tokens ending), the
 * pinned prompt and notice source, queue-failure containment, and fail-loud
 * configuration — all driven through a real agent loop against the scripted
 * mock adapter (no network). Shipped-profile behavior is covered by the
 * keyless recorded-session snapshots `max-tokens-continue` and
 * `subagent-max-tokens-continue`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as TurnContinuation from '@deepseek-ai/dsh-turn-continuation'
import { MockAdapter, maxTokensResponse, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/** The model-facing continuation prompt, pinned verbatim (see src/index.ts). */
const CONTINUATION =
  'Your previous response was cut off by the output token limit before you '
  + 'finished. Continue exactly where you stopped; do not repeat anything '
  + 'you already sent.'

/** The notice-form plugin source stamped on every continuation. */
const NOTICE_SOURCE = {
  kind: 'plugin',
  plugin: 'turn-continuation',
  form: 'notice',
  summary: 'previous response hit the output token limit',
}

/** Script entries this suite needs. */
type ScriptEntry = StreamChunk[] | 'hang'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Mount the loop + the guard with only the model scripted. */
async function harness(script: ScriptEntry[], config: TurnContinuation.Config = {}): Promise<{
  ctx: Context
  adapter: MockAdapter
  agent: Agent
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TurnContinuation, config)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(`tc-session-${Math.random()}`), {
    provider: 'mock',
    model: 'mock',
  })
  return { ctx, adapter, agent }
}

/** Queue one human prompt for the agent. */
function prompt(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Every continuation notice in the agent's session log. */
function continuations(agent: Agent): SessionEvent<'user/message'>[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    .filter(event => event.data.source.kind === 'plugin' && event.data.source.plugin === 'turn-continuation')
}

/** The turn-end reason kinds, in order. */
function endings(agent: Agent): string[] {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'turn/end' ? [event.data.reason.kind] : [])
}

/** All text of one model request, joined for content assertions. */
function requestText(request: GenerateOptions): string {
  return request.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

describe('truncation continuation', () => {
  it('queues exactly one pinned continuation; the resumed turn completes the work', async () => {
    const test = await harness([maxTokensResponse('part of the answer'), textResponse('finished')])
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    prompt(test.agent, 'answer the question')
    await vi.waitFor(() => expect(test.adapter.requests).toHaveLength(2))
    await test.agent.whenIdle()

    expect(requestText(test.adapter.requests[0]!)).not.toContain(CONTINUATION)
    expect(requestText(test.adapter.requests[1]!)).toContain(CONTINUATION)
    const notices = continuations(test.agent)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.data.source).toEqual(NOTICE_SOURCE)
    expect(notices[0]!.data.content.map(block => block.type === 'text' ? block.text : '')).toEqual([CONTINUATION])
    expect(endings(test.agent)).toEqual(['max-tokens', 'completed'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports the continuation turn as running to status observers (Stop stays available)', async () => {
    const test = await harness([maxTokensResponse('cut'), textResponse('done')])
    // Register a status observer AFTER the guard, reproducing the shipped load
    // order where the guard's `agent/status` listener precedes the session
    // controller's status forwarder.
    const statuses: AgentStatus[] = []
    test.ctx.on('agent/status', ({ agent, status }) => {
      if (agent.id === test.agent.id) statuses.push(status)
    })
    prompt(test.agent, 'long task')
    await vi.waitFor(() => expect(test.adapter.requests).toHaveLength(2))
    await test.agent.whenIdle()
    await vi.waitFor(() => expect(statuses).toHaveLength(4))

    // The truncation's idle edge must reach the observer, and the continuation
    // turn must then read as running until it itself ends. A synchronous
    // followup re-emits `running` inside the idle dispatch, masking the idle
    // and leaving the observer idle while the continuation is actually running.
    expect(statuses).toEqual(['running', 'idle', 'running', 'idle'])
  })

  it('continues the chain across back-to-back truncations', async () => {
    const test = await harness([
      maxTokensResponse('first cut'),
      maxTokensResponse('second cut'),
      textResponse('done'),
    ])
    prompt(test.agent, 'long task')
    await vi.waitFor(() => expect(test.adapter.requests).toHaveLength(3))
    await test.agent.whenIdle()

    expect(requestText(test.adapter.requests[1]!)).toContain(CONTINUATION)
    expect(requestText(test.adapter.requests[2]!)).toContain(CONTINUATION)
    expect(continuations(test.agent)).toHaveLength(2)
    expect(endings(test.agent)).toEqual(['max-tokens', 'max-tokens', 'completed'])
  })

  it('stops chaining at maxConsecutive, logs the stop, and resets the count', async () => {
    const test = await harness(
      [maxTokensResponse('cut once'), maxTokensResponse('cut again')],
      { maxConsecutive: 1 },
    )
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    prompt(test.agent, 'long task')
    await vi.waitFor(() => expect(test.adapter.requests).toHaveLength(2))
    await test.agent.whenIdle()

    // The first truncation earned its continuation; the second hits the cap
    // and is not continued.
    expect(test.adapter.requests).toHaveLength(2)
    expect(continuations(test.agent)).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain(`agent "${test.agent.id}"`)
    expect(warn.mock.calls[0]![0]).toContain('stopped at 1 consecutive continuations')
    expect(endings(test.agent)).toEqual(['max-tokens', 'max-tokens'])
  })

  it('resets the chain after a completed turn so later truncations continue again', async () => {
    const test = await harness(
      [
        maxTokensResponse('one'),
        textResponse('finished one'),
        maxTokensResponse('two'),
        textResponse('finished two'),
      ],
      { maxConsecutive: 1 },
    )
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    prompt(test.agent, 'first long task')
    await vi.waitFor(() => expect(test.adapter.requests).toHaveLength(2))
    prompt(test.agent, 'second long task')
    await vi.waitFor(() => expect(test.adapter.requests).toHaveLength(4))
    await test.agent.whenIdle()

    // The completed continuation turn reset the capped chain, so the second
    // truncation is continued too.
    expect(continuations(test.agent)).toHaveLength(2)
    expect(warn).not.toHaveBeenCalled()
    expect(endings(test.agent)).toEqual(['max-tokens', 'completed', 'max-tokens', 'completed'])
  })

  it('breaks the chain when a continuation turn is aborted', async () => {
    const test = await harness([
      maxTokensResponse('cut'),
      'hang',
      maxTokensResponse('cut later'),
      textResponse('done'),
    ])
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    prompt(test.agent, 'long task')
    await vi.waitFor(() => expect(test.adapter.requests).toHaveLength(2))
    test.agent.cancel({ kind: 'user' })
    await test.agent.whenIdle()
    prompt(test.agent, 'another long task')
    await vi.waitFor(() => expect(test.adapter.requests).toHaveLength(4))
    await test.agent.whenIdle()

    // The aborted continuation broke the chain: the later truncation is
    // continued again.
    expect(continuations(test.agent)).toHaveLength(2)
    expect(warn).not.toHaveBeenCalled()
    expect(endings(test.agent)).toEqual(['max-tokens', 'aborted', 'max-tokens', 'completed'])
  })

  it('starts the chain lazily for agents running before the guard mounted', async () => {
    // The session-start hook only pre-records agents created after the guard
    // mounted; an already-running agent must get its chain from the first
    // turn ending it sees.
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([maxTokensResponse('cut'), textResponse('done')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId(`tc-late-${Math.random()}`), {
      provider: 'mock',
      model: 'mock',
    })
    await ctx.plugin(TurnContinuation, {})

    prompt(agent, 'long task')
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(2))
    await agent.whenIdle()

    expect(requestText(adapter.requests[1]!)).toContain(CONTINUATION)
    expect(continuations(agent)).toHaveLength(1)
    expect(endings(agent)).toEqual(['max-tokens', 'completed'])
  })

  it('ignores turn events from sessions without an owning agent', async () => {
    const test = await harness([])
    const orphan = test.ctx.sessions.create(SessionId('orphan-session'))
    orphan.append('turn/end', { turn: 1, reason: { kind: 'max-tokens' } })
    await test.agent.whenIdle()

    expect(test.adapter.requests).toHaveLength(0)
    expect(continuations(test.agent)).toHaveLength(0)
  })

  it('clears the chain and warns when queueing the continuation fails with an Error', async () => {
    const test = await harness([maxTokensResponse('cut')])
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    const realFollowup = test.agent.followup.bind(test.agent)
    vi.spyOn(test.agent, 'followup').mockImplementation((input) => {
      if (input.source.kind === 'plugin') throw new Error('queue exploded')
      realFollowup(input)
    })
    prompt(test.agent, 'long task')
    await test.agent.whenIdle()

    expect(test.adapter.requests).toHaveLength(1)
    expect(continuations(test.agent)).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain(`agent "${test.agent.id}"`)
    expect(warn.mock.calls[0]![0]).toContain('queue exploded')
  })

  it('renders a non-Error queue failure in the warning', async () => {
    const test = await harness([maxTokensResponse('cut')])
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    const realFollowup = test.agent.followup.bind(test.agent)
    vi.spyOn(test.agent, 'followup').mockImplementation((input) => {
      if (input.source.kind === 'plugin') throw 'string-failure'
      realFollowup(input)
    })
    prompt(test.agent, 'long task')
    await test.agent.whenIdle()

    expect(test.adapter.requests).toHaveLength(1)
    expect(continuations(test.agent)).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('string-failure')
  })

  it('rejects a sub-1 maxConsecutive at plugin load', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await expect(ctx.plugin(TurnContinuation, { maxConsecutive: 0 }))
      .rejects.toThrow(/maxConsecutive/)
  })

  it('rejects a non-integer maxConsecutive at plugin load', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await expect(ctx.plugin(TurnContinuation, { maxConsecutive: 1.5 }))
      .rejects.toThrow('turn-continuation: invalid maxConsecutive 1.5 — must be an integer >= 1')
  })
})
