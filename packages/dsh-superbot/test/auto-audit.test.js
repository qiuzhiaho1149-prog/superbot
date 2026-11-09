import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createDispatcher } from '../lib/dispatch-tools.js'
import { WorkStore } from '../lib/work-store.js'
import { fingerprintWorkspace } from '../lib/workspace-snapshot.js'
import { createFakeContext } from './fake-context.js'

let dir
let projectDir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'superbot-auto-audit-'))
  projectDir = mkdtempSync(join(tmpdir(), 'superbot-auto-project-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
})

const build = () => {
  const store = new WorkStore({ stateDir: dir })
  const ctx = createFakeContext({ services: { workspaceRegistry: { list: () => [{ id: 'ws-1', path: projectDir, title: 'p', sessionIds: [] }] } } }).ctx
  const dispatcher = createDispatcher(ctx, { store, getConfig: () => ({ requireSandboxedEvidence: false }) })
  return { store, dispatcher }
}

const seedVerified = (store) => {
  const baseline = fingerprintWorkspace(projectDir)
  const requirement = store.submitRequirement({ projectId: 'ws-1', title: 'r', text: 'x' })
  const { plan } = store.createPlan({ requirementId: requirement.id, tasks: [{
    title: 'fix', projectId: 'ws-1', priority: 'normal', acceptance: ['ok'], acceptanceCommands: [{ command: 'node --test' }], risk: 'low', reversible: true, externalSideEffects: false,
  }] })
  const taskId = plan.taskIds[0]
  const workerRun = store.startRun({ taskId, agentPreset: 'superbot-worker', workspaceId: 'ws-1', workspacePath: projectDir, baselineWorkspaceDigest: baseline.digest, baselineProtectedDigest: baseline.protectedDigest, actor: 'manager' })
  store.bindRun(workerRun.runId, { childId: 'child-worker' })
  store.claimTask(taskId, { owner: workerRun.runId })
  store.finishRun(workerRun.runId, { status: 'succeeded', summary: 'done', actor: 'manager' })
  const verifierRun = store.startRun({ taskId, agentPreset: 'superbot-verifier', workspaceId: 'ws-1', workspacePath: projectDir, actor: 'manager' })
  store.bindRun(verifierRun.runId, { childId: 'child-verifier' })
  const after = fingerprintWorkspace(projectDir)
  const evidence = store.recordEvidence({ taskId, runId: verifierRun.runId, childId: 'child-verifier', index: 0, command: 'node --test', exitCode: 0, timedOut: false, durationMs: 5, outputDigest: 'sha256:x', preview: 'ok', workspaceDigest: after.digest, protectedDigest: after.protectedDigest, workspacePath: projectDir, executionMode: 'host-shell', sandboxed: true, actor: verifierRun.runId })
  store.submitReview({ taskId, reviewer: 'verifier:x', reviewerRole: 'verifier', runId: verifierRun.runId, verdict: 'pass', source: 'verifier', evidenceIds: [evidence.evidenceId], reviewedOwner: workerRun.runId })
  store.finishRun(verifierRun.runId, { status: 'succeeded', summary: 'pass', actor: 'manager' })
  return { taskId, verifierRunId: verifierRun.runId }
}

describe('automatic policy review', () => {
  it('auto-accepts a low-risk task with complete sandboxed evidence', async () => {
    const { store, dispatcher } = build()
    const { taskId } = seedVerified(store)
    const result = await dispatcher.autoReview(taskId, { agent: { id: 'manager-session' } })
    assert.equal(result.auto, true)
    assert.equal(store.getTask(taskId).status, 'done')
    assert.equal(store.getTask(taskId).acceptedBy, 'policy')
  })

  it('keeps the task in review when the verifier never passed', async () => {
    const { store, dispatcher } = build()
    const { taskId, verifierRunId } = seedVerified(store)
    // A later fail verdict supersedes the pass (same attempt).
    store.submitReview({ taskId, reviewer: 'verifier:y', reviewerRole: 'verifier', runId: verifierRunId, verdict: 'fail', source: 'verifier', notes: 'boom' })
    const result = await dispatcher.autoReview(taskId, { agent: { id: 'manager-session' } })
    assert.equal(result.auto, false)
    assert.equal(store.getTask(taskId).status, 'in_review')
  })
})
