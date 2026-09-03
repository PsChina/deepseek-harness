/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-turn-continuation`.
 * @module @deepseek-ai/dsh-turn-continuation/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-turn-continuation'

/** Cordis companion plugin name. */
export const name = 'turn-continuation-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the truncation chain and pending flag are private to
 * this plugin's own listeners, which observe the shared session and agent
 * events; it publishes no package-owned event or snapshot for an independent
 * companion to cross-check.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
