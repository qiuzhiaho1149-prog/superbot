import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { buildTimeline, toEpoch } from '../lib/timeline.js'
import { WorkStore } from '../lib/work-store.js'

let dir
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'superbot-timeline-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('timeline model', () => {
  it('toEpoch accepts numbers and ISO strings, rejects garbage', () => {
    assert.equal(toEpoch(123456), 123456)
    assert.equal(toEpoch('2026-11-01T00:00:00.000Z'), Date.parse('2026-11-01T00:00:00.000Z'))
    assert.equal(toEpoch('nope'), null)
    assert.equal(toEpoch(''), null)
  })

  it('emits numeric t0/t1 per lane with a single server now', () => {
    const store = new WorkStore({ stateDir: dir })
    store.confirmInventory({ projects: [{ projectId: 'ws-1', status: 'active' }] })
    const now = Date.now()
    store.submitTask({ id: 't-1', title: 'fix', projectId: 'ws-1', priority: 'normal', acceptance: ['ok'], createdAt: new Date(now - 3600_000).toISOString() })
    const workerRun = store.startRun({ taskId: 't-1', agentPreset: 'superbot-worker', workspaceId: 'ws-1', at: new Date(now - 3600_000).toISOString() })
    store.bindRun(workerRun.runId, { childId: 'child-1' })
    store.finishRun(workerRun.runId, { status: 'succeeded', at: new Date(now - 1800_000).toISOString() })
    const timeline = buildTimeline({ store, projects: [{ workspaceId: 'ws-1', title: 'p' }], now })
    assert.equal(timeline.now, now)
    assert.equal(timeline.lanes[0].title, 'p')
    const thread = timeline.lanes[0].items.find((item) => item.kind === 'thread')
    assert.ok(thread.t0 < thread.t1)
    assert.equal(thread.durationMs, thread.t1 - thread.t0)
    assert.equal(thread.childId, 'child-1')
    const task = timeline.lanes[0].items.find((item) => item.kind === 'task')
    assert.equal(task.taskId, 't-1')
  })

  it('marks open-ended threads and skips bad timestamps instead of dropping rows', () => {
    const store = new WorkStore({ stateDir: dir })
    const now = Date.now()
    store.submitTask({ id: 't-2', title: 'fix2', projectId: 'ws-1', priority: 'normal', acceptance: ['ok'] })
    const run = store.startRun({ taskId: 't-2', agentPreset: 'superbot-worker', workspaceId: 'ws-1', at: new Date(now - 600_000).toISOString() })
    store.bindRun(run.runId, { childId: 'child-open' })
    const timeline = buildTimeline({ store, projects: [{ workspaceId: 'ws-1' }], now })
    const thread = timeline.lanes[0].items.find((item) => item.kind === 'thread')
    assert.equal(thread.t1, null)
    assert.equal(thread.state, 'running')
  })
})
