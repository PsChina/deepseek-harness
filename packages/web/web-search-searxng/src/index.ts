/**
 * SearXNG-backed `WebSearchProvider` plugin. It will contribute to the
 * `ctx.web` registry without owning the service. The provider
 * implementation is pending; the entry currently publishes the
 * instance's wire types so consumers can model the endpoint.
 *
 * @module @deepseek-ai/dsh-web-search-searxng
 */

export type { SearXNGResultItem, SearXNGResponse } from './types.ts'
