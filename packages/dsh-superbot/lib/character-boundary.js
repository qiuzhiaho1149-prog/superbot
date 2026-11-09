/**
 * Worker/verifier character boundary (legacy host compatibility shim).
 *
 * Legacy character plugins may register a *global* dynamic prompt section
 * (legacy identifiers listed below). A worker or verifier
 * preset declares no persona row, but that alone does not stop the global
 * section from reaching its prompt — a global registration applies to every
 * agent that has no scoped shadow.
 *
 * The host registry (`@deepseek-ai/dsh-system-prompt`) merges prompt sections as
 * "global entries, then scope-chain shadows, nearest scope last", and a scoped
 * section with the SAME NAME replaces the global one. Preset rows are mounted in
 * a scope that is the parent of every agent bound to that preset
 * (`@deepseek-ai/dsh-agent-preset-registry`: `bindScopeParent(agentKey,
 * generationKey)`), so registering an empty scoped section here shadows the
 * character for exactly the worker/verifier sessions.
 *
 * The manager preset does NOT mount this row: it has its own professional
 * control-plane role text and no character store dependency.
 *
 * Section names are HOST COMPATIBILITY IDENTIFIERS ONLY (needed to shadow a
 * legacy global persona; Superbot does not depend on or load that plugin). This module does not
 * depend on any character plugin being installed: registering an empty scoped
 * section is valid with or without a global one, and a missing `systemPrompt`
 * service is skipped safely (reported in `/superbot/status`).
 */

/** Fallback placements if the service does not export `getSectionOrder`. */
export const FALLBACK_SECTION_ORDERS = Object.freeze({
  DEPLOYMENT_PERSONA_PREFIX: 0,
  DEPLOYMENT_PERSONA_SUFFIX: 10200,
})

/**
 * Sections shadowed in worker/verifier scopes. Character sections first; the
 * deployment persona slots are shadowed too, because a role-less executor must
 * not inherit any deployment-level identity either.
 */
/**
 * Host compatibility identifiers only. They let a role-less executor shadow a
 * legacy global persona registered by another plugin; Superbot itself never
 * loads, reads or depends on that plugin or its data.
 */
export const LEGACY_GLOBAL_PERSONA_SECTIONS = Object.freeze(['dafeiyu:persona', 'dafeiyu:persona-suffix'])

export const SHADOW_SECTIONS = Object.freeze([
  Object.freeze({ name: LEGACY_GLOBAL_PERSONA_SECTIONS[0], orderSlot: 'DEPLOYMENT_PERSONA_PREFIX' }),
  Object.freeze({ name: LEGACY_GLOBAL_PERSONA_SECTIONS[1], orderSlot: 'DEPLOYMENT_PERSONA_SUFFIX' }),
  Object.freeze({ name: 'deployment:persona-prefix', orderSlot: 'DEPLOYMENT_PERSONA_PREFIX' }),
  Object.freeze({ name: 'deployment:persona-suffix', orderSlot: 'DEPLOYMENT_PERSONA_SUFFIX' }),
])

/** A row may override the list (advanced); every entry needs a stable name. */
function normalizeSections(sections) {
  if (sections === undefined) return SHADOW_SECTIONS.map((entry) => ({ ...entry }))
  if (!Array.isArray(sections)) return []
  const seen = new Set()
  const normalized = []
  for (const value of sections) {
    const entry = typeof value === 'string' ? { name: value } : value
    if (entry === null || typeof entry !== 'object' || typeof entry.name !== 'string' || entry.name.trim() === '') continue
    const name = entry.name.trim()
    if (seen.has(name)) continue
    seen.add(name)
    normalized.push({
      name,
      orderSlot: typeof entry.orderSlot === 'string' ? entry.orderSlot : undefined,
      order: Number.isFinite(entry.order) ? entry.order : undefined,
    })
  }
  return normalized
}

/**
 * Resolve one section's placement: explicit numeric order, then the host
 * registry slot, then the documented fallback. Never throws.
 * @param {{getSectionOrder?: (name: string) => number}} prompt
 * @param {{order?: number, orderSlot?: string}} spec
 */
export function resolveShadowOrder(prompt, spec) {
  if (Number.isFinite(spec.order)) return spec.order
  const slot = spec.orderSlot ?? 'DEPLOYMENT_PERSONA_PREFIX'
  try {
    if (typeof prompt?.getSectionOrder === 'function') {
      const order = prompt.getSectionOrder(slot)
      if (Number.isFinite(order)) return order
    }
  } catch {
    /* registry without the slot: use the documented fallback */
  }
  return FALLBACK_SECTION_ORDERS[slot] ?? FALLBACK_SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX
}

/** Report the outcome to the plugin service when it exists (status/README). */
function report(ctx, config, report_) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('superbot') : undefined
    if (service === null || service === undefined || typeof service !== 'object') return
    const role = typeof config?.role === 'string' && config.role !== '' ? config.role : 'unknown'
    if (service.personaBoundaries === undefined || service.personaBoundaries === null) service.personaBoundaries = {}
    service.personaBoundaries[role] = report_
  } catch {
    /* diagnostics are best effort; the boundary itself must not depend on them */
  }
}

/**
 * Register the empty shadow sections in the calling (preset) scope.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{role?: string, sections?: Array<string | {name: string, order?: number, orderSlot?: string}>}} [config]
 */
export function apply(ctx, config = {}) {
  const role = typeof config?.role === 'string' ? config.role : undefined
  const sections = normalizeSections(config?.sections)
  const prompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : ctx?.systemPrompt
  if (prompt === undefined || prompt === null || typeof prompt.section !== 'function') {
    ctx.logger?.info?.(`dsh-superbot: systemPrompt unavailable; persona shadow skipped (${role ?? 'preset'})`)
    report(ctx, config, { registered: [], skipped: true, reason: 'systemPrompt service unavailable', role: role ?? null })
    return
  }

  const registered = []
  const failed = []
  for (const spec of sections) {
    try {
      const order = resolveShadowOrder(prompt, spec)
      ctx.effect(
        () => prompt.section({ name: spec.name, order, text: '', interpolate: false }),
        `dsh-superbot: persona shadow ${spec.name}`,
      )
      registered.push(spec.name)
    } catch (error) {
      failed.push({ name: spec.name, error: String(error?.message ?? error) })
    }
  }
  ctx.logger?.info?.(`dsh-superbot: persona boundary for ${role ?? 'preset'}: shadowed ${registered.length} section(s)`)
  report(ctx, config, {
    registered,
    skipped: registered.length === 0,
    ...(failed.length === 0 ? {} : { failed }),
    role: role ?? null,
  })
}
