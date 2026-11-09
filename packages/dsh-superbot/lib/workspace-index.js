/**
 * Read-only projection of DSH Workspace records into the control-plane project index.
 * DSH `ctx.workspaceRegistry` / `~/.dsh/storages/workspace.json` stays the source of truth;
 * this module only classifies and suggests merges. It never writes to projects.
 */

/**
 * Paths that are not projects even if DSH registered them.
 * @param {string} path
 * @returns {'app-data'|'dependency'|'external-data'|undefined}
 */
export function exclusionReason(path) {
  if (path.includes('/Library/Containers/')) return 'app-data'
  if (path.includes('/node_modules/')) return 'dependency'
  // Legacy external data stores: never treat them as project workspaces.
  if (/\/\.dsh-[^/]+\/(home|data)(\/|$)/.test(path)) return 'external-data'
  return undefined
}

/**
 * Normalize a workspace record from DSH's registry shape.
 * @param {string} workspaceId
 * @param {{path?: string, title?: string, sessionIds?: string[], updatedAt?: string}} record
 * @param {{exists?: boolean, remote?: string}} probe
 */
export function normalizeWorkspace(workspaceId, record, probe = {}) {
  const path = typeof record.path === 'string' ? record.path : ''
  const title = (typeof record.title === 'string' ? record.title : '').trim()
  const sessions = Array.isArray(record.sessionIds) ? record.sessionIds.length : 0
  const exists = probe.exists ?? false
  const excluded = exists ? exclusionReason(path) : 'missing'
  return {
    workspaceId,
    title,
    path,
    sessions,
    exists,
    excluded,
    remote: probe.remote ?? '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
  }
}

/** Days since `updatedAt` relative to a supplied clock. */
export function daysSince(updatedAt, now = Date.now()) {
  if (typeof updatedAt !== 'string') return null
  const time = Date.parse(updatedAt)
  if (Number.isNaN(time)) return null
  return Math.round(((now - time) / 86_400_000) * 10) / 10
}

/** active <=30d, warm <=90d, otherwise dormant/unknown. */
export function projectPhase(days) {
  if (days === null || days === undefined) return 'unknown'
  if (days <= 30) return 'active'
  if (days <= 90) return 'warm'
  return 'dormant'
}

function canonicalScore(project) {
  const icloud = project.path.includes('/Library/Mobile Documents/') ? 1 : 0
  return [-project.sessions, project.days ?? Number.POSITIVE_INFINITY, icloud]
}

function compareScore(a, b) {
  const left = canonicalScore(a)
  const right = canonicalScore(b)
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return a.title.localeCompare(b.title)
}

/**
 * Build the project index from a parsed DSH workspace registry.
 * @param {object} registry parsed `workspace.json`
 * @param {{now?: number, probe?: (path: string) => {exists?: boolean, remote?: string}}} options
 * @returns {{projects: object[], excluded: object[], mergeGroups: object[]}}
 */
export function buildProjectIndex(registry, { now = Date.now(), probe = () => ({}) } = {}) {
  const table = registry?.tables?.workspaces
  if (table === undefined || typeof table !== 'object') return { projects: [], excluded: [], mergeGroups: [] }
  const rows = Object.entries(table).map(([id, record]) => {
    const base = normalizeWorkspace(id, record ?? {}, probe(record?.path ?? ''))
    return { ...base, days: daysSince(base.updatedAt, now) }
  })

  const included = rows.filter((row) => row.excluded === undefined)
  const excluded = rows.filter((row) => row.excluded !== undefined)
  const groups = new Map()
  for (const row of included) {
    const key = row.remote !== '' ? `remote:${row.remote}` : `path:${row.path}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  const projects = []
  const mergeGroups = []
  for (const [key, group] of groups) {
    const ordered = [...group].sort(compareScore)
    const [canonical, ...merged] = ordered
    const project = {
      id: `ws-${canonical.workspaceId}`,
      workspaceId: canonical.workspaceId,
      title: canonical.title,
      path: canonical.path,
      sessions: canonical.sessions,
      days: canonical.days,
      phase: projectPhase(canonical.days),
      remote: canonical.remote,
      mergedFrom: merged.map((row) => ({ workspaceId: row.workspaceId, title: row.title, path: row.path, sessions: row.sessions })),
    }
    if (merged.length > 0) mergeGroups.push({ key, members: ordered.map((row) => ({ workspaceId: row.workspaceId, title: row.title, path: row.path })) })
    projects.push(project)
  }
  projects.sort((a, b) => (a.days ?? Number.POSITIVE_INFINITY) - (b.days ?? Number.POSITIVE_INFINITY) || a.title.localeCompare(b.title))
  return { projects, excluded, mergeGroups }
}

/**
 * Match a requirement to existing projects without inventing a registry.
 * Returns candidates ranked by simple first-party signals; the caller asks the
 * user when confidence is low.
 * @param {string} text
 * @param {ReadonlyArray<{title: string, path: string, phase: string, days: number|null}>} projects
 */
export function matchProjects(text, projects) {
  const lower = String(text).toLowerCase()
  const scored = projects.map((project) => {
    const title = project.title.toLowerCase()
    const path = project.path.toLowerCase()
    let score = 0
    const reasons = []
    if (lower.includes(title) || title.includes(lower)) { score += 5; reasons.push('title') }
    for (const token of title.split(/[\s/_\-.]+/).filter((part) => part.length >= 2)) {
      if (lower.includes(token)) { score += 2; reasons.push(`token:${token}`) }
    }
    if (lower.includes(path)) { score += 4; reasons.push('path') }
    if (score > 0 && project.phase === 'active') { score += 1; reasons.push('active') }
    return { project, score, reasons }
  }).filter((entry) => entry.score > 0)
  scored.sort((a, b) => b.score - a.score)
  return scored
}
