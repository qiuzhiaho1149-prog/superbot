/**
 * Preset-scoped tool registration.
 *
 * This module is a DSH plugin row inside `lib/presets.js`:</
 *   { id: 'superbot-tools', name: 'dsh-superbot/preset-tools', config: { role } }
 *
 * The preset registry mounts it inside the selecting Agent's scope, so
 * `ctx.tools.register()` here creates per-Agent tools. The agent only sees its
 * role's subset (`lib/roles.js`): manager gets the full surface, worker gets
 * claim/report, verifier gets read-only tools plus a review recorder.
 */

import { toolsForRole } from './roles.js'
import { createSuperbotTools } from './tools.js'

export const name = 'dsh-superbot/preset-tools'
export const inject = ['tools', 'superbot']

/** Register the role's tools in this Agent scope. */
export function apply(ctx, config = {}) {
  const role = config?.role
  const toolNames = toolsForRole(role) // throws on an unknown role → preset reports broken
  const service = ctx.get('superbot')
  if (service?.store === undefined) throw new Error('superbot service is unavailable; the dsh-superbot bundle row must be mounted')

  const definitions = createSuperbotTools({
    role,
    ctx,
    store: service.store,
    getConfig: typeof service.getConfig === 'function' ? service.getConfig : () => ({}),
  })
  const disposers = definitions.map((definition) => ctx.tools.register(definition))
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose?.() } catch { /* plugin disposal is best effort */ }
      }
    })
  }
  ctx.logger?.info?.(`dsh-superbot: registered ${toolNames.length} ${role} tools in this agent scope`)
}
