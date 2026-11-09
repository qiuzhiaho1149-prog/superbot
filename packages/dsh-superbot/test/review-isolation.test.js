import assert from 'node:assert/strict'
import { exec } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { appendRaw } from '../lib/event-log.js'
import { createSuperbotTools } from '../lib/tools.js'
import { WorkStore, workPaths } from '../lib/work-store.js'
import { fingerprintWorkspace } from '../lib/workspace-snapshot.js'
import { createFakeContext } from './fake-context.js'

/**
 * The whole point of this suite: agents may not accept their own work.
 * A verifier verdict only counts when it is bound to its own run and to
 * machine evidence the ledger recorded for every declared command.
 */

let dir
let projectDir
let homes = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'superbot-isolation-'))
  projectDir = mkdtempSync(join(tmpdir(), 'superbot-isolation-project-'))
  homes.push(projectDir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const home of homes) rmSync(home, { recursive: true, force: true })
  homes = []
})

const workspaceRegistry = () => ({
  list: () => [{ id: 'ws-1', path: projectDir, title: 'proj-1', sessionIds: [], updatedAt: new Date().toISOString() }],
})

const fakeShell = {
  resolve(request) {
    return { ...request, onExpiry: 'kill', timeoutMs: request.timeoutMs ?? 120000, stdoutMaxBytes: 1024 * 1024, sandboxPolicy: request.sandboxPolicy }
  },
  async execute(spec) {
    const outcome = await new Promise((resolve) => {
      exec(spec.command, { cwd: spec.workdir }, (error, stdout, stderr) => {
        const timedOut = error !== null && error.killed === true
        const exitCode = error === null ? 0 : (Number.isInteger(error.code) ? error.code : (timedOut ? 124 : 1))
        resolve({ stdout, stderr, exitCode, timedOut })
      })
    })
    return {
      async result() {
        return {
          exitCode: outcome.exitCode,
          signal: null,
          timedOut: outcome.timedOut,
          timeoutMs: spec.timeoutMs,
          stdout: { text: outcome.stdout, truncated: false },
          stderr: { text: outcome.stderr, truncated: false },
          sandbox: { mode: 'workspace-write', denied: false },
        }
      },
    }
  },
}

const build = ({ sandboxMode, shell, getConfig } = {}) => {
  const store = new WorkStore({ stateDir: dir })
  const approval = {
    async request() { return 'allowed-once' },
  }
  const services = { workspaceRegistry: workspaceRegistry(), approval }
  if (sandboxMode !== undefined) services.sandboxPolicy = { resolve: () => ({ mode: sandboxMode, workspaceRoot: projectDir }) }
  if (shell !== undefined) services.shell = shell
  const options = getConfig === undefined ? { role: 'manager', ctx: createFakeContext({ services }).ctx, store } : { role: 'manager', ctx: createFakeContext({ services }).ctx, store, getConfig }
  const ctx = options.ctx
  const manager = createSuperbotTools(options)
  const verifier = createSuperbotTools({ ...options, role: 'verifier' })
  const byName = (tools, name) => tools.find((tool) => tool.name === name)
  return { store, ctx, manager, verifier, byName }
}

/** Seed: requirement → plan with one task → claimed by a worker → worker report. */
const seedTask = (env, { commands = [{ command: 'node --test' }], tags } = {}) => {
  const requirement = env.byName(env.manager, 'superbot_requirement_submit').execute({ text: '修复 add 函数', projectId: 'ws-1', priority: 'high' })
  const plan = env.byName(env.manager, 'superbot_plan_create').execute({
    requirementId: requirement.requirement.id,
    tasks: [{
      title: '修复 add',
      projectId: 'ws-1',
      priority: 'high',
      acceptance: ['node --test 通过'],
      acceptanceCommands: commands,
      risk: tags === undefined ? 'low' : 'high',
      reversible: tags === undefined,
      ...(tags === undefined ? {} : { tags }),
    }],
  })
  const taskId = plan.plan.taskIds[0]
  // Real worker attempt: the owner is a worker RUN, never a model-typed string.
  const baseline = fingerprintWorkspace(projectDir)
  const workerRun = env.store.startRun({
    taskId, agentPreset: 'superbot-worker', workspaceId: 'ws-1', label: 'work', workspacePath: projectDir,
    baselineWorkspaceDigest: baseline.digest, baselineProtectedDigest: baseline.protectedDigest, actor: 'manager',
  })
  env.store.bindRun(workerRun.runId, { childId: `child-${workerRun.runId}` })
  env.byName(env.manager, 'superbot_task_claim').execute({ id: taskId, owner: workerRun.runId })
  env.byName(env.manager, 'superbot_task_report').execute({ taskId, runId: workerRun.runId, author: workerRun.runId, summary: '改好了', evidence: ['node --test: pass'] })
  env.store.finishRun(workerRun.runId, { status: 'succeeded', summary: 'done', actor: 'manager' })
  const run = env.store.startRun({ taskId, agentPreset: 'superbot-verifier', workspaceId: 'ws-1', label: 'verify', workspacePath: projectDir, actor: 'manager' })
  const childId = `child-${run.runId}`
  env.store.bindRun(run.runId, { childId })
  env.exec = { agent: { id: childId }, signal: undefined }
  env.childId = childId
  return { taskId, runId: run.runId, childId, exec: env.exec, workerRunId: workerRun.runId }
}

describe('review isolation: who may produce evidence', () => {
  it('records evidence only for a live verifier run, and only for declared commands', async () => {
    const env = build()
    const { taskId, runId } = seedTask(env)

    const ran = await env.byName(env.verifier, 'superbot_acceptance_run').execute({ taskId, index: 0 }, env.exec)
    assert.equal(ran.passed, true)
    assert.equal(ran.evidence.runId, runId)
    assert.equal(ran.evidence.command, 'node --test')
    assert.equal(ran.evidence.projectId, 'ws-1')
    assert.ok(ran.evidence.outputDigest.startsWith('sha256:'))

    // Out-of-range index, wrong run kind and a worker run are all refused.
    assert.throws(() => env.store.recordEvidence({
      taskId, runId, index: 3, command: 'true', exitCode: 0,
    }), /no acceptance command at index 3/)
    const workerRun = env.store.startRun({ taskId, agentPreset: 'superbot-worker', workspaceId: 'ws-1', actor: 'manager' })
    assert.throws(() => env.store.recordEvidence({
      taskId, runId: workerRun.runId, index: 0, command: 'node --test', exitCode: 0,
    }), /not a verifier run/)
    // The command is taken from the ledger; a different command is rejected.
    assert.throws(() => env.store.recordEvidence({
      taskId, runId, index: 0, command: 'rm -rf /', exitCode: 0,
    }), /does not match the declared acceptance command/)
  })

  it('a verifier cannot pass from prose: pass requires evidenceIds for every command', async () => {
    const env = build()
    const { taskId, runId } = seedTask(env, {
      commands: [{ command: 'node --test' }, { command: 'node --test' }],
    })
    const first = await env.byName(env.verifier, 'superbot_acceptance_run').execute({ taskId, index: 0 }, env.exec)

    // No evidenceIds → refused.
    assert.throws(() => env.byName(env.verifier, 'superbot_review_submit').execute({ taskId, verdict: 'pass', notes: 'looks fine' }, env.exec), /evidenceIds/)
    // Covering only one of two commands → refused with the missing index.
    assert.throws(
      () => env.byName(env.verifier, 'superbot_review_submit').execute({ taskId, verdict: 'pass', evidenceIds: [first.evidence.evidenceId] }, env.exec),
      /missing\/failed: 1:/,
    )

    const second = await env.byName(env.verifier, 'superbot_acceptance_run').execute({ taskId, index: 1 }, env.exec)
    const review = env.byName(env.verifier, 'superbot_review_submit').execute({
      taskId, verdict: 'pass', evidenceIds: [first.evidence.evidenceId, second.evidence.evidenceId],
    }, env.exec)
    assert.equal(review.review.source, 'verifier')
    assert.equal(review.review.reviewerRole, 'verifier')
    assert.equal(review.review.runId, runId)
    assert.deepEqual(review.review.evidenceIds.sort(), [first.evidence.evidenceId, second.evidence.evidenceId].sort())

    // A review may not re-use evidence recorded by another verifier run.
    const otherRun = env.store.startRun({ taskId, agentPreset: 'superbot-verifier', workspaceId: 'ws-1', actor: 'manager' })
    assert.throws(
      () => env.store.submitReview({ taskId, reviewer: 'verifier:x', runId: otherRun.runId, verdict: 'pass', source: 'verifier', evidenceIds: [first.evidence.evidenceId] }),
      /was produced by run/,
    )
  })

  it('a failing declared command can never become passing evidence', async () => {
    const env = build()
    writeFileSync(join(projectDir, 'failing.test.js'), "import { test } from 'node:test'\ntest('fails', () => { throw new Error('boom') })\n")
    const { taskId, runId } = seedTask(env, { commands: [{ command: 'node --test' }] })
    const ran = await env.byName(env.verifier, 'superbot_acceptance_run').execute({ taskId, index: 0 }, env.exec)
    assert.equal(ran.passed, false)
    assert.notEqual(ran.evidence.exitCode, 0)
    assert.throws(
      () => env.byName(env.verifier, 'superbot_review_submit').execute({ taskId, verdict: 'pass', evidenceIds: [ran.evidence.evidenceId] }, env.exec),
      /missing\/failed/,
    )
  })
})

describe('review isolation: acceptance', () => {
  it('policy refuses without verifier evidence and stays in_review for a human', () => {
    const env = build()
    const { taskId } = seedTask(env)
    const evaluated = env.byName(env.manager, 'superbot_task_review').execute({ id: taskId })
    assert.equal(evaluated.status, 'in_review')
    assert.equal(evaluated.waitingForHuman, true)
    assert.equal(evaluated.evidenceComplete, false)
    assert.ok(evaluated.blocking.includes('verification-not-passed'))
    assert.equal(env.store.getTask(taskId).acceptedBy, undefined)
  })

  it('auto-accepts only after verifier pass + complete evidence, attributing policy to the manager', async () => {
    const env = build()
    const { taskId, runId, workerRunId } = seedTask(env)
    await env.byName(env.verifier, 'superbot_acceptance_run').execute({ taskId, index: 0 }, env.exec)
    const evidence = env.store.listEvidence({ taskId })
    env.byName(env.verifier, 'superbot_review_submit').execute({ taskId, verdict: 'pass', evidenceIds: [evidence[0].evidenceId] }, env.exec)

    const done = env.byName(env.manager, 'superbot_task_review').execute({ id: taskId })
    assert.equal(done.status, 'done')
    assert.equal(done.acceptedBy, 'policy')
    assert.equal(done.verifierReviewId.length > 0, true)

    const policyReview = env.store.listReviews({ taskId }).find((review) => review.source === 'policy')
    assert.equal(policyReview.reviewerRole, 'manager')
    assert.equal(policyReview.reviewedOwner, workerRunId, 'owner is the reviewed party (worker run), never the reviewer')
    assert.equal(policyReview.decision.mode, 'auto')
    assert.equal(policyReview.reviewer, 'policy')
  })

  it('never auto-accepts when the task owner is not a real worker run', async () => {
    const env = build()
    const requirement = env.byName(env.manager, 'superbot_requirement_submit').execute({ text: 'x', projectId: 'ws-1' })
    const plan = env.byName(env.manager, 'superbot_plan_create').execute({
      requirementId: requirement.requirement.id,
      tasks: [{ title: 'no worker', projectId: 'ws-1', priority: 'normal', acceptance: ['ok'], acceptanceCommands: [{ command: 'node --test' }], risk: 'low', reversible: true }],
    })
    const taskId = plan.plan.taskIds[0]
    // Manager-typed owner string: no worker run exists for this task.
    env.store.claimTask(taskId, { owner: 'manager-self' })
    const verifierRun = env.store.startRun({ taskId, agentPreset: 'superbot-verifier', workspaceId: 'ws-1', label: 'verify' })
    env.store.bindRun(verifierRun.runId, { childId: 'child-no-worker' })
    const exec = { agent: { id: 'child-no-worker' } }
    const ran = await env.byName(env.verifier, 'superbot_acceptance_run').execute({ taskId, index: 0 }, exec)
    env.byName(env.verifier, 'superbot_review_submit').execute({ taskId, verdict: 'pass', evidenceIds: [ran.evidence.evidenceId] }, exec)
    const evaluated = env.byName(env.manager, 'superbot_task_review').execute({ id: taskId })
    assert.equal(evaluated.status, 'in_review')
    assert.equal(evaluated.waitingForHuman, true)
    assert.ok(evaluated.blocking.includes('no-worker-attempt'))
  })

  it('lets the append sequence, not reviewId strings, decide the latest verdict', () => {
    const env = build()
    const { taskId } = seedTask(env)
    const same = '2026-11-06T12:00:00.000Z'
    env.store.submitReview({ taskId, reviewer: 'policy', reviewerRole: 'manager', verdict: 'pass', source: 'policy', at: same })
    env.store.submitReview({ taskId, reviewer: 'policy', reviewerRole: 'manager', verdict: 'fail', source: 'policy', at: same })
    const reviews = env.store.listReviews({ taskId }).filter((review) => review.source === 'policy')
    assert.equal(reviews.at(-1).verdict, 'fail')
    assert.ok(Number.isInteger(reviews.at(-1).seq))
  })

  it('runs acceptance through the host shell when available and marks it sandboxed', async () => {
    const env = build({ shell: fakeShell, sandboxMode: 'workspace-write' })
    const { taskId } = seedTask(env)
    const ran = await env.byName(env.verifier, 'superbot_acceptance_run').execute({ taskId, index: 0 }, env.exec)
    assert.equal(ran.evidence.executionMode, 'host-shell')
    assert.equal(ran.evidence.sandboxed, true)
    assert.equal(ran.evidence.sandboxMode, 'workspace-write')
  })

  it('policy auto-accepts sandboxed evidence when requireSandboxedEvidence is on', async () => {
    const env = build({ shell: fakeShell, sandboxMode: 'workspace-write', getConfig: () => ({ requireSandboxedEvidence: true }) })
    const { taskId } = seedTask(env)
    const ran = await env.byName(env.verifier, 'superbot_acceptance_run').execute({ taskId, index: 0 }, env.exec)
    env.byName(env.verifier, 'superbot_review_submit').execute({ taskId, verdict: 'pass', evidenceIds: [ran.evidence.evidenceId] }, env.exec)
    const done = env.byName(env.manager, 'superbot_task_review').execute({ id: taskId })
    assert.equal(done.status, 'done')
    assert.equal(done.acceptedBy, 'policy')
  })

  it('runs acceptance in a one-time copy so project code cannot write the live tree', async () => {
    const env = build({ shell: fakeShell, sandboxMode: 'workspace-write' })
    writeFileSync(join(projectDir, 'isolation.test.js'), [
      "const { test } = require('node:test')",
      "const { writeFileSync } = require('node:fs')",
      "test('writes inside its cwd', () => { writeFileSync('sentinel.txt', 'x') })",
    ].join('\n'))
    const { taskId } = seedTask(env)
    const ran = await env.byName(env.verifier, 'superbot_acceptance_run').execute({ taskId, index: 0 }, env.exec)
    assert.equal(ran.passed, true)
    assert.equal(ran.evidence.isolationMode, 'copy')
    assert.equal(existsSync(join(projectDir, 'sentinel.txt')), false, 'live project must not receive copy writes')
  })

  it('forces a human when policy requires sandboxed evidence but execution was unsandboxed', async () => {
    const env = build({ getConfig: () => ({ requireSandboxedEvidence: true }) })
    const { taskId } = seedTask(env)
    const ran = await env.byName(env.verifier, 'superbot_acceptance_run').execute({ taskId, index: 0 }, env.exec)
    assert.equal(ran.evidence.executionMode, 'direct-exec')
    assert.equal(ran.evidence.sandboxed, false)
    env.byName(env.verifier, 'superbot_review_submit').execute({ taskId, verdict: 'pass', evidenceIds: [ran.evidence.evidenceId] }, env.exec)
    const evaluated = env.byName(env.manager, 'superbot_task_review').execute({ id: taskId })
    assert.equal(evaluated.status, 'in_review')
    assert.equal(evaluated.waitingForHuman, true)
    assert.ok(evaluated.blocking.includes('unsandboxed-evidence'))
  })

  it('human-required tags still wait for a human even with perfect evidence', async () => {
    const env = build()
    const { taskId, runId } = seedTask(env, { tags: ['aesthetic'] })
    await env.byName(env.verifier, 'superbot_acceptance_run').execute({ taskId, index: 0 }, env.exec)
    const evidence = env.store.listEvidence({ taskId })
    env.byName(env.verifier, 'superbot_review_submit').execute({ taskId, verdict: 'pass', evidenceIds: [evidence[0].evidenceId] }, env.exec)
    const evaluated = env.byName(env.manager, 'superbot_task_review').execute({ id: taskId })
    assert.equal(evaluated.status, 'in_review')
    assert.equal(evaluated.waitingForHuman, true)
    assert.ok(evaluated.blocking.includes('tag:aesthetic'))

    // Agent-callable acceptance goes through the host approval dialog: with an
    // approval service that rejects, the task must stay in_review.
    const rejectedCtx = createFakeContext({ services: { workspaceRegistry: workspaceRegistry(), approval: { async request() { return 'rejected' } } } }).ctx
    const rejectedManager = createSuperbotTools({ role: 'manager', ctx: rejectedCtx, store: env.store })
    const denied = await rejectedManager.find((tool) => tool.name === 'superbot_task_accept').execute({ id: taskId }, { agent: { id: 'manager-session' } })
    assert.equal(denied.accepted, false)
    assert.equal(env.store.getTask(taskId).status, 'in_review')
    // The verifier/worker cannot ask at all.
    for (const tools of [env.verifier]) {
      assert.equal(tools.some((tool) => tool.name === 'superbot_task_accept'), false)
    }
    const accepted = env.store.acceptTaskByHuman(taskId, { note: '审美通过' })
    assert.equal(accepted.task.status, 'done')
    assert.equal(accepted.task.acceptedBy, 'human')
    assert.equal(accepted.review.reviewerRole, 'human')
    assert.equal(accepted.review.source, 'human')
  })

  it('human acceptance is only possible from in_review', () => {
    const env = build()
    env.store.submitTask({ id: 't-draft', title: 'd', projectId: 'ws-1', priority: 'normal', acceptance: ['x'] })
    assert.throws(() => env.store.acceptTaskByHuman('t-draft'), /is draft/)
  })

  it('ignores manager attempts to downgrade the task at acceptance time', async () => {
    const env = build()
    const { taskId, workerRunId } = seedTask(env, { tags: ['aesthetic'] })
    const runInfo = { exec: env.exec, runId: env.store.listRuns({ taskId }).at(-1).runId }
    await env.byName(env.verifier, 'superbot_acceptance_run').execute({ taskId, index: 0 }, runInfo.exec)
    const evidence = env.store.listEvidence({ taskId })
    env.byName(env.verifier, 'superbot_review_submit').execute({ taskId, verdict: 'pass', evidenceIds: [evidence[0].evidenceId] }, runInfo.exec)
    // Old API accepted risk/tags overrides; the tool now has no such parameters,
    // and extra arguments must not change the ledger-derived decision.
    const evaluated = env.byName(env.manager, 'superbot_task_review').execute({ id: taskId, risk: 'low', tags: [], reversible: true })
    assert.equal(evaluated.status, 'in_review')
    assert.ok(evaluated.blocking.includes('tag:aesthetic'))
    assert.ok(evaluated.blocking.includes('irreversible'))
  })

  it('forces human acceptance when the verifier ran under danger-full-access', async () => {
    const env = build({ sandboxMode: 'danger-full-access' })
    const { taskId } = seedTask(env)
    const ran = await env.byName(env.verifier, 'superbot_acceptance_run').execute({ taskId, index: 0 }, env.exec)
    assert.equal(ran.evidence.sandboxMode, 'danger-full-access')
    const evidenceId = env.store.listEvidence({ taskId })[0].evidenceId
    env.byName(env.verifier, 'superbot_review_submit').execute({ taskId, verdict: 'pass', evidenceIds: [evidenceId] }, env.exec)
    const evaluated = env.byName(env.manager, 'superbot_task_review').execute({ id: taskId })
    assert.equal(evaluated.status, 'in_review')
    assert.equal(evaluated.waitingForHuman, true)
    assert.ok(evaluated.blocking.includes('verifier-sandbox-full-access'))
    assert.ok(evaluated.blocking.includes('manager-sandbox-full-access'))
    const policyReview = env.store.listReviews({ taskId }).find((review) => review.source === 'policy')
    assert.equal(policyReview.decision.mode, 'human')
  })

  it('rejects non-zero expected exit codes and shell chaining in declared commands', () => {
    const env = build()
    const requirement = env.byName(env.manager, 'superbot_requirement_submit').execute({ text: 'x', projectId: 'ws-1' })
    const plan = (acceptanceCommands) => env.byName(env.manager, 'superbot_plan_create').execute({
      requirementId: requirement.requirement.id,
      tasks: [{ title: 'bad', projectId: 'ws-1', priority: 'normal', acceptance: ['x'], acceptanceCommands }],
    })
    assert.throws(() => plan([{ command: 'node --test', expectExitCode: 1 }]), /must be 0/)
    assert.throws(() => plan([{ command: 'node --test; rm -rf /' }]), /single command/)
    assert.throws(() => plan([{ command: 'node --test && echo ok' }]), /single command/)
    assert.throws(() => plan([{ command: 'echo $(whoami)' }]), /single command/)
  })

  it('rejects acceptance commands outside the standard test allowlist', () => {
    const env = build()
    const requirement = env.byName(env.manager, 'superbot_requirement_submit').execute({ text: 'x', projectId: 'ws-1' })
    const plan = (acceptanceCommands) => env.byName(env.manager, 'superbot_plan_create').execute({
      requirementId: requirement.requirement.id,
      tasks: [{ title: 'bad', projectId: 'ws-1', priority: 'normal', acceptance: ['x'], acceptanceCommands }],
    })
    assert.throws(() => plan([{ command: 'node -e "process.exit(0)"' }]), /白名单/)
    assert.throws(() => plan([{ command: 'echo ok' }]), /白名单/)
    assert.throws(() => plan([{ command: 'rm -rf /' }]), /单条命令|白名单/)
    // Semantic bypass: flags that skip/select tests must be rejected even for
    // the standard runner (node --test --test-name-pattern can exit 0 with 0 runs).
    assert.throws(() => plan([{ command: 'node --test --test-name-pattern=NEVER_MATCH' }]), /白名单/)
    assert.throws(() => plan([{ command: 'cargo test --no-run' }]), /白名单/)
    assert.throws(() => plan([{ command: 'make check -n' }]), /白名单/)
  })

  it('cannot replay an old verifier run or hide a newer failing verdict', async () => {
    const env = build()
    const { taskId, exec } = seedTask(env)
    const first = await env.byName(env.verifier, 'superbot_acceptance_run').execute({ taskId, index: 0 }, exec)
    env.byName(env.verifier, 'superbot_review_submit').execute({ taskId, verdict: 'pass', evidenceIds: [first.evidence.evidenceId] }, exec)

    // A new verifier session cannot reuse the previous run's evidence.
    const runB = env.store.startRun({ taskId, agentPreset: 'superbot-verifier', workspaceId: 'ws-1', workspacePath: projectDir, actor: 'manager' })
    env.store.bindRun(runB.runId, { childId: 'child-B' })
    const execB = { agent: { id: 'child-B' } }
    assert.throws(
      () => env.byName(env.verifier, 'superbot_review_submit').execute({ taskId, verdict: 'pass', evidenceIds: [first.evidence.evidenceId] }, execB),
      /produced by run/,
    )
    env.byName(env.verifier, 'superbot_review_submit').execute({ taskId, verdict: 'fail', notes: 'regression' }, execB)

    // Latest verdict is fail → policy must not accept.
    const evaluated = env.byName(env.manager, 'superbot_task_review').execute({ id: taskId })
    assert.equal(evaluated.status, 'in_review')
    assert.ok(evaluated.blocking.includes('verification-not-passed'))
  })

  it('forces human acceptance when the workspace changed after evidence', async () => {
    const env = build()
    const { taskId, exec } = seedTask(env)
    await env.byName(env.verifier, 'superbot_acceptance_run').execute({ taskId, index: 0 }, exec)
    const evidence = env.store.listEvidence({ taskId })
    env.byName(env.verifier, 'superbot_review_submit').execute({ taskId, verdict: 'pass', evidenceIds: [evidence[0].evidenceId] }, exec)

    writeFileSync(join(projectDir, 'changed-after-evidence.txt'), 'x')
    const evaluated = env.byName(env.manager, 'superbot_task_review').execute({ id: taskId })
    assert.equal(evaluated.status, 'in_review')
    assert.ok(evaluated.blocking.includes('workspace-changed-since-evidence'))
  })

  it('detects acceptance-harness changes against the worker dispatch baseline', async () => {
    const env = build()
    const { taskId } = seedTask(env) // worker run captured the empty-harness baseline
    await env.byName(env.verifier, 'superbot_acceptance_run').execute({ taskId, index: 0 }, env.exec)
    const evidence = env.store.listEvidence({ taskId })
    env.byName(env.verifier, 'superbot_review_submit').execute({ taskId, verdict: 'pass', evidenceIds: [evidence[0].evidenceId] }, env.exec)
    // Worker (or anyone) rewrites the acceptance harness after evidence.
    writeFileSync(join(projectDir, 'tampered.test.js'), 'export const hacked = true\n')
    const evaluated = env.byName(env.manager, 'superbot_task_review').execute({ id: taskId })
    assert.equal(evaluated.status, 'in_review')
    assert.ok(evaluated.blocking.includes('acceptance-harness-changed'))
  })

  it('accepts by human through the host approval dialog, recording the via', async () => {
    const env = build()
    const { taskId, workerRunId } = seedTask(env, { tags: ['aesthetic'] })
    // Evaluation moves the task to in_review and leaves it for a human.
    const evaluated = env.byName(env.manager, 'superbot_task_review').execute({ id: taskId })
    assert.equal(evaluated.status, 'in_review')
    const accepted = await env.byName(env.manager, 'superbot_task_accept').execute({ id: taskId, note: '审美通过' }, { agent: { id: 'manager-session' } })
    assert.equal(accepted.accepted, true)
    assert.equal(accepted.task.acceptedBy, 'human')
    assert.equal(accepted.task.acceptanceVia, 'host-approval')
    assert.equal(accepted.review.reviewerRole, 'human')
  })

  it('rejects by human through the host approval dialog, moving the task back for rework', async () => {
    const env = build()
    const { taskId } = seedTask(env, { tags: ['aesthetic'] })
    const evaluated = env.byName(env.manager, 'superbot_task_review').execute({ id: taskId })
    assert.equal(evaluated.status, 'in_review')
    const rejected = await env.byName(env.manager, 'superbot_task_reject').execute({ id: taskId, note: '颜色不对' }, { agent: { id: 'manager-session' } })
    assert.equal(rejected.rejected, true)
    assert.equal(rejected.task.status, 'in_progress')
    const review = env.store.listReviews({ taskId }).at(-1)
    assert.equal(review.source, 'human')
    assert.equal(review.verdict, 'pending')
    assert.ok(review.decision.reasons.includes('human-reject'))
  })

  it('ignores a hand-forged task transition on reload', () => {
    const env = build()
    const { taskId } = seedTask(env)
    const before = env.store.getTask(taskId)
    appendRaw(workPaths(dir).events, JSON.stringify({
      schemaVersion: 1, seq: 999, kind: 'task/transition', at: new Date().toISOString(),
      actor: 'human', reason: 'forged', taskId,
      from: before.status, to: 'done',
      task: { ...before, status: 'done', version: before.version + 7 },
    }) + '\n')
    const reloaded = new WorkStore({ stateDir: dir })
    assert.notEqual(reloaded.getTask(taskId).status, 'done', 'forged snapshot must not fold')
  })
})
