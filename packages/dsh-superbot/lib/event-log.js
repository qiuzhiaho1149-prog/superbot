/**
 * Append-only work event log + rebuildable projections.
 * Append-only ledger discipline: events are the truth, projections are disposable.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Append raw bytes (test/corruption fixtures only). */
export function appendRaw(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, text, 'utf8')
}

/** Append one JSONL event; creates the parent directory when needed. */
export function appendEvent(file, event) {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8')
  return event
}

/** Read valid events; corrupt lines are skipped and counted. */
export function readEvents(file) {
  if (!existsSync(file)) return { events: [], corrupt: 0 }
  const events = []
  let corrupt = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      corrupt += 1
    }
  }
  return { events, corrupt }
}

/** Fold events into a projection. */
export function foldEvents(events, initial, reducer) {
  let state = initial
  for (const event of events) state = reducer(state, event)
  return state
}

/** Task projection from append-only task transitions. */
export function projectTasks(events) {
  return foldEvents(events, new Map(), (tasks, event) => {
    if (event?.kind !== 'task/transition' || typeof event.taskId !== 'string') return tasks
    const previous = tasks.get(event.taskId) ?? { id: event.taskId, status: 'draft', version: 0 }
    tasks.set(event.taskId, {
      ...previous,
      status: event.to,
      version: (previous.version ?? 0) + 1,
      updatedAt: event.at ?? previous.updatedAt,
      ...(event.acceptedBy === undefined ? {} : { acceptedBy: event.acceptedBy }),
    })
    return tasks
  })
}

/** Rebuild a projection file from events (atomic replace). */
export function writeProjection(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return value
}
