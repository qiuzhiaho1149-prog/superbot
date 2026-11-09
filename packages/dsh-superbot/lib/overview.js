/**
 * Control-plane overview: the hierarchy the UI and the manager read.
 *
 *   control plane (one DSH_HOME ledger)
 *     └─ project  (= DSH workspace; the isolation boundary)
 *          ├─ threads (one ledger run = one child session; manager threads are
 *          │           the parents that dispatched them)
 *          └─ work items (requirements / specs / plans / tasks / runs /
 *                        reports / reviews / evidence)
 *
 * Pure function: takes an already-loaded WorkStore + the live project inventory
 * and returns a JSON-safe snapshot. No host calls, no writes — the HTTP route
 * and the `superbot_project_overview` tool share it.
 */

import { deriveTaskPhase } from './task-phase.js'
import { isRunActive } from './work-store.js'

const projectIdOf = (task) => (typeof task?.projectId === 'string' ? task.projectId : 'unknown-project')

const timeOf = (value) => (typeof value === 'string' && value !== '' ? value : null)

const latestOf = (rows) => {
  const sorted = [...rows].sort((left, right) => {
    const leftSeq = Number.isInteger(left?.seq) ? left.seq : null
    const rightSeq = Number.isInteger(right?.seq) ? right.seq : null
    if (leftSeq !== null && rightSeq !== null) return leftSeq - rightSeq
    return String(left.submittedAt ?? '').localeCompare(String(right.submittedAt ?? '')) || String(left.reviewId ?? '').localeCompare(String(right.reviewId ?? ''))
  })
  return sorted.at(-1)
}

/** Why a task is waiting for a human (or `null` when it is not waiting). */
export function humanWaitReason({ task, reviews, coverage }) {
  if (task?.status !== 'in_review') return null
  const latestVerifier = latestOf(reviews.filter((review) => review.source === 'verifier'))
  if (latestVerifier === undefined) {
    return { code: 'awaiting-verifier', detail: '还没有 verifier 结论' }
  }
  if (latestVerifier.verdict === 'fail') {
    return { code: 'verifier-failed', detail: `最近一次 verifier 结论是 fail（${latestVerifier.reviewId}）` }
  }
  if (latestVerifier.verdict !== 'pass') {
    return { code: 'awaiting-verifier', detail: 'verifier 结论仍是 pending' }
  }
  if (!coverage?.complete) {
    const missing = (coverage?.rows ?? []).filter((row) => row.passed !== true).map((row) => row.index)
    return {
      code: 'evidence-incomplete',
      detail: missing.length === 0 ? '没有可执行的验收命令证据' : `缺少通过证据的验收命令索引：${missing.join(', ')}`,
    }
  }
  const policy = latestOf(reviews.filter((review) => review.source === 'policy'))
  const reasons = policy?.decision?.reasons ?? []
  if (reasons.includes('verifier-sandbox-full-access') || reasons.includes('manager-sandbox-full-access')) {
    return {
      code: 'sandbox-untrusted',
      detail: '验收在 danger-full-access 下执行：证据链不可信，部署契约要求人工验收',
    }
  }
  if (policy?.decision?.mode === 'human') {
    return {
      code: 'policy-human-required',
      detail: `策略要求人工验收：${reasons.join(', ') || 'high-risk'}`,
    }
  }
  return { code: 'awaiting-human', detail: '证据齐备，等待人工验收' }
}

/**
 * @param {{store: import('./work-store.js').WorkStore, projects?: ReadonlyArray<Record<string, unknown>>, generatedAt?: string, projectId?: string}} input
 */
export function buildOverview({ store, projects = [], generatedAt, projectId, filter, sort, q } = {}) {
  if (store === undefined) throw new Error('overview requires a work store')
  const inventory = new Map()
  for (const project of Array.isArray(projects) ? projects : []) {
    const id = String(project.workspaceId ?? project.path ?? '')
    if (id === '') continue
    inventory.set(id, {
      projectId: id,
      title: typeof project.title === 'string' && project.title !== '' ? project.title : id,
      path: typeof project.path === 'string' ? project.path : null,
      phase: project.phase ?? null,
      sessionCount: Number.isInteger(project.sessions) ? project.sessions : null,
      inInventory: true,
    })
  }

  const tasks = store.listTasks()
  const requirements = store.listRequirements()
  const plans = store.listPlans()
  const runs = store.listRuns()
  const reports = store.listReports()
  const reviews = store.listReviews()
  const evidence = store.listEvidence()
  const runsByTask = new Map()
  for (const run of runs) {
    if (run.taskId === undefined) continue
    const list = runsByTask.get(run.taskId) ?? []
    list.push(run)
    runsByTask.set(run.taskId, list)
  }
  const reviewsByTask = new Map()
  for (const review of reviews) {
    const list = reviewsByTask.get(review.taskId) ?? []
    list.push(review)
    reviewsByTask.set(review.taskId, list)
  }
  const evidenceByTaskIndex = new Map()
  for (const row of evidence) {
    const map = evidenceByTaskIndex.get(row.taskId) ?? new Map()
    map.set(row.index, row)
    evidenceByTaskIndex.set(row.taskId, map)
  }
  const coverageCache = new Map()
  const coverageFor = (task) => {
    if (coverageCache.has(task.id)) return coverageCache.get(task.id)
    const commands = Array.isArray(task.acceptanceCommands) ? task.acceptanceCommands : []
    const attempt = typeof task.owner === 'string' && task.owner !== '' ? task.owner : undefined
    const latest = evidenceByTaskIndex.get(task.id) ?? new Map()
    const rows = commands.map((entry, index) => {
      const candidate = latest.get(index)
      const evidenceRow = attempt === undefined || candidate === undefined || candidate.ownerRunId === undefined || candidate.ownerRunId === attempt ? candidate : undefined
      const expectedExitCode = entry.expectExitCode ?? 0
      const passed = evidenceRow !== undefined && evidenceRow.timedOut !== true && evidenceRow.exitCode === expectedExitCode
      return { index, command: entry.command, expectedExitCode, evidenceId: evidenceRow?.evidenceId ?? null, runId: evidenceRow?.runId ?? null, exitCode: evidenceRow?.exitCode ?? null, passed }
    })
    const coverage = { commandCount: rows.length, hasCommands: rows.length > 0, complete: rows.length > 0 && rows.every((row) => row.passed), rows }
    coverageCache.set(task.id, coverage)
    return coverage
  }
  const specs = []
  for (const requirement of requirements) {
    for (const spec of store.listSpecs({ requirementId: requirement.id })) specs.push(spec)
  }

  // Ledger entities may reference a project no longer in the inventory; keep
  // them visible (inInventory=false) instead of silently dropping the history.
  const ledgerProjectIds = new Set()
  for (const requirement of requirements) if (typeof requirement.projectId === 'string') ledgerProjectIds.add(requirement.projectId)
  for (const task of tasks) if (typeof task.projectId === 'string') ledgerProjectIds.add(task.projectId)
  for (const run of runs) if (typeof run.workspaceId === 'string') ledgerProjectIds.add(run.workspaceId)
  for (const id of ledgerProjectIds) {
    if (inventory.has(id)) continue
    inventory.set(id, { projectId: id, title: id, path: null, phase: null, sessionCount: null, inInventory: false })
  }

  const taskStatusCounts = (rows) => {
    const counts = { draft: 0, todo: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0, canceled: 0 }
    for (const row of rows) if (counts[row.status] !== undefined) counts[row.status] += 1
    return counts
  }

  const rows = []
  for (const project of inventory.values()) {
    if (projectId !== undefined && project.projectId !== projectId) continue
    const projectTasks = tasks.filter((task) => task.projectId === project.projectId)
    const taskIds = new Set(projectTasks.map((task) => task.id))
    const projectRequirements = requirements.filter((requirement) => requirement.projectId === project.projectId)
    const requirementIds = new Set(projectRequirements.map((requirement) => requirement.id))
    const projectSpecs = specs.filter((spec) => requirementIds.has(spec.requirementId))
    const projectPlans = plans.filter((plan) => requirementIds.has(plan.requirementId))
    const projectRuns = runs.filter((run) => (run.taskId !== undefined && taskIds.has(run.taskId)) || run.workspaceId === project.projectId)
    const projectReports = reports.filter((report) => report.taskId !== undefined && taskIds.has(report.taskId))
    const projectReviews = reviews.filter((review) => taskIds.has(review.taskId))
    const projectEvidence = evidence.filter((row) => taskIds.has(row.taskId))
    const statusCounts = taskStatusCounts(projectTasks)

    const waiting = []
    for (const task of projectTasks.filter((row) => row.status === 'in_review')) {
      const taskReviews = projectReviews.filter((review) => review.taskId === task.id)
      const coverage = coverageFor(task)
      const reason = humanWaitReason({ task, reviews: taskReviews, coverage })
      if (reason === null) continue
      const workerRun = projectRuns
        .filter((run) => run.taskId === task.id && run.agentPreset === 'superbot-worker')
        .sort((left, right) => String(left.startedAt ?? '').localeCompare(String(right.startedAt ?? '')))
        .at(-1)
      waiting.push({
        taskId: task.id,
        title: task.title,
        owner: task.owner ?? null,
        workerRunId: workerRun?.runId ?? null,
        workerChildId: workerRun?.childId ?? null,
        reason: reason.code,
        detail: reason.detail,
        priority: task.priority ?? 'normal',
        risk: task.risk ?? null,
        updatedAt: task.updatedAt ?? null,
        latestVerifierReviewId: latestOf(taskReviews.filter((review) => review.source === 'verifier'))?.reviewId ?? null,
        evidenceComplete: coverage.complete,
        commandCount: coverage.commandCount,
      })
    }

    const RISK_WEIGHT = { high: 0, normal: 1, low: 2 }
    waiting.sort((left, right) => {
      const byPriority = (RISK_WEIGHT[left.priority] ?? 1) - (RISK_WEIGHT[right.priority] ?? 1)
      if (byPriority !== 0) return byPriority
      return String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')) || left.taskId.localeCompare(right.taskId)
    })

    const threads = projectRuns
      .map((run) => ({
        runId: run.runId,
        taskId: run.taskId ?? null,
        childId: run.childId ?? null,
        parentSessionId: run.parentSessionId ?? null,
        agentPreset: run.agentPreset ?? null,
        label: run.label ?? null,
        taskTitle: run.taskId === undefined ? null : (store.getTask(run.taskId)?.title ?? null),
        status: run.status,
        active: isRunActive(run),
        startedAt: timeOf(run.startedAt),
        finishedAt: timeOf(run.finishedAt),
      }))
      .sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')))

    const lastActivityAt = [
      ...projectRequirements.map((row) => row.submittedAt),
      ...projectTasks.map((row) => row.updatedAt),
      ...projectRuns.map((row) => row.finishedAt ?? row.startedAt),
      ...projectReports.map((row) => row.submittedAt),
      ...projectReviews.map((row) => row.submittedAt),
    ].filter((value) => typeof value === 'string').sort().at(-1) ?? null

    const openTaskRows = projectTasks
      .filter((task) => task.status !== 'done' && task.status !== 'canceled')
      .sort((left, right) => {
        const order = { in_review: 0, blocked: 1, in_progress: 2, todo: 3, draft: 4 }
        const byStatus = (order[left.status] ?? 9) - (order[right.status] ?? 9)
        if (byStatus !== 0) return byStatus
        return String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
      })
      .slice(0, 20)
      .map((task) => ({
        taskId: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        owner: task.owner ?? null,
        risk: task.risk ?? null,
        updatedAt: task.updatedAt ?? null,
        acceptanceCommands: Array.isArray(task.acceptanceCommands) ? task.acceptanceCommands.length : 0,
      }))

    rows.push({
      ...project,
      confirmedStatus: store.confirmedProjectStatus?.(projectId) ?? null,
      counts: {
        requirements: projectRequirements.length,
        specs: projectSpecs.length,
        plans: projectPlans.length,
        tasks: { total: projectTasks.length, ...statusCounts },
        runs: { total: projectRuns.length, active: projectRuns.filter(isRunActive).length },
        reports: projectReports.length,
        reviews: projectReviews.length,
        evidence: projectEvidence.length,
        threads: threads.length,
      },
      activeRuns: threads.filter((thread) => thread.active),
      threads,
      pendingHuman: waiting,
      openTasks: openTaskRows,
      attention: waiting.length > 0,
      lastActivityAt,
      taskIds: [...taskIds],
    })
  }

  const allRows = rows
  const query = typeof q === 'string' ? q.trim().toLowerCase() : ''
  const normalizedFilter = ['all', 'attention', 'active', 'idle'].includes(filter) ? filter : 'all'
  const normalizedSort = ['activity', 'attention', 'name'].includes(sort) ? sort : 'activity'
  const matchesFilter = (row) => {
    if (normalizedFilter === 'all') return true
    if (normalizedFilter === 'attention') return row.pendingHuman.length > 0
    if (normalizedFilter === 'active') return row.counts.runs.active > 0 || row.counts.tasks.in_progress > 0
    return row.pendingHuman.length === 0 && row.counts.runs.active === 0 && row.counts.tasks.in_progress === 0
  }
  const matchesQuery = (row) => query === '' || String(row.title).toLowerCase().includes(query) || String(row.path ?? '').toLowerCase().includes(query)
  const visible = allRows.filter((row) => matchesFilter(row) && matchesQuery(row))
  visible.sort((left, right) => {
    if (normalizedSort === 'name') return left.title.localeCompare(right.title)
    if (normalizedSort === 'attention') {
      const byPending = right.pendingHuman.length - left.pendingHuman.length
      if (byPending !== 0) return byPending
      const byActive = right.counts.runs.active - left.counts.runs.active
      if (byActive !== 0) return byActive
    }
    return String(right.lastActivityAt ?? '').localeCompare(String(left.lastActivityAt ?? '')) || left.title.localeCompare(right.title)
  })

  const projectTitleById = new Map(allRows.map((row) => [row.projectId, row.title]))
  const latestThreadByTask = new Map()
  for (const row of allRows) {
    for (const thread of Array.isArray(row.threads) ? row.threads : []) {
      if (typeof thread.taskId !== 'string') continue
      const previous = latestThreadByTask.get(thread.taskId)
      if (previous === undefined || String(thread.startedAt ?? '') > String(previous.startedAt ?? '')) latestThreadByTask.set(thread.taskId, thread)
    }
  }
  const pendingReasonByTask = new Map()
  for (const row of allRows) {
    for (const item of row.pendingHuman) pendingReasonByTask.set(item.taskId, item.reason)
  }
  const taskRows = (Array.isArray(tasks) ? tasks : [])
    .map((task) => {
      const thread = latestThreadByTask.get(task.id)
      const phase = deriveTaskPhase({
        task,
        runs: runsByTask.get(task.id) ?? [],
        reviews: reviewsByTask.get(task.id) ?? [],
        coverage: coverageFor(task),
        pendingReason: pendingReasonByTask.get(task.id),
      })
      return {
        taskId: task.id,
        title: task.title,
        projectId: task.projectId,
        projectTitle: projectTitleById.get(task.projectId) ?? task.projectId,
        status: task.status,
        priority: task.priority ?? 'normal',
        owner: task.owner ?? null,
        createdAt: task.createdAt ?? null,
        updatedAt: task.updatedAt ?? null,
        acceptanceCommands: Array.isArray(task.acceptanceCommands) ? task.acceptanceCommands.length : 0,
        phase: phase.phase,
        phaseLabel: phase.label,
        phaseOrder: phase.order,
        phaseReason: phase.reason,
        phaseNext: phase.next,
        audit: phase.audit,
        ...(thread === undefined ? {} : {
          thread: {
            runId: thread.runId ?? null,
            childId: thread.childId ?? null,
            agentPreset: thread.agentPreset ?? null,
            status: thread.status ?? null,
            active: thread.active === true,
            startedAt: thread.startedAt ?? null,
          },
        }),
      }
    })
    .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')) || String(left.taskId).localeCompare(String(right.taskId)))
    .slice(0, 200)
  const attention = allRows.flatMap((row) => row.pendingHuman.map((item) => ({
    ...item,
    projectId: row.projectId,
    projectTitle: row.title,
  })))

  const totals = {
    projects: allRows.length,
    requirements: allRows.reduce((sum, row) => sum + row.counts.requirements, 0),
    plans: allRows.reduce((sum, row) => sum + row.counts.plans, 0),
    tasks: allRows.reduce((sum, row) => sum + row.counts.tasks.total, 0),
    tasksByStatus: allRows.reduce((acc, row) => {
      for (const [status, count] of Object.entries(row.counts.tasks)) {
        if (status === 'total') continue
        acc[status] = (acc[status] ?? 0) + count
      }
      return acc
    }, {}),
    activeRuns: allRows.reduce((sum, row) => sum + row.counts.runs.active, 0),
    reports: allRows.reduce((sum, row) => sum + row.counts.reports, 0),
    reviews: allRows.reduce((sum, row) => sum + row.counts.reviews, 0),
    evidence: allRows.reduce((sum, row) => sum + row.counts.evidence, 0),
    pendingHuman: allRows.reduce((sum, row) => sum + row.pendingHuman.length, 0),
    threads: allRows.reduce((sum, row) => sum + row.counts.threads, 0),
  }

  return {
    generatedAt: typeof generatedAt === 'string' ? generatedAt : new Date().toISOString(),
    controlPlane: { schemaVersion: store.stats().schemaVersion, stateDir: store.stateDir, events: store.stats().events },
    projects: visible,
    attention,
    tasks: projectId === undefined ? taskRows : taskRows.filter((task) => task.projectId === projectId),
    taskCount: Array.isArray(tasks) ? tasks.length : taskRows.length,
    view: { filter: normalizedFilter, sort: normalizedSort, q: query, matchedProjects: visible.length, totalProjects: allRows.length },
    totals,
    isolation: {
      projectBoundary: 'task.projectId == DSH workspaceId; a run cwd is its task project path',
      threadBoundary: 'one run = one child session; parentSessionId records the manager thread that dispatched it',
      ledger: 'one append-only ledger per DSH_HOME; per-project counts are projections, not separate files',
      evidence: 'only a verifier run can record evidence, and only for declared acceptanceCommands',
    },
  }
}
