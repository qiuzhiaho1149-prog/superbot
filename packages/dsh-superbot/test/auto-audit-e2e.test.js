import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { createDispatcher } from '../lib/dispatch-tools.js'
import { createSuperbotTools } from '../lib/tools.js'
import { WorkStore } from '../lib/work-store.js'
import { fingerprintWorkspace } from '../lib/workspace-snapshot.js'
import { createFakeContext } from './fake-context.js'

let dir
let projectDir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'superbot-e2e-auto-'))
  projectDir = mkdtempSync(join(tmpdir(), 'superbot-e2e-project-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
})

const build = () => {
  let taskIdForChild = ''
  const store = new WorkStore({ stateDir: dir })
  let counter = 0
  const subagents = {
    async startActivation(spec) {
      counter += 1
      const childId = `child-${counter}`
      const activation = { childId, result: null }
      activation.result = new Promise((resolve) => {
        setTimeout(async () => {
          if (spec.request.agentPreset === 'superbot-verifier') {
            const verifier = createSuperbotTools({ role: 'verifier', ctx, store })
            const run = (name) => verifier.find((tool) => tool.name === name)
            const exec = { agent: { id: childId } }
            const ran = await run('superbot_acceptance_run').execute({ taskId: taskIdForChild, index: 0 }, exec)
            await run('superbot_review_submit').execute({ taskId: taskIdForChild, verdict: 'pass', evidenceIds: [ran.evidence.evidenceId] }, exec)
          }
          resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })
        }, 5)
      })
      return activation
    },
  }
  const services = {
    subagents,
    agentPresets: { composedPreset: () => 'superbot-manager' },
    workspaceRegistry: { list: () => [{ id: 'ws-1', path: projectDir, title: 'p', sessionIds: [] }] },
  }
  const ctx = createFakeContext({ services }).ctx
  const getConfig = () => ({ autoAudit: true, requireSandboxedEvidence: false })
  const dispatcher = createDispatcher(ctx, { store, getConfig })
  return { store, dispatcher, getConfig, setTaskId: (id) => { taskIdForChild = id } }
}

describe('auto audit end-to-end (fake host)', () => {
  it('worker finish → auto verifier → auto policy done', async () => {
    const { store, dispatcher, getConfig, setTaskId } = build()
    store.confirmInventory({ projects: [{ projectId: 'ws-1', status: 'active' }] })
    const baseline = fingerprintWorkspace(projectDir)
    const requirement = store.submitRequirement({ projectId: 'ws-1', title: 'r', text: 'x' })
    const { plan } = store.createPlan({ requirementId: requirement.id, tasks: [{
      title: 'fix', projectId: 'ws-1', priority: 'normal', acceptance: ['ok'], acceptanceCommands: [{ command: 'node --test' }], risk: 'low', reversible: true, externalSideEffects: false,
    }] })
    const taskId = plan.taskIds[0]
    setTaskId(taskId)
    const workerRun = store.startRun({ taskId, agentPreset: 'superbot-worker', workspaceId: 'ws-1', workspacePath: projectDir, baselineWorkspaceDigest: baseline.digest, baselineProtectedDigest: baseline.protectedDigest, actor: 'manager' })
    store.bindRun(workerRun.runId, { childId: 'child-worker' })
    store.claimTask(taskId, { owner: workerRun.runId })
    store.finishRun(workerRun.runId, { status: 'succeeded', summary: 'done', actor: 'manager' })
    const task = store.getTask(taskId)
    await dispatcher.autoAuditAfterWorker(task, { agent: { id: 'manager-session', ctx: {} } })
    assert.equal(store.getTask(taskId).status, 'done')
    assert.equal(store.getTask(taskId).acceptedBy, 'policy')
  })
})
