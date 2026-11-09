import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { importHistoryWork } from '../lib/history-import.js'
import { WorkStore } from '../lib/work-store.js'

let dir
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'superbot-history-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const projects = [{ workspaceId: 'ws-1', title: 'proj-1', path: '/tmp/p1' }]

describe('history import', () => {
  it('creates a high-risk read-only investigation task per selected thread', () => {
    const store = new WorkStore({ stateDir: dir })
    const result = importHistoryWork(store, [{ projectId: 'ws-1', sessionId: 's-1', title: '旧登录页', intent: '修复登录页' }], { projects })
    assert.equal(result.count, 1)
    const task = store.getTask(result.imported[0].taskId)
    assert.equal(task.status, 'todo')
    assert.equal(task.risk, 'high')
    assert.match(task.context, /历史工作/)
    assert.deepEqual(task.acceptanceCommands ?? [], [])
    assert.equal(store.listRuns({ taskId: task.id }).length, 0, 'import never dispatches')
  })

  it('rejects unknown projects and unbounded batches', () => {
    const store = new WorkStore({ stateDir: dir })
    assert.throws(() => importHistoryWork(store, [{ projectId: 'nope' }], { projects }), /unknown project/)
    const many = Array.from({ length: 11 }, (_, index) => ({ projectId: 'ws-1', title: `t${index}` }))
    assert.throws(() => importHistoryWork(store, many, { projects }), /at most 10/)
  })
})
