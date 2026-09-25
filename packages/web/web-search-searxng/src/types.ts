/**
 * Provider-private wire types for a SearXNG instance's `/search?format=json`
 * endpoint. The instance merges its configured engines, so result items arrive
 * with engine-specific fields the provider does not need; these types declare
 * only what the provider maps.
 * @module @deepseek-ai/dsh-web-search-searxng/types
 */

/** One SearXNG result item; fields vary by engine, so all but `url` are optional. */
export interface SearXNGResultItem {
  /** Result page URL; the provider skips items that lack a usable one. */
  url?: string | null
  /** Result title, when the engine supplied one. */
  title?: string | null
  /** Engine-supplied snippet; the provider caps it to the configured limit. */
  content?: string | null
  /** Engine-supplied publication date, when known. */
  publishedDate?: string | null
}

/**
 * A SearXNG `format=json` search response. The provider consumes only
 * `results`; instance extras (`answers`, infoboxes, query echoes) are ignored.
 */
export interface SearXNGResponse {
  /** The merged engine results; absent on an error-shaped body. */
  results?: SearXNGResultItem[]
  /** Tolerated unknown fields; the provider never requires them. */
  [field: string]: unknown
}
