import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

const streamSimple = vi.hoisted(() => vi.fn())

// A hand-declared route is built by `createProvider` over the protocol table in
// `src/provider.ts`, so the table's lazy api module is the SDK boundary this
// test can observe. A catalog route dispatches through pi-ai's own provider and
// would not see this mock.
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', () => ({
  openAICompletionsApi: () => ({ stream: streamSimple, streamSimple }),
}))

import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

afterEach(() => { streamSimple.mockReset() })

/** A hand-declared OpenAI-compatible route with one fully described model. */
function gatewayAdapter(): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({
      'local-gateway': {
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:9/v1',
        models: [{ id: 'local-model', contextWindow: 8192, maxTokens: 1024 }],
      },
    }),
    resolveApiKey: () => Promise.resolve('test-key'),
    auth: memoryAuth(),
  })
}

async function drain(
  adapter: PiAiAdapter,
  reasoningEffort?: string,
  temperature?: number,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'local-gateway',
    model: 'local-model',
    messages: [],
    ...reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
    ...temperature === undefined ? {} : { temperature },
  })) chunks.push(chunk)
  return chunks
}

describe('pi-ai SDK retry boundary', () => {
  it('pins one SDK attempt even when the installed provider currently defaults to zero retries', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    const chunks = await drain(gatewayAdapter())

    expect(streamSimple).toHaveBeenCalledOnce()
    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({ maxRetries: 0, apiKey: 'test-key' })
    // pi-ai reports a setup failure as a terminal in-stream error rather than
    // throwing, which the converter turns into the harness error finish.
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'mock SDK boundary' } },
    })
  })

  it('dispatches a hand-declared route to the endpoint and model its configuration describes', async () => {
    streamSimple.mockImplementation(() => { throw new Error('mock SDK boundary') })

    await drain(gatewayAdapter())

    expect(streamSimple.mock.calls[0]?.[0]).toMatchObject({
      id: 'local-model',
      provider: 'local-gateway',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      contextWindow: 8192,
      maxTokens: 1024,
    })
  })

  it('selects per-model sampling presets by reasoning mode and preserves an explicit temperature', async () => {
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({
        'local-gateway': {
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:9/v1',
          reasoning: 'xhigh',
          models: [{
            id: 'local-model',
            contextWindow: 8192,
            maxTokens: 1024,
            reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', xhigh: 'xhigh' },
            sampling: {
              thinking: { temperature: 1, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repeat_penalty: 1 },
              off: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5, repeat_penalty: 1 },
            },
          }],
        },
      }),
      resolveApiKey: () => Promise.resolve('test-key'),
      auth: memoryAuth(),
    })

    await drain(adapter)
    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({
      temperature: 1,
      samplingParams: {
        top_p: 0.95,
        top_k: 20,
        min_p: 0,
        presence_penalty: 0,
        repeat_penalty: 1,
      },
    })

    await drain(adapter, 'off')
    expect(streamSimple.mock.calls[1]?.[2]).toMatchObject({
      temperature: 0.7,
      samplingParams: {
        top_p: 0.8,
        top_k: 20,
        min_p: 0,
        presence_penalty: 1.5,
        repeat_penalty: 1,
      },
    })

    await drain(adapter, 'off', 0.25)
    expect(streamSimple.mock.calls[2]?.[2]).toMatchObject({
      temperature: 0.25,
      samplingParams: { top_p: 0.8, presence_penalty: 1.5 },
    })
  })
})
