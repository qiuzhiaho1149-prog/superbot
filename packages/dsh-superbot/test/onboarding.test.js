import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import {
  buildInventory, dshHomeOf, readSessionMeta, scanInventory, scanThreads, sessionDirName,
} from '../lib/onboarding.js'
import { WorkStore } from '../lib/work-store.js'

let dir
let home
const dirs = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'superbot-onboarding-'))
  home = mkdtempSync(join(tmpdir(), 'superbot-home-'))
  dirs.push(home)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

const DAY = 86_400_000
const isoAgo = (days) => new Date(Date.now() - days * DAY).toISOString()

/** Write a session log as concatenated zstd frames (the real append-only shape). */
function writeSession(dshHome, workspacePath, sessionId, { title, mtimeAgoMs = 0, archived = false } = {}) {
  const workspaceDir = join(dshHome, 'sessions', sessionDirName(workspacePath))
  const sessionDir = join(workspaceDir, sessionId)
  mkdirSync(sessionDir, { recursive: true })
  const header = { type: 'session', version: 4, id: sessionId, createdAt: Date.now() - DAY, cwd: workspacePath, agentPreset: 'standard', origin: 'user', delegationDepth: 0 }
  const frames = [JSON.stringify(header) + '\n']
  if (title !== undefined) frames.push(JSON.stringify({ type: 'session/title', data: { title } }) + '\n')
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames.map((frame) => zstdCompressSync(Buffer.from(frame, 'utf8')))))
  if (mtimeAgoMs > 0) {
    const past = new Date(Date.now() - mtimeAgoMs)
    // mtime is the last-activity signal; touch it via utimes through fs (Node >= 14).
    utimesSync(join(sessionDir, 'session.v4.jsonl.zstd'), past, past)
  }
  if (archived) writeFileSync(join(sessionDir, 'session.lock'), '')
  return sessionDir
}

describe('onboarding inventory', () => {
  it('sanitizes workspace paths into DSH session directory names', () => {
    assert.equal(sessionDirName('/private/tmp/sb-deploy/proj-fix'), '--private-tmp-sb-deploy-proj-fix--')
    assert.equal(sessionDirName('/Users/afraxx/Documents/My Project'), '--Users-afraxx-Documents-My-Project--')
    assert.equal(sessionDirName(''), undefined)
  })

  it('derives DSH_HOME from the plugin stateDir', () => {
    assert.equal(dshHomeOf('/tmp/home/storages/dsh-superbot'), '/tmp/home')
    assert.equal(dshHomeOf(''), undefined)
  })

  it('reads a session head: header, title and last activity, never throwing', () => {
    const sessionDir = writeSession(home, '/tmp/proj-a', 'session-1', { title: '登录修复' })
    const meta = readSessionMeta(sessionDir, 'session-1')
    assert.equal(meta.title, '登录修复')
    assert.equal(meta.cwd, '/tmp/proj-a')
    assert.equal(meta.agentPreset, 'standard')
    assert.ok(typeof meta.lastActiveAt === 'string')
    assert.equal(meta.live, false)

    const missing = readSessionMeta(join(home, 'nope'), 'session-x')
    assert.equal(missing.title, null)
    assert.equal(missing.lastActiveAt, null)
  })

  it('scans sessions and maps them to projects by sanitized workspace path', () => {
    writeSession(home, '/tmp/proj-a', 'session-a1', { title: 'A 线程' })
    writeSession(home, '/tmp/proj-b', 'session-b1', { title: 'B 线程', mtimeAgoMs: 10 * DAY })
    const projects = [
      { workspaceId: 'ws-a', path: '/tmp/proj-a', title: '项目 A' },
      { workspaceId: 'ws-b', path: '/tmp/proj-b', title: '项目 B' },
    ]
    const scan = scanThreads(home, { projects, archivedSessionIds: ['session-b1'] })
    assert.equal(scan.available, true)
    assert.equal(scan.threads.length, 2)
    const a = scan.threads.find((thread) => thread.sessionId === 'session-a1')
    const b = scan.threads.find((thread) => thread.sessionId === 'session-b1')
    assert.equal(a.workspaceId, 'ws-a')
    assert.equal(a.title, 'A 线程')
    assert.equal(b.workspaceId, 'ws-b')
    assert.equal(b.archived, true)
  })

  it('classifies projects: active (open work / recent), paused, archived, unknown', () => {
    const projects = ['p-active', 'p-paused', 'p-archived', 'p-unknown'].map((id) => ({
      workspaceId: id, title: id, path: `/tmp/${id}`,
    }))
    const tasks = [
      { id: 't-open', projectId: 'p-active', status: 'in_review', title: 'open' },
      { id: 't-done', projectId: 'p-paused', status: 'done', title: 'done' },
    ]
    const threads = [
      { sessionId: 's1', workspaceId: 'p-active', title: 'recent', lastActiveAt: isoAgo(0.2), origin: 'user', archived: false, live: false },
      { sessionId: 's2', workspaceId: 'p-paused', title: 'old', lastActiveAt: isoAgo(10), origin: 'user', archived: false, live: false },
      { sessionId: 's3', workspaceId: 'p-archived', title: 'archived', lastActiveAt: isoAgo(30), origin: 'user', archived: true, live: false },
      { sessionId: 's4', workspaceId: 'p-active', title: 'child', lastActiveAt: isoAgo(0.1), origin: 'subagent', archived: false, live: false },
    ]
    const inventory = buildInventory({ projects, threads, tasks, requirements: [], now: Date.now() })
    const byId = Object.fromEntries(inventory.projects.map((project) => [project.projectId, project]))
    assert.equal(byId['p-active'].proposedStatus, 'active')
    assert.ok(byId['p-active'].proposedReasons.some((reason) => reason.includes('未完成任务')))
    assert.equal(byId['p-active'].counts.childThreads, 1, 'subagent sessions are counted separately from user threads')
    assert.equal(byId['p-paused'].proposedStatus, 'paused')
    assert.equal(byId['p-archived'].proposedStatus, 'archived')
    assert.equal(byId['p-unknown'].proposedStatus, 'unknown')
    assert.equal(inventory.totals.active, 1)
    assert.equal(inventory.totals.paused, 1)
    assert.equal(inventory.totals.archived, 1)
    assert.equal(inventory.totals.unknown, 1)
    assert.equal(inventory.confirmationRequired, true)
    assert.equal(inventory.readOnly, true)
    assert.ok(inventory.questions.length >= 3)
  })

  it('scanInventory combines registry, disk sessions and the ledger', () => {
    const store = new WorkStore({ stateDir: dir })
    store.submitRequirement({ projectId: 'ws-a', title: 'r', text: 'x' })
    writeSession(home, '/tmp/proj-a', 'session-a1', { title: 'A' })
    const inventory = scanInventory({
      store,
      dshHome: home,
      workspaceSnapshot: {
        projects: [{ workspaceId: 'ws-a', title: '项目 A', path: '/tmp/proj-a' }, { workspaceId: 'ws-b', title: '项目 B', path: '/tmp/proj-b' }],
        archivedSessionIds: [],
      },
    })
    const a = inventory.projects.find((project) => project.projectId === 'ws-a')
    assert.equal(a.counts.requirements, 1)
    assert.equal(a.counts.threads, 1)
    assert.equal(a.threads[0].title, 'A')
  })
})

describe('inventory confirmation ledger', () => {
  it('persists the user confirmation, survives restart and resolves statuses', () => {
    const store = new WorkStore({ stateDir: dir })
    const confirmed = store.confirmInventory({
      projects: [
        { projectId: 'ws-a', status: 'active', title: 'A' },
        { projectId: 'ws-b', status: 'paused', title: 'B' },
      ],
      note: '用户确认：B 先挂起',
      via: 'http',
    })
    assert.equal(confirmed.via, 'http')
    assert.equal(confirmed.projects.length, 2)
    assert.equal(store.stats().inventory, 1)
    assert.equal(store.confirmedProjectStatus('ws-a'), 'active')
    assert.equal(store.confirmedProjectStatus('ws-b'), 'paused')

    const reopened = new WorkStore({ stateDir: dir })
    assert.equal(reopened.getInventoryConfirmation().inventoryId, confirmed.inventoryId)
    assert.equal(reopened.getInventoryConfirmation().note, '用户确认：B 先挂起')
    assert.equal(reopened.confirmedProjectStatus('ws-b'), 'paused')
  })

  it('refuses malformed confirmations', () => {
    const store = new WorkStore({ stateDir: dir })
    assert.throws(() => store.confirmInventory({ projects: [] }), /non-empty/)
    assert.throws(() => store.confirmInventory({ projects: [{ projectId: 'ws-a', status: 'later' }] }), /unknown status/)
    assert.throws(() => store.confirmInventory({ projects: [{ status: 'active' }] }), /requires a projectId/)
  })
})
