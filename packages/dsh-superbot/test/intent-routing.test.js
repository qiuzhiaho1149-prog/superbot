import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { matchRequirement } from '../lib/workspace-service.js'

const projects = [
  { workspaceId: 'ws-a', title: 'proj-fix', path: '/work/proj-fix', phase: 'active' },
  { workspaceId: 'ws-b', title: 'proj-fix-2', path: '/work/proj-fix-2', phase: 'active' },
  { workspaceId: 'ws-c', title: 'alpha', path: '/work/alpha', phase: 'active' },
  { workspaceId: 'ws-d', title: 'beta', path: '/work/beta', phase: 'active' },
]

describe('intent routing (deterministic project match)', () => {
  it('routes an explicit project name without asking', () => {
    const match = matchRequirement('帮我把 proj-fix 的登录页改一下', projects)
    assert.equal(match.candidates[0].workspaceId, 'ws-a')
    assert.equal(match.needsConfirmation, false)
  })

  it('asks when the user gives no project signal', () => {
    const match = matchRequirement('优化一下', projects)
    assert.equal(match.candidates.length, 0)
    assert.equal(match.needsConfirmation, true)
  })

  it('asks when two projects are close in score', () => {
    const match = matchRequirement('alpha beta 都看看', projects)
    assert.equal(match.needsConfirmation, true)
  })

  it('never invents a project for a generic sentence', () => {
    const match = matchRequirement('这个 bug 修一下，测试跑不过', projects)
    assert.equal(match.candidates.length, 0)
    assert.equal(match.needsConfirmation, true)
  })
})
