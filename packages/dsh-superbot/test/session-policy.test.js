import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { decideSessionAction, formatHandoff } from '../lib/session-policy.js'

describe('decideSessionAction', () => {
  it('continues within budget', () => {
    const result = decideSessionAction({ promptTokens: 50_000, budgetTokens: 150_000 })
    assert.equal(result.action, 'continue')
    assert.equal(result.reason, 'within-budget')
  })

  it('compacts at 70% of budget', () => {
    const result = decideSessionAction({ promptTokens: 105_000, budgetTokens: 150_000 })
    assert.equal(result.action, 'compact')
    assert.equal(result.reason, 'budget-pressure')
  })

  it('hands off at 90% of budget', () => {
    const result = decideSessionAction({ promptTokens: 135_000, budgetTokens: 150_000 })
    assert.equal(result.action, 'handoff')
    assert.equal(result.reason, 'budget-exhausted')
  })

  it('hands off at any task boundary', () => {
    const result = decideSessionAction({ promptTokens: 10_000, taskBoundary: true })
    assert.equal(result.action, 'handoff')
    assert.equal(result.reason, 'task-boundary')
  })

  it('hands off after repeated compaction', () => {
    const result = decideSessionAction({ promptTokens: 10_000, compactionCount: 2 })
    assert.equal(result.action, 'handoff')
    assert.equal(result.reason, 'compaction-repeat')
  })

  it('falls back to a sane budget for invalid input', () => {
    const result = decideSessionAction({ promptTokens: 10_000, budgetTokens: -1 })
    assert.equal(result.budget, 150_000)
  })
})

describe('formatHandoff', () => {
  it('renders five lines with evidence', () => {
    const text = formatHandoff({
      goal: '完成 CLI',
      status: '核心函数通过，CLI 未开始',
      next: '实现 tasklite/cli.py',
      evidence: ['tasklite/core.py:1', 'pytest 6/6'],
    })
    const lines = text.split('\n')
    assert.equal(lines.length, 5)
    assert.match(lines[0], /^目标：/)
    assert.match(lines[4], /^证据：/)
    assert.match(lines[4], /pytest 6\/6/)
  })
})
