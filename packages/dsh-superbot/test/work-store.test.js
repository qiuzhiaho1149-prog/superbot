import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { appendEvent } from '../lib/event-log.js'
import {
  WORK_SCHEMA_VERSION, WorkStore, applyWorkEvent, createWorkStore, emptyProjection,
  projectWork, workPaths,
} from '../lib/work-store.js'

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'superbot-work-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const spec = (overrides = {}) => ({
  title: 'Persist the ledger',
  projectId: 'ws-1',
  priority: 'normal',
  acceptance: ['node --test test/*.test.js'],
  acceptanceCommands: [{ command: 'node -e "process.exit(0)"' }],
  ...overrides,
})

function readEventLines(stateDir) {
  return readFileSync(workPaths(stateDir).events, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

describe('work-store persistence', () => {
  it('persists tasks, runs, reports and reviews as append-only events', () => {
    const store = createWorkStore({ stateDir: dir, clock: () => '2026-11-04T00:00:00.000Z' })
    store.submitTask(spec({ id: 't-1' }), { actor: 'manager', reason: 'submit' })
    store.planTask('t-1')
    store.claimTask('t-1', { owner: 'worker-1' })
    const run = store.startRun({ taskId: 't-1', agentPreset: 'superbot-worker', workspaceId: 'ws-1', label: 'w1', actor: 'manager' })
    store.bindRun(run.runId, { childId: 'child-1' })
    store.finishRun(run.runId, { status: 'succeeded', summary: 'tests pass' })
    store.submitReport({ taskId: 't-1', runId: run.runId, author: 'worker-1', summary: 'implemented', evidence: ['node --test: 12 pass'] })
    // Independent acceptance: a verifier run executes the declared command and
    // records machine evidence; a prose-only pass is no longer accepted.
    const verifierRun = store.startRun({ taskId: 't-1', agentPreset: 'superbot-verifier', workspaceId: 'ws-1', label: 'v1', actor: 'manager' })
    const evidence = store.recordEvidence({
      taskId: 't-1', runId: verifierRun.runId, index: 0, command: 'node -e "process.exit(0)"',
      exitCode: 0, timedOut: false, durationMs: 12, outputDigest: 'sha256:00', outputPath: join(dir, 'work', 'artifacts', 'x.log'), preview: 'ok',
    })
    store.submitReview({
      taskId: 't-1', reviewer: 'verifier-1', reviewerRole: 'verifier', runId: verifierRun.runId,
      verdict: 'pass', notes: 'reviewed', evidenceIds: [evidence.evidenceId], source: 'verifier',
    })
    store.transitionTask('t-1', 'in_review', { actor: 'worker-1', reason: 'submit-for-review' })

    const task = store.getTask('t-1')
    assert.equal(task.status, 'in_review')
    assert.equal(task.owner, 'worker-1')
    assert.equal(task.version, 3)

    const runs = store.listRuns({ taskId: 't-1' })
    assert.equal(runs.length, 2, 'worker run + verifier run')
    assert.equal(runs[0].agentPreset, 'superbot-worker')
    assert.equal(runs[0].childId, 'child-1')
    assert.equal(runs[0].status, 'succeeded')
    assert.equal(runs[1].agentPreset, 'superbot-verifier')

    assert.equal(store.listReports({ taskId: 't-1' })[0].evidence[0], 'node --test: 12 pass')
    assert.equal(store.listReviews({ taskId: 't-1' })[0].verdict, 'pass')
    assert.equal(store.listEvidence({ taskId: 't-1' }).length, 1)
    assert.equal(store.evidenceCoverage('t-1').complete, true)

    const events = readEventLines(dir)
    assert.ok(events.length >= 9)
    for (const event of events) {
      assert.equal(event.schemaVersion, WORK_SCHEMA_VERSION)
      assert.ok(typeof event.at === 'string' && event.at !== '')
      assert.ok(typeof event.actor === 'string' && event.actor !== '')
      assert.ok(typeof event.reason === 'string' && event.reason !== '')
    }
    assert.deepEqual(events.map((event) => event.seq), events.map((_event, index) => index + 1))

    const projection = JSON.parse(readFileSync(workPaths(dir).projection, 'utf8'))
    assert.equal(projection.schemaVersion, WORK_SCHEMA_VERSION)
    assert.equal(projection.counts.tasks, 1)
    assert.equal(projection.counts.runs, 2, 'worker + verifier runs')
    assert.equal(projection.counts.reports, 1)
    assert.equal(projection.counts.reviews, 1)
    assert.equal(projection.counts.evidence, 1)
  })

  it('keeps tasks readable after a store restart', () => {
    const first = createWorkStore({ stateDir: dir })
    first.submitTask(spec({ id: 't-restart' }), { actor: 'manager', reason: 'submit' })
    first.planTask('t-restart')

    const second = new WorkStore({ stateDir: dir })
    assert.equal(second.getTask('t-restart').status, 'todo')
    assert.equal(second.listTasks().length, 1)
    assert.equal(second.stats().events, 2)
  })

  it('rebuilds a corrupt projection from events', () => {
    const store = createWorkStore({ stateDir: dir })
    store.submitTask(spec({ id: 't-1' }))
    // Simulate a broken/disposable projection: events remain the truth.
    writeFileSync(workPaths(dir).projection, '{not-json', 'utf8')

    const recovered = new WorkStore({ stateDir: dir })
    assert.equal(recovered.getTask('t-1').title, spec().title)
    const projection = JSON.parse(readFileSync(workPaths(dir).projection, 'utf8'))
    assert.equal(projection.counts.tasks, 1)

    // Explicit recovery path too.
    assert.equal(recovered.rebuild().tasks, 1)
  })

  it('skips corrupt log lines and reports them in the audit export', () => {
    const store = createWorkStore({ stateDir: dir })
    store.submitTask(spec({ id: 't-1' }))
    const { events } = workPaths(dir)
    writeFileSync(events, `${readFileSync(events, 'utf8')}{broken line}\n`, 'utf8')

    const reopened = new WorkStore({ stateDir: dir })
    assert.equal(reopened.getTask('t-1').title, spec().title)
    const audit = reopened.exportAudit()
    assert.equal(audit.corrupt, 1)
    assert.equal(audit.eventCount, 1)
  })

  it('exports the newest audit events and keeps unknown versions out of projections', () => {
    const store = createWorkStore({ stateDir: dir })
    store.submitTask(spec({ id: 't-1' }))
    store.planTask('t-1')
    appendEvent(workPaths(dir).events, {
      schemaVersion: 99, seq: 3, kind: 'task/created', at: '2026-11-04T00:00:00.000Z', actor: 'future', reason: 'future',
      task: { id: 't-future', title: 'future shape', projectId: 'ws-1', priority: 'low', acceptance: ['x'], status: 'draft', owner: null, version: 0 },
    })

    const reopened = new WorkStore({ stateDir: dir })
    assert.equal(reopened.getTask('t-future'), undefined)
    assert.equal(reopened.stats().events, 3)
    assert.equal(reopened.stats().ignored, 1)

    const audit = reopened.exportAudit({ limit: 2 })
    assert.equal(audit.eventCount, 3)
    assert.deepEqual(audit.events.map((event) => event.seq), [2, 3])
  })

  it('keeps the live fold counters correct after in-process appends', () => {
    const store = createWorkStore({ stateDir: dir })
    // A live append is folded, not ignored: `stats().ignored` must stay 0
    // (it used to grow with every append because the loaded `applied` count
    // was never advanced).
    store.submitTask(spec({ id: 't-1' }))
    store.planTask('t-1')
    store.startRun({ taskId: 't-1', agentPreset: 'superbot-worker' })
    assert.equal(store.stats().events, 3)
    assert.equal(store.stats().ignored, 0)
    // Reloading the same ledger must produce identical counters.
    const reopened = new WorkStore({ stateDir: dir })
    assert.equal(reopened.stats().ignored, 0)
    assert.equal(reopened.getTask('t-1').status, 'todo')
  })

  it('validates specs and refuses duplicate ids', () => {
    const store = createWorkStore({ stateDir: dir })
    assert.throws(() => store.submitTask(spec({ id: 't-bad', acceptance: [] })), /invalid task spec/)
    store.submitTask(spec({ id: 't-1' }))
    assert.throws(() => store.submitTask(spec({ id: 't-1' })), /already exists/)
  })

  it('projects every persisted collection from raw events', () => {
    const events = [
      { schemaVersion: WORK_SCHEMA_VERSION, seq: 1, kind: 'task/created', at: 't1', actor: 'manager', reason: 'submit', task: { id: 't1', title: 'x', status: 'draft', owner: null, version: 0 } },
      { schemaVersion: WORK_SCHEMA_VERSION, seq: 2, kind: 'run/started', at: 't2', actor: 'manager', reason: 'dispatch', run: { runId: 'r-2', status: 'running', agentPreset: 'superbot-worker' } },
      { schemaVersion: WORK_SCHEMA_VERSION, seq: 3, kind: 'run/finished', at: 't3', actor: 'manager', reason: 'result', runId: 'r-2', status: 'succeeded', summary: 'ok' },
      { schemaVersion: WORK_SCHEMA_VERSION, seq: 4, kind: 'report/submitted', at: 't4', actor: 'worker', reason: 'report', report: { reportId: 'rp-4', taskId: 't1', summary: 'done' } },
      { schemaVersion: WORK_SCHEMA_VERSION, seq: 5, kind: 'review/submitted', at: 't5', actor: 'verifier', reason: 'review', review: { reviewId: 'rv-5', taskId: 't1', verdict: 'pass' } },
    ]
    const projection = projectWork(events)
    assert.equal(projection.tasks.get('t1').id, 't1')
    assert.equal(projection.runs.get('r-2').status, 'succeeded')
    assert.equal(projection.reports.get('rp-4').summary, 'done')
    assert.equal(projection.reviews.get('rv-5').verdict, 'pass')
    assert.equal(projection.applied, 5)
    assert.equal(projection.ignored, 0)
    assert.equal(applyWorkEvent(emptyProjection(), { kind: 'mystery', schemaVersion: WORK_SCHEMA_VERSION }), false)
    assert.equal(existsSync(workPaths(dir).dir), false)
  })
})
