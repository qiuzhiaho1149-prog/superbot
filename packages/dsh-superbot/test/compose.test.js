import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { composeDraft } from '../lib/compose.js'

const projects = [
  { workspaceId: 'ws-1', title: '项目一', path: '/tmp/proj-1' },
  { workspaceId: 'ws-2', title: '项目二', path: '/tmp/proj-2' },
]

const base = {
  intent: '登录页在移动端点击提交后没有任何反馈，需要改成 300ms 内出现 loading 并在失败时显示可读错误。',
  projectId: 'ws-1',
  title: '修复移动端登录反馈',
  background: '线上收到 3 个用户反馈；后端接口不变。',
  acceptance: ['点击提交 300ms 内出现 loading', '失败时显示可读错误文案'],
  acceptanceCommands: ['node --test'],
  constraints: ['只改登录页组件与其样式'],
  nonGoals: ['不改后端接口', '不重做登录页视觉'],
  risk: 'low',
  reversible: true,
  externalSideEffects: false,
}

describe('structured intent composer', () => {
  it('returns a complete draft, ladder, quality score, brief and manager prompt', () => {
    const result = composeDraft(base, { projects })
    assert.equal(result.ok, true)
    assert.equal(result.errors.length, 0)
    assert.equal(result.quality.grade, 'A')
    assert.equal(result.quality.score, 100)
    assert.ok(result.tokenEstimate.brief > 0)
    assert.ok(result.tokenEstimate.managerPrompt > 0)
    assert.equal(result.autoAccept.eligible, true)
    assert.match(result.managerPrompt, /机器可读草稿/)
    assert.match(result.managerPrompt, /```json/)
    assert.equal(result.ladder.find((row) => row.level === 'L3').status, 'ok')
    assert.match(result.brief, /## 1\. 项目边界/)
    assert.match(result.brief, /## 4\. 验收/)
    assert.match(result.brief, /node --test/)
    assert.match(result.managerPrompt, /调度三原则|结构化意图/)
    assert.match(result.managerPrompt, /acceptanceCommands/)
    assert.equal(result.draft.task.projectId, 'ws-1')
    assert.equal(result.draft.task.acceptanceCommands[0].command, 'node --test')
  })

  it('accepts newline-separated list strings from a textarea form', () => {
    const result = composeDraft({ ...base, acceptance: '第一条\n第二条', constraints: 'A\nB' }, { projects })
    assert.deepEqual(result.draft.task.acceptance, ['第一条', '第二条'])
    assert.deepEqual(result.draft.task.constraints, ['A', 'B'])
  })

  it('blocks incomplete L1 drafts and caps the score', () => {
    const result = composeDraft({ intent: '帮我优化一下登录', projectId: 'ws-1' }, { projects })
    assert.equal(result.ok, false)
    assert.ok(result.blockers.length >= 2)
    assert.ok(result.errors.some((row) => row.field === 'acceptance'))
    assert.ok(result.errors.some((row) => row.field === 'acceptanceCommands'))
    assert.equal(result.quality.grade, 'D')
    assert.ok(result.quality.score <= 59)
    assert.equal(result.ladder.find((row) => row.level === 'L1').status, 'missing')
    assert.equal(result.tokenEstimate.brief, 0)
  })

  it('still warns about vague intent when the draft is structurally complete', () => {
    const result = composeDraft({ ...base, intent: '帮我优化一下登录页的提交反馈' }, { projects })
    assert.equal(result.ok, true)
    assert.ok(result.quality.warnings.some((row) => row.includes('模糊词')))
    assert.ok(result.quality.score < 100)
    assert.ok(result.autoAccept.eligible)
  })

  it('rejects unsafe command templates and unknown projects', () => {
    const unsafe = composeDraft({ ...base, acceptanceCommands: ['node -e "process.exit(0)"'] }, { projects })
    assert.equal(unsafe.ok, false)
    assert.ok(unsafe.errors.some((row) => row.field === 'acceptanceCommands'))

    const unknown = composeDraft({ ...base, projectId: 'ws-missing' }, { projects })
    assert.equal(unknown.ok, false)
    assert.ok(unknown.errors.some((row) => row.field === 'projectId'))

    const invalidRisk = composeDraft({ ...base, risk: 'critical' }, { projects })
    assert.equal(invalidRisk.ok, false)
    assert.ok(invalidRisk.errors.some((row) => row.field === 'risk'))

    const legacyRisk = composeDraft({ ...base, risk: 'normal' }, { projects })
    assert.equal(legacyRisk.ok, false)
    assert.ok(legacyRisk.errors.some((row) => row.field === 'risk'))
  })

  it('warns about low-risk declarations that hide external side effects', () => {
    const result = composeDraft({ ...base, externalSideEffects: true }, { projects })
    assert.equal(result.ok, true)
    assert.ok(result.quality.warnings.some((row) => row.includes('外部副作用')))
    assert.ok(result.quality.score < 100)
  })
})
