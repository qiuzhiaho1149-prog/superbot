import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { buildOverview, humanWaitReason } from '../lib/overview.js'
import { WorkStore } from '../lib/work-store.js'

/**
 * Hierarchy contract the UI and the manager read:
 *   control plane → project (workspace) → threads (runs) → work items
 * Projects are isolated: every count is computed per projectId.
 */

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'superbot-overview-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const projects = [
  { workspaceId: 'ws-1', title: '项目一', path: '/tmp/proj-1', sessions: 4 },
  { workspaceId: 'ws-2', title: '项目二', path: '/tmp/proj-2', sessions: 2 },
]

function seed() {
  const store = new WorkStore({ stateDir: dir })
  // Project 1: one plan, two tasks (one done, one in_review waiting for human).
  const rq1 = store.submitRequirement({ projectId: 'ws-1', title: '修复登录', text: '登录按钮无响应' })
  const plan1 = store.createPlan({
    requirementId: rq1.id,
    tasks: [
      { title: '修按钮', projectId: 'ws-1', priority: 'high', acceptance: ['node --test 通过'], acceptanceCommands: [{ command: 'node -e "process.exit(0)"' }] },
      { title: '补文档', projectId: 'ws-1', priority: 'normal', acceptance: ['doc ok'], tags: ['aesthetic'] },
    ],
  })
  const [t1, t2] = plan1.plan.taskIds
  store.claimTask(t1, { owner: 'worker-1' })
  store.transitionTask(t1, 'in_review', { actor: 'worker-1' })
  // t1: verifier run with passing evidence and a pass review (but policy not run yet)
  const v1 = store.startRun({ taskId: t1, agentPreset: 'superbot-verifier', workspaceId: 'ws-1', label: 'verify:t1', parentSessionId: 'session-manager-1', actor: 'manager' })
  store.bindRun(v1.runId, { childId: 'child-v1' })
  const ev = store.recordEvidence({ taskId: t1, runId: v1.runId, index: 0, command: 'node -e "process.exit(0)"', exitCode: 0, timedOut: false, durationMs: 5, outputDigest: 'sha256:x', outputPath: '/tmp/x.log', preview: 'ok' })
  store.submitReview({ taskId: t1, reviewer: 'verifier:abc', reviewerRole: 'verifier', runId: v1.runId, verdict: 'pass', source: 'verifier', evidenceIds: [ev.evidenceId], reviewedOwner: 'worker-1' })
  store.finishRun(v1.runId, { status: 'succeeded', summary: 'verdict pass' })
  // t2 stays todo in the plan (planned, dispatchable).
  // Project 2: separate requirement + active worker run.
  const rq2 = store.submitRequirement({ projectId: 'ws-2', title: '导出 CSV', text: '加导出' })
  const plan2 = store.createPlan({ requirementId: rq2.id, tasks: [{ title: '写导出', projectId: 'ws-2', priority: 'high', acceptance: ['csv ok'] }] })
  const t3 = plan2.plan.taskIds[0]
  store.claimTask(t3, { owner: 'worker-2' })
  store.startRun({ taskId: t3, agentPreset: 'superbot-worker', workspaceId: 'ws-2', label: 'worker:t3', parentSessionId: 'session-manager-1', actor: 'manager' })
  // Orphan ledger project: no longer in the DSH inventory.
  store.submitRequirement({ projectId: 'ws-gone', title: '历史', text: '旧项目' })
  return { store, t1, t2, t3 }
}

describe('buildOverview', () => {
  it('keeps projects isolated with their own counts and threads', () => {
    const { store } = seed()
    const overview = buildOverview({ store, projects, generatedAt: '2026-11-06T00:00:00.000Z' })

    assert.equal(overview.generatedAt, '2026-11-06T00:00:00.000Z')
    assert.deepEqual(overview.projects.map((row) => row.projectId).sort(), ['ws-1', 'ws-2', 'ws-gone'])
    const one = overview.projects.find((row) => row.projectId === 'ws-1')
    const two = overview.projects.find((row) => row.projectId === 'ws-2')

    assert.equal(one.title, '项目一')
    assert.equal(one.counts.requirements, 1)
    assert.equal(one.counts.plans, 1)
    assert.equal(one.counts.tasks.total, 2)
    assert.equal(one.counts.tasks.in_review, 1)
    assert.equal(one.counts.tasks.todo, 1)
    assert.equal(Array.isArray(one.openTasks), true)
    assert.equal(one.openTasks.length, 2, 'two open tasks (in_review + todo)')
    assert.equal(one.openTasks[0].status, 'in_review', 'review queue first')
    assert.equal(one.attention, true)
    assert.equal(one.counts.tasks.done, 0)
    assert.equal(one.counts.runs.total, 1)
    assert.equal(one.counts.reviews, 1)
    assert.equal(one.counts.evidence, 1)

    assert.equal(two.counts.requirements, 1)
    assert.equal(two.counts.tasks.total, 1)
    assert.equal(two.counts.runs.active, 1, 'one active worker thread in project two')
    assert.equal(two.threads.length, 1)
    assert.equal(two.threads[0].agentPreset, 'superbot-worker')
    assert.equal(two.threads[0].parentSessionId, 'session-manager-1')

    // Thread provenance is exposed for the UI: manager thread → child session → task.
    assert.equal(one.threads[0].childId, 'child-v1')
    assert.equal(one.threads[0].label, 'verify:t1')
    assert.equal(one.threads[0].parentSessionId, 'session-manager-1')

    assert.equal(two.counts.tasks.in_review, 0, 'project two must not inherit project one state')
    assert.equal(two.openTasks.length, 1)
    assert.equal(two.attention, false)
  })

  it('surfaces the human-attention queue with a reason per task', () => {
    const { store, t1 } = seed()
    const overview = buildOverview({ store, projects })
    const one = overview.projects.find((row) => row.projectId === 'ws-1')
    assert.equal(overview.totals.pendingHuman, 1)
    assert.equal(one.pendingHuman.length, 1)
    assert.equal(one.pendingHuman[0].taskId, t1)
    assert.equal(one.pendingHuman[0].evidenceComplete, true)
    assert.ok('workerRunId' in one.pendingHuman[0])
    assert.ok('workerChildId' in one.pendingHuman[0])
    assert.equal(one.pendingHuman[0].reason, 'awaiting-human', 'evidence is complete but nobody accepted yet')

    const task = store.getTask(t1)
    const reviews = store.listReviews({ taskId: t1 })
    const coverage = store.evidenceCoverage(t1)
    assert.equal(humanWaitReason({ task, reviews, coverage }).code, 'awaiting-human')
    assert.equal(humanWaitReason({ task: { ...task, status: 'in_progress' }, reviews, coverage }), null)
  })

  it('keeps projects that left the inventory visible from the ledger (orphans)', () => {
    const { store } = seed()
    const overview = buildOverview({ store, projects })
    const orphan = overview.projects.find((row) => row.projectId === 'ws-gone')
    assert.ok(orphan !== undefined)
    assert.equal(orphan.inInventory, false)
    assert.equal(orphan.counts.requirements, 1)
  })

  it('filters, searches and sorts the project list while totals stay global', () => {
    const { store } = seed()
    const filtered = buildOverview({ store, projects, filter: 'idle', q: 'zzz' })
    assert.equal(filtered.view.matchedProjects, 0)
    assert.equal(filtered.attention.length, 1, 'attention queue is independent of the project filter')
    assert.equal(filtered.attention[0].projectTitle, '项目一')

    const attention = buildOverview({ store, projects, filter: 'attention' })
    assert.ok(attention.projects.length >= 1)
    assert.equal(attention.projects.every((row) => row.pendingHuman.length > 0), true)
    assert.equal(attention.view.filter, 'attention')
    assert.equal(attention.view.totalProjects, 3)
    assert.ok(attention.view.matchedProjects <= attention.view.totalProjects)

    const active = buildOverview({ store, projects, filter: 'active' })
    assert.equal(active.projects.every((row) => row.counts.runs.active > 0 || row.counts.tasks.in_progress > 0), true)

    const idle = buildOverview({ store, projects, filter: 'idle' })
    assert.equal(idle.projects.every((row) => row.pendingHuman.length === 0 && row.counts.runs.active === 0), true)

    const searched = buildOverview({ store, projects, q: '项目一' })
    assert.deepEqual(searched.projects.map((row) => row.projectId), ['ws-1'])
    assert.ok('confirmedStatus' in searched.projects[0])

    const byName = buildOverview({ store, projects, sort: 'name' })
    const names = byName.projects.map((row) => row.title)
    assert.deepEqual([...names].sort((left, right) => left.localeCompare(right)), names)

    // Totals are always the whole ledger, not the filtered view.
    assert.equal(attention.totals.projects, byName.totals.projects)
    assert.equal(attention.totals.tasks, byName.totals.tasks)
    // Unknown filters fall back to defaults.
    assert.equal(buildOverview({ store, projects, filter: 'nope', sort: 'nope' }).view.filter, 'all')
  })

  it('surfaces actionable fields for the attention queue and thread titles', () => {
    const { store, t1 } = seed()
    const overview = buildOverview({ store, projects })
    const item = overview.projects.flatMap((row) => row.pendingHuman).find((row) => row.taskId === t1)
    assert.equal(item.priority, 'high')
    assert.ok(item.risk === null || typeof item.risk === 'string', 'risk is a nullable field')
    assert.equal(typeof item.updatedAt, 'string')
    const thread = overview.projects.flatMap((row) => row.threads).find((row) => row.taskId === t1)
    assert.equal(thread.taskTitle, '修按钮')
  })

  it('maps sandbox integrity failures to a dedicated human reason', () => {
    const reviews = [
      { source: 'verifier', verdict: 'pass', reviewId: 'rv-1' },
      { source: 'policy', reviewId: 'rv-2', decision: { mode: 'human', reasons: ['verifier-sandbox-full-access'] } },
    ]
    const reason = humanWaitReason({ task: { status: 'in_review' }, reviews, coverage: { complete: true, rows: [] } })
    assert.equal(reason.code, 'sandbox-untrusted')
    assert.match(reason.detail, /danger-full-access/)
  })

  it('filters to one project and reports totals across the rest', () => {
    const { store } = seed()
    const only = buildOverview({ store, projects, projectId: 'ws-2' })
    assert.equal(only.projects.length, 1)
    assert.equal(only.projects[0].projectId, 'ws-2')
    assert.equal(only.totals.tasks, 1)

    const all = buildOverview({ store, projects })
    assert.equal(all.totals.projects, 3)
    assert.equal(all.totals.tasks, 3)
    assert.equal(all.totals.threads, 2)
    assert.equal(all.totals.activeRuns, 1)
    assert.ok(all.isolation.projectBoundary.length > 0)
  })
})
