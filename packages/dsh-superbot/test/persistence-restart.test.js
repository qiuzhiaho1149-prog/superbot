import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { saveConfig } from '../lib/config.js'
import { apply } from '../lib/index.js'
import { createSuperbotTools } from '../lib/tools.js'
import { WorkStore } from '../lib/work-store.js'
import { createFakeContext, createFakeResponse, jsonOf, settle } from './fake-context.js'

let dir
let homes = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'superbot-restart-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const home of homes) rmSync(home, { recursive: true, force: true })
  homes = []
})

const registries = () => {
  const registered = []
  return {
    registered,
    service: {
      async register(definition) {
        registered.push(definition)
        return () => {}
      },
      async list() {
        return registered.map((definition) => ({ id: definition.id, name: definition.name }))
      },
      composedPreset() {
        return 'superbot-manager'
      },
    },
  }
}

const taskSpec = (id) => ({
  id,
  title: `task ${id}`,
  projectId: 'ws-1',
  priority: 'normal',
  acceptance: ['node --test test/*.test.js'],
})

describe('plugin restart persistence', () => {
  it('reopens the ledger on a second apply() and registers no global tools', async () => {
    const presets = registries()
    const first = createFakeContext({ services: { agentPresets: presets.service } })
    apply(first.ctx, { stateDir: dir })
    await settle()
    assert.equal(first.tools.length, 0, 'root plugin must not register tools globally on a preset surface')

    const service = first.ctx.get('superbot')
    assert.equal(service.store.getTask('t-1'), undefined)
    service.store.submitTask(taskSpec('t-1'), { actor: 'manager', reason: 'submit' })
    service.store.planTask('t-1')

    // Simulated process restart: fresh plugin instance, same stateDir.
    const presetsAgain = registries()
    const second = createFakeContext({ services: { agentPresets: presetsAgain.service } })
    apply(second.ctx, { stateDir: dir })
    await settle()

    const reopened = second.ctx.get('superbot').store
    assert.equal(reopened.getTask('t-1').status, 'todo')
    assert.equal(reopened.stats().tasks, 1)
    assert.ok(existsSync(join(dir, 'work', 'events.jsonl')))
    assert.ok(existsSync(join(dir, 'work', 'projection.json')))
  })

  it('serves the first-run inventory and accepts a human confirmation', async () => {
    const presets = registries()
    const routes = new Map()
    const webServer = { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path) } }
    const fake = createFakeContext({ services: { agentPresets: presets.service, webServer, connection: { requestRejection: () => undefined } } })
    saveConfig(dir, { httpHumanActions: true })
    apply(fake.ctx, { stateDir: dir })
    await settle()
    const response = createFakeResponse()
    await routes.get('/superbot/onboarding')({ method: 'GET' }, response)
    const inventory = jsonOf(response)
    assert.equal(inventory.readOnly, true)
    assert.equal(inventory.confirmationRequired, true)

    const confirm = createFakeResponse()
    await routes.get('/superbot/onboarding/confirm')({
      method: 'POST',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ projects: [{ projectId: 'ws-a', status: 'active' }], note: 'ok' }))
      },
    }, confirm)
    const confirmed = jsonOf(confirm)
    assert.equal(confirmed.inventory.projects[0].status, 'active')
    assert.equal(fake.ctx.get('superbot').store.getInventoryConfirmation().note, 'ok')
  })

  it('uses DSH_HOME for the default state directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'superbot-dsh-home-'))
    homes.push(home)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const presets = registries()
      const fake = createFakeContext({ services: { agentPresets: presets.service } })
      apply(fake.ctx, {})
      await settle()
      fake.ctx.get('superbot').store.submitTask(taskSpec('t-home'), { actor: 'manager', reason: 'submit' })
      const events = join(home, 'storages', 'dsh-superbot', 'work', 'events.jsonl')
      assert.ok(existsSync(events))
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('exposes a read-only status route with preset and ledger state', async () => {
    const presets = registries()
    const routes = new Map()
    const webServer = {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    }
    const fake = createFakeContext({ services: { agentPresets: presets.service, webServer, connection: { requestRejection: () => undefined } } })
    apply(fake.ctx, { stateDir: dir })
    await settle()
    fake.ctx.get('superbot').store.submitTask(taskSpec('t-status'), { actor: 'manager', reason: 'submit' })

    assert.equal(routes.size, 10, 'config/status/overview/compose/history-import/reject/accept/task/onboarding/onboarding-confirm routes')
    const response = createFakeResponse()
    await routes.get('/superbot/status')({ method: 'GET' }, response)
    const status = jsonOf(response)
    assert.equal(status.mode, 'preset-scoped')
    assert.equal(status.legacyGlobalTools, null, 'the legacy global row must be inactive on a preset surface')
    assert.equal(status.presets.manager.registered, true)
    assert.equal(status.presets.worker.registered, true)
    assert.equal(status.presets.verifier.registered, true)
    assert.equal(status.work.tasks, 1)
    assert.equal(status.work.events, 1)
  })
})

describe('task/run/report/review flow through tools', () => {
  it('auto-accepts a low-risk task only after the verifier records machine evidence', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'superbot-project-'))
    homes.push(projectDir)
    const workspaceRegistry = {
      list: () => [{ id: 'ws-1', path: projectDir, title: 'proj-1', sessionIds: [], updatedAt: new Date().toISOString() }],
    }
    const fake = createFakeContext({ services: { workspaceRegistry } })
    const store = new WorkStore({ stateDir: dir })
    const manager = createSuperbotTools({ role: 'manager', ctx: fake.ctx, store })
    const verifier = createSuperbotTools({ role: 'verifier', ctx: fake.ctx, store })
    const byName = (tools, name) => tools.find((tool) => tool.name === name)

    byName(manager, 'superbot_task_submit').execute({
      title: 'flow', projectId: 'ws-1', priority: 'normal',
      acceptance: ['node --test 通过'], acceptanceCommands: [{ command: 'node --test' }],
      risk: 'low', reversible: true,
    })
    byName(manager, 'superbot_task_plan').execute({ id: 't-1' })
    const workerRun = store.startRun({ taskId: 't-1', agentPreset: 'superbot-worker', workspaceId: 'ws-1', label: 'work:t-1', workspacePath: projectDir, actor: 'manager' })
    store.bindRun(workerRun.runId, { childId: `child-${workerRun.runId}` })
    byName(manager, 'superbot_task_claim').execute({ id: 't-1', owner: workerRun.runId })
    const reported = byName(manager, 'superbot_task_report').execute({ taskId: 't-1', runId: workerRun.runId, author: workerRun.runId, summary: 'implemented', evidence: ['node --test: pass'] })
    store.finishRun(workerRun.runId, { status: 'succeeded', summary: 'done', actor: 'manager' })
    assert.equal(reported.report.evidence[0], 'node --test: pass')

    // The verifier executes the declared command itself and records evidence.
    // The run is resolved from the verifier SESSION id, not from a model argument.
    const verifierRun = store.startRun({ taskId: 't-1', agentPreset: 'superbot-verifier', workspaceId: 'ws-1', label: 'verify:t-1', workspacePath: projectDir, actor: 'manager' })
    store.bindRun(verifierRun.runId, { childId: 'child-verifier-1' })
    const verifierExec = { agent: { id: 'child-verifier-1' }, signal: undefined }
    const ran = await byName(verifier, 'superbot_acceptance_run').execute({ taskId: 't-1', index: 0 }, verifierExec)
    assert.equal(ran.passed, true)
    assert.ok(ran.evidence.evidenceId.startsWith('ev-'))

    // A prose-only pass is rejected before it reaches the ledger.
    assert.throws(
      () => byName(verifier, 'superbot_review_submit').execute({ taskId: 't-1', verdict: 'pass', notes: 'looks good' }, verifierExec),
      /evidenceIds/,
    )
    const verdict = byName(verifier, 'superbot_review_submit').execute({ taskId: 't-1', verdict: 'pass', notes: 'command passed', evidenceIds: [ran.evidence.evidenceId] }, verifierExec)
    assert.equal(verdict.review.reviewerRole, 'verifier')
    assert.equal(store.getTask('t-1').status, 'in_progress', 'verifier verdict does not move task status')

    const reviewed = byName(manager, 'superbot_task_review').execute({ id: 't-1' })
    assert.equal(reviewed.status, 'done')
    assert.equal(reviewed.acceptedBy, 'policy')
    assert.equal(reviewed.acceptance.mode, 'auto')
    assert.ok(reviewed.reviewId.startsWith('rv-'))
    assert.ok(reviewed.verifierReviewId.startsWith('rv-'))

    const reviews = byName(manager, 'superbot_review_list').execute({ taskId: 't-1' })
    assert.equal(reviews.reviews.length, 2)
    const verifierReview = reviews.reviews.find((review) => review.source === 'verifier')
    const policyReview = reviews.reviews.find((review) => review.source === 'policy')
    assert.ok(verifierReview !== undefined)
    assert.deepEqual(verifierReview.evidenceIds, [ran.evidence.evidenceId])
    assert.ok(policyReview !== undefined)
    assert.equal(policyReview.reviewerRole, 'manager', 'policy evaluation must not be attributed to the worker owner')
    assert.equal(policyReview.reviewedOwner, workerRun.runId)

    const audit = byName(manager, 'superbot_audit_export').execute({ limit: 5 })
    assert.equal(audit.events.length, 5)
    assert.ok(audit.eventCount >= 10)
  })

  it('leaves aesthetic or high-risk tasks waiting for a human', () => {
    const fake = createFakeContext()
    const store = new WorkStore({ stateDir: dir })
    const tools = createSuperbotTools({ role: 'manager', ctx: fake.ctx, store })
    const byName = (name) => tools.find((tool) => tool.name === name)

    byName('superbot_task_submit').execute({ title: 'taste', projectId: 'ws-1', priority: 'high', acceptance: ['looks right'], tags: ['aesthetic'] })
    byName('superbot_task_plan').execute({ id: 't-1' })
    byName('superbot_task_claim').execute({ id: 't-1', owner: 'worker-1' })
    const reviewed = byName('superbot_task_review').execute({ id: 't-1' })
    assert.equal(reviewed.status, 'in_review')
    assert.equal(reviewed.waitingForHuman, true)
    assert.equal(reviewed.acceptance.mode, 'human')
    assert.ok(reviewed.acceptance.reasons.includes('tag:aesthetic'))
    assert.ok(reviewed.acceptance.reasons.includes('verification-not-passed'), 'no verifier evidence yet')
    assert.equal(reviewed.evidenceComplete, false)
  })

  it('accepts a task by human through the store (the HTTP route surface), never through tools', () => {
    const store = new WorkStore({ stateDir: dir })
    store.submitTask({ id: 't-h', title: 'human', projectId: 'ws-1', priority: 'normal', acceptance: ['looks right'], tags: ['aesthetic'] })
    store.planTask('t-h')
    store.claimTask('t-h', { owner: 'worker-1' })
    store.transitionTask('t-h', 'in_review', { actor: 'worker-1', reason: 'submit' })
    const result = store.acceptTaskByHuman('t-h', { note: '审美通过' })
    assert.equal(result.task.status, 'done')
    assert.equal(result.task.acceptedBy, 'human')
    assert.equal(result.task.acceptanceNote, '审美通过')
    assert.equal(result.review.source, 'human')
    assert.equal(result.review.reviewerRole, 'human')
  })

  it('honours the toolsEnabled setting on every tool family', () => {
    const store = new WorkStore({ stateDir: dir })
    const tools = createSuperbotTools({ role: 'manager', ctx: createFakeContext().ctx, store, getConfig: () => ({ toolsEnabled: false }) })
    const byName = (name) => tools.find((tool) => tool.name === name)
    assert.throws(() => byName('superbot_task_list').execute(), /disabled in settings/)
    assert.throws(() => byName('superbot_project_list').execute(), /disabled in settings/)
    assert.throws(() => byName('superbot_project_overview').execute(), /disabled in settings/)
    assert.throws(() => byName('superbot_dispatch_worker').execute({ workspaceId: 'ws-1', prompt: 'x' }), /disabled in settings/)
  })
})
