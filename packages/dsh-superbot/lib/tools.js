/**
 * Superbot tool catalog.
 *
 * Tools are thin wrappers over two host seams:
 * - `lib/work-store.js` — append-only requirement/spec/plan/task/run/report/review ledger;
 * - `lib/dispatch-tools.js` — worker/verifier child sessions with explicit presets.
 *
 * `createSuperbotTools({ role })` is the only place that assembles a tool set.
 * `lib/preset-tools.js` mounts it inside a preset (per-Agent scope);
 * `lib/global-tools.js` mounts the manager subset globally only in compositions
 * with no agent-preset registry (headless CLI).
 */

import { join } from 'node:path'

import { acceptByPolicy, buildHandoff, classifyAcceptance } from './task-engine.js'
import { buildProjectHandoff, writeProjectHandoff } from './project-handoff.js'
import { createAcceptanceWorkspace } from './acceptance-workspace.js'
import { importHistoryWork } from './history-import.js'
import { checkAcceptanceCommand, checkDeclaredCommands, commandPolicyError } from './command-policy.js'
import { createDispatchTools, createDispatcher } from './dispatch-tools.js'
import { runAcceptanceCommand } from './evidence-runner.js'
import { dshHomeOf, scanInventory } from './onboarding.js'
import { buildOverview } from './overview.js'
import { createPlanningTools } from './planning-tools.js'
import { fingerprintWorkspace } from './workspace-snapshot.js'
import { createProjectTools } from './project-tools.js'
import { ROLE_TOOLS, TOOL_NAMES, toolsForRole } from './roles.js'
import { readProjects } from './workspace-service.js'

const textRender = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
const objectOutput = { schema: { type: 'object', additionalProperties: true }, render: textRender }
const stringOutput = { schema: { type: 'string' }, render: textRender }

const enabledOrThrow = (getConfig) => {
  if (getConfig?.()?.toolsEnabled === false) throw new Error('superbot task tools are disabled in settings')
}

const requireTask = (store, id) => {
  const task = store.getTask(id)
  if (task === undefined) throw new Error(`unknown task: ${String(id)}`)
  return task
}

/**
 * Task lifecycle tools (submit/plan/list/get/claim/review/handoff).
 * @param {{getConfig?: () => Record<string, unknown>, store: import('./work-store.js').WorkStore}} options
 */
export function createTaskTools({ getConfig = () => ({}), store, ctx } = {}) {
  if (store === undefined) throw new Error('task tools require a work store')
  return [
    {
      name: TOOL_NAMES.taskSubmit,
      description: 'Submit a task as a persistent draft (append-only work ledger). It does not run until superbot_task_plan moves it to todo.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'projectId', 'priority', 'acceptance'],
        properties: {
          id: { type: 'string', description: 'Optional stable id; generated when omitted.' },
          title: { type: 'string', description: 'Short imperative title.' },
          projectId: { type: 'string', description: 'Project/workspace identifier.' },
          priority: { type: 'string', enum: ['high', 'normal', 'low'] },
          acceptance: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Acceptance criteria (human-readable).' },
          acceptanceCommands: {
            type: 'array', maxItems: 10,
            description: 'Machine-executable acceptance commands (command + optional expectExitCode); the only commands a verifier may execute as evidence.',
            items: {
              type: 'object', additionalProperties: false, required: ['command'],
              properties: {
                command: { type: 'string', minLength: 1 },
                expectExitCode: { type: 'integer' },
              },
            },
          },
          deps: { type: 'array', items: { type: 'string' } },
          risk: { type: 'string', enum: ['low', 'high'] },
          tags: { type: 'array', items: { type: 'string' } },
          reversible: { type: 'boolean' },
          externalSideEffects: { type: 'boolean' },
          context: { type: 'string', description: 'Background and goal for the executor (bounded 2000 chars).' },
          constraints: { type: 'array', items: { type: 'string' } },
          nonGoals: { type: 'array', items: { type: 'string' } },
        },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        if (Array.isArray(args.acceptanceCommands)) {
          const policy = checkDeclaredCommands([{ acceptanceCommands: args.acceptanceCommands }])
          if (!policy.ok) throw new Error(commandPolicyError(policy.rejected))
        }
        return store.submitTask({
          ...(args.id === undefined ? {} : { id: args.id }),
          title: args.title,
          projectId: args.projectId,
          priority: args.priority,
          acceptance: args.acceptance,
          ...(args.acceptanceCommands === undefined ? {} : { acceptanceCommands: args.acceptanceCommands }),
          ...(args.deps === undefined ? {} : { deps: args.deps }),
          ...(args.risk === undefined ? {} : { risk: args.risk }),
          ...(args.tags === undefined ? {} : { tags: args.tags }),
          ...(args.reversible === undefined ? {} : { reversible: args.reversible }),
          ...(args.externalSideEffects === undefined ? {} : { externalSideEffects: args.externalSideEffects }),
          ...(args.context === undefined ? {} : { context: args.context }),
          ...(args.constraints === undefined ? {} : { constraints: args.constraints }),
          ...(args.nonGoals === undefined ? {} : { nonGoals: args.nonGoals }),
        }, { actor: 'manager', reason: 'task-submit' })
      },
    },
    {
      name: TOOL_NAMES.taskPlan,
      description: 'Move a draft task to todo so it becomes dispatchable.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['id'],
        properties: { id: { type: 'string' } },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        return store.planTask(args.id, { actor: 'manager', reason: 'task-plan' })
      },
    },
    {
      name: TOOL_NAMES.taskList,
      description: 'List persisted tasks with status, priority, owner and version. Pass projectId to read one project only (projects are isolated).',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { projectId: { type: 'string', description: 'Optional DSH workspace id: only that project\'s tasks.' } },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        const tasks = store.listTasks().filter((task) => args.projectId === undefined || task.projectId === args.projectId)
        return { tasks }
      },
    },
    {
      name: TOOL_NAMES.taskGet,
      description: 'Read one persisted task by id.',
      parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        return { task: requireTask(store, args.id) }
      },
    },
    {
      name: TOOL_NAMES.taskClaim,
      description: 'Claim a todo task for an owner (optimistic version check); the claim is persisted in the ledger.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['id', 'owner'],
        properties: {
          id: { type: 'string' },
          owner: { type: 'string' },
          expectedVersion: { type: 'integer', minimum: 0 },
        },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        return store.claimTask(args.id, { owner: args.owner, expectedVersion: args.expectedVersion })
      },
    },
    {
      name: TOOL_NAMES.taskReview,
      description: 'Ask the LEDGER to evaluate acceptance: moves the task to in_review, then auto-accepts ONLY when (a) the LATEST verifier review of THIS attempt passed with complete machine evidence, (b) the workspace fingerprint still matches the evidence, (c) the task declared risk=low, reversible=true, no external side effects, and no human-required tag. All acceptance inputs come from the task snapshot — this tool has no risk/tags parameters, so the manager cannot downgrade a task at acceptance time. Otherwise the task stays in_review for a human.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['id'],
        properties: { id: { type: 'string' } },
      },
      output: objectOutput,
      execute(args, exec) {
        enabledOrThrow(getConfig)
        const task = requireTask(store, args.id)
        if (task.status !== 'in_progress' && task.status !== 'in_review') {
          throw new Error(`task ${args.id} is ${task.status}; only an in-progress or in-review task can be evaluated`)
        }
        const activeRun = store.listRuns({ taskId: task.id }).find((run) => run.status === 'running' && run.agentPreset === 'superbot-worker')
        if (activeRun !== undefined) throw new Error(`task ${args.id} still has an active run ${activeRun.runId}; wait for it to finish before evaluating`)
        const reviewed = task.status === 'in_progress'
          ? store.transitionTask(task.id, 'in_review', { actor: 'manager', reason: 'submit-for-review' })
          : task
        const attempt = reviewed.owner ?? undefined
        const attemptRun = attempt === undefined ? undefined : store.getRun(attempt)
        // A real worker attempt is the structural precondition for policy auto-
        // acceptance: a manager-typed owner string (or no worker run at all)
        // must never be able to skip the execution layer.
        const attemptIsWorkerRun = attemptRun !== undefined
          && attemptRun.agentPreset === 'superbot-worker'
          && attemptRun.taskId === task.id
        const verifierReviews = store.listReviews({ taskId: task.id })
          .filter((review) => review.source === 'verifier' && (attempt === undefined || review.ownerRunId === undefined || review.ownerRunId === attempt))
        // The LATEST verdict decides: a pass followed by a fail must not accept.
        const latest = verifierReviews.at(-1)
        const coverage = store.evidenceCoverage(task.id)

        // Workspace integrity: the harness/workspace the verifier measured must
        // still be what is on disk now.
        const integrity = []
        // Deployment contract D2: evidence produced under danger-full-access is
        // not an independent verification (the verifier could edit the ledger or
        // read credentials). Such tasks must be accepted by a human.
        const evidenceSandboxModes = coverage.rows
          .map((row) => (row.evidenceId === null ? undefined : store.getEvidence(row.evidenceId)?.sandboxMode))
          .filter((mode) => typeof mode === 'string')
        if (evidenceSandboxModes.includes('danger-full-access')) integrity.push('verifier-sandbox-full-access')
        if (resolveSandboxMode(exec?.agent, ctx) === 'danger-full-access') integrity.push('manager-sandbox-full-access')
        if (!attemptIsWorkerRun) integrity.push('no-worker-attempt')
        // D6: policy auto-accept is only defensible when the evidence command
        // ran through the host sandbox executor, not a bare child_process in the
        // plugin process (deployment config can opt out for legacy setups).
        const evidenceRows = coverage.rows
          .map((row) => (row.evidenceId === null ? undefined : store.getEvidence(row.evidenceId)))
          .filter((row) => row !== undefined)
        if (getConfig()?.requireSandboxedEvidence === true && evidenceRows.some((row) => row.executionMode !== 'host-shell' || row.sandboxed !== true)) {
          integrity.push('unsandboxed-evidence')
        }
        if (getConfig()?.requireSandboxedEvidence === true && evidenceRows.some((row) => row.isolationMode !== 'copy')) {
          integrity.push('in-place-evidence')
        }
        let project
        try {
          project = projectRootOf(ctx, task)
        } catch {
          integrity.push('project-unresolved')
        }
        if (project !== undefined) {
          const current = fingerprintWorkspace(project.path)
          // Compare against the WORKER attempt's baseline only. Falling back to
          // the verifier baseline would hide a worker who edited the tests
          // before the verifier started.
          const baselineProtected = typeof attemptRun?.baselineProtectedDigest === 'string'
            ? attemptRun.baselineProtectedDigest
            : undefined
          if (typeof baselineProtected === 'string' && baselineProtected !== current.protectedDigest) {
            integrity.push('acceptance-harness-changed')
          }
          if (current.truncated === true) integrity.push('workspace-scan-truncated')
          const digests = new Set(coverage.rows
            .map((row) => (row.evidenceId === null ? undefined : store.getEvidence(row.evidenceId)?.workspaceDigest))
            .filter((digest) => typeof digest === 'string'))
          if (digests.size === 0) integrity.push('no-workspace-fingerprint')
          else if (!digests.has(current.digest)) integrity.push('workspace-changed-since-evidence')
        }

        const verifierPassed = latest !== undefined && latest.verdict === 'pass' && coverage.complete
        // Fail-closed: acceptance facts come from the task snapshot, never from
        // manager arguments. Missing risk counts as high; missing reversible
        // counts as not-reversible.
        const decision = classifyAcceptance({
          risk: reviewed.risk === 'low' ? 'low' : 'high',
          tags: Array.isArray(reviewed.tags) ? reviewed.tags : [],
          verifierPassed,
          reversible: reviewed.reversible === true,
          externalSideEffects: reviewed.externalSideEffects === true,
        })
        const blocking = [...decision.reasons, ...integrity]
        const auto = verifierPassed && integrity.length === 0 && decision.mode === 'auto'
        const review = store.submitReview({
          taskId: task.id,
          reviewer: 'policy',
          reviewerRole: 'manager',
          verdict: auto ? 'pass' : 'pending',
          notes: `policy decision: ${auto ? 'auto' : 'human'}${blocking.length === 0 ? '' : ` (${blocking.join(', ')})`}; evidence ${coverage.rows.filter((row) => row.passed).length}/${coverage.commandCount}`,
          evidenceIds: coverage.rows.map((row) => row.evidenceId).filter((id) => typeof id === 'string'),
          decision: { mode: auto ? 'auto' : 'human', reasons: blocking },
          source: 'policy',
          reviewedOwner: reviewed.owner ?? null,
          actor: 'manager',
          reason: 'task-review',
        })
        if (auto) {
          const done = store.commitAccepted(acceptByPolicy(reviewed, decision))
          return {
            ...done,
            acceptance: decision,
            reviewId: review.reviewId,
            verifierReviewId: latest.reviewId,
            evidenceComplete: true,
            integrity,
          }
        }
        return {
          ...reviewed,
          acceptance: decision,
          waitingForHuman: true,
          reviewId: review.reviewId,
          verifierReviewId: latest?.reviewId ?? null,
          evidenceComplete: coverage.complete,
          blocking,
        }
      },
    },
    {
      name: TOOL_NAMES.taskAccept,
      description: 'Ask the HUMAN to accept an in_review task through the host approval dialog (superbot_task_accept is the only agent-callable human path; the agent cannot answer the dialog and gets `allowed-once` only if the user clicks allow). On approval the ledger records acceptedBy=human, via=host-approval.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['id'],
        properties: { id: { type: 'string' }, note: { type: 'string', description: 'Optional acceptance note shown to the human and stored in the ledger.' } },
      },
      output: objectOutput,
      async execute(args, exec) {
        enabledOrThrow(getConfig)
        const task = requireTask(store, args.id)
        if (task.status !== 'in_review') throw new Error(`task ${args.id} is ${task.status}; only an in-review task can be accepted`)
        const approval = typeof ctx?.get === 'function' ? ctx.get('approval') : undefined
        if (approval === undefined || typeof approval.request !== 'function') {
          throw new Error('host approval is unavailable; accept this task from the Superbot panel (POST /superbot/accept)')
        }
        const coverage = store.evidenceCoverage(task.id)
        const outcome = await approval.request({
          agent: exec?.agent,
          toolName: TOOL_NAMES.taskAccept,
          reason: `人工验收 ${task.id}「${task.title}」：证据 ${coverage.rows.filter((row) => row.passed).length}/${coverage.commandCount}${args.note === undefined ? '' : `；${args.note}`}`,
          ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
        })
        if (outcome !== 'allowed-once') return { accepted: false, outcome, task }
        const accepted = store.acceptTaskByHuman(task.id, {
          ...(args.note === undefined ? {} : { note: args.note }),
          via: 'host-approval',
        })
        return { accepted: true, outcome, task: accepted.task, review: accepted.review }
      },
    },
    {
      name: TOOL_NAMES.taskReject,
      description: 'Ask the HUMAN to reject an in_review task through the host approval dialog. On approval the ledger records a human reject and moves the task back to in_progress for rework. Use only when the boss explicitly wants changes; never for hiding failures.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['id'],
        properties: { id: { type: 'string' }, note: { type: 'string', description: 'Rejection reason shown to the human and stored in the ledger.' } },
      },
      output: objectOutput,
      async execute(args, exec) {
        enabledOrThrow(getConfig)
        const task = requireTask(store, args.id)
        if (task.status !== 'in_review') throw new Error(`task ${args.id} is ${task.status}; only an in-review task can be rejected`)
        const approval = typeof ctx?.get === 'function' ? ctx.get('approval') : undefined
        if (approval === undefined || typeof approval.request !== 'function') {
          throw new Error('host approval is unavailable; reject this task from the Superbot panel (POST /superbot/reject)')
        }
        const coverage = store.evidenceCoverage(task.id)
        const outcome = await approval.request({
          agent: exec?.agent,
          toolName: TOOL_NAMES.taskReject,
          reason: `人工退回 ${task.id}「${task.title}」：证据 ${coverage.rows.filter((row) => row.passed).length}/${coverage.commandCount}${args.note === undefined ? '' : `；${args.note}`}`,
          ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
        })
        if (outcome !== 'allowed-once') return { rejected: false, outcome, task }
        return { rejected: true, outcome, ...store.rejectTaskByHuman(task.id, { ...(args.note === undefined ? {} : { note: args.note }) }) }
      },
    },
    {
      name: TOOL_NAMES.taskReport,
      description: 'Record a worker/manager report for a task in the ledger (summary + evidence).',
      parameters: {
        type: 'object', additionalProperties: false, required: ['summary'],
        properties: {
          taskId: { type: 'string' },
          runId: { type: 'string' },
          author: { type: 'string', description: 'Who is reporting; defaults to the calling role.' },
          summary: { type: 'string', description: 'What was done, what remains.' },
          evidence: { type: 'array', items: { type: 'string' }, description: 'Commands/checks that actually ran and their results.' },
        },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        return {
          report: store.submitReport({
            taskId: args.taskId,
            runId: args.runId,
            author: args.author,
            summary: args.summary,
            evidence: args.evidence,
            actor: args.author ?? 'worker',
            reason: 'task-report',
          }),
        }
      },
    },
    {
      name: TOOL_NAMES.reportList,
      description: 'List persisted reports, optionally for one task or run.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { taskId: { type: 'string' }, runId: { type: 'string' } },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        return { reports: store.listReports({ taskId: args.taskId, runId: args.runId }) }
      },
    },
    {
      name: TOOL_NAMES.projectHandoff,
      description: 'Generate the per-project handoff file (SUPERBOT-HANDOFF.md) from the ledger, so work can continue when Superbot is turned off. Bounded (<4KB): goal, open tasks, acceptance commands, constraints, next steps. Writes only into that project root; refuses to overwrite a foreign file. Manager-only.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['projectId'],
        properties: {
          projectId: { type: 'string' },
          write: { type: 'boolean', description: 'Write the file (default true); false only renders it.' },
        },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        const inventory = readProjects(ctx)
        const project = inventory.projects.find((entry) => entry.workspaceId === args.projectId || entry.projectId === args.projectId)
        if (project === undefined) throw new Error(`unknown project: ${args.projectId}`)
        if (typeof project.path !== 'string' || project.path === '') throw new Error(`project ${args.projectId} has no filesystem path`)
        const markdown = buildProjectHandoff({ store, project: { projectId: project.workspaceId, title: project.title, path: project.path } })
        const write = args.write !== false
        const result = write ? writeProjectHandoff(project.path, markdown, { fileName: getConfig().handoffFile ?? 'SUPERBOT-HANDOFF.md' }) : { path: null, written: false, bytes: Buffer.byteLength(markdown, 'utf8') }
        return { projectId: project.workspaceId, ...result, markdown: markdown.length > 8_000 ? `${markdown.slice(0, 8_000)}…` : markdown }
      },
    },
    {
      name: TOOL_NAMES.handoff,
      description: 'Render a 5-line handoff for session rotation/recovery.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['goal', 'status', 'next'],
        properties: {
          goal: { type: 'string' },
          status: { type: 'string' },
          next: { type: 'string' },
          blockers: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
        },
      },
      output: stringOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        return buildHandoff(args)
      },
    },
  ]
}

/**
 * The sandbox mode a tool call executes under, resolved from the host policy
 * service. `danger-full-access` means the verifier could write the ledger or
 * read credentials — policy acceptance must then fall back to a human.
 * Undefined = host without the service (recorded as unknown, not failed).
 */
function resolveSandboxMode(agent, fallbackCtx) {
  try {
    const scope = agent?.ctx ?? fallbackCtx
    const service = typeof scope?.get === 'function' ? scope.get('sandboxPolicy') : undefined
    if (service === undefined || typeof service.resolve !== 'function') return undefined
    const request = agent?.session === undefined ? {} : { session: agent.session }
    const policy = service.resolve(request)
    return typeof policy?.mode === 'string' ? policy.mode : undefined
  } catch {
    return undefined
  }
}

const requireRun = (store, runId) => {
  const run = store.getRun(runId)
  if (run === undefined) throw new Error(`unknown run: ${String(runId)}`)
  return run
}

/** Resolve the project root of a task from the live inventory (read-only). */
const projectRootOf = (ctx, task) => {
  const inventory = readProjects(ctx)
  const project = inventory.projects.find((row) => row.workspaceId === task.projectId)
  if (project === undefined) throw new Error(`task ${task.id} project ${task.projectId} is not in the current workspace inventory`)
  return project
}

/**
 * Run/report/review read + maintenance tools.
 * @param {{getConfig?: () => Record<string, unknown>, store: import('./work-store.js').WorkStore, ctx?: import('@deepseek-ai/cordis').Context}} options
 */
export function createWorkTools({ getConfig = () => ({}), store, ctx } = {}) {
  if (store === undefined) throw new Error('work tools require a work store')
  return [
    {
      name: TOOL_NAMES.runList,
      description: 'List persisted worker/verifier runs, optionally for one task.',
      parameters: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string' } } },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        return { runs: store.listRuns({ taskId: args.taskId }) }
      },
    },
    {
      name: TOOL_NAMES.runFinish,
      description: 'Close a running ledger run (for background dispatches whose result the manager collected elsewhere).',
      parameters: {
        type: 'object', additionalProperties: false, required: ['runId', 'status'],
        properties: {
          runId: { type: 'string' },
          status: { type: 'string', enum: ['succeeded', 'failed', 'canceled'] },
          summary: { type: 'string' },
        },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        return store.finishRun(args.runId, { status: args.status, summary: args.summary, actor: 'manager', reason: 'run-finish' })
      },
    },
    {
      name: TOOL_NAMES.acceptanceRun,
      description: 'Verifier-only, restricted executor: run ONE acceptance command declared in the task ledger (task.acceptanceCommands[index]) in the project root and record machine evidence bound to YOUR verifier session. You cannot pass arbitrary shell and you cannot choose the run id — the ledger resolves it from your session. Returns evidenceId, exit code, preview and the workspace fingerprint.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['taskId', 'index'],
        properties: {
          taskId: { type: 'string' },
          index: { type: 'integer', minimum: 0, maximum: 9, description: 'Index into task.acceptanceCommands.' },
        },
      },
      output: objectOutput,
      async execute(args, exec) {
        enabledOrThrow(getConfig)
        const task = requireTask(store, args.taskId)
        const childId = typeof exec?.agent?.id === 'string' ? exec.agent.id : ''
        if (childId === '') throw new Error('acceptance_run must be called from the verifier child session')
        const run = store.findRunByChildId(childId, { taskId: task.id, agentPreset: 'superbot-verifier' })
        if (run === undefined) throw new Error(`no verifier run is bound to session ${childId} for task ${task.id}`)
        if (run.status !== 'running') throw new Error(`run ${run.runId} is ${run.status}; evidence can only be recorded by the live verifier run`)
        const project = projectRootOf(ctx, task)
        if (typeof run.workspacePath === 'string' && run.workspacePath !== project.path) {
          throw new Error(`verifier run workspace ${run.workspacePath} != task project path ${project.path}`)
        }
        const declaredCommand = Array.isArray(task.acceptanceCommands) ? task.acceptanceCommands[args.index]?.command : undefined
        const commandCheck = checkAcceptanceCommand(declaredCommand)
        if (!commandCheck.ok) throw new Error(`拒绝执行验收命令：${commandCheck.reason}`)
        const artifactBase = `${task.id}-${String(args.index)}-${Date.now()}`
        const shell = typeof ctx?.get === 'function' ? ctx.get('shell') : undefined
        const sandboxPolicyService = typeof ctx?.get === 'function' ? ctx.get('sandboxPolicy') : undefined
        let sandboxPolicy
        try {
          if (typeof sandboxPolicyService?.resolve === 'function') {
            sandboxPolicy = sandboxPolicyService.resolve(exec?.agent?.session === undefined ? {} : { session: exec.agent.session })
          }
        } catch {
          sandboxPolicy = undefined
        }
        const inPlace = getConfig()?.acceptanceIsolation === 'in-place'
        let workspace
        if (inPlace) {
          workspace = { dir: project.path, mode: 'in-place', cleanup() {} }
        } else {
          try {
            workspace = createAcceptanceWorkspace(project.path)
          } catch (error) {
            throw new Error(`acceptance workspace creation failed: ${String(error?.message ?? error)}`)
          }
        }
        let result
        try {
          result = await runAcceptanceCommand({
            task,
            index: args.index,
            cwd: workspace.dir,
            artifactsDir: join(store.stateDir, 'work', 'artifacts'),
            evidenceId: artifactBase,
            ...(shell === undefined ? {} : { shell }),
            ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
            isolationMode: workspace.mode,
          })
        } finally {
          workspace.cleanup()
        }
        const after = fingerprintWorkspace(project.path)
        const evidence = store.recordEvidence({
          taskId: task.id,
          runId: run.runId,
          childId,
          index: args.index,
          command: result.command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          outputDigest: result.outputDigest,
          outputPath: result.outputPath,
          preview: result.preview,
          workspaceDigest: after.digest,
          protectedDigest: after.protectedDigest,
          workspacePath: project.path,
          sandboxMode: result.sandboxMode ?? resolveSandboxMode(exec?.agent, ctx),
          executionMode: result.executionMode,
          sandboxed: result.sandboxed,
          isolationMode: result.isolationMode,
          actor: run.runId,
        })
        return {
          evidence,
          expectedExitCode: evidence.expectedExitCode,
          passed: evidence.timedOut !== true && evidence.exitCode === evidence.expectedExitCode,
          harnessChanged: typeof run.baselineProtectedDigest === 'string' && run.baselineProtectedDigest !== after.protectedDigest,
          coverage: store.evidenceCoverage(task.id),
        }
      },
    },
    {
      name: TOOL_NAMES.reviewSubmit,
      description: 'Record the verifier verdict. The ledger resolves YOUR verifier run from this session (no runId parameter, so an old run cannot be replayed). A pass REQUIRES evidenceIds produced by this session covering EVERY declared acceptance command; a prose-only pass is rejected. The verdict does not by itself change task status.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['taskId', 'verdict'],
        properties: {
          taskId: { type: 'string' },
          verdict: { type: 'string', enum: ['pass', 'fail', 'pending'] },
          notes: { type: 'string' },
          evidenceIds: { type: 'array', items: { type: 'string' }, description: 'Evidence ids returned by superbot_acceptance_run (required for pass).' },
        },
      },
      output: objectOutput,
      execute(args, exec) {
        enabledOrThrow(getConfig)
        const task = requireTask(store, args.taskId)
        const childId = typeof exec?.agent?.id === 'string' ? exec.agent.id : ''
        if (childId === '') throw new Error('review_submit must be called from the verifier child session')
        const run = store.findRunByChildId(childId, { taskId: task.id, agentPreset: 'superbot-verifier' })
        if (run === undefined) throw new Error(`no verifier run is bound to session ${childId} for task ${task.id}`)
        const reviewer = `verifier:${String(childId).slice(0, 8)}`
        const review = store.submitReview({
          taskId: task.id,
          reviewer,
          reviewerRole: 'verifier',
          runId: run.runId,
          childId,
          verdict: args.verdict,
          notes: args.notes,
          evidenceIds: args.evidenceIds,
          source: 'verifier',
          reviewedOwner: task.owner ?? null,
          actor: reviewer,
          reason: 'verification',
        })
        return { review, coverage: store.evidenceCoverage(task.id) }
      },
    },
    {
      name: TOOL_NAMES.reviewList,
      description: 'List persisted review records, optionally for one task.',
      parameters: { type: 'object', additionalProperties: false, properties: { taskId: { type: 'string' } } },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        return { reviews: store.listReviews({ taskId: args.taskId }) }
      },
    },
    {
      name: TOOL_NAMES.auditExport,
      description: 'Export the raw append-only audit trail (newest `limit` events, default 50).',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        const limit = Number.isInteger(args.limit) ? Math.min(args.limit, 500) : 50
        return store.exportAudit({ limit })
      },
    },
    {
      name: TOOL_NAMES.onboardingScan,
      description: 'First-run inventory (read-only): scan ALL existing DSH workspaces, sessions (threads) and ledger work, and propose which projects are 进行中 / 暂时挂起 / 已归档 / 未知. Present this to the user and ask for confirmation before dispatching anything.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: objectOutput,
      execute() {
        enabledOrThrow(getConfig)
        const inventory = readProjects(ctx)
        return scanInventory({ store, workspaceSnapshot: inventory, dshHome: dshHomeOf(store.stateDir) })
      },
    },
    {
      name: TOOL_NAMES.onboardingConfirm,
      description: 'Ask the HUMAN (host approval dialog) to confirm the first-run inventory status of the projects, then persist it in the ledger (via=host-approval). The agent cannot answer the dialog; do not call this with guessed statuses.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['projects'],
        properties: {
          projects: {
            type: 'array', minItems: 1,
            items: {
              type: 'object', additionalProperties: false, required: ['projectId', 'status'],
              properties: {
                projectId: { type: 'string' },
                status: { type: 'string', enum: ['active', 'paused', 'archived', 'unknown'] },
                title: { type: 'string' },
                path: { type: 'string' },
              },
            },
          },
          note: { type: 'string' },
        },
      },
      output: objectOutput,
      async execute(args, exec) {
        enabledOrThrow(getConfig)
        const approval = typeof ctx?.get === 'function' ? ctx.get('approval') : undefined
        if (approval === undefined || typeof approval.request !== 'function') {
          throw new Error('host approval is unavailable; confirm the inventory from the Superbot panel (POST /superbot/onboarding/confirm)')
        }
        const active = args.projects.filter((project) => project.status === 'active').length
        const paused = args.projects.filter((project) => project.status === 'paused').length
        const outcome = await approval.request({
          agent: exec?.agent,
          toolName: TOOL_NAMES.onboardingConfirm,
          reason: `确认首次接入盘点：${args.projects.length} 个项目（进行中 ${active} / 暂时挂起 ${paused}）`,
          ...(exec?.signal === undefined ? {} : { signal: exec.signal }),
        })
        if (outcome !== 'allowed-once') return { confirmed: false, outcome }
        const inventory = store.confirmInventory({
          projects: args.projects,
          ...(args.note === undefined ? {} : { note: args.note }),
          via: 'host-approval',
        })
        return { confirmed: true, outcome, inventory }
      },
    },
    {
      name: TOOL_NAMES.projectOverview,
      description: 'Read the control-plane hierarchy (project → threads → tasks) with per-project counts, active child sessions and the human-attention queue. Projects are isolated: each row carries its own workspaceId, counts and pendingHuman tasks.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { projectId: { type: 'string', description: 'Optional: limit to one DSH workspace id.' } },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        const inventory = readProjects(ctx)
        return buildOverview({ store, projects: inventory.projects, projectId: args.projectId })
      },
    },
    {
      name: TOOL_NAMES.workRebuild,
      description: 'Rebuild all work projections from the append-only event log (recovery after a corrupt projection).',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: objectOutput,
      execute() {
        enabledOrThrow(getConfig)
        return store.rebuild()
      },
    },
    {
      name: TOOL_NAMES.taskCancel,
      description: 'Cancel a non-terminal task and close any active runs. Ledger-recorded with the manager reason; terminal tasks cannot be canceled. Use when the goal is no longer valid, not to hide a failed verification.',
      parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' }, reason: { type: 'string' } } },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        const task = requireTask(store, args.id)
        if (['done', 'canceled'].includes(task.status)) throw new Error(`task ${task.id} is already ${task.status}`)
        const reason = typeof args.reason === 'string' && args.reason.trim() !== '' ? args.reason.trim() : 'canceled by manager'
        for (const run of store.listRuns({ taskId: task.id })) {
          if (run.status === 'running') store.finishRun(run.runId, { status: 'canceled', summary: reason, actor: 'manager', reason: 'task-cancel' })
        }
        return store.transitionTask(task.id, 'canceled', { actor: 'manager', reason, at: undefined })
      },
    },
    {
      name: TOOL_NAMES.historyImport,
      description: 'Import selected historical DSH threads as ledger-managed history work items (manager-only, user-confirmed). Creates one requirement + one high-risk read-only investigation task per item; never dispatches and never rewrites the original session.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['items'],
        properties: {
          items: {
            type: 'array', minItems: 1, maxItems: 10,
            items: {
              type: 'object', additionalProperties: false, required: ['projectId'],
              properties: { projectId: { type: 'string' }, sessionId: { type: 'string' }, title: { type: 'string' }, intent: { type: 'string' } },
            },
          },
        },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        const inventory = readProjects(ctx)
        return importHistoryWork(store, args.items, { projects: inventory.projects, actor: 'manager', via: 'manager-tool' })
      },
    },
    {
      name: TOOL_NAMES.fleetStatus,
      description: 'Single-window fleet status for the Manager: every project, active worker/verifier threads, pending human decisions and recent completions, all derived from the ledger. Use at each boss check-in.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: objectOutput,
      execute() {
        enabledOrThrow(getConfig)
        const inventory = readProjects(ctx)
        const overview = buildOverview({ store, projects: inventory.projects })
        return {
          totals: overview.totals,
          projects: overview.projects.map((project) => ({ projectId: project.projectId, title: project.title, counts: project.counts, pendingHuman: project.pendingHuman.length, lastActivityAt: project.lastActivityAt })),
          activeThreads: overview.projects.flatMap((project) => project.threads.filter((thread) => thread.active === true).map((thread) => ({ ...thread, projectTitle: project.title }))),
          pendingHuman: overview.attention,
          recentTasks: overview.tasks.slice(0, 20),
        }
      },
    },
  ]
}

/**
 * Assemble the complete catalog, then select one role's subset.
 * @param {{
 *   role: 'manager'|'worker'|'verifier',
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   store: import('./work-store.js').WorkStore,
 *   getConfig?: () => Record<string, unknown>,
 *   exclude?: string[],
 * }} options
 * @returns {Array<Record<string, unknown>>}
 */
export function createSuperbotTools({ role, ctx, store, getConfig = () => ({}), exclude = [] } = {}) {
  if (store === undefined) throw new Error('superbot tools require a work store')
  // One dispatcher backs both the explicit dispatch tools and plan dispatch, so
  // task-scoped and prompt-scoped children go through the exact same path.
  const dispatcher = createDispatcher(ctx, { store, getConfig })
  const catalog = new Map()
  for (const definition of [
    ...createTaskTools({ getConfig, store, ctx }),
    ...createWorkTools({ getConfig, store, ctx }),
    ...createPlanningTools({ ctx, getConfig, store, dispatcher }),
    ...createProjectTools(ctx, { getConfig }),
    ...createDispatchTools(ctx, { store, dispatcher, getConfig }),
  ]) {
    catalog.set(definition.name, definition)
  }
  const allowed = toolsForRole(role).filter((name) => !exclude.includes(name))
  const missing = allowed.filter((name) => !catalog.has(name))
  if (missing.length > 0) throw new Error(`tool catalog is missing role tools: ${missing.join(', ')}`)
  return allowed.map((name) => catalog.get(name))
}

/** Every tool name this plugin can register (manager superset). */
export function catalogNames() {
  return [...ROLE_TOOLS.manager]
}
