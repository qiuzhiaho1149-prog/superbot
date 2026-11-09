/**
 * Worker / verifier dispatch.
 *
 * DSH 0.2.1-rc.5: `subagents.startActivation({ provider, label, request })` with
 * `request.agentPreset` mounts that preset independently of the parent
 * (`dsh-subagent`: `applyChildComposition()` mounts the named preset and only
 * joins the parent's generation when `agentPreset` is omitted). This tool never
 * omits it: a dispatched child always runs the worker or verifier preset, so it
 * cannot inherit the manager's persona/tool surface.
 *
 * Two callers share one implementation:
 * - `superbot_dispatch_worker` / `superbot_dispatch_verifier` (explicit prompt);
 * - `superbot_plan_dispatch` (`lib/planning-tools.js`), which passes a taskId and
 *   lets this module generate the task brief from the ledger.
 *
 * With a taskId the brief is self-contained (task id/title/acceptance/deps and
 * project boundary) and the run is bound to that task. A task may have at most
 * one active run: that is the double-dispatch guard, since a worker claims the
 * task only after it starts. Every dispatch is recorded in the work ledger
 * before the child starts and closed when its result (or failure) is known.
 */

import { relative, resolve, isAbsolute } from 'node:path'

import { acceptByPolicy, classifyAcceptance } from './task-engine.js'

import { PRESET_IDS, TOOL_NAMES } from './roles.js'
import { fingerprintWorkspace } from './workspace-snapshot.js'
import { isRunActive } from './work-store.js'
import { readProjects } from './workspace-service.js'

const textRender = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
const objectOutput = { schema: { type: 'object', additionalProperties: true }, render: textRender }

export const NO_PRESET_SERVICE = 'dispatch requires the agent-presets service: this profile has no preset registry (headless/legacy composition). Run dispatch from a preset surface (web/desktop) with the superbot-manager preset.'

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

/** Extract readable text from a settled child result for the ledger summary. */
export function summarizeActivationResult(result) {
  if (result === undefined || result === null) return ''
  const blocks = Array.isArray(result.output) ? result.output : []
  // `output` is the child's FINAL assistant message; it may still contain
  // reasoning blocks. Only answer text is a report — reasoning is not.
  const text = blocks
    .map((block) => (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((part) => part.trim() !== '')
    .join('\n')
  if (text !== '') return text.length <= 4000 ? text : `${text.slice(0, 3999)}…`
  try {
    const serialized = JSON.stringify(result)
    return serialized.length <= 4000 ? serialized : `${serialized.slice(0, 3999)}…`
  } catch {
    return ''
  }
}

/** Status of a settled activation: `error` stop reason means the child failed. */
export function runStatusOf(result) {
  if (result !== null && typeof result === 'object' && result.stopReason === 'error') return 'failed'
  return 'succeeded'
}

/**
 * Build the self-contained child brief for one ledger task.
 *
 * The manager's conversation is deliberately NOT included: only ledger facts
 * (task, acceptance, deps, project boundary) plus an optional extra note. This
 * is the only context the child gets besides its own preset/filesystem.
 *
 * @param {Record<string, unknown>} task
 * @param {{
 *   store?: import('./work-store.js').WorkStore,
 *   workspaceId: string,
 *   cwd?: string,
 *   runId?: string,
 *   note?: string,
 *   kind?: 'worker'|'verifier',
 * }} options
 * @returns {string}
 */
export function buildTaskBrief(task, { store, workspaceId, cwd, runId, note, kind = 'worker' } = {}) {
  const lines = []
  const role = kind === 'verifier' ? 'verifier（只读验收）' : 'worker（执行）'
  const commands = Array.isArray(task.acceptanceCommands) ? task.acceptanceCommands : []
  const constraints = Array.isArray(task.constraints) ? task.constraints : []
  const nonGoals = Array.isArray(task.nonGoals) ? task.nonGoals : []

  lines.push(`# 任务 ${task.id}: ${task.title}`)
  lines.push('')
  lines.push(`你是这个任务的 ${role}。你只看到这份 brief 和项目文件；你看不到 manager 的会话、角色设定或情绪，也不需要它们。`)
  lines.push('这份 brief 是工作合约：按事实、证据和命令输出工作，不要用角色口吻或主观叙述替代结果。')
  lines.push('')
  lines.push('## 1. 项目边界（硬约束）')
  lines.push(`- workspaceId: ${workspaceId}`)
  if (isNonEmptyString(cwd)) lines.push(`- 工作目录: ${cwd}`)
  lines.push('- 只在该项目内改动；不要访问其他项目、真实用户 profile、凭据或全局配置。')
  lines.push('- 不要新建/切换分支或 worktree，除非 brief 明确要求。')
  lines.push('')
  lines.push('## 2. 背景与目标')
  if (isNonEmptyString(task.context)) {
    lines.push(task.context.trim())
  } else {
    lines.push(task.title)
  }
  lines.push('')
  lines.push('## 3. 范围与非目标')
  if (constraints.length > 0) {
    lines.push('范围/约束：')
    for (const item of constraints) lines.push(`- ${item}`)
  } else {
    lines.push('- 范围：完成验收项所需的最小改动。')
  }
  if (nonGoals.length > 0) {
    lines.push('非目标（明确不做）：')
    for (const item of nonGoals) lines.push(`- ${item}`)
  } else {
    lines.push('- 非目标：不重构、不改依赖、不改与本任务无关的文件。')
  }
  lines.push('')
  lines.push('## 4. 验收（全部满足；不能自行放宽）')
  for (const item of task.acceptance ?? []) lines.push(`- [ ] ${item}`)
  if (commands.length > 0) {
    lines.push('')
    lines.push('机器验收命令（唯一可被接受的证据来源；命令文本来自账本，不可改写、不可替换）：')
    commands.forEach((entry, index) => {
      lines.push(`- [${index}] \`${entry.command}\`（期望退出码 ${entry.expectExitCode ?? 0}）`)
    })
  }
  lines.push('')
  const deps = Array.isArray(task.deps) ? task.deps : []
  lines.push('## 5. 依赖')
  if (deps.length === 0) {
    lines.push('- 无')
  } else {
    const byId = typeof store?.getTask === 'function' ? store : undefined
    for (const dep of deps) {
      const depTask = byId?.getTask(dep)
      lines.push(`- ${dep} (${depTask?.status ?? 'unknown'}): ${depTask?.title ?? '未记录'}`)
    }
  }
  if (task.risk !== undefined || (Array.isArray(task.tags) && task.tags.length > 0) || task.reversible !== undefined || task.externalSideEffects !== undefined) {
    lines.push('')
    lines.push('## 6. 风险与变更属性')
    if (task.risk !== undefined) lines.push(`- 风险等级: ${task.risk}`)
    if (task.reversible !== undefined) lines.push(`- 可逆: ${task.reversible === true ? '是' : '否'}`)
    if (task.externalSideEffects !== undefined) lines.push(`- 外部副作用: ${task.externalSideEffects === true ? '有' : '无'}`)
    if (Array.isArray(task.tags) && task.tags.length > 0) lines.push(`- 标签: ${task.tags.join(', ')}`)
  }
  lines.push('')
  if (kind === 'verifier') {
    lines.push('## 7. 工作流程（唯一合法的验收方式）')
    lines.push('1. 用 superbot_task_get / superbot_report_list / superbot_run_list 读取任务、报告与运行记录。它们只是**背景**，worker 的自测输出不算证据。')
    lines.push(`2. 对每条机器验收命令调用 superbot_acceptance_run：{"taskId": "${task.id}", "index": <索引>}；工具会在项目目录执行账本里的命令并写 evidence。`)
    lines.push(`3. 用 superbot_review_submit 提交结论：{"taskId": "${task.id}", "verdict": "pass"|"fail", "evidenceIds": ["ev-..."]}。pass 必须覆盖全部命令索引，且只能引用你本次会话产生的 evidence。`)
    lines.push('4. 不修改任务状态、不派工、不修改任何项目文件（包括测试与验收脚本）。')
    lines.push('')
    lines.push('## 8. 报告格式（工作语域）')
    lines.push('- 每条验收命令：命令、exitCode、关键输出摘要、evidenceId。')
    lines.push('- 结论：pass/fail + 依据；若 fail，给出可复现的失败原因与建议修复点，不替 worker 修。')
    lines.push('- 如发现验收 harness 被动过（测试/package/lockfile 与工作区指纹不一致），直接 fail 并说明。')
  } else {
    lines.push('## 7. 工作流程')
    lines.push(`1. 用 superbot_task_claim 认领任务：{"id": "${task.id}", "owner": "${runId ?? 'worker'}"}。`)
    lines.push(`2. 按范围完成工作；可在本地跑测试自检，但自测结果只是说明，不是验收证据。`)
    lines.push(`3. 完成后用 superbot_task_report 记录：{"taskId": "${task.id}", "runId": "${runId ?? ''}", "summary": "...", "evidence": ["实际跑过的命令 + 结果"]}。`)
    lines.push('4. 不要自行把任务标成完成；不要修改验收命令、测试文件或 package 清单来"变绿"。')
    lines.push('')
    lines.push('## 8. 报告格式（工作语域）')
    lines.push('- summary：改了什么、为什么这样改（不超过 5 行）。')
    lines.push('- 变更文件：路径 + 变更类型（新增/修改/删除）。')
    lines.push('- 实际执行的命令与结果（含 exitCode；失败也如实写）。')
    lines.push('- 剩余风险/未完成项/需要 manager 决策的点。')
    lines.push('- 不写角色口吻、不写情绪叙述；用事实与输出说话。')
  }
  lines.push('')
  lines.push('## 9. 失败处理')
  lines.push('- 任何一步失败：停止扩展范围，保留现场（命令、输出、文件），在报告里写清 blocker 与已尝试路径。')
  lines.push('- 不要为了通过验收而放宽断言、跳过测试、修改验收命令或包装输出；这些会被账本的工作区指纹识别。')
  if (isNonEmptyString(note)) {
    lines.push('')
    lines.push('## 10. manager 的额外指示')
    lines.push(note.trim())
  }
  return lines.join('\n')
}

/**
 * One dispatcher instance shared by dispatch tools and plan dispatch.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{provider?: string, store?: import('./work-store.js').WorkStore}} [options]
 */
export function createDispatcher(ctx, options = {}) {
  const provider = options.provider ?? 'spawn'
  const store = options.store
  const service = (name) => (typeof ctx?.get === 'function' ? ctx.get(name) : undefined)

  /** The child must mount our preset explicitly; never inherit the caller's. */
  const requireSurface = (exec) => {
    const presets = service('agentPresets')
    if (presets === undefined) throw new Error(NO_PRESET_SERVICE)
    if (exec?.agent === undefined) throw new Error('dispatch requires a calling agent')
    const current = typeof presets.composedPreset === 'function' && exec.agent.ctx !== undefined
      ? presets.composedPreset(exec.agent.ctx)
      : undefined
    if (current !== PRESET_IDS.manager) {
      throw new Error(`dispatch is manager-only (calling preset: ${current ?? 'none'}); select the superbot-manager preset in this session`)
    }
  }

  /** True when the project directory is an ancestor of (or contains) the ledger state dir. */
  const stateDirInsideProject = (projectPath) => {
    if (!isNonEmptyString(projectPath) || !isNonEmptyString(store?.stateDir)) return false
    const rel = relative(resolve(projectPath), resolve(store.stateDir))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }

  const findProject = (workspaceId) => {
    const inventory = readProjects(ctx)
    return inventory.projects.find((item) => item.workspaceId === workspaceId)
  }

  /** Task-bound dispatch preconditions, evaluated before any ledger write. */
  const precheckTask = (kind, task, args) => {
    if (kind === 'worker' && task.status !== 'todo') {
      throw new Error(`task ${task.id} is ${task.status}; only a planned (todo) task can be dispatched to a worker`)
    }
    const confirmed = store.confirmedProjectStatus?.(task.projectId)
    // A user-declared paused/archived project always blocks, regardless of the
    // onboarding escape hatch: the confirmation is a standing user decision.
    if (confirmed !== undefined && confirmed !== 'active') {
      throw new Error(`project ${task.projectId} is marked ${confirmed} in the confirmed inventory; dispatch is blocked until the user re-confirms it as active (reason: project-${confirmed})`)
    }
    if (confirmed === undefined && options.getConfig?.()?.requireOnboarding !== false) {
      throw new Error(`project ${task.projectId} has not been confirmed in the onboarding inventory; scan + confirm before dispatching (reason: project-not-confirmed)`)
    }
    if (kind === 'verifier') {
      const ownerRun = typeof task.owner === 'string' ? store.getRun(task.owner) : undefined
      const finishedWorker = ownerRun !== undefined
        && ownerRun.agentPreset === 'superbot-worker'
        && ownerRun.taskId === task.id
        && !isRunActive(ownerRun)
      if (!finishedWorker) {
        throw new Error(`task ${task.id} has no finished worker attempt (owner=${String(task.owner ?? 'none')}); dispatch a worker and let it finish before verification`)
      }
    }
    const activeRun = store.listRuns({ taskId: task.id }).find(isRunActive)
    if (activeRun !== undefined) {
      throw new Error(`task ${task.id} already has an unfinished run (${activeRun.runId}); finish or collect it before dispatching again`)
    }
    if (args.workspaceId !== undefined && args.workspaceId !== task.projectId) {
      throw new Error(`task ${task.id} belongs to project ${task.projectId}, not ${args.workspaceId}`)
    }
  }

  const dispatch = async (kind, args, exec) => {
    const agentPreset = kind === 'worker' ? PRESET_IDS.worker : PRESET_IDS.verifier
    requireSurface(exec)
    // S5.2 first-run gate: a fresh installation must inventory + confirm the
    // user's existing projects before dispatching anything.
    if (options.getConfig?.()?.requireOnboarding !== false && store?.getInventoryConfirmation?.() === undefined) {
      throw new Error('首次接入尚未确认盘点：先调用 superbot_onboarding_scan 并向用户确认进行中/挂起项目（面板「首次接入盘点」），再派工')
    }
    const task = args.taskId === undefined ? undefined : store?.getTask(args.taskId)
    if (args.taskId !== undefined) {
      if (task === undefined) throw new Error(`unknown task: ${args.taskId}`)
      precheckTask(kind, task, args)
    }
    const note = isNonEmptyString(args.prompt) ? String(args.prompt) : undefined
    if (task === undefined && note === undefined) throw new Error('prompt is required when taskId is omitted')
    const requestedWorkspaceId = isNonEmptyString(args.workspaceId) ? args.workspaceId : task?.projectId
    if (requestedWorkspaceId === undefined) throw new Error('workspaceId is required when taskId is omitted')
    const project = findProject(requestedWorkspaceId)
    if (project === undefined) throw new Error(`unknown workspace: ${requestedWorkspaceId}`)
    if (stateDirInsideProject(project.path)) {
      throw new Error(`workspace ${project.workspaceId} contains the Superbot ledger stateDir; refusing to dispatch into the ledger boundary (D3)`)
    }
    // A project has at most one active writer, regardless of entry point.
    if (kind === 'worker' && task !== undefined) {
      const activeWriter = store.listRuns().find((run) => isRunActive(run)
        && run.agentPreset === PRESET_IDS.worker
        && run.taskId !== task.id
        && ((run.workspaceId === project.workspaceId) || (run.taskId !== undefined && store.getTask(run.taskId)?.projectId === project.workspaceId)))
      if (activeWriter !== undefined) {
        throw new Error(`project ${project.workspaceId} already has an active writer run ${activeWriter.runId}; one project allows one writer at a time`)
      }
    }
    const subagents = service('subagents')
    if (subagents?.startActivation === undefined) throw new Error('subagents service is unavailable')
    const label = isNonEmptyString(args.label)
      ? args.label.trim()
      : (task === undefined ? `${kind}:${project.title}` : `${kind}:${task.id}`)
    // Capture the acceptance-integrity baseline BEFORE the child starts so a
    // later verifier can prove the test harness was not rewritten by the worker.
    let baseline
    try {
      baseline = fingerprintWorkspace(project.path)
    } catch {
      baseline = undefined
    }
    const run = store?.startRun({
      taskId: args.taskId,
      agentPreset,
      workspaceId: project.workspaceId,
      label,
      parentSessionId: exec?.agent?.id,
      workspacePath: project.path,
      ...(baseline === undefined ? {} : {
        baselineWorkspaceDigest: baseline.digest,
        baselineProtectedDigest: baseline.protectedDigest,
      }),
      actor: 'manager',
      reason: `dispatch-${kind}`,
    })
    const promptText = task === undefined
      ? note
      : buildTaskBrief(task, {
          store,
          workspaceId: project.workspaceId,
          cwd: project.path,
          runId: run?.runId,
          note: args.prompt,
          kind,
        })
    const request = {
      parent: exec.agent,
      cwd: project.path,
      prompt: [{ type: 'text', text: promptText }],
      // Always explicit: an omitted preset would join the parent's generation.
      agentPreset,
    }
    let activation
    try {
      activation = await subagents.startActivation({ provider, label, request, signal: exec.signal, delivery: 'parent' })
    } catch (error) {
      if (run !== undefined) {
        try { store.finishRun(run.runId, { status: 'failed', summary: String(error?.message ?? error), actor: 'manager', reason: 'dispatch-failed' }) } catch { /* audit best effort */ }
      }
      throw error
    }
    if (run !== undefined && typeof activation?.childId === 'string') {
      try { store.bindRun(run.runId, { childId: activation.childId, label, actor: 'manager' }) } catch { /* audit best effort */ }
    }
    const base = {
      childId: activation?.childId,
      runId: run?.runId,
      label,
      workspaceId: project.workspaceId,
      cwd: project.path,
      agentPreset,
      delivery: 'parent',
      ...(args.taskId === undefined ? {} : { taskId: args.taskId }),
    }
    // Fire-and-forget still OBSERVES its child: when the activation settles we
    // close the ledger run. Otherwise the run stays running forever and the
    // verifier gate ("finished worker attempt") deadlocks the chain.
    if (args.wait !== true) {
      if (run !== undefined && activation?.result !== undefined) {
        setImmediate(() => {
          Promise.resolve(activation.result).then((result) => {
            try { store.finishRun(run.runId, { status: runStatusOf(result), summary: summarizeActivationResult(result), actor: 'manager', reason: 'dispatch-result' }) } catch { /* best effort */ }
            if (kind === 'worker' && task !== undefined) autoAuditAfterWorker(task, exec).catch(() => {})
          }).catch((error) => {
            try { store.finishRun(run.runId, { status: 'failed', summary: String(error?.message ?? error), actor: 'manager', reason: 'dispatch-failed' }) } catch { /* best effort */ }
          })
        })
      }
      return base
    }

    let result
    try {
      result = await activation.result
    } catch (error) {
      if (run !== undefined) {
        try { store.finishRun(run.runId, { status: 'failed', summary: String(error?.message ?? error), actor: 'manager', reason: 'dispatch-failed' }) } catch { /* audit best effort */ }
      }
      throw error
    }
    const status = runStatusOf(result)
    if (run !== undefined) {
      try {
        store.finishRun(run.runId, { status, summary: summarizeActivationResult(result), actor: 'manager', reason: 'dispatch-result' })
      } catch { /* a close failure must not hide the child result */ }
    }
    if (kind === 'worker' && task !== undefined) {
      try { await autoAuditAfterWorker(task, exec) } catch { /* audit driver is best effort */ }
    }
    return { ...base, status, result }
  }

  // S0 auto-audit: a finished worker attempt with declared commands gets a
  // verifier run without waiting for a separate manager tool call. Policy
  // acceptance stays explicit (task_review) until the next driver step.
  const autoAuditAfterWorker = async (task, exec) => {
    if (options.getConfig?.()?.autoAudit !== true || task === undefined) return
    if (!Array.isArray(task.acceptanceCommands) || task.acceptanceCommands.length === 0) return
    const runs = store.listRuns({ taskId: task.id })
    if (runs.some((run) => run.agentPreset === PRESET_IDS.verifier)) return
    if (runs.some((run) => run.agentPreset === PRESET_IDS.verifier && isRunActive(run))) return
    try { await dispatch('verifier', { taskId: task.id, wait: true }, exec) } catch { /* audit failure is visible on next tick */ }
    await autoReview(task.id, exec).catch(() => {})
  }

  // Same policy rules as superbot_task_review (tools.js), run automatically after
  // the auto-dispatched verifier settles. Shared code extraction is a follow-up.
  const autoReview = async (taskId, exec) => {
    const task = store.getTask(taskId)
    if (task === undefined || ['done', 'canceled'].includes(task.status)) return
    const reviewed = task.status === 'in_progress' ? store.transitionTask(task.id, 'in_review', { actor: 'manager', reason: 'auto-review' }) : task
    const attempt = reviewed.owner ?? undefined
    const attemptRun = attempt === undefined ? undefined : store.getRun(attempt)
    const attemptIsWorkerRun = attemptRun !== undefined && attemptRun.agentPreset === PRESET_IDS.worker && attemptRun.taskId === task.id
    const latest = store.listReviews({ taskId }).filter((review) => review.source === 'verifier' && (attempt === undefined || review.ownerRunId === undefined || review.ownerRunId === attempt)).at(-1)
    const coverage = store.evidenceCoverage(taskId)
    const integrity = []
    const evidenceRows = coverage.rows.map((row) => (row.evidenceId === null ? undefined : store.getEvidence(row.evidenceId))).filter((row) => row !== undefined)
    if (!attemptIsWorkerRun) integrity.push('no-worker-attempt')
    if (evidenceRows.some((row) => row.sandboxMode === 'danger-full-access')) integrity.push('verifier-sandbox-full-access')
    if (options.getConfig?.()?.requireSandboxedEvidence === true && evidenceRows.some((row) => row.executionMode !== 'host-shell' || row.sandboxed !== true)) integrity.push('unsandboxed-evidence')
    if (options.getConfig?.()?.requireSandboxedEvidence === true && evidenceRows.some((row) => row.isolationMode !== 'copy')) integrity.push('in-place-evidence')
    let project
    try { project = findProject(task.projectId) } catch { integrity.push('project-unresolved') }
    if (project !== undefined) {
      const current = fingerprintWorkspace(project.path)
      const baselineProtected = typeof attemptRun?.baselineProtectedDigest === 'string' ? attemptRun.baselineProtectedDigest : undefined
      if (typeof baselineProtected === 'string' && baselineProtected !== current.protectedDigest) integrity.push('acceptance-harness-changed')
      const digests = new Set(evidenceRows.map((row) => row.workspaceDigest).filter((digest) => typeof digest === 'string'))
      if (digests.size === 0) integrity.push('no-workspace-fingerprint')
      else if (!digests.has(current.digest)) integrity.push('workspace-changed-since-evidence')
    }
    const verifierPassed = latest !== undefined && latest.verdict === 'pass' && coverage.complete
    const decision = classifyAcceptance({
      risk: reviewed.risk === 'low' ? 'low' : 'high',
      tags: Array.isArray(reviewed.tags) ? reviewed.tags : [],
      verifierPassed,
      reversible: reviewed.reversible === true,
      externalSideEffects: reviewed.externalSideEffects === true,
    })
    const blocking = [...decision.reasons, ...integrity]
    const auto = verifierPassed && integrity.length === 0 && decision.mode === 'auto'
    store.submitReview({
      taskId, reviewer: 'policy', reviewerRole: 'manager', verdict: auto ? 'pass' : 'pending',
      notes: `auto-audit decision: ${auto ? 'auto' : 'human'}${blocking.length === 0 ? '' : ` (${blocking.join(', ')})`}`,
      evidenceIds: coverage.rows.map((row) => row.evidenceId).filter((id) => typeof id === 'string'),
      decision: { mode: auto ? 'auto' : 'human', reasons: blocking },
      source: 'policy', reviewedOwner: reviewed.owner ?? null, actor: 'manager', reason: 'auto-review',
    })
    if (auto) store.commitAccepted(acceptByPolicy(reviewed, decision))
    return { taskId, auto }
  }

  return { dispatch, requireSurface, findProject, autoAuditAfterWorker, autoReview }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{provider?: string, store?: import('./work-store.js').WorkStore, dispatcher?: ReturnType<typeof createDispatcher>}} options
 */
export function createDispatchTools(ctx, options = {}) {
  const dispatcher = options.dispatcher ?? createDispatcher(ctx, options)
  const store = options.store
  const enabledOrThrow = () => {
    if (options.getConfig?.()?.toolsEnabled === false) throw new Error('superbot task tools are disabled in settings')
  }

  /** Failure context the next worker needs, built from the ledger (never prose-only). */
  const buildReworkNote = (task, review, coverage) => {
    const lines = []
    lines.push('# 返工说明（上一轮验收未通过）')
    lines.push('')
    lines.push(`任务 ${task.id} 的上一轮 verifier 结论：${review.verdict}（${review.reviewId}）`)
    if (typeof review.notes === 'string' && review.notes.trim() !== '') {
      lines.push('')
      lines.push('## 验收员记录')
      lines.push(review.notes.trim())
    }
    const failed = (coverage?.rows ?? []).filter((row) => row.passed !== true)
    if (failed.length > 0) {
      lines.push('')
      lines.push('## 失败证据（来自账本）')
      for (const row of failed) {
        const evidence = row.evidenceId === null ? undefined : store.getEvidence(row.evidenceId)
        lines.push(`- [${row.index}] \`${row.command}\` exitCode=${String(row.exitCode)}; evidence=${String(row.evidenceId ?? 'none')}`)
        if (typeof evidence?.preview === 'string' && evidence.preview.trim() !== '') {
          lines.push('```')
          lines.push(evidence.preview.slice(0, 1200))
          lines.push('```')
        }
      }
    }
    lines.push('')
    lines.push('## 返工要求')
    lines.push('1. 只修复导致失败的原因；先复现失败，再改代码。')
    lines.push('2. 不得修改测试、验收命令、package/依赖清单来变绿；这些会被工作区指纹识别。')
    lines.push('3. 完成后重新写 superbot_task_report，列出实际执行的命令与 exitCode。')
    return lines.join('\n')
  }

  /** Parameters shared by both dispatch tools. */
  const parameters = {
    type: 'object',
    additionalProperties: false,
    properties: {
      workspaceId: { type: 'string', description: 'DSH workspace id (from superbot_project_list). Optional when taskId is given: the task project is used.' },
      prompt: { type: 'string', description: 'Extra instructions for the child. Optional when taskId is given: the task brief is generated from the ledger. Without taskId it is required.' },
      taskId: { type: 'string', description: 'Optional ledger task to bind this run to. The child brief is generated from the task (id/title/acceptance/deps/project boundary) and a worker task must be planned (todo) with no active run.' },
      label: { type: 'string', description: 'Short display label for the run/child session.' },
      wait: { type: 'boolean', description: 'Await child completion and return its final result (default false; verifier defaults true).' },
    },
  }

  return [
    {
      name: 'superbot_dispatch_worker',
      description: 'Create a worker child session in an existing DSH workspace. The child ALWAYS runs the superbot-worker preset (no parent persona/tools inherited), so the brief must be self-contained. Pass taskId to bind a planned (todo) ledger task: the brief is generated from the task and the run is bound to it. Records a run in the work ledger; set wait=true to await the result.',
      parameters,
      output: objectOutput,
      execute(args, exec) {
        enabledOrThrow()
        return dispatcher.dispatch('worker', args, exec)
      },
    },
    {
      name: 'superbot_dispatch_verifier',
      description: 'Create a read-only verifier child session in an existing DSH workspace. The child ALWAYS runs the superbot-verifier preset (read-only filesystem, no shell, no dispatch) and records a run in the work ledger; waits for the verdict by default. Pass taskId to bind the verification to a ledger task.',
      parameters,
      output: objectOutput,
      execute(args, exec) {
        enabledOrThrow()
        return dispatcher.dispatch('verifier', { ...args, wait: args.wait !== false }, exec)
      },
    },
    {
      name: TOOL_NAMES.taskRework,
      description: 'Turn a failed verification into a new worker attempt: requires the LATEST verifier verdict to be fail, transitions the task back to todo (in_review → in_progress → todo), and dispatches a worker run whose brief embeds the verifier notes, failing evidence and anti-cheat rules from the ledger. Never edits acceptance commands or tests. Returns the new run; the previous attempt stays in the ledger.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['id'],
        properties: {
          id: { type: 'string', description: 'Task id whose latest verifier verdict is fail.' },
          note: { type: 'string', description: 'Optional extra instructions appended after the ledger-derived rework context.' },
          wait: { type: 'boolean', description: 'Await the new worker run and return its final result.' },
        },
      },
      output: objectOutput,
      async execute(args, exec) {
        enabledOrThrow()
        dispatcher.requireSurface(exec)
        const task = store.getTask(args.id)
        if (task === undefined) throw new Error(`unknown task: ${String(args.id)}`)
        if (!['in_review', 'in_progress'].includes(task.status)) {
          throw new Error(`task ${task.id} is ${task.status}; rework is only possible after a failed verification (in_review/in_progress)`)
        }
        const active = store.listRuns({ taskId: task.id }).find(isRunActive)
        if (active !== undefined) throw new Error(`task ${task.id} still has an active run ${active.runId}; collect it before rework`)
        const attempt = typeof task.owner === 'string' && task.owner !== '' ? task.owner : null
        const latestVerifier = store.listReviews({ taskId: task.id })
          .filter((review) => review.source === 'verifier')
          .filter((review) => attempt === null || review.ownerRunId === attempt)
          .at(-1)
        const latestHumanReject = store.listReviews({ taskId: task.id }).filter((review) => review.source === 'human' && review.verdict === 'pending' && review.decision?.reasons?.includes('human-reject')).at(-1)
        if (latestVerifier?.verdict !== 'fail' && latestHumanReject === undefined) {
          throw new Error(`task ${task.id} has no latest verifier fail verdict and no human reject (latest: ${latestVerifier?.verdict ?? 'none'}); rework requires a real failed verification or a boss reject`)
        }
        const coverage = store.evidenceCoverage(task.id)
        const note = buildReworkNote(task, latestVerifier, coverage)
        if (task.status === 'in_review') {
          store.transitionTask(task.id, 'in_progress', { actor: 'manager', reason: 'rework-start' })
        }
        if (store.getTask(task.id).status === 'in_progress') {
          store.transitionTask(task.id, 'todo', { actor: 'manager', reason: 'rework-requeue', clearOwner: true })
        }
        try {
          const result = await dispatcher.dispatch('worker', {
            taskId: task.id,
            workspaceId: task.projectId,
            prompt: isNonEmptyString(args.note) ? `${note}\n\n## 额外指示\n${args.note.trim()}` : note,
            ...(args.wait === true ? { wait: true } : {}),
          }, exec)
          return { ...result, task: store.getTask(task.id), reworkOf: latestVerifier.reviewId }
        } catch (error) {
          throw new Error(`task ${task.id} was requeued to todo, but worker dispatch failed: ${String(error?.message ?? error)}`)
        }
      },
    },
  ]
}
