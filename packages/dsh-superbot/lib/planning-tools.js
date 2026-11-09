/**
 * Control-plane chain: requirement → spec → plan → dispatch.
 *
 * Tools here are mounted ONLY on the manager preset (`lib/roles.js`): a worker
 * executes one planned task and a verifier only reads, so neither may create
 * requirements/plans or dispatch siblings.
 *
 * Readiness for `superbot_plan_dispatch` is deliberately conservative:
 *   - the task belongs to the plan and still exists in the ledger;
 *   - task status is `todo` (planned, not yet claimed);
 *   - every dep is `done`;
 *   - no unfinished run is bound to the task (prevents double dispatch);
 *   - the task's projectId resolves in the live workspace inventory;
 *   - at most `max` tasks per call (default 1) — one pass, no loop.
 *
 * Dispatch itself is NOT reimplemented here: it calls the same dispatcher that
 * backs `superbot_dispatch_worker` (`lib/dispatch-tools.js`), so a task-scoped
 * run always gets the worker preset, the generated task brief and the ledger
 * binding.
 */

import { compareTasks, planDispatch as selectDispatchBatch } from './task-engine.js'
import { TOOL_NAMES } from './roles.js'
import { checkDeclaredCommands, commandPolicyError } from './command-policy.js'
import { relative, resolve, isAbsolute } from 'node:path'

import { isRunActive } from './work-store.js'
import { readProjects } from './workspace-service.js'

const textRender = (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
const objectOutput = { schema: { type: 'object', additionalProperties: true }, render: textRender }

const enabledOrThrow = (getConfig) => {
  if (getConfig?.()?.toolsEnabled === false) throw new Error('superbot task tools are disabled in settings')
}

const requirePlan = (store, id) => {
  const plan = store.getPlan(id)
  if (plan === undefined) throw new Error(`unknown plan: ${String(id)}`)
  return plan
}

/**
 * Compute the dispatchable subset of a plan, read-only.
 * @param {{store: import('./work-store.js').WorkStore, plan: Record<string, unknown>, projects: ReadonlyArray<{workspaceId: string}>}} input
 * @returns {{ready: Array<Record<string, unknown>>, skipped: Array<{taskId: string, reason: string, [key: string]: unknown}>}}
 */
export function selectReadyPlanTasks({ store, plan, projects }) {
  const projectIds = new Set((Array.isArray(projects) ? projects : []).map((project) => project.workspaceId))
  const ready = []
  const skipped = []
  for (const taskId of plan?.taskIds ?? []) {
    const task = store.getTask(taskId)
    if (task === undefined) {
      skipped.push({ taskId, reason: 'missing-task' })
      continue
    }
    if (task.status !== 'todo') {
      skipped.push({ taskId, reason: `status:${task.status}` })
      continue
    }
    const activeRun = store.listRuns({ taskId }).find(isRunActive)
    if (activeRun !== undefined) {
      skipped.push({ taskId, reason: 'run-active', runId: activeRun.runId })
      continue
    }
    const pendingDeps = (task.deps ?? []).filter((dep) => store.getTask(dep)?.status !== 'done')
    if (pendingDeps.length > 0) {
      skipped.push({ taskId, reason: 'deps-pending', deps: pendingDeps })
      continue
    }
    const project = (Array.isArray(projects) ? projects : []).find((item) => item.workspaceId === task.projectId)
    if (project === undefined) {
      skipped.push({ taskId, reason: 'project-unknown', projectId: task.projectId })
      continue
    }
    const confirmed = store.confirmedProjectStatus?.(task.projectId)
    if (confirmed !== undefined && confirmed !== 'active') {
      skipped.push({ taskId, reason: `project-${confirmed}`, projectId: task.projectId })
      continue
    }
    if (typeof project.path === 'string' && project.path !== '' && typeof store.stateDir === 'string' && store.stateDir !== '') {
      const rel = relative(resolve(project.path), resolve(store.stateDir))
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
        skipped.push({ taskId, reason: 'ledger-inside-workspace', projectId: task.projectId })
        continue
      }
    }
    ready.push(task)
  }
  ready.sort(compareTasks)
  return { ready, skipped }
}

/**
 * @param {{
 *   ctx?: import('@deepseek-ai/cordis').Context,
 *   getConfig?: () => Record<string, unknown>,
 *   store: import('./work-store.js').WorkStore,
 *   dispatcher?: {dispatch: Function, requireSurface: Function},
 * }} options
 */
export function createPlanningTools({ ctx, getConfig = () => ({}), store, dispatcher } = {}) {
  if (store === undefined) throw new Error('planning tools require a work store')

  return [
    {
      name: TOOL_NAMES.requirementSubmit,
      description: 'Persist a raw user requirement (verbatim text + projectId) in the append-only work ledger. Creates NO task and dispatches nothing; the later steps are superbot_spec_record and superbot_plan_create.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'projectId'],
        properties: {
          text: { type: 'string', minLength: 1, description: 'The user requirement, verbatim (bounded to 8000 chars in the ledger).' },
          projectId: { type: 'string', minLength: 1, description: 'DSH workspace id or project identifier (see superbot_project_list).' },
          title: { type: 'string', description: 'Optional short title; derived from the first line of the text when omitted.' },
          priority: { type: 'string', enum: ['high', 'normal', 'low'] },
        },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        return {
          requirement: store.submitRequirement({
            projectId: args.projectId,
            title: args.title,
            text: args.text,
            ...(args.priority === undefined ? {} : { priority: args.priority }),
          }, { actor: 'manager', reason: 'requirement-submit' }),
        }
      },
    },
    {
      name: TOOL_NAMES.requirementList,
      description: 'List persisted requirements (read-only), optionally for one project.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          projectId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Newest N requirements.' },
        },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        return { requirements: store.listRequirements({ projectId: args.projectId, limit: args.limit }) }
      },
    },
    {
      name: TOOL_NAMES.specRecord,
      description: 'Record an actionable spec (content + optional acceptance/constraints) under a requirement. Specs are appended, never rewritten; a plan may reference the newest one via specId.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['requirementId', 'content'],
        properties: {
          requirementId: { type: 'string' },
          title: { type: 'string' },
          content: { type: 'string', minLength: 1, description: 'What to build / how it works; bounded to 8000 chars.' },
          acceptance: { type: 'array', items: { type: 'string' }, description: 'Plan-level acceptance criteria (max 20, 500 chars each).' },
          constraints: { type: 'array', items: { type: 'string' }, description: 'Boundaries: files/packages, no-go zones, compatibility.' },
        },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        return {
          spec: store.recordSpec({
            requirementId: args.requirementId,
            title: args.title,
            content: args.content,
            acceptance: args.acceptance,
            constraints: args.constraints,
          }, { actor: 'manager', reason: 'spec-record' }),
        }
      },
    },
    {
      name: TOOL_NAMES.planCreate,
      description: 'Create a persisted plan from a requirement: validates every task spec through task-engine (non-empty acceptance), rejects unknown deps and cycles, then creates the tasks and immediately plans them into todo so they are dispatchable. Returns the plan + task ids.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['requirementId', 'tasks'],
        properties: {
          requirementId: { type: 'string' },
          title: { type: 'string', description: 'Plan title; defaults to the requirement title.' },
          specId: { type: 'string', description: 'Optional spec to bind this plan to (must belong to the requirement).' },
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'projectId', 'priority', 'acceptance'],
              properties: {
                id: { type: 'string', description: 'Optional stable task id; generated when omitted.' },
                title: { type: 'string' },
                projectId: { type: 'string', description: 'DSH workspace id this task is executed in.' },
                priority: { type: 'string', enum: ['high', 'normal', 'low'] },
                acceptance: { type: 'array', items: { type: 'string' }, minItems: 1 },
                acceptanceCommands: {
                  type: 'array',
                  maxItems: 10,
                  description: 'Machine-executable acceptance commands (command + optional expectExitCode). These are the ONLY commands a verifier may run as evidence; declare them here, they are immutable afterwards.',
                  items: {
                    type: 'object', additionalProperties: false, required: ['command'],
                    properties: {
                      command: { type: 'string', minLength: 1, description: 'Shell command executed in the project root by the verifier (bounded to 500 chars, timeout 120s).' },
                      expectExitCode: { type: 'integer', description: 'Expected exit code; defaults to 0.' },
                    },
                  },
                },
                deps: { type: 'array', items: { type: 'string' }, description: 'Task ids in this plan or already persisted tasks (same project only).' },
                risk: { type: 'string', enum: ['low', 'high'] },
                tags: { type: 'array', items: { type: 'string' } },
                context: { type: 'string', description: 'Background and goal for the executor (bounded 2000 chars). Goes into the worker/verifier brief.' },
                constraints: { type: 'array', items: { type: 'string' }, description: 'Scope constraints: files, boundaries, compatibility, things not to touch.' },
                nonGoals: { type: 'array', items: { type: 'string' }, description: 'Explicit non-goals so the executor does not expand scope.' },
                reversible: { type: 'boolean', description: 'Declare true only when the change is trivially revertible; policy acceptance requires it.' },
                externalSideEffects: { type: 'boolean', description: 'True when the task touches anything outside the project; forces human acceptance.' },
              },
            },
          },
        },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        // Trust anchor: only standard test commands may become acceptance evidence.
        const policy = checkDeclaredCommands(args.tasks)
        if (!policy.ok) throw new Error(commandPolicyError(policy.rejected))
        const { plan, tasks } = store.createPlan({
          requirementId: args.requirementId,
          title: args.title,
          specId: args.specId,
          tasks: args.tasks,
        }, { actor: 'manager', reason: 'plan-create' })
        return { plan, taskIds: plan.taskIds, tasks, dispatchable: true }
      },
    },
    {
      name: TOOL_NAMES.planGet,
      description: 'Read one plan with its current task snapshots (statuses reflect later claims/reports).',
      parameters: {
        type: 'object', additionalProperties: false, required: ['id'],
        properties: { id: { type: 'string' } },
      },
      output: objectOutput,
      execute(args) {
        enabledOrThrow(getConfig)
        const plan = requirePlan(store, args.id)
        return {
          plan,
          tasks: plan.taskIds.map((taskId) => store.getTask(taskId)).filter((task) => task !== undefined),
          requirement: store.getRequirement(plan.requirementId) ?? null,
        }
      },
    },
    {
      name: TOOL_NAMES.planDispatch,
      description: 'Dispatch the ready tasks of one plan to workers (deps done, status todo, no active run, project resolvable). One pass, at most `max` tasks (default 1). Each dispatch reuses superbot_dispatch_worker: worker preset, generated task brief, ledger run bound to the task.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['planId'],
        properties: {
          planId: { type: 'string' },
          max: { type: 'integer', minimum: 1, maximum: 5, description: 'Maximum tasks to dispatch in this call (default 1).' },
          wait: { type: 'boolean', description: 'Await each child result (default false).' },
        },
      },
      output: objectOutput,
      async execute(args, exec) {
        enabledOrThrow(getConfig)
        const plan = requirePlan(store, args.planId)
        if (dispatcher === undefined) {
          throw new Error('plan dispatch requires the dispatch subsystem: select the superbot-manager preset on a preset surface (web/desktop)')
        }
        // Hard preconditions (host surface) surface before any ledger write.
        dispatcher.requireSurface(exec)
        const max = Number.isInteger(args.max) ? Math.min(Math.max(args.max, 1), 5) : 1
        const inventory = readProjects(ctx)
        const { ready, skipped } = selectReadyPlanTasks({ store, plan, projects: inventory.projects })
        // Project isolation at dispatch time: task-engine enforces one active
        // worker per project and a global WIP cap across different projects.
        const runningByProject = {}
        for (const run of store.listRuns()) {
          if (!isRunActive(run)) continue
          const runTask = run.taskId === undefined ? undefined : store.getTask(run.taskId)
          const projectKey = run.workspaceId ?? runTask?.projectId
          if (projectKey === undefined) continue
          runningByProject[projectKey] = (runningByProject[projectKey] ?? 0) + 1
        }
        const wipLimit = Number.isInteger(getConfig?.()?.wipLimit) ? Math.max(1, Math.min(getConfig().wipLimit, 8)) : 2
        const planTasks = plan.taskIds.map((taskId) => store.getTask(taskId)).filter((task) => task !== undefined)
        const hardSkipped = new Set(skipped.map((row) => row.taskId))
        const knownById = new Map(store.listTasks().map((task) => [task.id, task]))
        const batch = selectDispatchBatch(planTasks, { maxActive: wipLimit, runningByProject, knownById })
        const selected = batch.selected.filter((task) => !hardSkipped.has(task.id)).slice(0, max)
        const deferred = [
          ...batch.selected.filter((task) => !hardSkipped.has(task.id)).slice(max).map((task) => ({ taskId: task.id, reason: 'max-reached' })),
          ...batch.skipped.filter((row) => !hardSkipped.has(row.taskId)),
        ]
        const dispatched = []
        const failed = []
        for (const task of selected) {
          try {
            const result = await dispatcher.dispatch('worker', {
              taskId: task.id,
              workspaceId: task.projectId,
              ...(args.wait === true ? { wait: true } : {}),
            }, exec)
            dispatched.push({ taskId: task.id, ...result })
          } catch (error) {
            failed.push({ taskId: task.id, error: String(error?.message ?? error) })
          }
        }
        return {
          planId: plan.id,
          taskCount: plan.taskIds.length,
          ready: ready.map((task) => task.id),
          dispatched,
          failed,
          skipped: [...skipped, ...deferred],
        }
      },
    },
  ]
}
