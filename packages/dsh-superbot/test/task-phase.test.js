import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { deriveTaskPhase } from '../lib/task-phase.js'

const task = (overrides = {}) => ({ id: 't-1', projectId: 'ws-1', status: 'in_progress', owner: 'r-worker', ...overrides })
const worker = (overrides = {}) => ({ runId: 'r-worker', taskId: 't-1', agentPreset: 'superbot-worker', status: 'running', ...overrides })
const verifier = (overrides = {}) => ({ runId: 'r-verifier', taskId: 't-1', agentPreset: 'superbot-verifier', status: 'running', ...overrides })

describe('ledger-derived task phase', () => {
  it('executes even when an older attempt has a fail verdict', () => {
    const phase = deriveTaskPhase({
      task: task({ owner: 'r-worker' }),
      runs: [worker({ runId: 'r-worker', status: 'running' })],
      reviews: [{ source: 'verifier', verdict: 'fail', ownerRunId: 'r-worker' }],
    })
    assert.equal(phase.phase, 'executing')
  })

  it('audits while the verifier run is live', () => {
    const phase = deriveTaskPhase({
      task: task({ owner: 'r-worker' }),
      runs: [worker({ runId: 'r-worker', status: 'succeeded' }), verifier()],
      reviews: [],
    })
    assert.equal(phase.phase, 'auditing')
    assert.equal(phase.audit.state, 'running')
  })

  it('marks rework only after the audit failed and nothing is running', () => {
    const phase = deriveTaskPhase({
      task: task({ owner: 'r-worker' }),
      runs: [worker({ runId: 'r-worker', status: 'succeeded' })],
      reviews: [{ source: 'verifier', verdict: 'fail', ownerRunId: 'r-worker' }],
    })
    assert.equal(phase.phase, 'rework')
    assert.equal(phase.audit.latestVerdict, 'fail')
  })

  it('is attempt-scoped: an old attempt failure does not rework the new attempt', () => {
    const phase = deriveTaskPhase({
      task: task({ owner: 'r-new' }),
      runs: [worker({ runId: 'r-new', status: 'running' })],
      reviews: [{ source: 'verifier', verdict: 'fail', ownerRunId: 'r-old' }],
    })
    assert.equal(phase.phase, 'executing')
  })

  it('flags a stalled run so the board can surface it', () => {
    const phase = deriveTaskPhase({
      task: task({ owner: 'r-worker' }),
      runs: [worker({ runId: 'r-worker', status: 'running', startedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() })],
      reviews: [],
    })
    assert.equal(phase.phase, 'stalled')
  })

  it('gives the boss a decision phase and safe defaults', () => {
    const needsYou = deriveTaskPhase({
      task: task({ status: 'in_review', owner: 'r-worker' }),
      runs: [worker({ runId: 'r-worker', status: 'succeeded' })],
      reviews: [{ source: 'verifier', verdict: 'pass', ownerRunId: 'r-worker' }],
      pendingReason: 'policy-human-required',
    })
    assert.equal(needsYou.phase, 'needs-you')
    assert.equal(needsYou.audit.state, 'finished')
    assert.equal(deriveTaskPhase({ task: task({ status: 'done' }) }).phase, 'done')
    assert.equal(deriveTaskPhase({ task: task({ status: 'todo', owner: null }), runs: [] }).phase, 'queued')
  })
})
