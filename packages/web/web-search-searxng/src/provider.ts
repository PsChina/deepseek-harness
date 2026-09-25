/**
 * SearXNG-backed search against one instance's `/search?format=json` endpoint.
 * One search is a plain retrieval call — no model turn, no generated tokens:
 * the instance does the metasearch across its configured engines and returns
 * structured results, so this provider never scrapes prose.
 * @module @deepseek-ai/dsh-web-search-searxng/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { SearXNGResponse } from './types.ts'

/** Stable id this provider registers under, and the value `web.searchProvider` selects. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/**
 * Resource backstop for one search. This is NOT the model-facing tool-call
 * budget — `@deepseek-ai/dsh-tool-call-timeout-policy` owns that via
 * `searchTimeoutMs` and arms the caller's signal. A deployment should leave
 * this below the tool budget so a slow instance surfaces as a provider
 * timeout rather than a tool timeout.
 */
export const SEARXNG_DEFAULT_TIMEOUT_MS = 10_000

/**
 * Cap on one source's snippet. SearXNG snippets are engine-supplied and
 * occasionally carry a whole lead paragraph; the seam has no snippet bound of
 * its own, so an uncapped provider would let one verbose engine dominate the
 * result budget.
 */
export const SEARXNG_DEFAULT_MAX_SNIPPET_CHARS = 500

/** Recency window values SearXNG accepts for `time_range`. */
export type SearxngTimeRange = 'day' | 'week' | 'month' | 'year'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface SearxngSearchProviderOptions {
  /** Instance root, e.g. `http://127.0.0.1:8888`; the provider calls `{baseURL}/search`. Empty or unparseable makes the provider unavailable. */
  baseURL: string
  /** SearXNG category names to restrict the search to; omitted sends no filter. */
  categories?: string[]
  /** Explicit engine names to search; omitted sends no filter. */
  engines?: string[]
  /** SearXNG language code, e.g. `en` or `zh`; omitted sends no filter. */
  language?: string
  /** Recency window sent as `time_range`; omitted sends no filter. */
  timeRange?: SearxngTimeRange
  /** Safe-search level (0 off, 1 moderate, 2 strict) sent to the instance; omitted leaves the instance default. */
  safesearch?: 0 | 1 | 2
  /** Resource backstop for one search, in milliseconds; must be a positive integer. */
  timeoutMs: number
  /** Per-source snippet cap in characters; must be a positive integer. */
  maxSnippetChars: number
  /** Extra request headers merged over the default `accept`. */
  headers?: Record<string, string>
}

/** Parse `baseURL` once so `available()` stays a cheap synchronous check. */
function parseBaseURL(baseURL: string): URL | undefined {
  if (baseURL.trim().length === 0) return undefined
  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    return undefined
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : undefined
}

/** Read one wire field as a non-empty trimmed string, or `undefined`. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Truncate a snippet to the configured cap without splitting a surrogate pair. */
function cap(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const cut = value.slice(0, maxChars)
  const last = cut.charCodeAt(cut.length - 1)
  // A high surrogate at the boundary lost its pair; drop it rather than emit U+FFFD.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

/**
 * Map one instance response to the seam's normalized result.
 *
 * Sources are deduplicated by URL because a metasearch merges engines that
 * routinely return the same page. `truncated` is always `false`: the seam owns
 * `maxResults` enforcement, and reporting our own truncation here would make it
 * lie about whose bound cut the list.
 *
 * @param body - the parsed `format=json` response.
 * @param maxSnippetChars - per-source snippet cap.
 * @returns the normalized search outcome.
 */
export function mapSearxngResponse(body: SearXNGResponse, maxSnippetChars: number): WebSearchResult {
  const rawResults = Array.isArray(body.results) ? body.results : []
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  for (const result of rawResults) {
    const url = text(result?.url)
    if (url === undefined || seen.has(url)) continue
    seen.add(url)
    const title = text(result?.title)
    const snippet = text(result?.content)
    const publishedAt = text(result?.publishedDate)
    sources.push({
      url,
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet: cap(snippet, maxSnippetChars) }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    })
  }
  // `answers[]` is the only instance-generated text worth surfacing as an
  // answer. Infoboxes are structured entity cards, not an answer to the query,
  // so they stay out rather than being flattened into prose the model would
  // read as one.
  const answers = Array.isArray(body.answers)
    ? body.answers.map(text).filter((a): a is string => a !== undefined)
    : []
  return {
    ...(answers.length === 0 ? {} : { content: answers.join('\n') }),
    sources,
    truncated: false,
  }
}

/** Cap on the error body read back from a rejected request. */
const ERROR_BODY_MAX_CHARS = 300

/**
 * Read the instance's own reason for refusing a request.
 *
 * SearXNG answers a bad parameter with `{"error": "Invalid value <x> for
 * parameter <name>"}` — the one string naming WHICH setting is wrong. It
 * validates a language's shape but not whether the locale exists, so a
 * malformed value is the only kind it reports at all; quoting the reason is
 * what turns "HTTP 400" into something a user can act on.
 * @param response - the non-2xx response, whose body is still unread.
 * @returns the reason, or `undefined` when the body carries none.
 */
async function instanceErrorText(response: Response): Promise<string | undefined> {
  let bodyText: string
  try {
    bodyText = await response.text()
  } catch {
    // Failing to read the error body must never replace the status we do know.
    return undefined
  }
  try {
    const body = JSON.parse(bodyText)
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const error = (body as { error: unknown }).error
      if (typeof error === 'string' && error.trim().length > 0) {
        return cap(error.trim(), ERROR_BODY_MAX_CHARS)
      }
    }
  } catch {
    // Not JSON: an HTML error page carries no reason worth quoting at a model.
  }
  return undefined
}

/**
 * The SearXNG-backed search provider; HTTP redirects are refused as
 * `WEB_PROVIDER_ERROR` so the query never travels to a host the deployment
 * never configured.
 */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  constructor(private readonly options: SearxngSearchProviderOptions) {}

  /** Cheap local check: a parseable http(s) base URL and positive integer bounds. Never touches the network. */
  available(): boolean {
    return parseBaseURL(this.options.baseURL) !== undefined
      && isPositiveInteger(this.options.timeoutMs)
      && isPositiveInteger(this.options.maxSnippetChars)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const endpoint = parseBaseURL(this.options.baseURL)
    // Defensive: the seam consults available() before selecting, so reaching
    // here without an endpoint means a caller bypassed selection.
    if (endpoint === undefined) {
      throw new WebError(
        "SearXNG search has no usable baseURL; set the provider's baseURL (or $SEARXNG_URL) to the instance root",
        'WEB_PROVIDER_ERROR',
      )
    }
    const url = new URL('search', this.options.baseURL.endsWith('/') ? this.options.baseURL : `${this.options.baseURL}/`)
    url.searchParams.set('q', request.query)
    url.searchParams.set('format', 'json')
    if (this.options.categories?.length) {
      url.searchParams.set('categories', this.options.categories.join(','))
    }
    if (this.options.engines?.length) {
      url.searchParams.set('engines', this.options.engines.join(','))
    }
    if (this.options.language !== undefined) {
      url.searchParams.set('language', this.options.language)
    }
    if (this.options.timeRange !== undefined) {
      url.searchParams.set('time_range', this.options.timeRange)
    }
    if (this.options.safesearch !== undefined) {
      url.searchParams.set('safesearch', String(this.options.safesearch))
    }
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        // A self-hosted instance has no reason to redirect a search; following
        // one would send the query to a host the deployment never configured.
        redirect: 'error',
        headers: { accept: 'application/json', ...this.options.headers },
        signal: combined,
      })
    } catch (error: unknown) {
      if (signal?.aborted === true) {
        throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: signal.reason })
      }
      if (timeout.aborted) {
        throw new WebError(`SearXNG search timed out after ${this.options.timeoutMs}ms`, 'WEB_PROVIDER_ERROR', {
          cause: timeout.reason,
        })
      }
      throw new WebError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', {
        cause: error,
      })
    }
    if (!response.ok) {
      // 403 from a public instance is nearly always its bot filter, which no
      // amount of retrying fixes — say so instead of reporting a bare status.
      const hint = response.status === 403
        ? ' (a public instance often refuses programmatic access; run your own instance or allow this client)'
        : ''
      // A rejected parameter carries its reason in the body (`Invalid value
      // <x> for parameter language`). That names the misconfigured setting,
      // which a bare status code cannot, so it rides the message.
      const reason = await instanceErrorText(response)
      throw new WebError(
        `SearXNG search failed with HTTP ${response.status}${reason === undefined ? '' : `: ${reason}`}${hint}`,
        'WEB_PROVIDER_ERROR',
      )
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('json')) {
      // The single most common misconfiguration: `json` missing from the
      // instance's `search.formats`, which answers with the HTML result page.
      throw new WebError(
        `SearXNG returned "${contentType || 'no content-type'}" instead of JSON; add "json" to search.formats in the instance settings.yml`,
        'WEB_PROVIDER_ERROR',
      )
    }
    let body: SearXNGResponse
    try {
      body = (await response.json()) as SearXNGResponse
    } catch (error: unknown) {
      throw new WebError(`SearXNG returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', {
        cause: error,
      })
    }
    return mapSearxngResponse(body, this.options.maxSnippetChars)
  }
}

/** True for a request limit that can be sent to SearXNG (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
