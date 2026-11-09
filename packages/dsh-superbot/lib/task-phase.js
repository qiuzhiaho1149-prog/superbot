/**
 * Result-oriented task phase: the boss-facing answer to "what is actually
 * happening and what happens next". Derived ONLY from the ledger (task + runs +
 * reviews + evidence coverage) so the UI never invents a state.
 *
 * Phases are intentionally few and action-oriented:
 *   needs-you  → a human decision is required (pendingHuman)
 *   rework     → latest verification failed; a new attempt is the next step
 *   auditing   → worker delivered; verifier/policy is checking machine evidence
 *   executing  → a worker run is live
 *   queued     → planned, not started
 *   done/blocked/canceled
 */

import { isRunActive } from './work-store.js'

const PHASE_META = {
  'needs-you': { label: '需你决定', tone: 'warn', order: 0 },
  stalled: { label: '疑似卡住', tone: 'danger', order: 1 },
  rework: { label: '返工', tone: 'danger', order: 2 },
  auditing: { label: '审计中', tone: 'business', order: 3 },
  executing: { label: '执行中', tone: 'business', order: 4 },
  queued: { label: '待开始', tone: 'idle', order: 5 },
  done: { label: '已完成', tone: 'success', order: 6 },
  blocked: { label: '阻塞', tone: 'danger', order: 7 },
  canceled: { label: '已取消', tone: 'idle', order: 8 },
}

const latest = (rows) => (Array.isArray(rows) && rows.length > 0 ? rows.at(-1) : undefined)

/**
 * @param {{
 *   task: Record<string, unknown>,
 *   runs?: ReadonlyArray<Record<string, unknown>>,
 *   reviews?: ReadonlyArray<Record<string, unknown>>,
 *   coverage?: {rows?: ReadonlyArray<{passed?: boolean}>},
 *   pendingReason?: string,
 * }} input
 */
export function deriveTaskPhase({ task, runs = [], reviews = [], coverage, pendingReason, now = Date.now() } = {}) {
  const status = typeof task?.status === 'string' ? task.status : 'unknown'
  const activeRuns = (Array.isArray(runs) ? runs : []).filter(isRunActive)
  const activeWorker = activeRuns.some((run) => run.agentPreset === 'superbot-worker')
  const activeVerifier = activeRuns.some((run) => run.agentPreset === 'superbot-verifier')
  const attempt = typeof task?.owner === 'string' && task.owner !== '' ? task.owner : null
  const verifierReviews = (Array.isArray(reviews) ? reviews : []).filter((review) => review.source === 'verifier'
    && (attempt === null || review.ownerRunId === undefined || review.ownerRunId === attempt))
  const latestVerifier = latest(verifierReviews)
  const latestWorkerRun = latest((Array.isArray(runs) ? runs : []).filter((run) => run.agentPreset === 'superbot-worker'))
  const evidenceRows = Array.isArray(coverage?.rows) ? coverage.rows : []
  const evidencePassed = evidenceRows.filter((row) => row.passed === true).length
  const attempts = (Array.isArray(runs) ? runs : []).filter((run) => run.agentPreset === 'superbot-worker').length

  const withAudit = (phase, reason, next) => ({
    phase,
    ...PHASE_META[phase],
    reason,
    next,
    audit: {
      state: phase === 'auditing' ? 'running' : phase === 'needs-you' || phase === 'rework' || phase === 'done' ? 'finished' : 'not-started',
      evidencePassed,
      evidenceTotal: evidenceRows.length,
      latestVerdict: latestVerifier?.verdict ?? null,
      attempts,
    },
  })

  if (status === 'done') return withAudit('done', '已通过验收', '无需操作')
  if (status === 'canceled') return withAudit('canceled', '已取消', '无需操作')
  if (status === 'blocked') return withAudit('blocked', '任务被阻塞', '需要 Manager 或你解除阻塞')
  if (typeof pendingReason === 'string' && pendingReason !== '') {
    return withAudit('needs-you', `等待你处理：${pendingReason}`, '在「待你验收」里通过/驳回')
  }
  const STALL_MS = 30 * 60 * 1000
  const stalledRun = activeRuns.find((run) => {
    const started = Date.parse(String(run.startedAt ?? ''))
    return Number.isFinite(started) && now - started > STALL_MS
  })
  if (stalledRun !== undefined) {
    return withAudit('stalled', `run ${stalledRun.runId ?? ''} 已运行超过 30 分钟无收尾`, '让 Manager 检查子线程，必要时 cancel/重派')
  }
  if (activeVerifier) return withAudit('auditing', 'verifier 正在执行验收命令并写证据', '等待自动审计结论')
  if (activeWorker) return withAudit('executing', 'worker 正在执行任务', '等待 worker 交付报告')
  const latestHumanReject = latest((Array.isArray(reviews) ? reviews : []).filter((review) => review.source === 'human' && review.verdict === 'pending' && review.decision?.reasons?.includes('human-reject')))
  if (latestHumanReject !== undefined && status === 'in_progress') {
    return withAudit('rework', '老板已退回，等待返工', '让 Manager 调用 superbot_task_rework 派新 worker')
  }
  if (latestVerifier?.verdict === 'fail') {
    return withAudit('rework', '最近一次自动审计未通过', '让 Manager 调用 superbot_task_rework 派新 worker')
  }
  if (status === 'in_review') return withAudit('auditing', '证据已齐，等待裁决/人工验收', '查看证据后决定是否通过')
  if (status === 'in_progress') {
    if (latestVerifier?.verdict === 'pass') return withAudit('auditing', 'worker 已交付，等待 policy 裁决', '运行 superbot_task_review')
    return withAudit('auditing', latestWorkerRun === undefined ? '等待派工' : 'worker 已交付，等待自动审计派工', '让 Manager 派 verifier 执行自动审计')
  }
  if (status === 'todo' || status === 'draft') return withAudit('queued', '已计划，尚未派工', '等待 Manager 派工')
  return withAudit('queued', `未知状态 ${status}`, '检查账本')
}
