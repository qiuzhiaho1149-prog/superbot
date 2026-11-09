import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { apply } from '../lib/index.js'
import { apply as applyGlobalTools } from '../lib/global-tools.js'
import { apply as applyPresetTools } from '../lib/preset-tools.js'
import { createPresetDefinitions } from '../lib/presets.js'
import { PRESET_IDS, ROLE_TOOLS, ROLES, TOOL_NAMES, hasPresetSurface, isToolAllowed, toolsForRole } from '../lib/roles.js'
import { createSuperbotTools } from '../lib/tools.js'
import { WorkStore } from '../lib/work-store.js'
import { createFakeContext, settle } from './fake-context.js'

let dir
let home

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'superbot-preset-'))
  home = mkdtempSync(join(tmpdir(), 'superbot-project-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

const packageJson = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const patchYaml = () => readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

const store = () => new WorkStore({ stateDir: dir })
const fake = (services = {}) => createFakeContext({ services })

describe('agent preset definitions', () => {
  it('declares manager/worker/verifier with distinct ids and order', () => {
    const definitions = createPresetDefinitions()
    assert.deepEqual(definitions.map((definition) => definition.id), [PRESET_IDS.manager, PRESET_IDS.worker, PRESET_IDS.verifier])
    assert.deepEqual(definitions.map((definition) => definition.id), [...ROLES.map((role) => PRESET_IDS[role])])
    assert.equal(new Set(definitions.map((definition) => definition.order)).size, 3)
    for (const definition of definitions) {
      assert.ok(definition.name.includes('Superbot'))
      assert.ok(definition.description.length > 0)
      assert.ok(definition.plugins.length > 0)
      for (const row of definition.plugins) {
        assert.equal(typeof row.id, 'string')
        assert.equal(typeof row.name, 'string')
      }
      const toolsRow = definition.plugins.find((row) => row.name === 'dsh-superbot/preset-tools')
      assert.equal(toolsRow.config.role, definition.id.replace('superbot-', ''))
    }
  })

  it('keeps the worker role-less and the verifier read-only', () => {
    const [manager, worker, verifier] = createPresetDefinitions()
    assert.ok(manager.plugins.some((row) => row.name === '@deepseek-ai/dsh-persona'))
    assert.equal(worker.plugins.some((row) => row.name === '@deepseek-ai/dsh-persona'), false, 'worker must not inherit a persona')
    assert.equal(verifier.plugins.some((row) => row.name === '@deepseek-ai/dsh-persona'), false)

    const workerBash = worker.plugins.filter((row) => row.name === '@deepseek-ai/dsh-tool-bash')
    assert.equal(workerBash.length, 1)
    // D1: the manager never executes code (no shell, read-only fs).
    assert.equal(manager.plugins.some((row) => row.name === '@deepseek-ai/dsh-tool-bash'), false, 'manager must not have a shell')
    const managerFs = manager.plugins.find((row) => row.name === '@deepseek-ai/dsh-tool-fs')
    assert.equal(managerFs.config.write, false)
    assert.equal(managerFs.config.edit, false)
    assert.equal(verifier.plugins.some((row) => row.name === '@deepseek-ai/dsh-tool-bash'), false, 'verifier must not have a shell')

    const verifierFs = verifier.plugins.find((row) => row.name === '@deepseek-ai/dsh-tool-fs')
    assert.deepEqual(verifierFs.config, { read: true, readImage: false, write: false, edit: false })
    assert.equal(verifier.plugins.some((row) => row.name === '@deepseek-ai/dsh-tool-fs-search'), true)
  })

  it('keeps the preset tools subpath exported and the legacy row gated', () => {
    const exports = packageJson().exports
    assert.equal(exports['./preset-tools'], './lib/preset-tools.js')
    assert.equal(exports['./global-tools'], './lib/global-tools.js')
    assert.equal(exports['./planning-tools'], './lib/planning-tools.js')
    assert.equal(exports['./work-store'], './lib/work-store.js')
    assert.ok(existsSync(new URL('../lib/preset-tools.js', import.meta.url)))
    assert.ok(existsSync(new URL('../lib/planning-tools.js', import.meta.url)))

    const yaml = patchYaml()
    assert.match(yaml, /id: dsh-superbot-global-tools/)
    assert.match(yaml, /name: dsh-superbot\/global-tools/)
    assert.match(yaml, /disabled: !!js .*startedBundles/)
    assert.equal(hasPresetSurface(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']), true)
    assert.equal(hasPresetSurface(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']), false)
  })
})

describe('role tool scopes', () => {
  it('gives manager the full surface and the worker/verifier narrow subsets', () => {
    assert.equal(ROLE_TOOLS.manager.length, 35)
    assert.equal(ROLE_TOOLS.worker.length, 6)
    assert.equal(ROLE_TOOLS.verifier.length, 8)
    assert.equal(isToolAllowed('manager', TOOL_NAMES.dispatchWorker), true)
    assert.equal(isToolAllowed('worker', TOOL_NAMES.dispatchWorker), false)
    assert.equal(isToolAllowed('verifier', TOOL_NAMES.taskClaim), false)
    assert.equal(isToolAllowed('verifier', TOOL_NAMES.workRebuild), false)
    assert.equal(isToolAllowed('verifier', TOOL_NAMES.reviewSubmit), true)
    assert.equal(isToolAllowed('verifier', TOOL_NAMES.acceptanceRun), true, 'the verifier executes declared acceptance commands for evidence')
    assert.equal(isToolAllowed('worker', TOOL_NAMES.acceptanceRun), false, 'a worker cannot produce its own acceptance evidence')
    assert.equal(isToolAllowed('manager', TOOL_NAMES.acceptanceRun), false)
    assert.equal(isToolAllowed('manager', TOOL_NAMES.projectOverview), true)
    assert.equal(isToolAllowed('manager', TOOL_NAMES.taskAccept), true, 'the manager asks the human through the approval dialog')
    assert.equal(isToolAllowed('worker', TOOL_NAMES.taskAccept), false)
    assert.equal(isToolAllowed('verifier', TOOL_NAMES.taskAccept), false)
    assert.equal(isToolAllowed('manager', TOOL_NAMES.onboardingScan), true)
    assert.equal(isToolAllowed('manager', TOOL_NAMES.onboardingConfirm), true)
    assert.equal(isToolAllowed('worker', TOOL_NAMES.onboardingScan), false)
    assert.throws(() => toolsForRole('nope'), /unknown role/)
  })

  it('builds exactly the role subset, never the full catalog', () => {
    const workStore = store()
    for (const role of ROLES) {
      const tools = createSuperbotTools({ role, ctx: fake().ctx, store: workStore })
      assert.deepEqual(tools.map((tool) => tool.name), [...ROLE_TOOLS[role]])
      assert.equal(tools.some((tool) => tool.name === TOOL_NAMES.dispatchWorker), role === 'manager')
      assert.equal(tools.some((tool) => tool.name === TOOL_NAMES.taskSubmit), role === 'manager')
    }
  })

  it('registers the role subset inside a preset scope via preset-tools', () => {
    const workStore = store()
    for (const role of ROLES) {
      const context = fake({ superbot: { store: workStore, getConfig: () => ({}) } })
      applyPresetTools(context.ctx, { role })
      assert.deepEqual(context.tools.map((tool) => tool.name), [...ROLE_TOOLS[role]])
    }
    assert.throws(() => applyPresetTools(fake({ superbot: { store: workStore } }).ctx, { role: 'intruder' }), /unknown role/)
  })

  it('registers the legacy global surface without dispatch when no presets exist', () => {
    const context = fake({ superbot: { store: store(), getConfig: () => ({}) } })
    applyGlobalTools(context.ctx)
    const names = context.tools.map((tool) => tool.name)
    assert.equal(names.length, 32)
    assert.equal(names.includes(TOOL_NAMES.dispatchWorker), false)
    assert.equal(names.includes(TOOL_NAMES.dispatchVerifier), false)
    assert.equal(names.includes(TOOL_NAMES.planDispatch), false)
    assert.equal(names.includes(TOOL_NAMES.requirementSubmit), true)
    assert.equal(names.includes(TOOL_NAMES.planCreate), true)
    assert.equal(names.includes(TOOL_NAMES.taskSubmit), true)
    assert.ok(context.logs.warn.some((line) => line.includes('legacy mode')))
    assert.equal(context.ctx.get('superbot').globalTools.toolCount, 32)
  })
})

describe('preset registration and dispatch isolation', () => {
  it('registers all three presets through agentPresets.register on startup', async () => {
    const registered = []
    const agentPresets = { async register(definition) { registered.push(definition); return () => {} }, async list() { return [] } }
    const context = fake({ agentPresets })
    apply(context.ctx, { stateDir: dir })
    await settle()
    assert.deepEqual(registered.map((definition) => definition.id), [PRESET_IDS.manager, PRESET_IDS.worker, PRESET_IDS.verifier])
    assert.equal(context.tools.length, 0, 'root row must not register tools globally')
  })

  it('can skip programmatic registration when the profile declares its own preset rows', async () => {
    const registered = []
    const agentPresets = { async register(definition) { registered.push(definition); return () => {} } }
    const context = fake({ agentPresets })
    apply(context.ctx, { stateDir: dir, registerPresets: false })
    await settle()
    assert.equal(registered.length, 0)
    assert.ok(context.ctx.get('superbot')?.store !== undefined, 'the work store service still mounts')
  })

  it('dispatches a worker with the worker preset, never the parent preset', async () => {
    const captured = []
    const subagents = {
      async startActivation(spec) {
        captured.push(spec)
        return { childId: 'child-1', result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }) }
      },
    }
    const agentPresets = { composedPreset: () => PRESET_IDS.manager }
    const workspaceRegistry = { list: () => [{ id: 'ws-1', path: home, title: 'proj', sessionIds: [], updatedAt: new Date().toISOString() }] }
    const context = fake({ subagents, agentPresets, workspaceRegistry })
    const workStore = store()
    const tools = createSuperbotTools({ role: 'manager', ctx: context.ctx, store: workStore, getConfig: () => ({ requireOnboarding: false }) })
    const dispatchWorker = tools.find((tool) => tool.name === TOOL_NAMES.dispatchWorker)
    const exec = { agent: { id: 'agent-1', ctx: {} }, signal: undefined }

    const result = await dispatchWorker.execute({ workspaceId: 'ws-1', prompt: 'do the task', wait: true }, exec)
    assert.equal(captured.length, 1)
    assert.equal(captured[0].request.agentPreset, PRESET_IDS.worker)
    assert.notEqual(captured[0].request.agentPreset, PRESET_IDS.manager)
    assert.equal(captured[0].request.parent, exec.agent)
    assert.equal(captured[0].request.cwd, home)
    assert.equal(result.agentPreset, PRESET_IDS.worker)
    assert.equal(result.status, 'succeeded')

    const runs = workStore.listRuns({})
    assert.equal(runs.length, 1)
    assert.equal(runs[0].agentPreset, PRESET_IDS.worker)
    assert.equal(runs[0].status, 'succeeded')
    assert.equal(runs[0].childId, 'child-1')
  })

  it('dispatches a read-only verifier with the verifier preset', async () => {
    const captured = []
    const subagents = {
      async startActivation(spec) {
        captured.push(spec)
        return { childId: 'child-2', result: Promise.resolve({ output: [{ type: 'text', text: 'pass' }], stopReason: 'completed' }) }
      },
    }
    const agentPresets = { composedPreset: () => PRESET_IDS.manager }
    const workspaceRegistry = { list: () => [{ id: 'ws-1', path: home, title: 'proj', sessionIds: [], updatedAt: new Date().toISOString() }] }
    const context = fake({ subagents, agentPresets, workspaceRegistry })
    const workStore = store()
    const tools = createSuperbotTools({ role: 'manager', ctx: context.ctx, store: workStore, getConfig: () => ({ requireOnboarding: false }) })
    const result = await tools.find((tool) => tool.name === TOOL_NAMES.dispatchVerifier)
      .execute({ workspaceId: 'ws-1', prompt: 'verify the task' }, { agent: { id: 'agent-1', ctx: {} } })
    assert.equal(captured[0].request.agentPreset, PRESET_IDS.verifier)
    assert.equal(result.agentPreset, PRESET_IDS.verifier)
  })

  it('refuses dispatch without a preset registry or outside the manager preset', async () => {
    const workspaceRegistry = { list: () => [{ id: 'ws-1', path: home, title: 'proj', sessionIds: [], updatedAt: new Date().toISOString() }] }
    const subagents = { async startActivation() { throw new Error('should not start') } }

    const noPresets = fake({ subagents, workspaceRegistry })
    const toolsWithout = createSuperbotTools({ role: 'manager', ctx: noPresets.ctx, store: store() })
    await assert.rejects(
      toolsWithout.find((tool) => tool.name === TOOL_NAMES.dispatchWorker).execute({ workspaceId: 'ws-1', prompt: 'x' }, { agent: { id: 'a', ctx: {} } }),
      /agent-presets service/,
    )

    const standardPreset = fake({ subagents, workspaceRegistry, agentPresets: { composedPreset: () => 'standard' } })
    const toolsStandard = createSuperbotTools({ role: 'manager', ctx: standardPreset.ctx, store: store() })
    await assert.rejects(
      toolsStandard.find((tool) => tool.name === TOOL_NAMES.dispatchWorker).execute({ workspaceId: 'ws-1', prompt: 'x' }, { agent: { id: 'a', ctx: {} } }),
      /manager-only/,
    )
  })
})
