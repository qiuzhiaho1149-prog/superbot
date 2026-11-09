/**
 * Task engine core: contract, state machine, claims, waitpoints, scheduling, handoff.
 * Zero dependencies; unit-testable with Node's test runner.
 */

export const TASK_STATUSES = ['draft', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled']
export const TERMINAL_STATUSES = new Set(['done', 'canceled'])
export const PRIORITIES = ['high', 'normal', 'low']

/** Upper bounds for machine-checkable acceptance commands (evidence contract). */
export const MAX_ACCEPTANCE_COMMANDS = 10
export const MAX_COMMAND_CHARS = 500

/**
 * Characters that let a declared command do more than run one argv list:
 * chaining (`; && ||`), pipes (`|`), redirection (`> <`), substitution
 * (`$ ` `` ` ``) and newlines. Acceptance commands are data in the ledger, so
 * they must stay a single, statically inspectable invocation.
 * (Globs, quotes, flags and paths remain allowed.)
 */
const UNSAFE_COMMAND = /[;&|$`<>\n\r]/

/** Whether a declared acceptance command is a single shell-free invocation. */
export function isSafeAcceptanceCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return false
  const trimmed = command.trim()
  if (trimmed.length > MAX_COMMAND_CHARS) return false
  if (UNSAFE_COMMAND.test(trimmed)) return false
  // Expectation must be a clean success: a non-zero "expected exit code" would
  // let a declared failing command masquerade as passing evidence.
  return true
}

/** Allowed transitions. `done` is additionally restricted to human actors. */
export const TRANSITIONS = Object.freeze({
  draft: ['todo', 'canceled'],
  todo: ['in_progress', 'blocked', 'canceled'],
  in_progress: ['in_review', 'blocked', 'canceled', 'todo'],
  in_review: ['done', 'in_progress', 'canceled'],
  blocked: ['todo', 'in_progress', 'canceled'],
  done: [],
  canceled: [],
})

export class TaskError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TaskError'
    this.code = code
  }
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

/** Validate a TaskSpec. Returns `{ ok: true, value }` or `{ ok: false, errors }`. */
export function validateTaskSpec(value) {
  const errors = []
  if (!isRecord(value)) return { ok: false, errors: [{ path: '$', message: 'must be an object' }] }
  if (!nonEmptyString(value.id)) errors.push({ path: '$.id', message: 'must be a non-empty string' })
  if (!nonEmptyString(value.title)) errors.push({ path: '$.title', message: 'must be a non-empty string' })
  if (!nonEmptyString(value.projectId)) errors.push({ path: '$.projectId', message: 'must be a non-empty string' })
  if (!PRIORITIES.includes(value.priority)) errors.push({ path: '$.priority', message: 'must be high, normal or low' })
  if (!Array.isArray(value.acceptance) || value.acceptance.length === 0) {
    errors.push({ path: '$.acceptance', message: 'must be a non-empty array' })
  }
  if (value.deps !== undefined && (!Array.isArray(value.deps) || value.deps.some((dep) => !nonEmptyString(dep)))) {
    errors.push({ path: '$.deps', message: 'must be a string array when present' })
  }
  if (value.risk !== undefined && value.risk !== 'low' && value.risk !== 'high') {
    errors.push({ path: '$.risk', message: 'must be low or high when present' })
  }
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some((tag) => !nonEmptyString(tag)))) {
    errors.push({ path: '$.tags', message: 'must be a string array when present' })
  }
  if (value.reversible !== undefined && typeof value.reversible !== 'boolean') {
    errors.push({ path: '$.reversible', message: 'must be a boolean when present' })
  }
  if (value.context !== undefined && (!nonEmptyString(value.context) || value.context.length > 2000)) {
    errors.push({ path: '$.context', message: 'must be a non-empty string <= 2000 chars when present' })
  }
  if (value.constraints !== undefined && (!Array.isArray(value.constraints) || value.constraints.some((item) => !nonEmptyString(item)))) {
    errors.push({ path: '$.constraints', message: 'must be a string array when present' })
  }
  if (value.nonGoals !== undefined && (!Array.isArray(value.nonGoals) || value.nonGoals.some((item) => !nonEmptyString(item)))) {
    errors.push({ path: '$.nonGoals', message: 'must be a string array when present' })
  }
  if (value.externalSideEffects !== undefined && typeof value.externalSideEffects !== 'boolean') {
    errors.push({ path: '$.externalSideEffects', message: 'must be a boolean when present' })
  }
  if (value.acceptanceCommands !== undefined) {
    if (!Array.isArray(value.acceptanceCommands)) {
      errors.push({ path: '$.acceptanceCommands', message: 'must be an array when present' })
    } else if (value.acceptanceCommands.length > MAX_ACCEPTANCE_COMMANDS) {
      errors.push({ path: '$.acceptanceCommands', message: `accepts at most ${MAX_ACCEPTANCE_COMMANDS} commands` })
    } else {
      value.acceptanceCommands.forEach((entry, index) => {
        if (!isRecord(entry)) {
          errors.push({ path: `$.acceptanceCommands[${index}]`, message: 'must be an object' })
          return
        }
        if (!nonEmptyString(entry.command)) {
          errors.push({ path: `$.acceptanceCommands[${index}].command`, message: 'must be a non-empty string' })
        } else if (entry.command.trim().length > MAX_COMMAND_CHARS) {
          errors.push({ path: `$.acceptanceCommands[${index}].command`, message: `command must be <= ${MAX_COMMAND_CHARS} chars` })
        }
        if (entry.expectExitCode !== undefined && !Number.isInteger(entry.expectExitCode)) {
          errors.push({ path: `$.acceptanceCommands[${index}].expectExitCode`, message: 'must be an integer when present' })
        } else if (entry.expectExitCode !== undefined && entry.expectExitCode !== 0) {
          // Fail-closed: encoding "this command is allowed to fail" would turn a
          // red build into green evidence. Non-zero expectations are not a thing.
          errors.push({ path: `$.acceptanceCommands[${index}].expectExitCode`, message: 'must be 0 when present (only clean success counts as evidence)' })
        }
        if (nonEmptyString(entry.command) && !isSafeAcceptanceCommand(entry.command)) {
          errors.push({ path: `$.acceptanceCommands[${index}].command`, message: 'must be a single command without shell chaining/substitution/redirection' })
        }
      })
    }
  }
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      id: value.id,
      title: value.title,
      projectId: value.projectId,
      priority: value.priority,
      acceptance: [...value.acceptance],
      ...(value.deps === undefined ? {} : { deps: [...value.deps] }),
      ...(value.risk === undefined ? {} : { risk: value.risk }),
      ...(value.tags === undefined ? {} : { tags: [...value.tags] }),
      ...(value.reversible === undefined ? {} : { reversible: value.reversible }),
      ...(value.externalSideEffects === undefined ? {} : { externalSideEffects: value.externalSideEffects }),
      ...(value.context === undefined ? {} : { context: value.context }),
      ...(value.constraints === undefined ? {} : { constraints: [...value.constraints] }),
      ...(value.nonGoals === undefined ? {} : { nonGoals: [...value.nonGoals] }),
      // Structured, machine-executable acceptance: the ONLY commands a verifier
      // may run to produce independent evidence. Declared at plan time by the
      // manager, persisted in the ledger, and never editable afterwards.
      ...(value.acceptanceCommands === undefined
        ? {}
        : {
            acceptanceCommands: value.acceptanceCommands.map((entry) => ({
              command: entry.command.trim(),
              ...(entry.expectExitCode === undefined ? {} : { expectExitCode: entry.expectExitCode }),
            })),
          }),
    },
  }
}

/** Create a draft task. */
export function createTask(spec, { at = new Date().toISOString() } = {}) {
  return {
    ...spec,
    status: 'draft',
    owner: null,
    version: 0,
    createdAt: at,
    updatedAt: at,
  }
}

/** Whether `from -> to` is structurally allowed. */
export function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to)
}

function event(task, from, to, actor, reason, at) {
  return {
    kind: 'task/transition',
    taskId: task.id,
    from,
    to,
    actor,
    at,
    ...(reason === undefined ? {} : { reason }),
  }
}

/**
 * Apply one transition. `done` requires `actor === 'human'`; agents can reach
 * `in_review` but never `done` directly.
 */
export function transition(task, to, { actor = 'agent', reason, at = new Date().toISOString() } = {}) {
  if (!TASK_STATUSES.includes(to)) throw new TaskError('INVALID_STATUS', `unknown status: ${to}`)
  if (TERMINAL_STATUSES.has(task.status)) throw new TaskError('TERMINAL', `task ${task.id} is terminal (${task.status})`)
  if (!canTransition(task.status, to)) throw new TaskError('INVALID_TRANSITION', `cannot transition ${task.status} -> ${to}`)
  if (to === 'done' && actor !== 'human') throw new TaskError('HUMAN_ONLY', 'only a human can accept a task as done')
  const next = { ...task, status: to, updatedAt: at, version: task.version + 1 }
  if (to === 'done' || to === 'canceled') next.owner = null
  return { task: next, event: event(task, task.status, to, actor, reason, at) }
}

/** Claim a todo task for an owner using optimistic version checking. */
export function claim(task, { owner, expectedVersion, at = new Date().toISOString() } = {}) {
  if (!nonEmptyString(owner)) throw new TaskError('OWNER_REQUIRED', 'claim requires an owner')
  if (task.owner !== null) throw new TaskError('ALREADY_CLAIMED', `task ${task.id} is already claimed by ${task.owner}`)
  if (task.status !== 'todo') throw new TaskError('NOT_CLAIMABLE', `task ${task.id} is ${task.status}`)
  if (expectedVersion !== undefined && expectedVersion !== task.version) {
    throw new TaskError('VERSION_CONFLICT', `task ${task.id} version ${task.version} != ${expectedVersion}`)
  }
  return transition({ ...task, owner }, 'in_progress', { actor: owner, at })
}

/** Release an in-progress task back to todo. */
export function release(task, { owner, at = new Date().toISOString() } = {}) {
  if (task.status !== 'in_progress') throw new TaskError('NOT_RELEASABLE', `task ${task.id} is ${task.status}`)
  if (owner !== undefined && task.owner !== owner) throw new TaskError('NOT_OWNER', `task ${task.id} is owned by ${task.owner}`)
  return transition({ ...task, owner: null }, 'todo', { actor: owner ?? 'agent', reason: 'release', at })
}

/**
 * Create an independent waitpoint ("why is this waiting") instead of overloading
 * task status. Deadline is fixed at creation.
 */
export function createWaitpoint({ id, taskId, kind, question, options = [], deadline = null, at = new Date().toISOString() }) {
  if (!nonEmptyString(id) || !nonEmptyString(taskId)) throw new TaskError('INVALID_WAITPOINT', 'id and taskId are required')
  if (!['decision', 'human_action', 'external'].includes(kind)) throw new TaskError('INVALID_WAITPOINT', `unknown kind: ${kind}`)
  if (!nonEmptyString(question)) throw new TaskError('INVALID_WAITPOINT', 'question is required')
  return {
    id,
    taskId,
    kind,
    question,
    options: [...options],
    status: 'pending',
    deadline,
    createdAt: at,
    resolvedAt: null,
    answer: null,
    resolvedBy: null,
  }
}

/** Resolve a pending waitpoint exactly once. */
export function resolveWaitpoint(waitpoint, { answer, by = 'human', at = new Date().toISOString() } = {}) {
  if (waitpoint.status !== 'pending') throw new TaskError('WAITPOINT_RESOLVED', `waitpoint ${waitpoint.id} is ${waitpoint.status}`)
  return { ...waitpoint, status: 'resolved', answer: answer ?? null, resolvedBy: by, resolvedAt: at }
}

/** Whether every dependency is done. Missing deps count as not ready. */
export function dependenciesDone(task, byId) {
  return (task.deps ?? []).every((id) => byId.get(id)?.status === 'done')
}

const PRIORITY_WEIGHT = { high: 0, normal: 1, low: 2 }

/** Deterministic order: priority, then createdAt, then id. */
export function compareTasks(a, b) {
  const byPriority = (PRIORITY_WEIGHT[a.priority] ?? 9) - (PRIORITY_WEIGHT[b.priority] ?? 9)
  if (byPriority !== 0) return byPriority
  const byCreated = String(a.createdAt).localeCompare(String(b.createdAt))
  return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id)
}

/**
 * Plan deterministic dispatch: ready todo tasks -> per-project mutual exclusion ->
 * global active cap. Returns selected tasks and skip reasons.
 */
export function planDispatch(tasks, { maxActive = 2, runningByProject = {}, knownById } = {}) {
  // `knownById` lets a caller pass a plan subset while dependencies still
  // resolve against the whole ledger (a dep may live outside this plan).
  const byId = knownById instanceof Map ? knownById : new Map(tasks.map((task) => [task.id, task]))
  const activeByProject = { ...runningByProject }
  const selected = []
  const skipped = []
  let active = Object.values(activeByProject).reduce((sum, count) => sum + count, 0)
  for (const task of tasks.filter((item) => item.status === 'todo').sort(compareTasks)) {
    if (!dependenciesDone(task, byId)) {
      skipped.push({ taskId: task.id, reason: 'deps-pending' })
    } else if (active >= maxActive) {
      skipped.push({ taskId: task.id, reason: 'wip-limit' })
    } else if ((activeByProject[task.projectId] ?? 0) > 0) {
      skipped.push({ taskId: task.id, reason: 'project-busy' })
    } else {
      activeByProject[task.projectId] = (activeByProject[task.projectId] ?? 0) + 1
      active += 1
      selected.push(task)
    }
  }
  return { selected, skipped }
}

/** 5-line handoff for session rotation / recovery. */
export function buildHandoff({ goal, status, next, blockers = '无', evidence = [] }) {
  if (!nonEmptyString(goal) || !nonEmptyString(status) || !nonEmptyString(next)) {
    throw new TaskError('INVALID_HANDOFF', 'goal, status and next are required')
  }
  return [
    `目标：${goal}`,
    `现状：${status}`,
    `下一步：${next}`,
    `未决：${blockers}`,
    `证据：${evidence.length === 0 ? '无' : evidence.join('; ')}`,
  ].join('\n')
}


/** Tags that always require a human acceptance, even when tests pass. */
export const HUMAN_REQUIRED_TAGS = Object.freeze([
  'aesthetic', 'ux', 'design', 'copy', 'tone', 'voice', 'subjective', 'taste',
  'security', 'credentials', 'permissions', 'external-side-effect', 'destructive',
  'public-api', 'data-model', 'migration', 'release',
])

/**
 * Decide whether a verified task may be auto-accepted or must wait for a human.
 * Errs toward human review: missing evidence, subjective tags, irreversible or
 * externally visible actions always require a human.
 * @param {{
 *   risk?: 'low'|'high',
 *   tags?: string[],
 *   verifierPassed?: boolean,
 *   reversible?: boolean,
 *   externalSideEffects?: boolean,
 * }} input
 * @returns {{mode: 'auto'|'human', reasons: string[]}}
 */
export function classifyAcceptance({
  risk = 'low',
  tags = [],
  verifierPassed = false,
  reversible = true,
  externalSideEffects = false,
} = {}) {
  const reasons = []
  if (verifierPassed !== true) reasons.push('verification-not-passed')
  if (risk !== 'low') reasons.push('risk-not-low')
  if (!reversible) reasons.push('irreversible')
  if (externalSideEffects) reasons.push('external-side-effects')
  for (const tag of tags) if (HUMAN_REQUIRED_TAGS.includes(tag)) reasons.push(`tag:${tag}`)
  return { mode: reasons.length === 0 ? 'auto' : 'human', reasons }
}

/**
 * Accept a verified low-risk task by policy. High-risk/subjective tasks are
 * rejected here; they must go through `transition(..., { actor: 'human' })`.
 * @param {Record<string, unknown>} task
 * @param {{mode: 'auto'|'human', reasons: string[]}} decision
 * @param {string} at
 * @returns {{task: Record<string, unknown>, event: Record<string, unknown>}}
 */
/** Human acceptance: the only path to `done` when policy refuses (or lacks evidence).
 *  Requires `in_review`; records the human note and who accepted for the audit trail. */
export function acceptByHuman(task, { note, by = 'human', via = 'http', at = new Date().toISOString() } = {}) {
  if (task.status !== 'in_review') throw new TaskError('NOT_REVIEWABLE', `task ${task.id} is ${task.status}`)
  if (note !== undefined && typeof note !== 'string') throw new TaskError('INVALID_NOTE', 'acceptance note must be a string')
  return {
    task: {
      ...task,
      status: 'done',
      owner: null,
      updatedAt: at,
      version: task.version + 1,
      acceptedBy: 'human',
      acceptedByActor: by,
      acceptanceVia: via,
      acceptedAt: at,
      ...(note === undefined ? {} : { acceptanceNote: note }),
    },
    event: {
      kind: 'task/accepted-by-human',
      taskId: task.id,
      from: task.status,
      to: 'done',
      actor: 'human',
      at,
      ...(note === undefined ? {} : { note }),
    },
  }
}

export function acceptByPolicy(task, decision, at = new Date().toISOString()) {
  if (decision?.mode !== 'auto') throw new TaskError('HUMAN_ONLY', `auto acceptance refused: ${decision?.reasons?.join(', ') ?? 'human required'}`)
  if (task.status !== 'in_review') throw new TaskError('NOT_REVIEWABLE', `task ${task.id} is ${task.status}`)
  return {
    task: { ...task, status: 'done', owner: null, updatedAt: at, version: task.version + 1, acceptedBy: 'policy' },
    event: {
      kind: 'task/accepted-by-policy',
      taskId: task.id,
      from: task.status,
      to: 'done',
      actor: 'policy',
      at,
      reasons: [...decision.reasons],
    },
  }
}
