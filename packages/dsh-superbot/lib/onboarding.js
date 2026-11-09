/**
 * First-run inventory: scan the existing DSH installation before scheduling.
 *
 * The user usually arrives with many projects and threads already in flight.
 * Superbot must NOT start dispatching on assumptions: it inventories
 *   project (= DSH workspace)
 *     └─ threads (= sessions, including subagent sessions) + ledger work items
 * proposes a status per project (进行中 / 暂时挂起 / 已归档 / 未知), and asks the
 * user to confirm. Read-only: it never creates tasks, never archives sessions.
 *
 * Data sources (degrade silently):
 *   1. host workspaceRegistry via lib/workspace-service.js (authoritative projects);
 *   2. $DSH_HOME/sessions/<sanitized-workspace-path>/<session-id>/session.v4.jsonl.zstd
 *      — bounded head-parse for title / agentPreset / origin; file mtime = last activity;
 *      session.lock mtime = "probably live" hint;
 *   3. the plugin's own ledger (tasks/requirements) when it already has history.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const PROJECT_STATUSES = ['active', 'paused', 'archived', 'unknown']
export const STATUS_LABELS = { active: '进行中', paused: '暂时挂起', archived: '已归档', unknown: '未知' }

const ACTIVE_DAYS = 3
const MAX_SESSIONS = 300
const MAX_SESSION_BYTES = 192 * 1024
const MAX_FRAMES = 24
const LOCK_LIVE_MS = 5 * 60 * 1000
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** DSH_HOME derived from the plugin stateDir (`<home>/storages/dsh-superbot`). */
export function dshHomeOf(stateDir) {
  if (typeof stateDir !== 'string' || stateDir === '') return undefined
  return dirname(dirname(stateDir))
}

/** Directory name DSH uses for a workspace path (`/a/b` -> `--a-b--`). */
export function sessionDirName(workspacePath) {
  if (typeof workspacePath !== 'string' || workspacePath === '') return undefined
  const slug = workspacePath.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? undefined : `--${slug}--`
}

/** Split a concatenated-zstd buffer into frames (append-only session logs). */
function frameOffsets(buffer) {
  const offsets = []
  for (let index = 0; index + 3 < buffer.length; index += 1) {
    if (buffer[index] === ZSTD_MAGIC[0] && buffer[index + 1] === ZSTD_MAGIC[1]
      && buffer[index + 2] === ZSTD_MAGIC[2] && buffer[index + 3] === ZSTD_MAGIC[3]) offsets.push(index)
  }
  return offsets
}

const asIso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)
const daysSince = (iso, now) => {
  if (typeof iso !== 'string') return Number.POSITIVE_INFINITY
  const time = Date.parse(iso)
  return Number.isFinite(time) ? (now - time) / 86_400_000 : Number.POSITIVE_INFINITY
}

/**
 * Read bounded metadata from one session log: header + latest title in the head
 * window. Never throws; a corrupt/absent log yields nulls.
 * @returns {{sessionId: string, title: string|null, cwd: string|null, agentPreset: string|null, origin: string|null, delegationDepth: number|null, lastActiveAt: string|null, archived: boolean, live: boolean}}
 */
export function readSessionMeta(sessionDir, sessionId, { archived = false, now = Date.now(), maxBytes = MAX_SESSION_BYTES } = {}) {
  const meta = {
    sessionId,
    title: null,
    cwd: null,
    agentPreset: null,
    origin: null,
    delegationDepth: null,
    lastActiveAt: null,
    archived,
    live: false,
    digest: null,
  }
  const logPath = join(sessionDir, 'session.v4.jsonl.zstd')
  try {
    const stat = statSync(logPath)
    meta.lastActiveAt = asIso(stat.mtimeMs)
    const size = Math.min(stat.size, maxBytes)
    const buffer = readFileSync(logPath).subarray(0, size)
    const offsets = frameOffsets(buffer)
    let parsedFrames = 0
    let text = ''
    for (let index = 0; index < offsets.length && parsedFrames < MAX_FRAMES; index += 1) {
      const start = offsets[index]
      const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
      try {
        text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
        parsedFrames += 1
      } catch {
        // torn tail: stop reading this log
        break
      }
    }
    let firstUserText = null
    const extractText = (content) => {
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join(' ').trim()
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type === 'session') {
        meta.cwd = typeof event.cwd === 'string' ? event.cwd : meta.cwd
        meta.agentPreset = typeof event.agentPreset === 'string' ? event.agentPreset : meta.agentPreset
        meta.origin = typeof event.origin === 'string' ? event.origin : meta.origin
        meta.delegationDepth = Number.isInteger(event.delegationDepth) ? event.delegationDepth : meta.delegationDepth
      } else if (event.type === 'session/title') {
        const title = event?.data?.title
        if (typeof title === 'string' && title.trim() !== '') meta.title = title
      } else if (event.type === 'user/message' && firstUserText === null) {
        const candidate = extractText(event?.data?.content ?? event?.content)
        if (candidate !== '') firstUserText = candidate
      }
    }
    if (firstUserText !== null) meta.digest = { intent: firstUserText.slice(0, 600) }
  } catch {
    // missing/unreadable log: keep nulls (lastActiveAt may be null)
  }
  try {
    const lock = statSync(join(sessionDir, 'session.lock'))
    meta.live = now - lock.mtimeMs < LOCK_LIVE_MS
  } catch {
    meta.live = false
  }
  return meta
}

/**
 * Enumerate sessions on disk, grouped by workspace directory.
 * Bounded by `maxSessions` (newest first) and a soft deadline.
 */
export function scanThreads(dshHome, { projects = [], archivedSessionIds = [], now = Date.now(), maxSessions = MAX_SESSIONS, deadline = Date.now() + 1500 } = {}) {
  const result = { available: false, sessionsDir: null, threads: [], scanned: 0, skipped: 0, projectDirById: {} }
  if (typeof dshHome !== 'string' || dshHome === '') return result
  const sessionsDir = join(dshHome, 'sessions')
  result.sessionsDir = sessionsDir
  let dirs
  try {
    dirs = readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return result
  }
  result.available = true
  const byDirName = new Map()
  for (const project of projects) {
    const dirName = sessionDirName(project.path)
    if (dirName !== undefined) byDirName.set(dirName, project.workspaceId)
  }
  const archived = new Set(archivedSessionIds)
  const candidates = []
  for (const workspaceDir of dirs) {
    const workspacePath = join(sessionsDir, workspaceDir.name)
    let sessions
    try {
      sessions = readdirSync(workspacePath, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    for (const session of sessions) {
      const sessionDir = join(workspacePath, session.name)
      let mtimeMs = 0
      try {
        mtimeMs = statSync(join(sessionDir, 'session.v4.jsonl.zstd')).mtimeMs
      } catch {
        continue
      }
      candidates.push({ workspaceDir: workspaceDir.name, sessionId: session.name, sessionDir, mtimeMs })
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  for (const candidate of candidates) {
    if (result.scanned >= maxSessions || Date.now() > deadline) {
      result.skipped += 1
      continue
    }
    const workspaceId = byDirName.get(candidate.workspaceDir) ?? null
    const meta = readSessionMeta(candidate.sessionDir, candidate.sessionId, {
      archived: archived.has(candidate.sessionId),
      now,
    })
    if (meta.lastActiveAt === null) meta.lastActiveAt = asIso(candidate.mtimeMs)
    result.scanned += 1
    result.threads.push({ ...meta, workspaceId, workspaceDir: candidate.workspaceDir })
  }
  return result
}

/**
 * Turn raw scan data into a proposal the user confirms.
 *
 * @param {{
 *   projects: ReadonlyArray<Record<string, unknown>>,
 *   threads: ReadonlyArray<Record<string, unknown>>,
 *   tasks?: ReadonlyArray<Record<string, unknown>>,
 *   requirements?: ReadonlyArray<Record<string, unknown>>,
 *   confirmation?: Record<string, unknown>|null,
 *   now?: number,
 *   generatedAt?: string,
 * }} input
 */
export function buildInventory({ projects = [], threads = [], tasks = [], requirements = [], confirmation = null, now = Date.now(), generatedAt } = {}) {
  const threadRows = Array.isArray(threads) ? threads : []
  const taskRows = Array.isArray(tasks) ? tasks : []
  const requirementRows = Array.isArray(requirements) ? requirements : []
  const rows = []
  for (const project of projects) {
    const projectId = String(project.workspaceId ?? project.projectId ?? '')
    if (projectId === '') continue
    const projectThreads = threadRows.filter((thread) => thread.workspaceId === projectId)
    const projectTasks = taskRows.filter((task) => task.projectId === projectId)
    const projectRequirements = requirementRows.filter((requirement) => requirement.projectId === projectId)
    const openTasks = projectTasks.filter((task) => task.status !== 'done' && task.status !== 'canceled')
    const userThreads = projectThreads.filter((thread) => thread.origin !== 'subagent')
    const childThreads = projectThreads.filter((thread) => thread.origin === 'subagent')
    const liveThreads = projectThreads.filter((thread) => thread.live === true)
    const lastThreadAt = projectThreads.map((thread) => thread.lastActiveAt).filter(Boolean).sort().at(-1) ?? null
    const lastTaskAt = projectTasks.map((task) => task.updatedAt).filter(Boolean).sort().at(-1) ?? null
    const lastActiveAt = [lastThreadAt, lastTaskAt, project.updatedAt].filter(Boolean).sort().at(-1) ?? null
    const days = daysSince(lastActiveAt, now)
    const archivedThreads = projectThreads.filter((thread) => thread.archived === true)
    const hasHistory = projectThreads.length > 0 || projectTasks.length > 0 || projectRequirements.length > 0

    let proposed
    const reasons = []
    if (!hasHistory) {
      proposed = 'unknown'
      reasons.push('DSH 里没有该项目的会话或账本历史')
    } else if (openTasks.length > 0) {
      proposed = 'active'
      reasons.push(`账本里有 ${openTasks.length} 个未完成任务`)
    } else if (liveThreads.length > 0) {
      proposed = 'active'
      reasons.push(`${liveThreads.length} 个线程可能正在运行`)
    } else if (days <= ACTIVE_DAYS) {
      proposed = 'active'
      reasons.push(`${Math.max(0, Math.round(days))} 天内有活动`)
    } else if (projectThreads.length > 0 && archivedThreads.length === projectThreads.length) {
      proposed = 'archived'
      reasons.push('全部线程已归档且无未完成工作')
    } else {
      proposed = 'paused'
      reasons.push(`最近活动在 ${Math.round(days)} 天前，且无未完成工作`)
    }

    rows.push({
      projectId,
      title: typeof project.title === 'string' && project.title !== '' ? project.title : projectId,
      path: typeof project.path === 'string' ? project.path : null,
      phase: project.phase ?? null,
      inInventory: project.inInventory !== false,
      proposedStatus: proposed,
      proposedReasons: reasons,
      lastActiveAt,
      counts: {
        requirements: projectRequirements.length,
        tasks: projectTasks.length,
        openTasks: openTasks.length,
        threads: userThreads.length,
        childThreads: childThreads.length,
        liveThreads: liveThreads.length,
        archivedThreads: archivedThreads.length,
      },
      openTasks: openTasks.map((task) => ({
        taskId: task.id,
        title: task.title,
        status: task.status,
        owner: task.owner ?? null,
        updatedAt: task.updatedAt ?? null,
      })),
      threads: userThreads
        .sort((left, right) => String(right.lastActiveAt ?? '').localeCompare(String(left.lastActiveAt ?? '')))
        .slice(0, 20)
        .map((thread) => ({
          sessionId: thread.sessionId,
          title: thread.title ?? null,
          lastActiveAt: thread.lastActiveAt ?? null,
          archived: thread.archived === true,
          live: thread.live === true,
          agentPreset: thread.agentPreset ?? null,
          digest: thread.digest ?? null,
        })),
    })
  }
  rows.sort((left, right) => String(right.lastActiveAt ?? '').localeCompare(String(left.lastActiveAt ?? '')) || left.title.localeCompare(right.title))

  const totals = {
    projects: rows.length,
    active: rows.filter((row) => row.proposedStatus === 'active').length,
    paused: rows.filter((row) => row.proposedStatus === 'paused').length,
    archived: rows.filter((row) => row.proposedStatus === 'archived').length,
    unknown: rows.filter((row) => row.proposedStatus === 'unknown').length,
    threads: rows.reduce((sum, row) => sum + row.counts.threads, 0),
    childThreads: rows.reduce((sum, row) => sum + row.counts.childThreads, 0),
    openTasks: rows.reduce((sum, row) => sum + row.counts.openTasks, 0),
    liveThreads: rows.reduce((sum, row) => sum + row.counts.liveThreads, 0),
  }

  return {
    generatedAt: typeof generatedAt === 'string' ? generatedAt : new Date().toISOString(),
    readOnly: true,
    confirmationRequired: confirmation === null || confirmation === undefined,
    confirmation: confirmation ?? null,
    projects: rows,
    totals,
    questions: rows
      .filter((row) => row.proposedStatus !== 'unknown')
      .map((row) => ({
        id: `project-status:${row.projectId}`,
        projectId: row.projectId,
        question: `项目「${row.title}」现在是什么状态？`,
        proposed: row.proposedStatus,
        options: PROJECT_STATUSES.map((status) => ({ value: status, label: STATUS_LABELS[status] })),
        reason: row.proposedReasons.join('；'),
      })),
    next: confirmation === null || confirmation === undefined
      ? '请用户确认每个项目的状态（进行中 / 暂时挂起 / 已归档 / 未知）；确认后才会开始调度。'
      : '盘点已确认；后续调度以确认结果为准，可重新盘点。',
  }
}


/**
 * One-stop read-only inventory scan shared by the HTTP route and the manager
 * tool: workspace registry + on-disk session heads + the plugin ledger.
 *
 * @param {{
 *   store: import('./work-store.js').WorkStore,
 *   workspaceSnapshot: {projects?: ReadonlyArray<Record<string, unknown>>, archivedSessionIds?: ReadonlyArray<string>},
 *   dshHome?: string,
 *   now?: number,
 * }} input
 */
export function scanInventory({ store, workspaceSnapshot, dshHome, now = Date.now() } = {}) {
  if (store === undefined) throw new Error('inventory scan requires a work store')
  const projects = Array.isArray(workspaceSnapshot?.projects) ? workspaceSnapshot.projects : []
  const threads = scanThreads(dshHome, {
    projects,
    archivedSessionIds: Array.isArray(workspaceSnapshot?.archivedSessionIds) ? workspaceSnapshot.archivedSessionIds : [],
    now,
  })
  return buildInventory({
    projects,
    threads: threads.threads,
    tasks: store.listTasks(),
    requirements: store.listRequirements(),
    confirmation: store.getInventoryConfirmation(),
    now,
  })
}
