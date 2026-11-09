import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { PRESET_IDS, TOOL_NAMES } from '../lib/roles.js'
import { createSuperbotTools } from '../lib/tools.js'
import { WorkStore } from '../lib/work-store.js'
import { createFakeContext } from './fake-context.js'

let dir
let projectOne
let projectTwo

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'superbot-dispatch-plan-'))
  projectOne = mkdtempSync(join(tmpdir(), 'superbot-project-one-'))
  projectTwo = mkdtempSync(join(tmpdir(), 'superbot-project-two-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(projectOne, { recursive: true, force: true })
  rmSync(projectTwo, { recursive: true, force: true })
})

const workspaceRegistry = () => ({
  list: () => [
    { id: 'ws-1', path: projectOne, title: 'project one', sessionIds: [], updatedAt: new Date().toISOString() },
    { id: 'ws-2', path: projectTwo, title: 'project two', sessionIds: [], updatedAt: new Date().toISOString() },
  ],
})

const exec = () => ({ agent: { id: 'agent-1', ctx: {} }, signal: undefined })

/** Fake host: records activations and settles immediately. */
function fakeHost({ preset = PRESET_IDS.manager } = {}) {
  const capture = []
  const subagents = {
    async startActivation(spec) {
      capture.push(spec)
      return {
        childId: `child-${capture.length}`,
        result: Promise.resolve({ output: [{ type: 'text', text: `result-${capture.length}` }], stopReason: 'completed' }),
      }
    },
  }
  const agentPresets = { composedPreset: () => preset }
  const fake = createFakeContext({ services: { subagents, agentPresets, workspaceRegistry: workspaceRegistry() } })
  return { fake, capture, subagents, ctx: fake.ctx }
}

function managerTools(workStore, ctx, getConfig = () => ({ requireOnboarding: false })) {
  const tools = createSuperbotTools({ role: 'manager', ctx, store: workStore, getConfig })
  return { tools, byName: (name) => tools.find((tool) => tool.name === name) }
}

const taskRow = (id, overrides = {}) => ({
  id,
  title: `task ${id}`,
  projectId: 'ws-1',
  priority: 'normal',
  acceptance: [`${id} acceptance passes`],
  ...overrides,
})

function seedPlan(workStore, tasks) {
  const requirement = workStore.submitRequirement({ projectId: 'ws-1', title: '需求', text: '把功能做出来' })
  return workStore.createPlan({ requirementId: requirement.id, title: 'plan', tasks })
}

function finishRuns(workStore, taskId) {
  for (const run of workStore.listRuns({ taskId })) {
    if (run.status === 'running') workStore.finishRun(run.runId, { status: 'succeeded', summary: 'collected' })
  }
}

function completeTask(workStore, taskId) {
  finishRuns(workStore, taskId)
  const task = workStore.getTask(taskId)
  if (task.status === 'todo') workStore.claimTask(taskId, { owner: 'sim-worker' })
  if (workStore.getTask(taskId).status === 'in_progress') {
    workStore.transitionTask(taskId, 'in_review', { actor: 'sim-worker', reason: 'submit-for-review' })
  }
  workStore.transitionTask(taskId, 'done', { actor: 'human', reason: 'accepted' })
}

const briefText = (activation) => activation.request.prompt.map((block) => block.text).join('\n')

describe('task-bound worker dispatch', () => {
  it('binds the run to a planned task and generates a self-contained brief', async () => {
    const workStore = new WorkStore({ stateDir: dir })
    const { plan } = seedPlan(workStore, [taskRow('t1'), taskRow('t2', { deps: ['t1'] })])
    const { capture, ctx } = fakeHost()
    const { byName } = managerTools(workStore, ctx)

    const result = await byName(TOOL_NAMES.dispatchWorker).execute({ taskId: 't1' }, exec())
    assert.equal(capture.length, 1)
    assert.equal(result.taskId, 't1')
    assert.equal(result.agentPreset, PRESET_IDS.worker)
    assert.equal(result.workspaceId, 'ws-1')
    assert.equal(result.cwd, projectOne)

    const activation = capture[0]
    assert.equal(activation.request.agentPreset, PRESET_IDS.worker)
    assert.equal(activation.request.cwd, projectOne)
    // only the explicit child request fields; the manager conversation is not forwarded
    assert.deepEqual(Object.keys(activation.request).sort(), ['agentPreset', 'cwd', 'parent', 'prompt'])

    const brief = briefText(activation)
    for (const expected of [
      '任务 t1', 'task t1', 't1 acceptance passes',
      'workspaceId: ws-1', projectOne,
      '你看不到 manager 的会话',
      'superbot_task_claim', 'superbot_task_report',
    ]) {
      assert.ok(brief.includes(expected), `brief must include ${expected}`)
    }
    assert.ok(brief.includes('## 5. 依赖'))
    assert.ok(brief.includes('- 无'), 'a task without deps says so explicitly')

    const run = workStore.getRun(result.runId)
    assert.equal(run.taskId, 't1')
    assert.equal(run.workspaceId, 'ws-1')
    assert.equal(run.agentPreset, PRESET_IDS.worker)
    assert.equal(run.status, 'running', 'wait:false leaves the run open for later collection')
    assert.deepEqual(workStore.listRuns({ taskId: 't1' }).map((row) => row.taskId), ['t1'])
    assert.deepEqual(workStore.getPlan(plan.id).taskIds, ['t1', 't2'])
  })

  it('includes dep ids/statuses and the extra manager note in the task brief', async () => {
    const workStore = new WorkStore({ stateDir: dir })
    workStore.submitTask({ id: 't-done', title: 'prereq task', projectId: 'ws-1', priority: 'normal', acceptance: ['ok'] })
    workStore.planTask('t-done')
    completeTask(workStore, 't-done')
    seedPlan(workStore, [taskRow('t-next', { deps: ['t-done'] })])
    const { capture, ctx } = fakeHost()
    const { byName } = managerTools(workStore, ctx)
    await byName(TOOL_NAMES.dispatchWorker).execute({ taskId: 't-next', prompt: '只改 lib/planning-tools.js' }, exec())
    const brief = briefText(capture[0])
    assert.ok(brief.includes('t-done (done): prereq task'))
    assert.ok(brief.includes('只改 lib/planning-tools.js'))
  })

  it('rejects dispatch of unplanned, unknown or mismatched tasks and duplicate runs', async () => {
    const workStore = new WorkStore({ stateDir: dir })
    workStore.submitTask({ id: 't-draft', title: 'draft task', projectId: 'ws-1', priority: 'normal', acceptance: ['x'] })
    const { plan } = seedPlan(workStore, [
      taskRow('t1', { projectId: 'ws-2', title: 'other project' }),
      taskRow('t2', { projectId: 'ws-2' }),
    ])
    const { ctx } = fakeHost()
    const { byName } = managerTools(workStore, ctx)
    const dispatchWorker = byName(TOOL_NAMES.dispatchWorker)

    await assert.rejects(dispatchWorker.execute({ taskId: 't-draft' }, exec()), /planned \(todo\) task/)
    await assert.rejects(dispatchWorker.execute({ taskId: 't-nope' }, exec()), /unknown task/)
    await assert.rejects(dispatchWorker.execute({ taskId: 't1', workspaceId: 'ws-1' }, exec()), /belongs to project ws-2/)
    await assert.rejects(dispatchWorker.execute({}, exec()), /prompt is required/)

    await dispatchWorker.execute({ taskId: 't1' }, exec())
    await assert.rejects(dispatchWorker.execute({ taskId: 't1' }, exec()), /already has an unfinished run/)
    // the guard is released when the run is collected, then dispatch is possible again
    finishRuns(workStore, 't1')
    const second = await dispatchWorker.execute({ taskId: 't1' }, exec())
    assert.equal(workStore.listRuns({ taskId: 't1' }).length, 2)
    assert.equal(second.taskId, 't1')
    assert.equal(workStore.getPlan(plan.id).taskIds.length, 2)

    // a previously completed task is no longer todo -> not dispatchable again
    completeTask(workStore, 't1')
    await assert.rejects(dispatchWorker.execute({ taskId: 't1' }, exec()), /planned \(todo\) task/)
  })

  it('dispatches a verifier bound to a task without requiring todo', async () => {
    const workStore = new WorkStore({ stateDir: dir })
    workStore.submitTask({ id: 't-rev', title: 'review me', projectId: 'ws-1', priority: 'normal', acceptance: ['ok'] })
    workStore.planTask('t-rev')
    const workerRun = workStore.startRun({ taskId: 't-rev', agentPreset: PRESET_IDS.worker, workspaceId: 'ws-1', label: 'work:t-rev', workspacePath: projectOne, actor: "manager" })
    workStore.bindRun(workerRun.runId, { childId: 'child-worker-t-rev' })
    workStore.claimTask('t-rev', { owner: workerRun.runId })
    workStore.finishRun(workerRun.runId, { status: 'succeeded', summary: 'done', actor: 'manager' })
    workStore.transitionTask('t-rev', 'in_review', { actor: 'manager' })
    const { capture, ctx } = fakeHost()
    const { byName } = managerTools(workStore, ctx)

    const result = await byName(TOOL_NAMES.dispatchVerifier).execute({ taskId: 't-rev' }, exec())
    const brief = briefText(capture[0])
    assert.equal(capture[0].request.agentPreset, PRESET_IDS.verifier)
    assert.equal(result.status, 'succeeded')
    assert.ok(brief.includes('superbot_review_submit'))
    assert.ok(brief.includes('只读验收'))
    assert.ok(workStore.listRuns({ taskId: 't-rev' }).some((run) => run.agentPreset === PRESET_IDS.verifier))
  })
})

describe('failure rework loop', () => {
  const failedTask = (workStore) => {
    const { plan } = seedPlan(workStore, [taskRow('t-rw')])
    const taskId = plan.taskIds[0]
    const workerRun = workStore.startRun({ taskId, agentPreset: PRESET_IDS.worker, workspaceId: 'ws-1', label: 'work:t-rw', workspacePath: projectOne, actor: 'manager' })
    workStore.bindRun(workerRun.runId, { childId: 'child-work-rw' })
    workStore.claimTask(taskId, { owner: workerRun.runId })
    workStore.finishRun(workerRun.runId, { status: 'succeeded', summary: 'attempt 1', actor: 'manager' })
    workStore.transitionTask(taskId, 'in_review', { actor: 'manager', reason: 'submit' })
    const verifierRun = workStore.startRun({ taskId, agentPreset: PRESET_IDS.verifier, workspaceId: 'ws-1', label: 'verify:t-rw', workspacePath: projectOne, actor: 'manager' })
    workStore.bindRun(verifierRun.runId, { childId: 'child-verify-rw' })
    workStore.finishRun(verifierRun.runId, { status: 'succeeded', summary: 'fail', actor: 'manager' })
    workStore.submitReview({ taskId, reviewer: 'verifier:x', reviewerRole: 'verifier', verdict: 'fail', source: 'verifier', runId: verifierRun.runId, notes: '测试失败：add 返回 NaN', reviewedOwner: workerRun.runId })
    return { taskId, workerRun }
  }

  it('requeues a failed task and embeds the verifier evidence in the new brief', async () => {
    const workStore = new WorkStore({ stateDir: dir })
    const { taskId, workerRun } = failedTask(workStore)
    const { capture, ctx } = fakeHost()
    const { byName } = managerTools(workStore, ctx)
    const result = await byName(TOOL_NAMES.taskRework).execute({ id: taskId, note: '注意边界情况' }, exec())
    assert.ok(typeof result.runId === 'string' && result.runId.startsWith('r-'))
    assert.equal(workStore.getTask(taskId).status, 'todo')
    const brief = briefText(capture[0])
    assert.match(brief, /返工说明/)
    assert.match(brief, /测试失败：add 返回 NaN/)
    assert.match(brief, /注意边界情况/)
    const workerRuns = workStore.listRuns({ taskId }).filter((run) => run.agentPreset === PRESET_IDS.worker)
    assert.equal(workerRuns.length, 2, 'a new worker attempt is recorded, the old one is kept')
    assert.equal(workStore.getTask(taskId).owner ?? null, null, 'rework must clear the old owner so the next worker can claim')
    const newOwner = workStore.claimTask(taskId, { owner: 'worker-next' })
    assert.equal(newOwner.status, 'in_progress')
  })

  it('refuses rework when the latest verifier verdict is not fail', async () => {
    const workStore = new WorkStore({ stateDir: dir })
    const { plan } = seedPlan(workStore, [taskRow('t-rw-ok')])
    const taskId = plan.taskIds[0]
    const workerRun = workStore.startRun({ taskId, agentPreset: PRESET_IDS.worker, workspaceId: 'ws-1', workspacePath: projectOne, actor: 'manager' })
    workStore.bindRun(workerRun.runId, { childId: 'child-ok' })
    workStore.claimTask(taskId, { owner: workerRun.runId })
    workStore.finishRun(workerRun.runId, { status: 'succeeded', summary: 'done', actor: 'manager' })
    workStore.transitionTask(taskId, 'in_review', { actor: 'manager', reason: 'submit' })
    const { ctx } = fakeHost()
    const { byName } = managerTools(workStore, ctx)
    await assert.rejects(byName(TOOL_NAMES.taskRework).execute({ id: taskId }, exec()), /no latest verifier fail/)
  })
})

describe('dispatch safety gates', () => {
  it('blocks dispatch into a project the user marked paused/archived', async () => {
    const workStore = new WorkStore({ stateDir: dir })
    const { plan } = seedPlan(workStore, [taskRow('t-paused')])
    workStore.confirmInventory({ projects: [
      { projectId: 'ws-1', status: 'paused' },
      { projectId: 'ws-2', status: 'active' },
    ] })
    const { ctx } = fakeHost()
    const tools = managerTools(workStore, ctx).tools
    const byName = (name) => tools.find((tool) => tool.name === name)
    const result = await byName(TOOL_NAMES.planDispatch).execute({ planId: plan.id }, exec())
    assert.equal(result.dispatched.length, 0)
    assert.ok(result.skipped.some((row) => row.reason === 'project-paused'), JSON.stringify(result.skipped))
    assert.deepEqual(workStore.listRuns({ taskId: plan.taskIds[0] }), [])
  })

  it('refuses a workspace that contains the ledger stateDir (D3)', async () => {
    const ledgerHome = mkdtempSync(join(tmpdir(), 'superbot-inside-'))
    const stateDir = join(ledgerHome, 'home', 'storages', 'dsh-superbot')
    const workStore = new WorkStore({ stateDir })
    workStore.confirmInventory({ projects: [{ projectId: 'ws-1', status: 'active' }] })
    const { ctx } = fakeHost()
    const tools = createSuperbotTools({ role: 'manager', ctx, store: workStore, getConfig: () => ({ requireOnboarding: false }) })
    const byName = (name) => tools.find((tool) => tool.name === name)
    // A workspace whose path is an ancestor of the ledger state dir.
    const registry = { list: () => [{ id: 'ws-1', path: ledgerHome, title: 'home', sessionIds: [] }] }
    const fake = createFakeContext({ services: { workspaceRegistry: registry, agentPresets: { composedPreset: () => PRESET_IDS.manager }, subagents: { startActivation: async () => ({ childId: 'child-x' }) } } })
    const scoped = createSuperbotTools({ role: 'manager', ctx: fake.ctx, store: workStore, getConfig: () => ({ requireOnboarding: false }) })
    const tool = scoped.find((entry) => entry.name === TOOL_NAMES.dispatchWorker)
    const requirement = workStore.submitRequirement({ projectId: 'ws-1', title: 'r', text: 'x' })
    const planRow = workStore.createPlan({ requirementId: requirement.id, tasks: [taskRow('t-d3')] })
    await assert.rejects(tool.execute({ taskId: planRow.plan.taskIds[0] }, exec()), /ledger|D3/i)
    rmSync(ledgerHome, { recursive: true, force: true })
  })
})

describe('first-run onboarding gate', () => {
  it('refuses dispatch until the user confirmed the inventory', async () => {
    const workStore = new WorkStore({ stateDir: dir })
    const { plan } = seedPlan(workStore, [taskRow('t-gate')])
    const { ctx } = fakeHost()
    const strict = createSuperbotTools({ role: 'manager', ctx, store: workStore })
    const planDispatch = strict.find((tool) => tool.name === TOOL_NAMES.planDispatch)
    const blocked = await planDispatch.execute({ planId: plan.id }, exec())
    assert.deepEqual(blocked.dispatched, [])
    assert.ok(blocked.failed.some((row) => /首次接入尚未确认盘点/.test(row.error)), 'the gate reason must be reported per task')
    assert.equal(workStore.listRuns().length, 0, 'no run may be started before confirmation')

    workStore.confirmInventory({ projects: [{ projectId: 'ws-1', status: 'active' }], via: 'http' })
    const allowed = await planDispatch.execute({ planId: plan.id }, exec())
    assert.equal(allowed.dispatched.length, 1)
  })
})

describe('plan dispatch readiness', () => {
  it('dispatches one ready task by default and explains every skip', async () => {
    const workStore = new WorkStore({ stateDir: dir })
    const { plan } = seedPlan(workStore, [
      taskRow('t1', { priority: 'high', title: 'first' }),
      taskRow('t2', { deps: ['t1'], title: 'after first' }),
      taskRow('t3', { projectId: 'ws-2', priority: 'low', title: 'parallel elsewhere' }),
      taskRow('t4', { deps: ['t1'], title: 'after first too' }),
    ])
    const { capture, ctx } = fakeHost()
    const { byName } = managerTools(workStore, ctx)
    const planDispatch = byName(TOOL_NAMES.planDispatch)

    const first = await planDispatch.execute({ planId: plan.id }, exec())
    assert.deepEqual(first.dispatched.map((row) => row.taskId), ['t1'])
    assert.deepEqual(first.ready, ['t1', 't3'])
    assert.deepEqual(first.skipped.filter((row) => row.reason === 'deps-pending').map((row) => row.taskId), ['t2', 't4'])
    assert.deepEqual(first.skipped.find((row) => row.taskId === 't3'), { taskId: 't3', reason: 'max-reached' })
    assert.equal(first.taskCount, 4)
    assert.equal(first.failed.length, 0)
    assert.equal(capture[0].request.agentPreset, PRESET_IDS.worker)

    // The active run blocks t1; t3 becomes the only ready task.
    const second = await planDispatch.execute({ planId: plan.id }, exec())
    assert.deepEqual(second.dispatched.map((row) => row.taskId), ['t3'])
    assert.deepEqual(second.skipped.find((row) => row.taskId === 't1'), { taskId: 't1', reason: 'run-active', runId: workStore.listRuns({ taskId: 't1' })[0].runId })

    // Close and finish everything, then t2/t4 become ready. They share project
    // ws-1, and the ledger enforces ONE active worker per project, so the second
    // task is deferred with `project-busy` instead of being dispatched in parallel.
    finishRuns(workStore, 't3')
    completeTask(workStore, 't1')
    const third = await planDispatch.execute({ planId: plan.id, max: 2 }, exec())
    assert.deepEqual(third.dispatched.map((row) => row.taskId).sort(), ['t2', 't3'])
    assert.deepEqual(third.skipped.filter((row) => row.reason === 'project-busy').map((row) => row.taskId), ['t4'])
    assert.deepEqual(third.failed, [])

    // Close the remaining runs and finish t2; t4 is then the only ready task.
    finishRuns(workStore, 't2')
    finishRuns(workStore, 't3')
    completeTask(workStore, 't2')
    completeTask(workStore, 't3')
    const fourth = await planDispatch.execute({ planId: plan.id, max: 2 }, exec())
    assert.deepEqual(fourth.dispatched.map((row) => row.taskId), ['t4'])
  })

  it('builds a professional, self-contained brief with scope, commands and report format', async () => {
    const workStore = new WorkStore({ stateDir: dir })
    const { plan } = seedPlan(workStore, [taskRow('t-brief', {
      context: '登录按钮点击后无响应，需要修复事件绑定并回归登录流程。',
      constraints: ['只改 src/login.js', '不新增依赖'],
      nonGoals: ['不重构路由', '不改视觉样式'],
      acceptanceCommands: [{ command: 'node -e "process.exit(0)"' }],
      risk: 'low',
      reversible: true,
    })])
    const { capture, ctx } = fakeHost()
    const { byName } = managerTools(workStore, ctx)
    await byName(TOOL_NAMES.planDispatch).execute({ planId: plan.id, wait: true }, exec())
    const brief = briefText(capture[0])
    // Work-register sections, not role-play:
    for (const section of ['## 1. 项目边界', '## 2. 背景与目标', '## 3. 范围与非目标', '## 4. 验收', '## 7. 工作流程', '## 8. 报告格式（工作语域）', '## 9. 失败处理']) {
      assert.ok(brief.includes(section), `missing brief section: ${section}`)
    }
    assert.ok(brief.includes('登录按钮点击后无响应'))
    assert.ok(brief.includes('只改 src/login.js'))
    assert.ok(brief.includes('不重构路由'))
    assert.ok(brief.includes('机器验收命令'))
    assert.ok(brief.includes('期望退出码 0'))
    assert.ok(brief.includes('不要用角色口吻'))
    assert.ok(brief.includes(`"owner": "${workStore.listRuns()[-1] ? '' : ''}`) || brief.includes('superbot_task_claim'))
    // The verifier brief must demand real execution + evidence ids.
    const verifier = workStore.startRun({ taskId: 't-brief', agentPreset: 'superbot-verifier', workspaceId: 'ws-1', actor: 'manager' })
    const verifierBrief = (await import('../lib/dispatch-tools.js')).buildTaskBrief(workStore.getTask('t-brief'), {
      store: workStore, workspaceId: 'ws-1', cwd: projectOne, runId: verifier.runId, kind: 'verifier',
    })
    assert.ok(verifierBrief.includes('superbot_acceptance_run'))
    assert.ok(verifierBrief.includes('evidenceIds'))
    assert.ok(verifierBrief.includes('worker 的自测输出不算证据'))
  })

  it('skips tasks whose project does not resolve and never dispatches tasks outside the plan', async () => {
    const workStore = new WorkStore({ stateDir: dir })
    const { plan } = seedPlan(workStore, [taskRow('t-ghost', { projectId: 'ws-missing' })])
    // a todo task that belongs to no plan must not be picked up by plan dispatch
    workStore.submitTask({ id: 't-standalone', title: 'standalone', projectId: 'ws-1', priority: 'high', acceptance: ['x'] })
    workStore.planTask('t-standalone')
    const { capture, ctx } = fakeHost()
    const { byName } = managerTools(workStore, ctx)

    const result = await byName(TOOL_NAMES.planDispatch).execute({ planId: plan.id }, exec())
    assert.deepEqual(result.dispatched, [])
    assert.deepEqual(result.skipped, [{ taskId: 't-ghost', reason: 'project-unknown', projectId: 'ws-missing' }])
    assert.equal(capture.length, 0)
    assert.equal(workStore.listRuns().length, 0)
    assert.equal(workStore.getTask('t-standalone').status, 'todo')
  })

  it('awaits child results when wait=true and reports a closed run', async () => {
    const workStore = new WorkStore({ stateDir: dir })
    const { plan } = seedPlan(workStore, [taskRow('t1')])
    const { ctx } = fakeHost()
    const { byName } = managerTools(workStore, ctx)
    const result = await byName(TOOL_NAMES.planDispatch).execute({ planId: plan.id, wait: true }, exec())
    assert.equal(result.dispatched.length, 1)
    assert.equal(result.dispatched[0].status, 'succeeded')
    assert.equal(result.dispatched[0].result.output[0].text, 'result-1')
    const run = workStore.getRun(result.dispatched[0].runId)
    assert.equal(run.status, 'succeeded')
    assert.equal(run.taskId, 't1')
  })

  it('fails clearly for unknown plans and for profiles without a preset surface', async () => {
    const workStore = new WorkStore({ stateDir: dir })
    const { plan } = seedPlan(workStore, [taskRow('t1')])
    const { ctx } = fakeHost()
    const { byName } = managerTools(workStore, ctx)
    await assert.rejects(byName(TOOL_NAMES.planDispatch).execute({ planId: 'pl-nope' }, exec()), /unknown plan/)

    // no agent-presets registry (headless/legacy composition): hard error, no run started
    const headless = createFakeContext({ services: { workspaceRegistry: workspaceRegistry() } })
    const headlessTools = managerTools(workStore, headless.ctx)
    await assert.rejects(
      headlessTools.byName(TOOL_NAMES.planDispatch).execute({ planId: plan.id }, exec()),
      /agent-presets service/,
    )
    assert.equal(workStore.listRuns().length, 0)

    // a session outside the manager preset cannot dispatch either
    const standard = fakeHost({ preset: 'standard' })
    const standardTools = managerTools(workStore, standard.ctx)
    await assert.rejects(
      standardTools.byName(TOOL_NAMES.planDispatch).execute({ planId: plan.id }, exec()),
      /manager-only/,
    )
    assert.equal(workStore.listRuns().length, 0)
  })
})
