/**
 * The bundle's substance is its patch file: the `dsh.bundle.patch` manifest
 * field must name a real, parseable patch list.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

const QWEN_REASONING_EFFORTS = {
  off: 'none',
  low: 'low',
  medium: 'medium',
  xhigh: 'xhigh',
}
const QWEN_SAMPLING = {
  thinking: {
    temperature: 1,
    top_p: 0.95,
    top_k: 20,
    min_p: 0,
    presence_penalty: 0,
    repeat_penalty: 1,
  },
  off: {
    temperature: 0.7,
    top_p: 0.8,
    top_k: 20,
    min_p: 0,
    presence_penalty: 1.5,
    repeat_penalty: 1,
  },
}

describe('dsh-base bundle', () => {
  it('declares a parseable patch list through the dsh.bundle.patch manifest field', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    expect(Array.isArray(parsed)).toBe(true)
    // The base layer is one insert list over the empty profile root.
    const rows = (parsed as { insert?: { id?: string; config?: Record<string, unknown>; disabled?: boolean }[] }[]).flatMap(
      patch => patch.insert ?? [],
    )
    expect(rows.length).toBeGreaterThan(50)
    expect(rows.some(row => row.id === 'agent-loop')).toBe(true)
    expect(rows.find(row => row.id === 'session-telemetry-otel')?.disabled).toBeUndefined()
    expect(rows.find(row => row.id === 'session-telemetry-otel')?.config?.['mode']).toEqual({
      __jsExpr: "process.env.DSH_TELEMETRY_MODE || 'FEEDBACK_ONLY'",
    })
    expect(rows.find(row => row.id === 'hmr')).toMatchObject({
      config: { root: [] },
    })
    expect(rows.filter(row => row.id === 'subagent-codex')).toHaveLength(0)
    expect(rows.filter(row => row.id === 'subagent-claude-code')).toHaveLength(0)
    expect(rows.find(row => row.id === 'web')?.config).toMatchObject({ fetchProvider: 'http' })
    expect(rows.find(row => row.id === 'web-fetch-http')).toBeDefined()
    expect(rows.find(row => row.id === 'tool-web')?.config).toMatchObject({ fetch: true })
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-subagent-codex')
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-subagent-claude-code')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-web-fetch-http')
    expect(rows.find(row => row.id === 'compaction-basic')?.config).toMatchObject({
      modelPolicies: [{
        provider: 'qwen38',
        model: 'Qwen3.8-27B-Q3',
        headroomTokens: 7_184,
        maxTokens: 55_000,
      }, {
        provider: 'qwen38',
        model: 'Qwen3.8-27B-Q2',
        headroomTokens: 3_616,
        maxTokens: 100_000,
      }],
    })
    const llmConfig = rows.find(row => row.id === 'llm-pi-ai')?.config
    const providers = isRecord(llmConfig?.['providers']) ? llmConfig['providers'] : undefined
    const qwen38 = isRecord(providers?.['qwen38']) ? providers['qwen38'] : undefined
    const models = qwen38?.['models']
    if (!isUnknownArray(models)) throw new TypeError('base patch must configure Qwen3.8 models')
    const q3 = models.find(model => isRecord(model) && model['id'] === 'Qwen3.8-27B-Q3')
    if (!isRecord(q3)) throw new TypeError('base patch must configure the Qwen3.8 Q3 model')
    expect(q3).toMatchObject({
      contextWindow: 82_000,
      maxTokens: 9_216,
      reasoningEfforts: QWEN_REASONING_EFFORTS,
      sampling: QWEN_SAMPLING,
    })
    const q2 = models.find(model => isRecord(model) && model['id'] === 'Qwen3.8-27B-Q2')
    if (!isRecord(q2)) throw new TypeError('base patch must configure the Qwen3.8 Q2 model')
    expect(q2).toMatchObject({
      contextWindow: 100_000,
      maxTokens: 16_384,
      reasoningEfforts: QWEN_REASONING_EFFORTS,
      sampling: QWEN_SAMPLING,
    })
  })

  it('gates each shell stack by platform with a symmetric disabled expression', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const parsed = yaml.load(
      readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'),
      { schema: entryListSchema },
    )
    if (!Array.isArray(parsed)) throw new TypeError('base patch must parse to a patch list')
    const rows = parsed.flatMap((patch): Record<string, unknown>[] =>
      typeof patch === 'object' && patch !== null
        ? (patch as { insert?: Record<string, unknown>[] }).insert ?? []
        : [],
    )
    // Symmetric gating: each stack's executor and tool rows carry the same
    // platform fact, inverted between the bash and pwsh twins, so exactly one
    // shell stack mounts per host. Evaluate with a platform-scoped context
    // (the `with` scope shadows the global `process`) so both outcomes pin on
    // every host.
    for (const [id, win32, linux] of [
      ['bash-sandbox', true, false],
      ['tool-bash', true, false],
      ['pwsh-sandbox', false, true],
      ['tool-pwsh', false, true],
    ] as const) {
      const row = rows.find(candidate => candidate.id === id)
      if (row === undefined) throw new Error(`base patch must mount ${id}`)
      const expression = (row.disabled as { __jsExpr?: string } | undefined)?.__jsExpr
      if (expression === undefined) throw new Error(`${id} must gate on a !!js disabled expression`)
      expect(Boolean(evaluate({ process: { platform: 'win32' } }, expression)), `${id} on win32`).toBe(win32)
      expect(Boolean(evaluate({ process: { platform: 'linux' } }, expression)), `${id} on linux`).toBe(linux)
    }
    // The platform layer folded into these rows: no separate patch file ships.
    expect(existsSync(resolve(root, 'windows.cordis.patch.yml'))).toBe(false)
  })
})
