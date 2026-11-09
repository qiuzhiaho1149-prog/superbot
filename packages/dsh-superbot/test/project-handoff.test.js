import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { validateConfigPatch } from '../lib/config.js'
import { HANDOFF_FILE_NAME, buildProjectHandoff, renderProjectHandoff, writeProjectHandoff } from '../lib/project-handoff.js'
import { WorkStore } from '../lib/work-store.js'

let dir
let projectDir
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'superbot-handoff-'))
  projectDir = mkdtempSync(join(tmpdir(), 'superbot-handoff-proj-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
})

const seed = () => {
  const store = new WorkStore({ stateDir: dir })
  store.confirmInventory({ projects: [{ projectId: 'ws-1', status: 'active' }] })
  store.submitTask({
    id: 't-1', title: '导出 CSV', projectId: 'ws-1', priority: 'normal',
    acceptance: ['CSV 下载可用'], acceptanceCommands: [{ command: 'node --test' }],
    constraints: ['不改数据库 schema'], nonGoals: ['不做 Excel 导出'],
  })
  store.planTask('t-1')
  return store
}

describe('project handoff projection', () => {
  it('renders goal, open work, acceptance commands and constraints without history', () => {
    const store = seed()
    const markdown = buildProjectHandoff({ store, project: { projectId: 'ws-1', title: 'demo' }, now: Date.parse('2026-11-09T00:00:00Z') })
    assert.match(markdown, /^# Superbot handoff — demo/)
    assert.match(markdown, /## Goal/)
    assert.match(markdown, /## Queued/)
    assert.match(markdown, /t-1 — 导出 CSV/)
    assert.match(markdown, /node --test/)
    assert.match(markdown, /不改数据库 schema/)
    assert.match(markdown, /## How to continue without Superbot/)
    assert.ok(Buffer.byteLength(markdown, 'utf8') < 6_000)
    assert.equal(markdown.includes('assistant/message'), false)
  })

  it('caps a large project so context stays bounded and includes need-you/rework lanes', () => {
    const tasks = []
    for (let index = 0; index < 40; index += 1) {
      tasks.push({ id: `t-${index}`, title: `task ${index}`, projectId: 'ws-1', status: index < 2 ? 'in_review' : 'todo', acceptance: ['ok'], acceptanceCommands: [{ command: 'node --test' }] })
    }
    const markdown = renderProjectHandoff({ project: { projectId: 'ws-1', title: 'many' }, tasks, now: Date.parse('2026-11-09T00:00:00Z') })
    assert.match(markdown, /## Needs your decision/)
    assert.ok(markdown.split('\n').filter((line) => line.startsWith('- t-')).length <= 40)
    assert.ok(Buffer.byteLength(markdown, 'utf8') <= 4_600)
  })

  it('writes atomically and refuses to overwrite a foreign file', () => {
    const markdown = renderProjectHandoff({ project: { projectId: 'ws-1', title: 'demo' }, tasks: [] })
    const first = writeProjectHandoff(projectDir, markdown)
    assert.equal(first.written, true)
    assert.equal(first.path, join(projectDir, HANDOFF_FILE_NAME))
    assert.match(readFileSync(first.path, 'utf8'), /^# Superbot handoff/)
    const second = writeProjectHandoff(projectDir, '# foreign\n')
    assert.equal(second.written, true, 'our own marker may be regenerated')
    writeFileSync(join(projectDir, HANDOFF_FILE_NAME), '# user file\n')
    const refused = writeProjectHandoff(projectDir, markdown)
    assert.equal(refused.written, false)
    assert.equal(refused.reason, 'foreign-file')
  })
})

describe('handoff config and event subscription', () => {
  it('validates projectHandoff/handoffFile', () => {
    assert.deepEqual(validateConfigPatch({ projectHandoff: false }), { projectHandoff: false })
    assert.deepEqual(validateConfigPatch({ handoffFile: 'HANDOFF.md' }), { handoffFile: 'HANDOFF.md' })
    assert.throws(() => validateConfigPatch({ handoffFile: '../x.md' }), /plain file name/)
    assert.throws(() => validateConfigPatch({ projectHandoff: 'yes' }), /boolean/)
  })

  it('notifies append listeners and stops after unsubscribe', () => {
    const store = new WorkStore({ stateDir: dir })
    const seen = []
    const off = store.onAppend((event) => seen.push(event.kind))
    store.submitTask({ id: 't-2', title: 'x', projectId: 'ws-1', priority: 'normal', acceptance: ['ok'] })
    assert.deepEqual(seen, ['task/created'])
    off()
    store.planTask('t-2')
    assert.deepEqual(seen, ['task/created'])
  })
})
