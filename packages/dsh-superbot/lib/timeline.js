/**
 * Server-side timeline model: numeric epochs and durations only, so the client
 * can draw aligned bars with a single xPct function. No ISO strings, no
 * client-side Date.now, no silent drops — a bad timestamp marks the item
 * instead of disappearing.
 */

import { isRunActive } from './work-store.js'

export function toEpoch(value, { now = Date.now() } = {}) {
  if (Number.isInteger(value)) return value
  if (typeof value !== 'string' || value === '') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const MAX_ITEMS = 300

/**
 * @param {{
 *   store: import('./work-store.js').WorkStore,
 *   projects?: ReadonlyArray<Record<string, unknown>>,
 *   now?: number,
 * }} input
 */
export function buildTimeline({ store, projects = [], now = Date.now() }) {
  const tasks = store.listTasks()
  const runs = store.listRuns()
  const lanes = []
  let itemTotal = 0
  let shown = 0
  for (const project of Array.isArray(projects) ? projects : []) {
    const projectId = project.workspaceId
    const items = []
    for (const run of runs) {
      const runProject = run.workspaceId ?? (run.taskId === undefined || run.taskId === null ? null : store.getTask(run.taskId)?.projectId)
      if (runProject !== projectId) continue
      const t0 = toEpoch(run.startedAt, { now })
      if (t0 === null) continue
      const t1 = toEpoch(run.finishedAt, { now })
      items.push({
        key: `run:${run.runId}`,
        kind: 'thread',
        t0,
        t1,
        durationMs: t1 === null ? null : t1 - t0,
        state: isRunActive(run) ? 'running' : run.status,
        preset: run.agentPreset ?? null,
        label: run.label ?? null,
        taskId: run.taskId ?? null,
        childId: run.childId ?? null,
        missingTime: t1 === null && !isRunActive(run),
      })
      itemTotal += 1
    }
    for (const task of tasks) {
      if (task.projectId !== projectId) continue
      const t0 = toEpoch(task.createdAt ?? task.updatedAt, { now })
      if (t0 === null) continue
      const t1 = toEpoch(task.updatedAt, { now })
      items.push({
        key: `task:${task.id}`,
        kind: 'task',
        t0,
        t1,
        durationMs: t1 === null ? null : Math.max(0, t1 - t0),
        taskId: task.id,
        status: task.status,
        missingTime: t1 === null,
      })
      itemTotal += 1
    }
    items.sort((left, right) => left.t0 - right.t0)
    lanes.push({
      laneId: projectId,
      projectId,
      title: typeof project.title === 'string' && project.title !== '' ? project.title : projectId,
      items: items.slice(0, MAX_ITEMS),
      truncated: items.length > MAX_ITEMS,
      total: items.length,
    })
    shown += items.slice(0, MAX_ITEMS).length
  }
  return {
    now,
    generatedAt: new Date(now).toISOString(),
    lanes,
    truncated: { shown, total: itemTotal, cap: MAX_ITEMS },
  }
}
