/**
 * Minimal fake `systemPrompt` service for unit tests. Not a test file (not
 * matched by `test/*.test.js`); imported by tests that exercise prompt-section
 * plugins without booting DSH.
 *
 * It reproduces the two documented host semantics the plugins rely on:
 * - `getSectionOrder(slot)` resolves the repository placements;
 * - a section registered in a scope shadows a GLOBAL section with the same
 *   name (the host merges: global first, scope-chain layers last-wins), and a
 *   section whose text renders to '' is dropped from the prompt.
 *
 * The real service decides the registering scope from the calling context
 * (Cordis service tracing); this fake is scope-bound at creation, so a test
 * hands `registry.scoped(scopeKey)` to a fake context's `systemPrompt` service.
 */

/** The placements these plugins read, mirroring `@deepseek-ai/dsh-system-prompt`. */
export const FAKE_SECTION_ORDERS = Object.freeze({
  HARNESS_IDENTITY: -1000,
  DEPLOYMENT_PERSONA_PREFIX: 0,
  PLAN_POLICY: 500,
  DEPLOYMENT_PERSONA_SUFFIX: 10200,
})

/** @param {unknown} text */
const evaluate = (text) => (typeof text === 'function' ? String(text() ?? '') : String(text ?? ''))

/**
 * @returns {object} a fake registry with a global prompt and per-scope prompts
 */
export function createFakePromptRegistry() {
  /** @type {Map<string, object>} */
  const globalSections = new Map()
  /** @type {Map<string, Map<string, object>>} */
  const scopes = new Map()

  const layerFor = (scopeKey) => {
    if (scopeKey === undefined) return globalSections
    let layer = scopes.get(scopeKey)
    if (layer === undefined) {
      layer = new Map()
      scopes.set(scopeKey, layer)
    }
    return layer
  }

  const promptFor = (scopeKey) => ({
    /** Host registry placement lookup. */
    getSectionOrder(slot) {
      return FAKE_SECTION_ORDERS[slot]
    },
    /** Register a section in this prompt's scope; returns an undo. */
    section(spec) {
      const layer = layerFor(scopeKey)
      layer.set(spec.name, { ...spec })
      return () => {
        layer.delete(spec.name)
      }
    },
    /** Direct read of this scope's own layer (no inheritance). */
    own(scopeId = scopeKey) {
      return layerFor(scopeId)
    },
  })

  const sectionsOf = (scopeKey) => [...(scopeKey === undefined ? globalSections : (scopes.get(scopeKey) ?? new Map())).values()]

  return {
    /** Global (deployment) prompt: sections registered here apply to everyone. */
    global: promptFor(undefined),
    /** A scoped prompt for a preset generation / agent scope. */
    scoped(scopeKey) {
      return promptFor(scopeKey)
    },
    /** Section specs registered directly in one layer (global when omitted). */
    sectionsOf,
    /** Names registered directly in one layer. */
    namesOf(scopeKey) {
      return sectionsOf(scopeKey).map((section) => section.name)
    },
    /**
     * Emulate one assembly for `scopeKey`: global sections then the exact
     * scope's layer (last wins by name), empty sections dropped, sorted by
     * order then name.
     */
    assemble(scopeKey) {
      const merged = new Map(globalSections)
      for (const [name, spec] of scopes.get(scopeKey) ?? new Map()) merged.set(name, spec)
      return [...merged.values()]
        .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map((section) => ({ name: section.name, order: section.order, text: evaluate(section.text) }))
        .filter((section) => section.text.length > 0)
    },
  }
}

/** A fake `superbot` service object for prompt-plugin diagnostics. */
export function createFakeSuperbotService() {
  return { personaBoundaries: {} }
}
