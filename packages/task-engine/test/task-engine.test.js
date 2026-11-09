import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildHandoff, claim, compareTasks, createTask, createWaitpoint, dependenciesDone, planDispatch,
  release, resolveWaitpoint, transition, validateTaskSpec,
} from '../lib/index.js'

const AT = '2026-11-04T00:00:00.000Z'
const spec = (id, overrides = {}) => ({
  id,
  title: `task ${id}`,
  projectId: 'proj-a',
  priority: 'normal',
  acceptance: ['pnpm test'],
  ...overrides,
})

describe('validateTaskSpec', () => {
  it('accepts a complete spec', () => {
    const result = validateTaskSpec(spec('t1', { deps: ['t0'] }))
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.value.deps, ['t0'])
  })

  it('rejects missing title and empty acceptance', () => {
    const result = validateTaskSpec({ ...spec('t1'), title: '', acceptance: [] })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.errors.some((error) => error.path === '$.title'))
    assert.ok(result.errors.some((error) => error.path === '$.acceptance'))
  })
})

describe('state machine', () => {
  it('walks draft -> todo -> in_progress -> in_review -> done', () => {
    let task = createTask(spec('t1'), { at: AT })
    task = transition(task, 'todo', { at: AT }).task
    const claimed = claim(task, { owner: 'worker-1', expectedVersion: 1, at: AT })
    task = transition(claimed.task, 'in_review', { actor: 'worker-1', at: AT }).task
    const accepted = transition(task, 'done', { actor: 'human', at: AT })
    assert.equal(accepted.task.status, 'done')
    assert.equal(accepted.task.version, 4)
  })

  it('rejects agent marking done', () => {
    let task = createTask(spec('t1'), { at: AT })
    task = transition(task, 'todo', { at: AT }).task
    task = claim(task, { owner: 'worker-1', at: AT }).task
    task = transition(task, 'in_review', { actor: 'worker-1', at: AT }).task
    assert.throws(() => transition(task, 'done', { actor: 'agent', at: AT }), /only a human/)
  })

  it('rejects invalid transitions', () => {
    const task = createTask(spec('t1'), { at: AT })
    assert.throws(() => transition(task, 'done', { actor: 'human', at: AT }), /cannot transition/)
  })

  it('claims with optimistic version and rejects double claim', () => {
    let task = createTask(spec('t1'), { at: AT })
    task = transition(task, 'todo', { at: AT }).task
    assert.throws(() => claim(task, { owner: 'a', expectedVersion: 9, at: AT }), /version/)
    const claimed = claim(task, { owner: 'a', at: AT }).task
    assert.equal(claimed.status, 'in_progress')
    assert.equal(claimed.owner, 'a')
    assert.throws(() => claim(claimed, { owner: 'b', at: AT }), /already claimed/)
  })

  it('releases back to todo', () => {
    let task = createTask(spec('t1'), { at: AT })
    task = transition(task, 'todo', { at: AT }).task
    task = claim(task, { owner: 'a', at: AT }).task
    task = release(task, { owner: 'a', at: AT }).task
    assert.equal(task.status, 'todo')
    assert.equal(task.owner, null)
  })
})

describe('waitpoints', () => {
  it('creates and resolves exactly once', () => {
    const wait = createWaitpoint({ id: 'w1', taskId: 't1', kind: 'decision', question: '开 PR 吗？', options: ['开', '先别开'], at: AT })
    assert.equal(wait.status, 'pending')
    const resolved = resolveWaitpoint(wait, { answer: '先别开', at: AT })
    assert.equal(resolved.status, 'resolved')
    assert.equal(resolved.answer, '先别开')
    assert.throws(() => resolveWaitpoint(resolved, { answer: '开', at: AT }), /resolved/)
  })
})

describe('deterministic dispatch', () => {
  it('orders by priority then id and respects deps', () => {
    const tasks = [
      createTask(spec('b', { priority: 'normal' }), { at: AT }),
      createTask(spec('a', { priority: 'high' }), { at: AT }),
      createTask(spec('dep'), { at: AT }),
      createTask(spec('c', { deps: ['dep'] }), { at: AT }),
    ].map((task) => transition(task, 'todo', { at: AT }).task)
    assert.deepEqual([...tasks].sort(compareTasks).map((task) => task.id), ['a', 'b', 'c', 'dep'])
    const plan = planDispatch(tasks, { maxActive: 3 })
    assert.deepEqual(plan.selected.map((task) => task.id), ['a'])
    assert.ok(plan.skipped.some((entry) => entry.taskId === 'c' && entry.reason === 'deps-pending'))
    assert.ok(plan.skipped.some((entry) => entry.reason === 'project-busy'))
  })

  it('respects WIP and project mutex', () => {
    const tasks = [
      createTask(spec('a'), { at: AT }),
      createTask(spec('b'), { at: AT }),
      createTask(spec('c', { projectId: 'proj-b' }), { at: AT }),
    ].map((task) => transition(task, 'todo', { at: AT }).task)
    const wip = planDispatch(tasks, { maxActive: 1 })
    assert.deepEqual(wip.selected.map((task) => task.id), ['a'])
    assert.ok(wip.skipped.some((entry) => entry.reason === 'wip-limit'))
    const busy = planDispatch(tasks, { maxActive: 3, runningByProject: { 'proj-a': 1 } })
    assert.deepEqual(busy.selected.map((task) => task.id), ['c'])
    assert.ok(busy.skipped.some((entry) => entry.reason === 'project-busy'))
  })

  it('treats missing deps as not done', () => {
    const task = createTask(spec('a', { deps: ['missing'] }), { at: AT })
    assert.equal(dependenciesDone(task, new Map()), false)
  })
})

describe('handoff', () => {
  it('renders exactly five lines', () => {
    const text = buildHandoff({
      goal: '完成 CLI',
      status: '核心函数通过，CLI 未开始',
      next: '实现 tasklite/cli.py',
      evidence: ['tasklite/core.py:1', 'pytest 6/6'],
    })
    const lines = text.split('\n')
    assert.equal(lines.length, 5)
    assert.match(lines[0], /^目标：/)
    assert.match(lines[4], /^证据：/)
  })
})

import { acceptByPolicy, classifyAcceptance } from '../lib/index.js'

describe('risk-based acceptance', () => {
  it('auto-accepts verified low-risk work', () => {
    const decision = classifyAcceptance({ risk: 'low', verifierPassed: true, reversible: true })
    assert.deepEqual(decision, { mode: 'auto', reasons: [] })
  })

  it('requires a human for aesthetic/design work even when tests pass', () => {
    const decision = classifyAcceptance({ risk: 'low', verifierPassed: true, tags: ['aesthetic'] })
    assert.equal(decision.mode, 'human')
    assert.ok(decision.reasons.includes('tag:aesthetic'))
  })

  it('requires a human for high risk, irreversible or external effects', () => {
    assert.equal(classifyAcceptance({ risk: 'high', verifierPassed: true }).mode, 'human')
    assert.equal(classifyAcceptance({ risk: 'low', verifierPassed: true, reversible: false }).mode, 'human')
    assert.equal(classifyAcceptance({ risk: 'low', verifierPassed: true, externalSideEffects: true }).mode, 'human')
  })

  it('refuses policy acceptance when verification is missing', () => {
    const decision = classifyAcceptance({ risk: 'low', verifierPassed: false })
    assert.equal(decision.mode, 'human')
    assert.ok(decision.reasons.includes('verification-not-passed'))
  })

  it('moves a verified low-risk in_review task to done with a policy audit event', () => {
    let task = createTask(spec('t1'), { at: AT })
    task = transition(task, 'todo', { at: AT }).task
    task = claim(task, { owner: 'w', at: AT }).task
    task = transition(task, 'in_review', { actor: 'w', at: AT }).task
    const decision = classifyAcceptance({ verifierPassed: true })
    const accepted = acceptByPolicy(task, decision, AT)
    assert.equal(accepted.task.status, 'done')
    assert.equal(accepted.task.acceptedBy, 'policy')
    assert.equal(accepted.event.actor, 'policy')
  })

  it('refuses policy acceptance for a human-required decision', () => {
    let task = createTask(spec('t1'), { at: AT })
    task = transition(task, 'todo', { at: AT }).task
    task = claim(task, { owner: 'w', at: AT }).task
    task = transition(task, 'in_review', { actor: 'w', at: AT }).task
    const decision = classifyAcceptance({ verifierPassed: true, tags: ['ux'] })
    assert.throws(() => acceptByPolicy(task, decision, AT), /HUMAN_ONLY|auto acceptance refused/)
  })
})
