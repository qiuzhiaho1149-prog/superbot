/**
 * Append-only work ledger + rebuildable projections.
 *
 * The event log (`<stateDir>/work/events.jsonl`) is the source of truth for
 * requirements, specs, plans, tasks, runs, reports and reviews. The projection
 * file (`<stateDir>/work/projection.json`) is disposable: every `load()`/`rebuild()`
 * folds the log from scratch and rewrites it, so a corrupt or stale projection
 * never blocks recovery.
 *
 * Every appended event carries:
 *   schemaVersion — projection compatibility gate
 *   seq           — 1-based append order
 *   kind          — one of WORK_EVENT_KINDS
 *   at            — ISO timestamp supplied by the store clock
 *   actor         — who caused the write (`manager`, `worker`, `verifier`, an owner id)
 *   reason        — short free-text reason for the audit trail
 *
 * Control-plane chain (S4): requirement/created → spec/recorded → plan/created.
 * A plan transaction validates the whole task DAG up front, then writes the
 * canonical `task/created` + `task/transition` events for every task and a
 * final `plan/created` event that only references task ids. Rebuilding from
 * events is therefore identical to the live projection.
 *
 * Zero dependencies: Node built-ins plus the task-engine state machine.
 */

import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import {
  MAX_ACCEPTANCE_COMMANDS, PRIORITIES, acceptByHuman, claim as claimTask, compareTasks, createTask, transition, validateTaskSpec,
} from './task-engine.js'
import { appendEvent, readEvents, writeProjection } from './event-log.js'

/** Envelope schema version. Projections fold only events with this version. */
export const WORK_SCHEMA_VERSION = 1

/** Event kinds the ledger knows about. Unknown kinds stay in the audit log only. */
export const WORK_EVENT_KINDS = Object.freeze([
  'requirement/created',
  'spec/recorded',
  'plan/created',
  'task/created',
  'task/transition',
  'run/started',
  'run/bound',
  'run/finished',
  'report/submitted',
  'review/submitted',
  // Independent acceptance evidence: exactly one machine execution of one
  // declared `acceptanceCommands[index]`, produced by the verifier's own run.
  'evidence/recorded',
  // First-run inventory: the user confirmed which existing projects are
  // active / paused / archived before Superbot started scheduling.
  'inventory/confirmed',
])

/** Run statuses that no longer hold their task. Anything else counts as active. */
export const RUN_TERMINAL_STATUSES = Object.freeze(['succeeded', 'failed', 'canceled'])

/** Whether a run still owns its task (dispatch/mutation guard). */
export function isRunActive(run) {
  return run !== undefined && run !== null && !RUN_TERMINAL_STATUSES.includes(run.status)
}

/** Fields whose text length is bounded so one report cannot bloat the ledger. */
const MAX_SUMMARY_CHARS = 4000
const MAX_NOTES_CHARS = 4000
const MAX_EVIDENCE_ITEMS = 20
const MAX_EVIDENCE_CHARS = 500
/** Planning free text is bounded too: a requirement/spec is context, not a data store. */
const MAX_TITLE_CHARS = 200
const MAX_REQUIREMENT_CHARS = 8000
const MAX_SPEC_CHARS = 8000
const MAX_PLAN_TASKS = 50
/** Machine evidence: one execution of one declared acceptance command. */
const MAX_OUTPUT_PREVIEW_CHARS = 2000
const MAX_DIGEST_CHARS = 128

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''
const clone = (value) => JSON.parse(JSON.stringify(value))

function boundedText(value, max, fallback = '') {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed === '') return fallback
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}

function boundedEvidence(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string' && item.trim() !== '')
    .slice(0, MAX_EVIDENCE_ITEMS)
    .map((item) => boundedText(item, MAX_EVIDENCE_CHARS))
}

/** Short display title: trimmed, bounded, first line only. */
function planTitle(value, fallback, max = MAX_TITLE_CHARS) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return fallback
  const firstLine = text.split('\n')[0].trim()
  return boundedText(firstLine === '' ? text : firstLine, max, fallback)
}

/** Derive a requirement title from the raw text when the caller omits one. */
function titleFromText(text) {
  return planTitle(text, '未命名需求', 80)
}

/**
 * Kahn's algorithm over plan-internal dependency edges. External deps (tasks
 * that already live in the ledger) cannot participate in a plan-internal cycle.
 * @param {ReadonlyArray<{id: string, deps?: string[]}>} specs
 * @returns {string[]|undefined} the ids left in a cycle, or undefined when acyclic
 */
export function findPlanCycle(specs) {
  const list = Array.isArray(specs) ? specs : []
  const ids = new Set(list.map((spec) => spec.id))
  const indegree = new Map(list.map((spec) => [spec.id, 0]))
  const dependents = new Map(list.map((spec) => [spec.id, []]))
  for (const spec of list) {
    for (const dep of spec.deps ?? []) {
      if (!ids.has(dep)) continue
      indegree.set(spec.id, (indegree.get(spec.id) ?? 0) + 1)
      dependents.get(dep).push(spec.id)
    }
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id)
  const ordered = []
  while (queue.length > 0) {
    const id = queue.shift()
    ordered.push(id)
    for (const next of dependents.get(id)) {
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  if (ordered.length === list.length) return undefined
  return list.map((spec) => spec.id).filter((id) => (indegree.get(id) ?? 0) > 0)
}

/** Absolute locations used by one store instance. */
export function workPaths(stateDir) {
  const dir = join(stateDir, 'work')
  return {
    dir,
    events: join(dir, 'events.jsonl'),
    projection: join(dir, 'projection.json'),
  }
}

/**
 * Single-instance lock for one stateDir (deployment contract D5).
 *
 * Two Superbot processes writing the same append-only ledger would race on
 * `seq` and evidence ids. The lock is advisory by design: a live foreign pid
 * refuses the second instance; a dead pid (crashed process) is taken over.
 */
export function acquireInstanceLock(stateDir, { pid = process.pid, now = Date.now(), attempts = 8 } = {}) {
  const dir = join(stateDir, 'work')
  const file = join(dir, 'instance.lock')
  mkdirSync(dir, { recursive: true })
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const token = randomUUID()
    const payload = `${JSON.stringify({ pid, token, startedAt: new Date(now).toISOString() })}\n`
    let fd
    try {
      // O_EXCL: exactly one process can create the lock even when two start at
      // the same instant. Never exists-check-then-write (that is a TOCTOU race).
      fd = openSync(file, 'wx', 0o600)
      writeSync(fd, payload)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      let released = false
      return {
        file,
        token,
        release() {
          if (released) return
          released = true
          try {
            const current = JSON.parse(readFileSync(file, 'utf8'))
            if (current?.token === token) unlinkSync(file)
          } catch {
            // best-effort: a missing/changed lock is not ours to delete
          }
        },
      }
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* ignore */ }
      }
      if (error?.code !== 'EEXIST') throw error
      // The winner creates the file with O_EXCL and writes immediately after;
      // a loser may observe it before the payload is flushed. Wait briefly for
      // a parseable payload instead of deleting a lock that is still being born.
      let previous
      const deadline = Date.now() + 100
      while (Date.now() < deadline) {
        try {
          previous = JSON.parse(readFileSync(file, 'utf8'))
          break
        } catch {
          previous = undefined
        }
      }
      if (previous === undefined) {
        throw new Error(`stateDir lock is present but unreadable (concurrent start?): ${file}`)
      }
      const previousPid = Number.isInteger(previous?.pid) ? previous.pid : null
      if (previousPid !== null && previousPid !== pid) {
        let alive = false
        try {
          process.kill(previousPid, 0)
          alive = true
        } catch (killError) {
          alive = killError?.code === 'EPERM'
        }
        if (alive) {
          throw new Error(`stateDir is already in use by another Superbot process (pid ${previousPid}): ${stateDir}。请先关闭它，或为每个实例配置独立的 stateDir/DSH_HOME。`)
        }
      }
      // Same-process reacquire, corrupt file, or a dead pid: remove and retry.
      try { unlinkSync(file) } catch { /* someone else may have removed it */ }
    }
  }
  throw new Error(`could not acquire the instance lock after ${attempts} attempts: ${file}`)
}

/** Order by the append seq when present; fall back to timestamps/id for old ledgers. */
function compareBySeq(left, right) {
  const leftSeq = Number.isInteger(left?.seq) ? left.seq : null
  const rightSeq = Number.isInteger(right?.seq) ? right.seq : null
  if (leftSeq !== null && rightSeq !== null) return leftSeq - rightSeq
  const leftTime = String(left?.submittedAt ?? left?.createdAt ?? '')
  const rightTime = String(right?.submittedAt ?? right?.createdAt ?? '')
  if (leftTime !== rightTime) return leftTime.localeCompare(rightTime)
  return String(left?.reviewId ?? left?.evidenceId ?? '').localeCompare(String(right?.reviewId ?? right?.evidenceId ?? ''))
}

/** Empty projection state. */
export function emptyProjection() {
  return {
    requirements: new Map(),
    specs: new Map(),
    plans: new Map(),
    tasks: new Map(),
    runs: new Map(),
    reports: new Map(),
    reviews: new Map(),
    evidence: new Map(),
    inventory: new Map(),
  }
}

/**
 * Fold one event into a projection in place.
 * @returns {boolean} whether the event was understood and applied.
 */
export function applyWorkEvent(projection, event) {
  if (!isObject(event)) return false
  if (event.schemaVersion !== WORK_SCHEMA_VERSION) return false
  if (!isNonEmptyString(event.kind)) return false
  const foldById = (collection, payload, key) => {
    const record = payload?.[key]
    if (!isObject(record) || !isNonEmptyString(record.id)) return false
    collection.set(record.id, clone(record))
    return true
  }
  const foldTask = (payload) => {
    const task = payload?.task
    if (!isObject(task) || !isNonEmptyString(task.id)) return false
    projection.tasks.set(task.id, clone(task))
    return true
  }
  switch (event.kind) {
    case 'requirement/created':
      return foldById(projection.requirements, event, 'requirement')
    case 'spec/recorded':
      return foldById(projection.specs, event, 'spec')
    case 'plan/created':
      return foldById(projection.plans, event, 'plan')
    case 'task/created':
      return foldTask(event)
    case 'task/transition': {
      // Integrity: a transition must continue the folded task, not replace it
      // with an arbitrary snapshot. A forged event (hand-edited log, injected
      // raw append) fails here and stays out of the projection.
      const task = event?.task
      if (!isObject(task) || !isNonEmptyString(task.id)) return false
      if (!isNonEmptyString(event.from) || !isNonEmptyString(event.to) || !isNonEmptyString(event.actor)) return false
      const previous = projection.tasks.get(task.id)
      if (previous !== undefined) {
        if (event.from !== previous.status) return false
        if (!Number.isInteger(task.version) || task.version !== previous.version + 1) return false
      }
      projection.tasks.set(task.id, clone(task))
      return true
    }
    case 'run/started': {
      const run = event.run
      if (!isObject(run) || !isNonEmptyString(run.runId)) return false
      projection.runs.set(run.runId, clone(run))
      return true
    }
    case 'run/bound': {
      const runId = event.runId
      if (!isNonEmptyString(runId)) return false
      const previous = projection.runs.get(runId)
      if (previous === undefined) return false
      projection.runs.set(runId, {
        ...previous,
        ...(typeof event.childId === 'string' ? { childId: event.childId } : {}),
        ...(typeof event.label === 'string' ? { label: event.label } : {}),
      })
      return true
    }
    case 'run/finished': {
      const runId = event.runId
      if (!isNonEmptyString(runId)) return false
      const previous = projection.runs.get(runId) ?? {
        runId,
        ...(typeof event.taskId === 'string' ? { taskId: event.taskId } : {}),
        ...(typeof event.agentPreset === 'string' ? { agentPreset: event.agentPreset } : {}),
        ...(typeof event.workspaceId === 'string' ? { workspaceId: event.workspaceId } : {}),
        status: 'running',
        startedAt: event.at ?? null,
      }
      projection.runs.set(runId, {
        ...previous,
        status: event.status,
        ...(typeof event.summary === 'string' ? { summary: event.summary } : {}),
        finishedAt: event.at ?? null,
      })
      return true
    }
    case 'report/submitted': {
      const report = event.report
      if (!isObject(report) || !isNonEmptyString(report.reportId)) return false
      projection.reports.set(report.reportId, clone(report))
      return true
    }
    case 'review/submitted': {
      const review = event.review
      if (!isObject(review) || !isNonEmptyString(review.reviewId)) return false
      projection.reviews.set(review.reviewId, clone(review))
      return true
    }
    case 'evidence/recorded': {
      const evidence = event.evidence
      if (!isObject(evidence) || !isNonEmptyString(evidence.evidenceId)) return false
      projection.evidence.set(evidence.evidenceId, clone(evidence))
      return true
    }
    case 'inventory/confirmed': {
      const inventory = event.inventory
      if (!isObject(inventory) || !isNonEmptyString(inventory.inventoryId)) return false
      projection.inventory.set(inventory.inventoryId, clone(inventory))
      return true
    }
    default:
      return false
  }
}

/**
 * Rebuild all projections from the raw event list.
 * @param {ReadonlyArray<Record<string, unknown>>} events
 */
export function projectWork(events) {
  const projection = emptyProjection()
  let applied = 0
  let ignored = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (applyWorkEvent(projection, event)) applied += 1
    else ignored += 1
  }
  return { ...projection, applied, ignored }
}

/** Deterministic snapshot written to `projection.json`. */
export function snapshotOf(state, { builtAt } = {}) {
  const sortById = (records) => [...records].sort((left, right) => String(left.id ?? left.runId ?? left.reportId ?? left.reviewId ?? '').localeCompare(String(right.id ?? right.runId ?? right.reportId ?? right.reviewId ?? '')))
  return {
    schemaVersion: WORK_SCHEMA_VERSION,
    builtAt: builtAt ?? null,
    counts: {
      requirements: state.requirements.size,
      specs: state.specs.size,
      plans: state.plans.size,
      tasks: state.tasks.size,
      runs: state.runs.size,
      reports: state.reports.size,
      reviews: state.reviews.size,
      evidence: state.evidence.size,
      inventory: state.inventory.size,
    },
    requirements: sortById([...state.requirements.values()]).map(clone),
    specs: sortById([...state.specs.values()]).map(clone),
    plans: sortById([...state.plans.values()]).map(clone),
    tasks: sortById([...state.tasks.values()]).map(clone),
    runs: sortById([...state.runs.values()]).map(clone),
    reports: sortById([...state.reports.values()]).map(clone),
    reviews: sortById([...state.reviews.values()]).map(clone),
    evidence: sortById([...state.evidence.values()]).map(clone),
    inventory: sortById([...state.inventory.values()].map((entry) => ({ ...entry, id: entry.inventoryId }))).map(clone),
  }
}

/**
 * Persistent work ledger. One instance per plugin process; every write is
 * appended synchronously before the in-memory projection is advanced.
 */
export class WorkStore {
  #stateDir
  #paths
  #lock
  #clock
  #defaultActor
  #events = []
  #corrupt = 0
  #nextSeq = 1
  #projectionTimer = null
  #projectionDirty = false
  #state = emptyProjection()

  /**
   * @param {{stateDir: string, actor?: string, clock?: () => string}} options
   */
  constructor({ stateDir, actor = 'manager', clock = () => new Date().toISOString() } = {}) {
    if (!isNonEmptyString(stateDir)) throw new Error('work store requires a stateDir')
    this.#lock = acquireInstanceLock(stateDir)
    this.#stateDir = stateDir
    this.#paths = workPaths(stateDir)
    this.#clock = clock
    this.#defaultActor = isNonEmptyString(actor) ? actor : 'manager'
    this.load()
  }

  get stateDir() {
    return this.#stateDir
  }

  /** Release the single-instance lock (plugin dispose). */
  dispose() {
    try { this.flushProjection() } catch { /* best effort */ }
    this.#lock?.release()
    this.#lock = undefined
  }

  get paths() {
    return { ...this.#paths }
  }

  /** Counts/health of the last fold. */
  stats() {
    return {
      schemaVersion: WORK_SCHEMA_VERSION,
      events: this.#events.length,
      corrupt: this.#corrupt,
      ignored: this.#events.length - this.#state.applied,
      requirements: this.#state.requirements.size,
      specs: this.#state.specs.size,
      plans: this.#state.plans.size,
      tasks: this.#state.tasks.size,
      runs: this.#state.runs.size,
      reports: this.#state.reports.size,
      reviews: this.#state.reviews.size,
      evidence: this.#state.evidence.size,
      inventory: this.#state.inventory.size,
      nextSeq: this.#nextSeq,
      eventsPath: this.#paths.events,
      projectionPath: this.#paths.projection,
    }
  }

  /**
   * Re-read the append-only log and rebuild every projection from scratch.
   * Always overwrites the disposable projection file.
   */
  load() {
    const { events, corrupt } = readEvents(this.#paths.events)
    this.#events = events
    this.#corrupt = corrupt
    this.#state = projectWork(events)
    this.#nextSeq = events.reduce((max, event) => (Number.isInteger(event?.seq) && event.seq > max ? event.seq : max), 0) + 1
    this.#writeProjection()
    return this.stats()
  }

  /** Explicit recovery entry point; same as {@link load}. */
  rebuild() {
    return this.load()
  }

  /** Append one well-formed envelope; advances the in-memory projection. */
  #append(kind, payload = {}, { actor, reason, at } = {}) {
    if (!WORK_EVENT_KINDS.includes(kind)) throw new Error(`unknown work event kind: ${String(kind)}`)
    const event = {
      schemaVersion: WORK_SCHEMA_VERSION,
      seq: this.#nextSeq,
      kind,
      at: typeof at === 'string' && at !== '' ? at : this.#clock(),
      actor: isNonEmptyString(actor) ? actor : this.#defaultActor,
      reason: isNonEmptyString(reason) ? reason : 'unspecified',
      ...payload,
    }
    appendEvent(this.#paths.events, event)
    this.#events.push(event)
    this.#nextSeq += 1
    // Keep the fold counters authoritative: after a live append, an event that
    // the projection accepts must not be counted as ignored by `stats()`.
    if (applyWorkEvent(this.#state, event)) this.#state.applied += 1
    else this.#state.ignored += 1
    this.#scheduleProjection()
    return clone(event)
  }

  // Small ledgers write synchronously (tests/tools expect a fresh projection);
  // large ledgers coalesce within 100ms so appending N events is not O(N²).
  #scheduleProjection() {
    if (this.#events.length <= 500) {
      this.#writeProjection()
      return
    }
    this.#projectionDirty = true
    if (this.#projectionTimer !== null) return
    this.#projectionTimer = setTimeout(() => {
      this.#projectionTimer = null
      if (!this.#projectionDirty) return
      this.#projectionDirty = false
      try { this.#writeProjection() } catch { /* projection is disposable */ }
    }, 100)
    if (typeof this.#projectionTimer.unref === 'function') this.#projectionTimer.unref()
  }

  /** Flush a pending projection write (plugin dispose). */
  flushProjection() {
    if (this.#projectionTimer !== null) { clearTimeout(this.#projectionTimer); this.#projectionTimer = null }
    if (!this.#projectionDirty) return
    this.#projectionDirty = false
    this.#writeProjection()
  }

  #writeProjection() {
    writeProjection(this.#paths.projection, snapshotOf(this.#state, { builtAt: this.#clock() }))
  }

  /**
   * Export the raw audit trail. `limit` keeps the most recent N events.
   * @param {{limit?: number}} [options]
   */
  exportAudit({ limit } = {}) {
    const events = Number.isInteger(limit) && limit > 0
      ? this.#events.slice(-limit)
      : this.#events
    return {
      schemaVersion: WORK_SCHEMA_VERSION,
      exportedAt: this.#clock(),
      eventCount: this.#events.length,
      corrupt: this.#corrupt,
      events: clone(events),
    }
  }

  // ── tasks ────────────────────────────────────────────────────────────────

  getTask(id) {
    return this.#state.tasks.get(id)
  }

  listTasks() {
    return [...this.#state.tasks.values()].sort(compareTasks)
  }

  /**
   * Validate and persist a new draft task.
   * @param {Record<string, unknown>} spec
   */
  submitTask(spec, { actor, reason = 'submit', at } = {}) {
    if (!isObject(spec)) throw new Error('task spec must be an object')
    const id = isNonEmptyString(spec.id) ? spec.id : `t-${this.#nextSeq}`
    const validation = validateTaskSpec({ ...spec, id })
    if (!validation.ok) {
      throw new Error(`invalid task spec: ${validation.errors.map((error) => `${error.path} ${error.message}`).join(', ')}`)
    }
    if (this.#state.tasks.has(id)) throw new Error(`task id already exists: ${id}`)
    const task = createTask(validation.value, { at: at ?? this.#clock() })
    this.#append('task/created', { task }, { actor, reason, at: task.createdAt })
    return this.getTask(task.id)
  }

  /** Apply a task-engine transition and persist the resulting snapshot. */
  #commitTransition(task, transitionEvent, { reason, actor } = {}) {
    this.#append('task/transition', {
      taskId: task.id,
      from: transitionEvent.from,
      to: transitionEvent.to,
      task,
    }, {
      actor: actor ?? transitionEvent.actor,
      reason: reason ?? transitionEvent.reason,
      at: transitionEvent.at,
    })
    return this.getTask(task.id)
  }

  /** draft → todo. */
  planTask(id, { actor = 'manager', reason = 'plan', at } = {}) {
    const task = this.#requireTask(id)
    const result = transition(task, 'todo', { actor, reason, at })
    return this.#commitTransition(result.task, result.event, { reason })
  }

  /** todo → in_progress with an owner (optimistic version check). */
  claimTask(id, { owner, expectedVersion, at } = {}) {
    const task = this.#requireTask(id)
    const result = claimTask(task, { owner, expectedVersion, at })
    return this.#commitTransition(result.task, result.event)
  }

  /** Generic state-machine transition used by the review flow. */
  transitionTask(id, to, { actor = 'manager', reason, at, clearOwner = false } = {}) {
    const task = this.#requireTask(id)
    const result = transition(clearOwner ? { ...task, owner: null } : task, to, { actor, reason, at })
    return this.#commitTransition(result.task, result.event, { reason })
  }

  /**
   * Persist an already-computed acceptance transition (e.g. `acceptByPolicy`).
   * @param {{task: Record<string, unknown>, event: Record<string, unknown>}} accepted
   */
  commitAccepted(accepted, { reason = 'policy-accept' } = {}) {
    if (!isObject(accepted) || !isObject(accepted.task) || !isObject(accepted.event)) {
      throw new Error('commitAccepted requires { task, event } from the task engine')
    }
    return this.#commitTransition(accepted.task, accepted.event, { reason })
  }

  #requireTask(id) {
    const task = this.#state.tasks.get(id)
    if (task === undefined) throw new Error(`unknown task: ${String(id)}`)
    return task
  }

  // ── runs ─────────────────────────────────────────────────────────────────

  getRun(runId) {
    return this.#state.runs.get(runId)
  }

  listRuns({ taskId } = {}) {
    const runs = [...this.#state.runs.values()]
    return (taskId === undefined ? runs : runs.filter((run) => run.taskId === taskId))
      .sort((left, right) => String(left.startedAt ?? '').localeCompare(String(right.startedAt ?? '')) || left.runId.localeCompare(right.runId))
  }

  /**
   * Resolve the run that a live child session belongs to. The verifier tools use
   * this instead of trusting a model-supplied runId: `exec.agent.id` is the
   * session id the host created, and the ledger binds it to exactly one run.
   */
  findRunByChildId(childId, { taskId, agentPreset } = {}) {
    if (!isNonEmptyString(childId)) return undefined
    const matches = [...this.#state.runs.values()].filter((run) => run.childId === childId
      && (taskId === undefined || run.taskId === taskId)
      && (agentPreset === undefined || run.agentPreset === agentPreset))
    return matches.sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')))[0]
  }

  /** Record a worker/verifier activation before it starts. */
  startRun({ taskId, agentPreset, workspaceId, label, parentSessionId, workspacePath, baselineWorkspaceDigest, baselineProtectedDigest, actor, reason = 'dispatch', at } = {}) {
    const runId = `r-${this.#nextSeq}`
    const run = {
      runId,
      status: 'running',
      ...(taskId === undefined ? {} : { taskId }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(label === undefined ? {} : { label }),
      // Provenance: which manager thread owns this child thread. Together with
      // `childId` this is the thread → task → project hierarchy the UI reads.
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      // Acceptance-integrity baseline, captured BEFORE the worker starts.
      ...(workspacePath === undefined ? {} : { workspacePath }),
      ...(baselineWorkspaceDigest === undefined ? {} : { baselineWorkspaceDigest }),
      ...(baselineProtectedDigest === undefined ? {} : { baselineProtectedDigest }),
      childId: null,
      startedAt: typeof at === 'string' && at !== '' ? at : this.#clock(),
    }
    this.#append('run/started', { run }, { actor, reason, at: run.startedAt })
    return this.getRun(runId)
  }

  /** Attach the durable child session id once activation returns it. */
  bindRun(runId, { childId, label, actor, reason = 'dispatch-started' } = {}) {
    this.#requireRun(runId)
    this.#append('run/bound', {
      runId,
      ...(childId === undefined ? {} : { childId }),
      ...(label === undefined ? {} : { label }),
    }, { actor, reason })
    return this.getRun(runId)
  }

  /** Close a run once its result is known (or its activation failed). */
  finishRun(runId, { status = 'succeeded', summary, actor, reason = 'dispatch-result', at } = {}) {
    const run = this.#requireRun(runId)
    if (run.status !== 'running') throw new Error(`run ${runId} is already ${run.status}`)
    this.#append('run/finished', {
      runId,
      ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
      ...(run.agentPreset === undefined ? {} : { agentPreset: run.agentPreset }),
      ...(run.workspaceId === undefined ? {} : { workspaceId: run.workspaceId }),
      status,
      ...(summary === undefined ? {} : { summary: boundedText(summary, MAX_SUMMARY_CHARS) }),
    }, { actor, reason, at })
    return this.getRun(runId)
  }

  #requireRun(runId) {
    const run = this.#state.runs.get(runId)
    if (run === undefined) throw new Error(`unknown run: ${String(runId)}`)
    return run
  }

  // ── reports ──────────────────────────────────────────────────────────────

  listReports({ taskId, runId } = {}) {
    return [...this.#state.reports.values()]
      .filter((report) => (taskId === undefined || report.taskId === taskId) && (runId === undefined || report.runId === runId))
      .sort((left, right) => String(left.submittedAt ?? '').localeCompare(String(right.submittedAt ?? '')) || left.reportId.localeCompare(right.reportId))
  }

  /** Persist a worker report (what was done + evidence). */
  submitReport({ taskId, runId, author, summary, evidence, actor, reason = 'report', at } = {}) {
    if (taskId !== undefined) this.#requireTask(taskId)
    if (runId !== undefined) this.#requireRun(runId)
    const reportId = `rp-${this.#nextSeq}`
    const report = {
      reportId,
      ...(taskId === undefined ? {} : { taskId }),
      ...(runId === undefined ? {} : { runId }),
      author: isNonEmptyString(author) ? author : (isNonEmptyString(actor) ? actor : 'worker'),
      summary: boundedText(summary, MAX_SUMMARY_CHARS, '(no summary)'),
      evidence: boundedEvidence(evidence),
      submittedAt: typeof at === 'string' && at !== '' ? at : this.#clock(),
    }
    this.#append('report/submitted', { report }, { actor: actor ?? report.author, reason, at: report.submittedAt })
    return this.#state.reports.get(reportId)
  }

  // ── evidence (machine-executed acceptance) ───────────────────────────────

  getEvidence(evidenceId) {
    return this.#state.evidence.get(evidenceId)
  }

  listEvidence({ taskId, runId } = {}) {
    return [...this.#state.evidence.values()]
      .filter((row) => (taskId === undefined || row.taskId === taskId) && (runId === undefined || row.runId === runId))
      .sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')) || left.evidenceId.localeCompare(right.evidenceId))
  }

  /**
   * Record ONE machine execution of ONE declared acceptance command.
   *
   * Structural rules (the point of the whole design):
   * - the run must be the verifying run bound to this task (`superbot-verifier`);
   * - the command must equal `task.acceptanceCommands[index].command` — arbitrary
   *   shell never enters the evidence trail;
   * - workers cannot record evidence (their report stays a claim).
   */
  recordEvidence({
    taskId, runId, childId, index, command, exitCode, timedOut, durationMs, outputDigest, outputPath, preview,
    workspaceDigest, protectedDigest, workspacePath, sandboxMode, executionMode, sandboxed, isolationMode, actor, at,
  } = {}) {
    const task = this.#requireTask(taskId)
    const verifierRun = this.#requireRun(runId)
    if (verifierRun.taskId !== taskId) throw new Error(`run ${runId} is not bound to task ${taskId}`)
    if (verifierRun.agentPreset !== 'superbot-verifier') throw new Error(`run ${runId} is not a verifier run (${String(verifierRun.agentPreset)})`)
    const declared = Array.isArray(task.acceptanceCommands) ? task.acceptanceCommands : []
    if (!Number.isInteger(index) || index < 0 || index >= declared.length) {
      throw new Error(`task ${taskId} has no acceptance command at index ${String(index)} (declared: ${declared.length})`)
    }
    const declaredCommand = declared[index].command
    if (typeof command !== 'string' || command.trim() !== declaredCommand) {
      throw new Error(`evidence command does not match the declared acceptance command at index ${index}`)
    }
    if (!Number.isInteger(exitCode)) throw new Error('evidence requires an integer exitCode')
    // A failing command is still evidence (the verifier must see the failure);
    // `evidenceCoverage` decides whether the expectation was met.
    if (childId !== undefined && verifierRun.childId !== undefined && childId !== verifierRun.childId) {
      throw new Error(`decision session ${childId} does not match verifier run ${runId} (child ${verifierRun.childId})`)
    }
    // Attempt binding: which worker attempt this evidence belongs to.
    const ownerRunId = isNonEmptyString(task.owner) ? task.owner : null
    const evidenceId = `ev-${this.#nextSeq}`
    const evidence = {
      evidenceId,
      seq: this.#nextSeq,
      taskId,
      projectId: task.projectId,
      runId,
      ...(childId === undefined ? {} : { childId }),
      ...(ownerRunId === null ? {} : { ownerRunId }),
      taskVersion: Number.isInteger(task.version) ? task.version : null,
      index,
      command: declaredCommand,
      exitCode,
      expectedExitCode: declared[index].expectExitCode ?? 0,
      timedOut: timedOut === true,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : null,
      outputDigest: boundedText(outputDigest, MAX_DIGEST_CHARS, ''),
      outputPath: boundedText(outputPath, 1024, ''),
      preview: boundedText(preview, MAX_OUTPUT_PREVIEW_CHARS, ''),
      ...(workspaceDigest === undefined ? {} : { workspaceDigest: boundedText(workspaceDigest, MAX_DIGEST_CHARS, '') }),
      ...(protectedDigest === undefined ? {} : { protectedDigest: boundedText(protectedDigest, MAX_DIGEST_CHARS, '') }),
      ...(workspacePath === undefined ? {} : { workspacePath: boundedText(workspacePath, 1024, '') }),
      ...(sandboxMode === undefined ? {} : { sandboxMode: boundedText(sandboxMode, 64, '') }),
      ...(executionMode === undefined ? {} : { executionMode: boundedText(executionMode, 32, '') }),
      ...(sandboxed === undefined ? {} : { sandboxed: sandboxed === true }),
      ...(isolationMode === undefined ? {} : { isolationMode: boundedText(isolationMode, 32, '') }),
      createdAt: typeof at === 'string' && at !== '' ? at : this.#clock(),
    }
    this.#append('evidence/recorded', { evidence }, { actor: isNonEmptyString(actor) ? actor : runId, reason: 'acceptance-run', at: evidence.createdAt })
    return this.#state.evidence.get(evidenceId)
  }

  /** Latest evidence per declared acceptance command: the only coverage policy accepts. */
  evidenceCoverage(taskId) {
    const task = this.#requireTask(taskId)
    const commands = Array.isArray(task.acceptanceCommands) ? task.acceptanceCommands : []
    // Only the CURRENT attempt counts: evidence produced for another owner run
    // (an earlier worker attempt) must not satisfy this attempt's acceptance.
    const attempt = isNonEmptyString(task.owner) ? task.owner : undefined
    const latest = new Map()
    for (const evidence of this.listEvidence({ taskId })) {
      if (attempt !== undefined && evidence.ownerRunId !== undefined && evidence.ownerRunId !== attempt) continue
      latest.set(evidence.index, evidence)
    }
    const rows = commands.map((entry, index) => {
      const evidence = latest.get(index)
      const expectedExitCode = entry.expectExitCode ?? 0
      const passed = evidence !== undefined && evidence.timedOut !== true && evidence.exitCode === expectedExitCode
      return {
        index,
        command: entry.command,
        expectedExitCode,
        evidenceId: evidence?.evidenceId ?? null,
        runId: evidence?.runId ?? null,
        exitCode: evidence?.exitCode ?? null,
        passed,
      }
    })
    return {
      commandCount: rows.length,
      hasCommands: rows.length > 0,
      complete: rows.length > 0 && rows.every((row) => row.passed),
      rows,
    }
  }

  // ── onboarding inventory ────────────────────────────────────────────────

  /**
   * Human reject: in_review → in_progress, owner kept so the SAME worker
   * attempt is reworked, and the decision is recorded as a human pending review.
   */
  rejectTaskByHuman(taskId, { note, actor = 'human', reason = 'human-reject' } = {}) {
    const task = this.#requireTask(taskId)
    if (task.status !== 'in_review') throw new Error(`task ${taskId} is ${task.status}; only an in-review task can be rejected`)
    const reviewed = this.transitionTask(taskId, 'in_progress', { actor, reason })
    this.submitReview({
      taskId,
      reviewer: 'human',
      reviewerRole: 'human',
      verdict: 'pending',
      notes: note ?? '老板退回：不通过，需要返工',
      source: 'human',
      reviewedOwner: task.owner ?? null,
      decision: { mode: 'human', reasons: ['human-reject'] },
      actor,
      reason: 'human-reject',
    })
    return { task: this.getTask(taskId), rejectedFrom: reviewed.status }
  }

  /** Latest confirmed inventory (newest append wins), or undefined. */
  getInventoryConfirmation() {
    return [...this.#state.inventory.values()]
      .sort((left, right) => String(left.confirmedAt ?? '').localeCompare(String(right.confirmedAt ?? '')) || left.inventoryId.localeCompare(right.inventoryId))
      .at(-1)
  }

  /**
   * Persist the user's confirmation of the first-run inventory.
   * Only the host HTTP surface / approval dialog should call this — it is the
   * user's decision about which existing projects are active or paused.
   */
  confirmInventory({ projects, note, via = 'http', actor = 'human' } = {}) {
    if (!Array.isArray(projects) || projects.length === 0) throw new Error('inventory confirmation requires a non-empty projects array')
    const rows = projects.map((project, index) => {
      if (!isObject(project) || !isNonEmptyString(project.projectId)) {
        throw new Error(`inventory project ${index + 1} requires a projectId`)
      }
      if (!['active', 'paused', 'archived', 'unknown'].includes(project.status)) {
        throw new Error(`inventory project ${project.projectId} has an unknown status: ${String(project.status)}`)
      }
      return {
        projectId: project.projectId.trim(),
        status: project.status,
        ...(isNonEmptyString(project.title) ? { title: planTitle(project.title, project.projectId) } : {}),
        ...(isNonEmptyString(project.path) ? { path: project.path } : {}),
      }
    })
    const inventoryId = `inv-${this.#nextSeq}`
    const inventory = {
      inventoryId,
      projects: rows,
      ...(note === undefined ? {} : { note: boundedText(note, MAX_NOTES_CHARS, '') }),
      via: isNonEmptyString(via) ? via : 'http',
      confirmedAt: this.#clock(),
    }
    this.#append('inventory/confirmed', { inventory }, { actor, reason: 'onboarding-confirm', at: inventory.confirmedAt })
    return this.#state.inventory.get(inventoryId)
  }

  /** Lookup a confirmed project status (used by future scheduling gates). */
  confirmedProjectStatus(projectId) {
    if (typeof projectId !== 'string') return undefined
    const latest = this.getInventoryConfirmation()
    return latest?.projects.find((project) => project.projectId === projectId)?.status
  }

  // ── reviews ──────────────────────────────────────────────────────────────

  listReviews({ taskId } = {}) {
    return [...this.#state.reviews.values()]
      .filter((review) => taskId === undefined || review.taskId === taskId)
      .sort(compareBySeq)
  }

  /**
   * Persist an acceptance record. Does not mutate the task.
   *
   * `source` decides which structural checks run:
   * - `verifier` — the verdict of the independent verifier thread. A `pass`
   *   MUST carry `runId` (its own verifier run) and `evidenceIds` produced by
   *   that run, covering EVERY declared acceptance command. A verifier can no
   *   longer vote from prose.
   * - `policy` — the manager asked the ledger to evaluate; reviewer identity is
   *   `policy`, never the task owner.
   * - `human` — an explicit human acceptance (only reachable from the host
   *   surface, never from an agent tool).
   */
  submitReview({ taskId, reviewer, reviewerRole, runId, childId, verdict, notes, evidenceIds, decision, source = 'verifier', reviewedOwner, workspaceDigest, protectedDigest, actor, reason = 'review', at } = {}) {
    if (!isNonEmptyString(taskId)) throw new Error('review requires taskId')
    const task = this.#requireTask(taskId)
    if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'pending') {
      throw new Error('review verdict must be pass, fail or pending')
    }
    const normalizedSource = isNonEmptyString(source) ? source : 'verifier'
    if (!['verifier', 'policy', 'human'].includes(normalizedSource)) {
      throw new Error(`unknown review source: ${normalizedSource}`)
    }
    const evidence = Array.isArray(evidenceIds) ? evidenceIds.filter((id) => isNonEmptyString(id)) : []
    let normalizedRole = reviewerRole
    if (normalizedSource === 'verifier') {
      normalizedRole = 'verifier'
      if (!isNonEmptyString(runId)) throw new Error('verifier review requires the verifier runId that produced the evidence')
      const run = this.#requireRun(runId)
      if (run.taskId !== taskId) throw new Error(`run ${runId} is not bound to task ${taskId}`)
      if (run.agentPreset !== 'superbot-verifier') throw new Error(`run ${runId} is not a verifier run (${String(run.agentPreset)})`)
      if (childId !== undefined && run.childId !== undefined && childId !== run.childId) {
        throw new Error(`review session ${childId} does not match verifier run ${runId} (child ${run.childId})`)
      }
      if (verdict === 'pass') {
        if (evidence.length === 0) {
          throw new Error('a passing review requires evidenceIds from superbot_acceptance_run (prose is not evidence)')
        }
        for (const evidenceId of evidence) {
          const row = this.#state.evidence.get(evidenceId)
          if (row === undefined) throw new Error(`unknown evidence: ${evidenceId}`)
          if (row.taskId !== taskId) throw new Error(`evidence ${evidenceId} belongs to task ${row.taskId}, not ${taskId}`)
          if (row.runId !== runId) throw new Error(`evidence ${evidenceId} was produced by run ${row.runId}, not by this verifier run ${runId}`)
        }
        const coverage = this.evidenceCoverage(taskId)
        const referenced = new Set(evidence)
        const missing = coverage.rows.filter((row) => row.passed !== true || !referenced.has(row.evidenceId))
        if (missing.length > 0) {
          throw new Error(`passing review requires passing evidence for every acceptance command; missing/failed: ${missing.map((row) => `${row.index}:${row.evidenceId ?? 'none'}`).join(', ')}`)
        }
      }
    } else if (normalizedSource === 'policy') {
      normalizedRole = 'manager'
    } else {
      normalizedRole = 'human'
    }
    const reviewId = `rv-${this.#nextSeq}`
    const review = {
      reviewId,
      seq: this.#nextSeq,
      taskId,
      ...(runId === undefined ? {} : { runId }),
      ...(childId === undefined ? {} : { childId }),
      reviewer: isNonEmptyString(reviewer) ? reviewer : (normalizedSource === 'policy' ? 'policy' : (isNonEmptyString(actor) ? actor : 'verifier')),
      reviewerRole: normalizedRole,
      ...(reviewedOwner === undefined ? {} : { reviewedOwner }),
      verdict,
      notes: boundedText(notes, MAX_NOTES_CHARS, ''),
      ...(evidence.length === 0 ? {} : { evidenceIds: evidence }),
      ...(decision === undefined ? {} : { decision }),
      ...(workspaceDigest === undefined ? {} : { workspaceDigest: boundedText(workspaceDigest, MAX_DIGEST_CHARS, '') }),
      ...(protectedDigest === undefined ? {} : { protectedDigest: boundedText(protectedDigest, MAX_DIGEST_CHARS, '') }),
      ...(isNonEmptyString(task.owner) ? { ownerRunId: task.owner } : {}),
      source: normalizedSource,
      submittedAt: typeof at === 'string' && at !== '' ? at : this.#clock(),
    }
    this.#append('review/submitted', { review }, { actor: normalizedSource === 'policy' ? 'policy' : (isNonEmptyString(actor) ? actor : review.reviewer), reason, at: review.submittedAt })
    return this.#state.reviews.get(reviewId)
  }

  /**
   * Human acceptance — the ONLY path for tasks policy refuses or cannot verify.
   * Callable only from the host HTTP surface (`POST /superbot/accept`), never
   * from an agent tool, so an agent cannot mark its own work done.
   */
  acceptTaskByHuman(id, { note, via = 'http' } = {}) {
    const task = this.#requireTask(id)
    const accepted = acceptByHuman(task, { via, ...(note === undefined ? {} : { note }) })
    const review = this.submitReview({
      taskId: id,
      reviewer: 'human',
      reviewerRole: 'human',
      verdict: 'pass',
      notes: note === undefined ? 'human acceptance' : boundedText(note, MAX_NOTES_CHARS, 'human acceptance'),
      source: 'human',
      reviewedOwner: task.owner ?? null,
      actor: 'human',
      reason: 'human-accept',
    })
    const committed = this.#commitTransition(accepted.task, accepted.event, { reason: 'human-accept' })
    return { task: committed, review }
  }

  // ── requirements / specs / plans ─────────────────────────────────────────

  getRequirement(id) {
    return this.#state.requirements.get(id)
  }

  listRequirements({ projectId, limit } = {}) {
    const rows = [...this.#state.requirements.values()]
      .filter((requirement) => projectId === undefined || requirement.projectId === projectId)
      .sort((left, right) => String(left.submittedAt ?? '').localeCompare(String(right.submittedAt ?? '')) || left.id.localeCompare(right.id))
    return Number.isInteger(limit) && limit > 0 ? rows.slice(-limit) : rows
  }

  /**
   * Persist the raw user requirement. This never creates tasks or dispatches:
   * a spec and a plan are explicit later steps.
   */
  submitRequirement({ projectId, title, text, priority = 'normal' }, { actor, reason = 'requirement-submit', at } = {}) {
    if (!isNonEmptyString(projectId)) throw new Error('requirement requires a projectId')
    if (!isNonEmptyString(text)) throw new Error('requirement requires the raw text')
    if (!PRIORITIES.includes(priority)) throw new Error(`requirement priority must be one of ${PRIORITIES.join(', ')}`)
    const requirement = {
      id: `rq-${this.#nextSeq}`,
      projectId: projectId.trim(),
      title: planTitle(title, titleFromText(text)),
      priority,
      text: boundedText(text, MAX_REQUIREMENT_CHARS),
      status: 'submitted',
      submittedAt: typeof at === 'string' && at !== '' ? at : this.#clock(),
    }
    this.#append('requirement/created', { requirement }, { actor, reason, at: requirement.submittedAt })
    return this.getRequirement(requirement.id)
  }

  getSpec(id) {
    return this.#state.specs.get(id)
  }

  listSpecs({ requirementId } = {}) {
    return [...this.#state.specs.values()]
      .filter((spec) => requirementId === undefined || spec.requirementId === requirementId)
      .sort((left, right) => String(left.recordedAt ?? '').localeCompare(String(right.recordedAt ?? '')) || left.id.localeCompare(right.id))
  }

  /** Record an actionable spec under a requirement (content + optional acceptance). */
  recordSpec({ requirementId, title, content, acceptance, constraints }, { actor, reason = 'spec-record', at } = {}) {
    const requirement = this.#requireRequirement(requirementId)
    if (!isNonEmptyString(content)) throw new Error('spec requires content')
    const spec = {
      id: `sp-${this.#nextSeq}`,
      requirementId: requirement.id,
      title: planTitle(title, requirement.title),
      content: boundedText(content, MAX_SPEC_CHARS),
      acceptance: boundedEvidence(acceptance),
      constraints: boundedEvidence(constraints),
      recordedAt: typeof at === 'string' && at !== '' ? at : this.#clock(),
    }
    this.#append('spec/recorded', { spec }, { actor, reason, at: spec.recordedAt })
    return this.getSpec(spec.id)
  }

  getPlan(id) {
    return this.#state.plans.get(id)
  }

  listPlans({ requirementId } = {}) {
    return [...this.#state.plans.values()]
      .filter((plan) => requirementId === undefined || plan.requirementId === requirementId)
      .sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')) || left.id.localeCompare(right.id))
  }

  /**
   * Create a plan: validate the whole DAG first, then persist the canonical
   * task events. Tasks are written as `draft` by `submitTask` and immediately
   * planned into `todo` — creating a plan IS the planning act, so its tasks are
   * dispatchable (unlike `superbot_task_submit`, whose draft needs an explicit
   * `superbot_task_plan`). Every task still goes through `validateTaskSpec`.
   *
   * @returns {{plan: Record<string, unknown>, tasks: Array<Record<string, unknown>>}}
   */
  createPlan({ requirementId, title, specId, tasks }, { actor, reason = 'plan-create', at } = {}) {
    const requirement = this.#requireRequirement(requirementId)
    if (specId !== undefined) {
      const spec = this.#requireSpec(specId)
      if (spec.requirementId !== requirement.id) throw new Error(`spec ${specId} does not belong to requirement ${requirement.id}`)
    }
    if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('plan requires at least one task')
    if (tasks.length > MAX_PLAN_TASKS) throw new Error(`plan accepts at most ${MAX_PLAN_TASKS} tasks`)

    // Phase 1 — validate everything before touching the append-only log.
    const reserved = new Set()
    let cursor = this.#nextSeq
    const specs = []
    for (const [index, raw] of tasks.entries()) {
      if (!isObject(raw)) throw new Error(`plan task ${index + 1} must be an object`)
      const id = isNonEmptyString(raw.id) ? raw.id.trim() : `t-${cursor}`
      // Each task consumes two events: task/created (+1) and task/transition (+1).
      cursor += 2
      if (reserved.has(id)) throw new Error(`duplicate task id in plan: ${id}`)
      if (this.#state.tasks.has(id)) throw new Error(`task id already exists: ${id}`)
      reserved.add(id)
      const validation = validateTaskSpec({ ...raw, id })
      if (!validation.ok) {
        throw new Error(`invalid plan task ${id}: ${validation.errors.map((error) => `${error.path} ${error.message}`).join(', ')}`)
      }
      specs.push(validation.value)
    }
    const planIds = new Set(specs.map((spec) => spec.id))
    for (const spec of specs) {
      for (const dep of spec.deps ?? []) {
        if (!planIds.has(dep) && !this.#state.tasks.has(dep)) {
          throw new Error(`plan task ${spec.id} depends on unknown task: ${dep}`)
        }
      }
    }
    const cycle = findPlanCycle(specs)
    if (cycle !== undefined) throw new Error(`plan task dependencies must be acyclic: ${cycle.join(', ')}`)

    // Phase 2 — append canonical events; the projection advances with them.
    const created = specs.map((spec) => this.submitTask(spec, { actor, reason: 'plan-task', at }))
    for (const task of created) this.planTask(task.id, { actor, reason: 'plan-create', at })
    const plan = {
      id: `pl-${this.#nextSeq}`,
      requirementId: requirement.id,
      title: planTitle(title, requirement.title),
      ...(specId === undefined ? {} : { specId }),
      taskIds: created.map((task) => task.id),
      createdAt: typeof at === 'string' && at !== '' ? at : this.#clock(),
    }
    this.#append('plan/created', { plan }, { actor, reason, at: plan.createdAt })
    return { plan: this.getPlan(plan.id), tasks: plan.taskIds.map((id) => this.getTask(id)) }
  }

  #requireRequirement(id) {
    const requirement = this.#state.requirements.get(id)
    if (requirement === undefined) throw new Error(`unknown requirement: ${String(id)}`)
    return requirement
  }

  #requireSpec(id) {
    const spec = this.#state.specs.get(id)
    if (spec === undefined) throw new Error(`unknown spec: ${String(id)}`)
    return spec
  }
}

/** Convenience factory. */
export function createWorkStore(options) {
  return new WorkStore(options)
}
