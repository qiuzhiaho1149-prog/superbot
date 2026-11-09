/**
 * Legacy global tool registration.
 *
 * This module is mounted as its own bundle row only in compositions WITHOUT the
 * agent-presets registry (the shipped headless profile mounts no
 * `@deepseek-ai/dsh-agent-preset-registry`; DSH's own tool rows are global
 * there). On preset surfaces (web/desktop) the row is disabled by
 * `cordis.patch.yml`, so tools can never leak into standard sessions — they
 * live only inside the manager/worker/verifier presets.
 *
 * Dispatch tools are excluded here: an explicit child preset cannot be mounted
 * without the agent-presets service, and this plugin never lets a child inherit
 * the parent preset. `superbot_plan_dispatch` is excluded for the same reason.
 * A headless session therefore has no dispatch, by design; requirement/spec/plan
 * creation still works because it is pure ledger work.
 */

import { TOOL_NAMES } from './roles.js'
import { createSuperbotTools } from './tools.js'

export const name = 'dsh-superbot/global-tools'
export const inject = ['tools', 'superbot']

/** Register the manager tool surface globally (pre-preset compositions only). */
export function apply(ctx) {
  const service = ctx.get('superbot')
  if (service?.store === undefined) throw new Error('superbot service is unavailable; the dsh-superbot bundle row must be mounted')
  const definitions = createSuperbotTools({
    role: 'manager',
    ctx,
    store: service.store,
    getConfig: typeof service.getConfig === 'function' ? service.getConfig : () => ({}),
    exclude: [TOOL_NAMES.dispatchWorker, TOOL_NAMES.dispatchVerifier, TOOL_NAMES.planDispatch],
  })
  const disposers = definitions.map((definition) => ctx.tools.register(definition))
  // Diagnostics for `GET /superbot/status`: on preset surfaces this stays null.
  service.globalTools = { toolCount: definitions.length, registeredAt: new Date().toISOString() }
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose?.() } catch { /* plugin disposal is best effort */ }
      }
    })
  }
  ctx.logger?.warn?.('dsh-superbot: no agent-preset registry in this profile; registered task tools globally (legacy mode)')
}
