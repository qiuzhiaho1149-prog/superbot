import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  FALLBACK_SECTION_ORDERS,
  LEGACY_GLOBAL_PERSONA_SECTIONS,
  SHADOW_SECTIONS,
  apply as applyCharacterBoundary,
  resolveShadowOrder,
} from '../lib/character-boundary.js'
import { MANAGER_PERSONA_PREFIX, createPresetDefinitions } from '../lib/presets.js'
import { PRESET_IDS } from '../lib/roles.js'
import { createFakeContext } from './fake-context.js'
import { FAKE_SECTION_ORDERS, createFakePromptRegistry, createFakeSuperbotService } from './fake-prompt.js'

const pkg = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Legacy host global sections a user may have enabled: character + deployment persona. */
function installGlobalPersonas(registry) {
  registry.global.section({ name: 'harness:identity', order: FAKE_SECTION_ORDERS.HARNESS_IDENTITY, text: 'You are an AI agent powered by DeepSeek Harness.' })
  registry.global.section({ name: LEGACY_GLOBAL_PERSONA_SECTIONS[0], order: 0, text: () => 'legacy character prompt' })
  registry.global.section({ name: LEGACY_GLOBAL_PERSONA_SECTIONS[1], order: 10200, text: 'legacy character suffix' })
  registry.global.section({ name: 'deployment:persona-prefix', order: 0, text: '部署级人格前缀' })
  registry.global.section({ name: 'deployment:persona-suffix', order: 10200, text: '部署级人格后缀' })
}

describe('preset identity wiring', () => {
  it('mounts the shadow row only in worker/verifier and keeps the manager free of character context', () => {
    const [manager, worker, verifier] = createPresetDefinitions()
    assert.deepEqual([manager.id, worker.id, verifier.id], [PRESET_IDS.manager, PRESET_IDS.worker, PRESET_IDS.verifier])

    const rows = (definition, name) => definition.plugins.filter((row) => row.name === name)
    for (const definition of [worker, verifier]) {
      const boundary = rows(definition, 'dsh-superbot/character-boundary')
      assert.equal(boundary.length, 1, `${definition.id} must mount exactly one character boundary row`)
      assert.equal(boundary[0].config.role, definition.id.replace('superbot-', ''))
      assert.equal(rows(definition, 'dsh-superbot/role-context').length, 0)
    }
    assert.equal(rows(manager, 'dsh-superbot/character-boundary').length, 0, 'the manager needs no character shadow')
    assert.equal(rows(manager, 'dsh-superbot/role-context').length, 0)
    assert.equal(rows(manager, 'dsh-superbot/fish-context').length, 0)

    const managerPersona = manager.plugins.find((row) => row.name === '@deepseek-ai/dsh-persona')
    assert.equal(managerPersona.config.prefix, MANAGER_PERSONA_PREFIX)
    for (const definition of [worker, verifier]) {
      assert.equal(definition.plugins.some((row) => row.name === '@deepseek-ai/dsh-persona'), false)
    }
  })

  it('gives the manager a professional Chinese control-plane role without character context', () => {
    assert.match(MANAGER_PERSONA_PREFIX, /[\u4e00-\u9fff]/, 'the fixed manager persona must be Chinese')
    assert.match(MANAGER_PERSONA_PREFIX, /中台/)
    for (const forbidden of ['dsh-fish', 'legacy-store', '角色上下文']) {
      assert.equal(MANAGER_PERSONA_PREFIX.includes(forbidden), false, `manager prompt must not contain ${forbidden}`)
    }
    assert.match(MANAGER_PERSONA_PREFIX, /账本/)
  })

  it('exports the character boundary module and no character-store modules', () => {
    const { exports } = pkg()
    assert.equal(exports['./character-boundary'], './lib/character-boundary.js')
    assert.equal(exports['./role-context'], undefined)
    assert.equal(exports['./fish-context'], undefined)
    assert.ok(existsSync(new URL('../lib/character-boundary.js', import.meta.url)))
  })
})

describe('worker/verifier persona shadow (fake host registry)', () => {
  for (const role of ['worker', 'verifier']) {
    it(`shadows the legacy global character persona in the ${role} scope only`, () => {
      const registry = createFakePromptRegistry()
      installGlobalPersonas(registry)
      const service = createFakeSuperbotService()
      const scope = `${role}-generation`
      const context = createFakeContext({ services: { systemPrompt: registry.scoped(scope), superbot: service } })

      applyCharacterBoundary(context.ctx, { role })

      // 1. Every shadow section landed in THIS scope's layer, empty.
      assert.deepEqual(registry.namesOf(scope).sort(), SHADOW_SECTIONS.map((entry) => entry.name).sort())
      for (const section of registry.sectionsOf(scope)) {
        assert.equal(section.text, '', 'a shadow section must render nothing')
        assert.ok(SHADOW_SECTIONS.some((spec) => spec.name === section.name) || section.name.startsWith('deployment:'), 'only shadow/deployment sections are registered')
      }
      const byName = Object.fromEntries(registry.sectionsOf(scope).map((section) => [section.name, section]))
      assert.equal(byName[LEGACY_GLOBAL_PERSONA_SECTIONS[0]].order, FAKE_SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX)
      assert.equal(byName[LEGACY_GLOBAL_PERSONA_SECTIONS[1]].order, FAKE_SECTION_ORDERS.DEPLOYMENT_PERSONA_SUFFIX)

      // 2. Assembly for this scope no longer contains the character.
      const prompt = registry.assemble(scope)
      for (const section of prompt) assert.doesNotMatch(section.text, /Superbot|部署级人格/, `${section.name} still leaks the persona`)
      assert.deepEqual(prompt.map((section) => section.name), ['harness:identity'])

      // 3. The global registrations are untouched: a non-preset scope still
      //    sees the character (this is exactly what the manager keeps).
      const untouched = registry.assemble('some-standard-agent')
      assert.ok(untouched.some((section) => section.name === LEGACY_GLOBAL_PERSONA_SECTIONS[0] && section.text.includes('legacy character prompt')))

      // 4. Diagnostics for /superbot/status: names only, never text.
      assert.equal(service.personaBoundaries[role].skipped, false)
      assert.deepEqual(service.personaBoundaries[role].registered.sort(), SHADOW_SECTIONS.map((entry) => entry.name).sort())
      assert.equal(service.personaBoundaries[role].role, role)
    })
  }

  it('works without dsh-persona-legacy installed (no global section to shadow)', () => {
    const registry = createFakePromptRegistry()
    registry.global.section({ name: 'harness:identity', order: -1000, text: 'identity' })
    const context = createFakeContext({ services: { systemPrompt: registry.scoped('worker-generation'), superbot: createFakeSuperbotService() } })
    assert.doesNotThrow(() => applyCharacterBoundary(context.ctx, { role: 'worker' }))
    assert.deepEqual(registry.assemble('worker-generation').map((section) => section.name), ['harness:identity'])
  })

  it('skips safely when the profile has no systemPrompt service', () => {
    const service = createFakeSuperbotService()
    const context = createFakeContext({ services: { superbot: service } })
    assert.doesNotThrow(() => applyCharacterBoundary(context.ctx, { role: 'worker' }))
    assert.deepEqual(service.personaBoundaries.worker.registered, [])
    assert.equal(service.personaBoundaries.worker.skipped, true)
    assert.match(service.personaBoundaries.worker.reason, /systemPrompt/)
    assert.ok(context.logs.info.some((line) => line.includes('persona shadow skipped')))
  })

  it('honours a custom section list and explicit order', () => {
    const registry = createFakePromptRegistry()
    const context = createFakeContext({ services: { systemPrompt: registry.scoped('worker-generation'), superbot: createFakeSuperbotService() } })
    applyCharacterBoundary(context.ctx, { role: 'worker', sections: [LEGACY_GLOBAL_PERSONA_SECTIONS[0], { name: 'superbot:custom', order: 4242 }] })
    const sections = registry.sectionsOf('worker-generation')
    assert.deepEqual(sections.map((section) => section.name).sort(), [LEGACY_GLOBAL_PERSONA_SECTIONS[0], 'superbot:custom'])
    assert.equal(Object.fromEntries(sections.map((section) => [section.name, section.order]))['superbot:custom'], 4242)
  })

  it('falls back to documented orders when the host exposes no getSectionOrder', () => {
    assert.equal(resolveShadowOrder({}, { orderSlot: 'DEPLOYMENT_PERSONA_PREFIX' }), FALLBACK_SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX)
    assert.equal(resolveShadowOrder({}, { orderSlot: 'DEPLOYMENT_PERSONA_SUFFIX' }), FALLBACK_SECTION_ORDERS.DEPLOYMENT_PERSONA_SUFFIX)
    assert.equal(resolveShadowOrder({ getSectionOrder: () => { throw new Error('nope') } }, { orderSlot: 'DEPLOYMENT_PERSONA_SUFFIX' }), 10200)
    assert.equal(resolveShadowOrder({ getSectionOrder: () => Number.NaN }, { orderSlot: 'DEPLOYMENT_PERSONA_PREFIX' }), 0)
    assert.equal(resolveShadowOrder({ getSectionOrder: () => 7 }, { orderSlot: 'DEPLOYMENT_PERSONA_PREFIX' }), 7)
    assert.equal(resolveShadowOrder({}, { order: 12 }), 12)
  })
})
