/**
 * Live project projection from the host `workspaceRegistry` (DSH is the source of truth).
 * Read-only: never creates, renames or deletes workspaces.
 */

import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { daysSince, exclusionReason, matchProjects, projectPhase } from './workspace-index.js'

/**
 * Map live DSH Workspace entities into project rows.
 * @param {ReadonlyArray<{id?: string, path: string, title?: string, sessionIds?: readonly string[], updatedAt?: string}>} workspaces
 * @param {{now?: number, exists?: (path: string) => boolean}} options
 */
export function projectsFromWorkspaces(workspaces, { now = Date.now(), exists = existsSync } = {}) {
  const projects = []
  const excluded = []
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    const path = typeof workspace?.path === 'string' ? workspace.path : ''
    if (path === '') continue
    const title = (typeof workspace.title === 'string' ? workspace.title : '').trim() || path.split('/').filter(Boolean).at(-1) || path
    const sessions = Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0
    const updatedAt = typeof workspace.updatedAt === 'string' ? workspace.updatedAt : null
    const days = daysSince(updatedAt, now)
    const reason = exists(path) ? exclusionReason(path) : 'missing'
    const row = {
      workspaceId: String(workspace.id ?? path),
      title,
      path,
      sessions,
      updatedAt,
      days,
      phase: projectPhase(days),
    }
    if (reason === undefined) projects.push(row)
    else excluded.push({ ...row, excluded: reason })
  }
  projects.sort((a, b) => (a.days ?? Number.POSITIVE_INFINITY) - (b.days ?? Number.POSITIVE_INFINITY) || a.title.localeCompare(b.title))
  return { projects, excluded }
}

/** Read-only fallback when the host service is unavailable (e.g. CLI calibration). */
export function projectsFromWorkspaceFile(file) {
  try {
    const registry = JSON.parse(readFileSync(file, 'utf8'))
    const table = registry?.tables?.workspaces ?? {}
    const workspaces = Object.entries(table).map(([id, record]) => ({
      id,
      path: record?.path ?? '',
      title: record?.title ?? '',
      sessionIds: Array.isArray(record?.sessionIds) ? record.sessionIds : [],
      updatedAt: record?.updatedAt,
    }))
    const archivedSessionIds = Array.isArray(registry?.global?.archivedSessionIds)
      ? registry.global.archivedSessionIds.filter((id) => typeof id === 'string')
      : []
    return { ...projectsFromWorkspaces(workspaces), archivedSessionIds }
  } catch {
    return { projects: [], excluded: [], archivedSessionIds: [] }
  }
}

/** Archived session ids from the workspace registry file (read-only, best effort). */
function archivedSessionIdsFromFile(file) {
  try {
    const registry = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(registry?.global?.archivedSessionIds)
      ? registry.global.archivedSessionIds.filter((id) => typeof id === 'string')
      : []
  } catch {
    return []
  }
}

/** Default DSH workspace registry path for the fallback reader. */
export function defaultWorkspaceFile(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'storages', 'workspace.json')
}

/**
 * Read projects from the live service, falling back to the registry file.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function readProjects(ctx) {
  const registry = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  if (registry !== undefined && typeof registry.list === 'function') {
    try {
      return {
        source: 'workspaceRegistry',
        ...projectsFromWorkspaces(registry.list()),
        // The registry service does not expose archived ids; the file is the
        // authoritative snapshot for that bit (read-only fallback).
        archivedSessionIds: archivedSessionIdsFromFile(defaultWorkspaceFile()),
      }
    } catch {
      // fall through to the read-only file snapshot
    }
  }
  return { source: 'workspace.json', ...projectsFromWorkspaceFile(defaultWorkspaceFile()) }
}

/** Rank existing projects for a requirement; never invents one. */
export function matchRequirement(text, projects) {
  const candidates = matchProjects(text, projects).map((entry) => ({
    workspaceId: entry.project.workspaceId,
    title: entry.project.title,
    path: entry.project.path,
    phase: entry.project.phase,
    score: entry.score,
    reasons: entry.reasons,
  }))
  const top = candidates[0]
  return {
    candidates,
    needsConfirmation: top === undefined || top.score < 4 || (candidates[1] !== undefined && top.score - candidates[1].score < 2),
  }
}
