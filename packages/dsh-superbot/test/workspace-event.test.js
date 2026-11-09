import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { appendRaw, appendEvent, projectTasks, readEvents } from '../lib/event-log.js'
import { buildProjectIndex, matchProjects, projectPhase } from '../lib/workspace-index.js'

const NOW = Date.parse('2026-11-04T00:00:00.000Z')
const registry = {
  tables: {
    workspaces: {
      ws1: { path: '/Users/me/proj-a', title: 'proj-a', sessionIds: ['s1', 's2'], updatedAt: '2026-11-03T00:00:00.000Z' },
      ws2: { path: '/Users/me/proj-a-other', title: 'proj-a other', sessionIds: [], updatedAt: '2026-11-03T00:00:00.000Z' },
      ws3: { path: '/Users/me/dep/node_modules/x', title: 'x', sessionIds: [], updatedAt: '2026-11-03T00:00:00.000Z' },
      ws4: { path: '/Users/me/.dsh-legacy/home', title: 'legacy data home', sessionIds: [], updatedAt: '2026-11-03T00:00:00.000Z' },
      ws5: { path: '/Users/me/missing', title: 'missing', sessionIds: [], updatedAt: '2026-01-01T00:00:00.000Z' },
    },
  },
}

describe('workspace-index', () => {
  it('projects DSH workspaces and excludes dependencies/character homes/missing', () => {
    const probe = (path) => ({
      exists: !path.endsWith('/missing'),
      remote: path.includes('proj-a') ? 'git@example:proj-a.git' : '',
    })
    const index = buildProjectIndex(registry, { now: NOW, probe })
    assert.equal(index.projects.length, 1)
    assert.equal(index.excluded.length, 3)
    assert.equal(index.projects[0].title, 'proj-a')
    assert.equal(index.projects[0].phase, 'active')
    assert.equal(index.projects[0].mergedFrom.length, 1)
    assert.equal(index.mergeGroups.length, 1)
  })

  it('phase boundaries', () => {
    assert.equal(projectPhase(30), 'active')
    assert.equal(projectPhase(31), 'warm')
    assert.equal(projectPhase(91), 'dormant')
    assert.equal(projectPhase(null), 'unknown')
  })

  it('matches by title token and active phase', () => {
    const matches = matchProjects('修一下 proj-a 的登录', [
      { title: 'proj-a', path: '/p/a', phase: 'active', days: 1 },
      { title: 'other', path: '/p/b', phase: 'active', days: 1 },
    ])
    assert.equal(matches[0].project.title, 'proj-a')
    assert.ok(matches[0].score > (matches[1]?.score ?? 0))
  })
})

describe('event-log', () => {
  it('appends, reads and projects task transitions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'superbot-events-'))
    try {
      const file = join(dir, 'events.jsonl')
      appendEvent(file, { kind: 'task/transition', taskId: 't1', from: 'draft', to: 'todo', at: '2026-11-04T00:00:00Z' })
      appendEvent(file, { kind: 'task/transition', taskId: 't1', from: 'todo', to: 'in_progress', at: '2026-11-04T00:01:00Z' })
      const { events, corrupt } = readEvents(file)
      assert.equal(corrupt, 0)
      assert.equal(events.length, 2)
      const tasks = projectTasks(events)
      assert.equal(tasks.get('t1').status, 'in_progress')
      assert.equal(tasks.get('t1').version, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips corrupt lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'superbot-events-'))
    try {
      const file = join(dir, 'events.jsonl')
      appendEvent(file, { kind: 'meta', value: 1 })
      appendEvent(file, { kind: 'meta', value: 2 })
      appendRaw(file, '{not-json}\n')
      const { events, corrupt } = readEvents(file)
      assert.equal(events.length, 2)
      assert.equal(corrupt, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

import { matchRequirement, projectsFromWorkspaces } from '../lib/workspace-service.js'

describe('workspace-service', () => {
  it('projects live entities and excludes non-projects', () => {
    const result = projectsFromWorkspaces([
      { id: 'a', path: '/p/a', title: 'proj-a', sessionIds: ['s1'], updatedAt: '2026-11-03T00:00:00Z' },
      { id: 'b', path: '/p/a/node_modules/x', title: 'dep', sessionIds: [], updatedAt: '2026-11-03T00:00:00Z' },
    ], { now: NOW, exists: () => true })
    assert.equal(result.projects.length, 1)
    assert.equal(result.excluded[0].excluded, 'dependency')
  })

  it('flags low-confidence matches for confirmation', () => {
    const match = matchRequirement('做一个完全无关的东西', [
      { workspaceId: 'a', title: 'proj-a', path: '/p/a', phase: 'active', days: 1 },
    ])
    assert.equal(match.candidates.length, 0)
    assert.equal(match.needsConfirmation, true)
  })
})
