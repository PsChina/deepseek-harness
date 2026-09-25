/** The active Web presets must preserve routed Qwen compaction policies. */

import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function insertedRows(file: string): unknown[] {
  return loadOverlayPatches('web-compaction-policy-test', file)
    .flatMap(patch => patch.insert ?? [])
}

function compactionPoliciesFromBase(): unknown {
  const file = fileURLToPath(new URL('../../base/cordis.patch.yml', import.meta.url))
  const config = records(insertedRows(file)).find(row => row.id === 'compaction-basic')?.config
  return isRecord(config) ? config['modelPolicies'] : undefined
}

function compactionPoliciesFromPreset(preset: string): unknown {
  const file = fileURLToPath(new URL(`../presets/${preset}.patch.yml`, import.meta.url))
  const presetRow = records(insertedRows(file)).find(row => row.id === `preset-${preset}`)
  const presetConfig = isRecord(presetRow?.config) ? presetRow.config : undefined
  const plugins = records(presetConfig?.['plugins'])
  const compactionGroup = plugins.find(row => row.id === 'compaction')
  const compactionPlugins = records(compactionGroup?.config)
  const compactBasic = compactionPlugins.find(row => row.id === 'compaction-basic')
  const config = compactBasic?.config
  return isRecord(config) ? config['modelPolicies'] : undefined
}

it.each(['standard', 'cordis', 'ptc'])('%s preset compaction matches the base Qwen model policies', (preset) => {
  expect(compactionPoliciesFromPreset(preset)).toEqual(compactionPoliciesFromBase())
})
