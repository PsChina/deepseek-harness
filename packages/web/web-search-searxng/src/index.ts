/**
 * SearXNG-backed `WebSearchProvider` plugin. It queries one instance's
 * `/search?format=json` endpoint — a plain retrieval call with no model turn —
 * and contributes to the `ctx.web` registry without owning the service. The
 * instance's own engine configuration is what gets searched.
 *
 * @module @deepseek-ai/dsh-web-search-searxng
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  SEARXNG_DEFAULT_MAX_SNIPPET_CHARS,
  SEARXNG_DEFAULT_TIMEOUT_MS,
  SearxngSearchProvider,
} from './provider.ts'

export {
  SEARXNG_DEFAULT_MAX_SNIPPET_CHARS,
  SEARXNG_DEFAULT_TIMEOUT_MS,
  SEARXNG_PROVIDER_ID,
  SearxngSearchProvider,
  mapSearxngResponse,
} from './provider.ts'
export type { SearxngSearchProviderOptions, SearxngTimeRange } from './provider.ts'
export type { SearXNGResultItem, SearXNGResponse } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Environment variable carrying the instance root when `baseURL` is omitted. */
const BASE_URL_ENV = 'SEARXNG_URL'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Instance root, e.g. `http://127.0.0.1:8888`; falls back to `$SEARXNG_URL`. Empty or unparseable makes the provider unavailable. */
  baseURL?: string
  /** SearXNG category names to restrict the search to; omitted sends no filter. */
  categories?: string[]
  /** Explicit engine names to search; omitted sends no filter. */
  engines?: string[]
  /** SearXNG language code, e.g. `en` or `zh`; omitted sends no filter. */
  language?: string
  /** Recency window sent as `time_range`; omitted sends no filter. */
  timeRange?: 'day' | 'week' | 'month' | 'year'
  /** Safe-search level (0 off, 1 moderate, 2 strict); omitted leaves the instance default. */
  safesearch?: 0 | 1 | 2
  /** Resource backstop for one search, in milliseconds. */
  timeoutMs?: number
  /** Per-source snippet cap in characters. */
  maxSnippetChars?: number
  /** Extra request headers merged over the default `accept`. */
  headers?: Record<string, string>
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  categories: z.array(z.string()),
  engines: z.array(z.string()),
  language: z.string(),
  timeRange: z.union(['day', 'week', 'month', 'year'] as const),
  safesearch: z.union([0, 1, 2] as const),
  timeoutMs: z.number().step(1).min(1).default(SEARXNG_DEFAULT_TIMEOUT_MS),
  maxSnippetChars: z.number().step(1).min(1).default(SEARXNG_DEFAULT_MAX_SNIPPET_CHARS),
  headers: z.dict(z.string()),
})

/** Complete config: the two constant defaults applied over the optional plugin config. */
type ResolvedConfig = Omit<Config, 'timeoutMs' | 'maxSnippetChars'> & Pick<Required<Config>, 'timeoutMs' | 'maxSnippetChars'>

/** Register the SearXNG search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const resolved = {
    ...config,
    timeoutMs: config.timeoutMs ?? SEARXNG_DEFAULT_TIMEOUT_MS,
    maxSnippetChars: config.maxSnippetChars ?? SEARXNG_DEFAULT_MAX_SNIPPET_CHARS,
  }
  const options: ResolvedConfig = { ...resolved }
  ctx.web.registerSearchProvider(new SearxngSearchProvider({
    baseURL: config.baseURL ?? launchEnvironmentOf(ctx).get(BASE_URL_ENV)?.value ?? '',
    ...options.categories !== undefined ? { categories: options.categories } : {},
    ...options.engines !== undefined ? { engines: options.engines } : {},
    ...options.language !== undefined ? { language: options.language } : {},
    ...options.timeRange !== undefined ? { timeRange: options.timeRange } : {},
    ...options.safesearch !== undefined ? { safesearch: options.safesearch } : {},
    timeoutMs: options.timeoutMs,
    maxSnippetChars: options.maxSnippetChars,
    ...options.headers !== undefined ? { headers: options.headers } : {},
  }))
}
