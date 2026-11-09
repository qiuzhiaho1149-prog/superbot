import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultStateDir, loadConfig, saveConfig } from './config.js'
import { duplicateNotice, isPlainTextContent, textOfContent } from './context-policy.js'
import { composeDraft } from './compose.js'
import { buildTimeline } from './timeline.js'
import { importHistoryWork } from './history-import.js'
import { deriveTaskPhase } from './task-phase.js'
import { buildOverview } from './overview.js'
import { buildProjectHandoff, writeProjectHandoff } from './project-handoff.js'
import { PROJECT_FILE_NAME, renderProjectMap, scanProjectProfile, writeProjectMap } from './project-profile.js'
import { dshHomeOf, scanInventory } from './onboarding.js'
import { createPresetDefinitions } from './presets.js'
import { PRESET_IDS, ROLES } from './roles.js'
import { readProjects } from './workspace-service.js'
import { WORK_SCHEMA_VERSION, createWorkStore } from './work-store.js'

export const name = 'dsh-superbot'
export const inject = ['tools']

/**
 * Superbot plugin:
 * - append-only work ledger (`lib/work-store.js`) for
 *   requirement/spec/plan/task/run/report/review;
 * - control-plane chain in `lib/planning-tools.js` (manager-only):
 *   `superbot_requirement_submit` → `superbot_spec_record` →
 *   `superbot_plan_create` (validated DAG, tasks planned to todo) →
 *   `superbot_plan_dispatch` (ready tasks only, one pass);
 * - three agent presets (manager/worker/verifier) registered through
 *   `ctx.agentPresets.register()`, with tools mounted inside each preset scope
 *   (`lib/preset-tools.js`) instead of globally;
 * - worker/verifier character boundary (`lib/character-boundary.js`): empty scoped
 *   sections shadow legacy global character/deployment persona slots, so a
 *   role-less executor never inherits a persona. Compatibility shim only;
 *   Superbot has no character-store dependency;
 * - a legacy global tool row (`lib/global-tools.js`, a separate YAML row) for
 *   profiles without the agent-presets registry;
 * - duplicate tool-result dedupe;
 * - persisted user config exposed both to tools and to the Web settings section.
 *
 * This root row mounts NO tools: on a preset surface they exist only inside the
 * three presets, so no other session sees them.
 *
 * Large-output head/tail preview is delegated to the official
 * `dsh-spill-policy`. Reasoning retention is NOT wired here: DSH 0.2.1-rc.5
 * freezes `llm/stream` options.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{stateDir?: string, cacheDir?: string, debugFile?: string}} [initialConfig]
 */
export function apply(ctx, initialConfig = {}) {
  const stateDir = typeof initialConfig.stateDir === 'string' && initialConfig.stateDir !== ''
    ? initialConfig.stateDir
    : defaultStateDir()
  let config = loadConfig(stateDir)
  if (typeof initialConfig.cacheDir === 'string' && initialConfig.cacheDir !== '') config.cacheDir = initialConfig.cacheDir

  const seenByAgent = new WeakMap()
  const seenGlobal = new Set()
  const stats = { dedupeOmitted: 0 }
  const debugFile = typeof initialConfig.debugFile === 'string' && initialConfig.debugFile !== '' ? initialConfig.debugFile : undefined
  const debug = (event) => {
    if (debugFile === undefined) return
    try { appendFileSync(debugFile, JSON.stringify({ at: Date.now(), event, ...stats }) + '\n') } catch { /* best-effort diagnostics */ }
  }
  const effectiveCacheDir = () => (config.cacheDir !== '' ? config.cacheDir : join(tmpdir(), 'dsh-superbot-cache'))

  // ── persistent work ledger ────────────────────────────────────────────────
  const store = createWorkStore({ stateDir, actor: 'manager' })
  if (typeof ctx.effect === 'function') ctx.effect(() => () => store.dispose())

  // Per-project handoff: regenerated from the ledger shortly after a relevant
  // event. It is written INTO the project so the work can continue when the
  // plugin is disabled; it is bounded and never contains chat transcripts.
  const handoffTimers = new Map()
  const scheduleProjectHandoff = (projectId) => {
    if (config.projectHandoff === false || typeof projectId !== 'string' || projectId === '') return
    if (handoffTimers.has(projectId)) return
    const timer = setTimeout(() => {
      handoffTimers.delete(projectId)
      try {
        const project = readProjects(ctx).projects.find((entry) => entry.workspaceId === projectId)
        if (project === undefined || typeof project.path !== 'string' || project.path === '') return
        if (!existsSync(join(project.path, PROJECT_FILE_NAME))) {
          try {
            const profile = scanProjectProfile({ projectId: project.workspaceId, title: project.title, path: project.path })
            writeProjectMap(project.path, renderProjectMap(profile), { fileName: PROJECT_FILE_NAME })
          } catch (error) {
            ctx.logger?.warn?.(`dsh-superbot: project profile failed for ${projectId}: ${String(error?.message ?? error)}`)
          }
        }
        const markdown = buildProjectHandoff({ store, project: { projectId: project.workspaceId, title: project.title, path: project.path } })
        writeProjectHandoff(project.path, markdown, { fileName: config.handoffFile ?? 'SUPERBOT-HANDOFF.md' })
      } catch (error) {
        ctx.logger?.warn?.(`dsh-superbot: project handoff failed for ${projectId}: ${String(error?.message ?? error)}`)
      }
    }, 400)
    if (typeof timer.unref === 'function') timer.unref()
    handoffTimers.set(projectId, timer)
  }
  const unsubscribeHandoff = store.onAppend((event) => {
    const projectIds = new Set()
    if (event?.task?.projectId) projectIds.add(event.task.projectId)
    if (typeof event?.taskId === 'string') {
      const task = store.getTask(event.taskId)
      if (task?.projectId) projectIds.add(task.projectId)
    }
    if (Array.isArray(event?.inventory?.projects)) {
      for (const project of event.inventory.projects) if (typeof project.projectId === 'string') projectIds.add(project.projectId)
    }
    for (const projectId of projectIds) scheduleProjectHandoff(projectId)
  })
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      unsubscribeHandoff()
      for (const timer of handoffTimers.values()) clearTimeout(timer)
      handoffTimers.clear()
    })
  }
  const service = {
    schemaVersion: WORK_SCHEMA_VERSION,
    stateDir,
    store,
    getConfig: () => config,
    presets: { ...PRESET_IDS },
    // Filled by `superbot/global-tools` when the legacy row is actually active.
    // On preset surfaces the row is disabled and this stays null.
    globalTools: null,
    // Filled by `lib/character-boundary.js` rows mounted inside the worker and
    // verifier preset scopes: which empty shadow sections were registered (or
    // why the row skipped when the profile had no systemPrompt service).
    personaBoundaries: {},
  }
  const provideService = () => {
    if (typeof ctx.provide === 'function') {
      try {
        ctx.provide('superbot', service)
        return
      } catch (error) {
        ctx.logger?.warn?.(`dsh-superbot: could not provide the superbot service: ${String(error)}`)
        return
      }
    }
    ctx.logger?.warn?.('dsh-superbot: context has no provide(); preset tool rows will not resolve the work store')
  }
  provideService()
  debug('store-open')

  // ── agent presets (manager / worker / verifier) ──────────────────────────
  // Registered only when the profile mounts the agent-presets registry. The
  // preset rows live in `lib/presets.js`; their tools are mounted inside the
  // selecting Agent's scope, never globally.
  const presetUnregisters = []
  const registerPresets = (scope) => {
    const registry = typeof scope?.get === 'function' ? scope.get('agentPresets') : scope?.agentPresets
    if (typeof registry?.register !== 'function') {
      ctx.logger?.warn?.('dsh-superbot: agentPresets.register is unavailable; presets not registered')
      return
    }
    let disposed = false
    for (const definition of createPresetDefinitions()) {
      Promise.resolve(registry.register(definition))
        .then((unregister) => {
          if (disposed) {
            Promise.resolve(unregister?.()).catch(() => { /* ignore */ })
            return
          }
          presetUnregisters.push(unregister)
          debug(`preset-registered:${definition.id}`)
        })
        .catch((error) => {
          ctx.logger?.warn?.(`dsh-superbot: agent preset ${definition.id} not registered: ${String(error?.message ?? error)}`)
        })
    }
    if (typeof scope.effect === 'function') {
      scope.effect(() => () => {
        disposed = true
        for (const unregister of presetUnregisters.splice(0)) Promise.resolve(unregister?.()).catch(() => { /* ignore */ })
      })
    }
  }
  // A composition that declares its own YAML preset rows can turn this off to
  // avoid duplicate registrations (advanced; default on).
  if (initialConfig.registerPresets !== false && typeof ctx.inject === 'function') {
    ctx.inject(['agentPresets'], (scope) => { registerPresets(scope) })
  }

  // ── duplicate tool-result dedupe ─────────────────────────────────────────
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      if (config.dedupeToolResults !== true) return decision
      if (decision?.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
      const content = decision.content ?? result?.content
      if (!isPlainTextContent(content)) return decision
      if (exec?.name === 'read') return decision
      const text = textOfContent(content)
      if (text.length === 0) return decision
      const key = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24)
      const seen = exec?.agent === undefined
        ? seenGlobal
        : (() => {
            let existing = seenByAgent.get(exec.agent)
            if (existing === undefined) {
              existing = new Set()
              seenByAgent.set(exec.agent, existing)
            }
            return existing
          })()
      if (!seen.has(key)) {
        seen.add(key)
        return decision
      }
      const cacheDir = effectiveCacheDir()
      const storedPath = join(cacheDir, `${key}.txt`)
      if (!existsSync(storedPath)) {
        mkdirSync(cacheDir, { recursive: true })
        writeFileSync(storedPath, text, 'utf8')
      }
      stats.dedupeOmitted += 1
      debug('dedupe')
      return { kind: 'accept', content: [{ type: 'text', text: duplicateNotice(storedPath) }] }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-superbot: dedupe skipped: ${String(error)}`)
      return decision
    }
  }, { prepend: true })

  // ── HTTP routes (config + read-only status) ──────────────────────────────
  const sendJson = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  const buildStatus = async () => {
    const registry = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined
    let roster = []
    let rosterError
    if (registry !== undefined && typeof registry.list === 'function') {
      try {
        const listed = await registry.list()
        roster = (Array.isArray(listed) ? listed : []).filter((row) => ROLES.some((role) => PRESET_IDS[role] === row.id))
      } catch (error) {
        rosterError = String(error?.message ?? error)
      }
    }
    return {
      schemaVersion: WORK_SCHEMA_VERSION,
      stateDir,
      mode: registry === undefined ? 'global-fallback' : 'preset-scoped',
      presets: Object.fromEntries(ROLES.map((role) => {
        const row = roster.find((entry) => entry.id === PRESET_IDS[role])
        return [role, {
          id: PRESET_IDS[role],
          registered: row !== undefined,
          ...(row?.broken === undefined ? {} : { broken: row.broken }),
        }]
      })),
      ...(rosterError === undefined ? {} : { rosterError }),
      legacyGlobalTools: service.globalTools === null ? null : { toolCount: service.globalTools.toolCount, registeredAt: service.globalTools.registeredAt },
      // Character boundary diagnostics only (section names, skip reasons).
      personaBoundaries: { ...service.personaBoundaries },
      policy: { httpHumanActions: config.httpHumanActions === true, requireSandboxedEvidence: config.requireSandboxedEvidence === true, requireOnboarding: config.requireOnboarding !== false, acceptanceIsolation: config.acceptanceIsolation, autoAudit: config.autoAudit === true },
      runtime: {
        shell: typeof ctx.get === 'function' && ctx.get('shell') !== undefined,
        sandboxPolicy: typeof ctx.get === 'function' && ctx.get('sandboxPolicy') !== undefined,
      },
      work: store.stats(),
      pendingHuman: buildOverview({ store, projects: [] }).totals.pendingHuman,
      onboarding: (() => {
        const confirmation = store.getInventoryConfirmation()
        return confirmation === undefined
          ? { confirmed: false }
          : { confirmed: true, confirmedAt: confirmation.confirmedAt, via: confirmation.via, projects: confirmation.projects.length }
      })(),
    }
  }
  const registerRoutes = (scope) => {
    const webServer = scope.webServer ?? (typeof scope.get === 'function' ? scope.get('webServer') : undefined)
    if (webServer?.register === undefined) return
    const authorized = (req) => {
      const connection = typeof scope.get === 'function' ? scope.get('connection') : undefined
      // Fail closed: without the host trust fence these routes have no human
      // identity source, so refuse instead of silently allowing every caller.
      if (typeof connection?.requestRejection !== 'function') {
        return { status: 503, message: 'Superbot HTTP routes require the host connection trust service' }
      }
      try {
        const rejection = connection.requestRejection(req)
        return rejection === undefined || rejection === null ? undefined : rejection
      } catch (error) {
        return { status: 503, message: `trust check failed: ${String(error)}` }
      }
    }
    const readBody = async (req) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return {}
      return JSON.parse(text)
    }
    const handler = async (req, res) => {
      const rejection = authorized(req)
      if (rejection !== undefined) return sendJson(res, rejection.status ?? 403, { error: rejection.message ?? 'forbidden' })
      try {
        if (req.method === 'GET') return sendJson(res, 200, { config })
        if (req.method === 'POST') {
          const patch = await readBody(req)
          config = saveConfig(stateDir, patch)
          return sendJson(res, 200, { config })
        }
        return sendJson(res, 405, { error: 'method not allowed' })
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) })
      }
    }
    const statusHandler = async (req, res) => {
      const rejection = authorized(req)
      if (rejection !== undefined) return sendJson(res, rejection.status ?? 403, { error: rejection.message ?? 'forbidden' })
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        return sendJson(res, 200, await buildStatus())
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message ?? error) })
      }
    }
    const overviewHandler = async (req, res) => {
      const rejection = authorized(req)
      if (rejection !== undefined) return sendJson(res, rejection.status ?? 403, { error: rejection.message ?? 'forbidden' })
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const url = new URL(String(req.url ?? '/superbot/overview'), 'http://127.0.0.1')
        const projectId = url.searchParams.get('projectId') ?? undefined
        const filter = url.searchParams.get('filter') ?? undefined
        const sort = url.searchParams.get('sort') ?? undefined
        const q = url.searchParams.get('q') ?? undefined
        const inventory = readProjects(scope)
        const now = Date.now()
        return sendJson(res, 200, { ...buildOverview({ store, projects: inventory.projects, projectId, filter, sort, q }), now, timeline: buildTimeline({ store, projects: inventory.projects, now }) })
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message ?? error) })
      }
    }
    // Structured-intent composer: pure draft generation, no ledger write. The
    // user still sends the result into a Manager session for planning.
    const composeHandler = async (req, res) => {
      const rejection = authorized(req)
      if (rejection !== undefined) return sendJson(res, rejection.status ?? 403, { error: rejection.message ?? 'forbidden' })
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const body = await readBody(req)
        const inventory = readProjects(scope)
        const result = composeDraft(body, { projects: inventory.projects })
        const status = result.ok ? 200 : (Array.isArray(result.blockers) && result.blockers.length > 0 ? 422 : 400)
        return sendJson(res, status, result)
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) })
      }
    }
    const taskDetailHandler = async (req, res) => {
      const rejection = authorized(req)
      if (rejection !== undefined) return sendJson(res, rejection.status ?? 403, { error: rejection.message ?? 'forbidden' })
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const url = new URL(String(req.url ?? '/superbot/task'), 'http://127.0.0.1')
        const id = url.searchParams.get('id') ?? ''
        const task = store.getTask(id)
        if (task === undefined) return sendJson(res, 404, { error: `unknown task: ${id}` })
        const runs = store.listRuns({ taskId: id }).map((run) => ({
          runId: run.runId, taskId: run.taskId ?? null, agentPreset: run.agentPreset ?? null, status: run.status,
          startedAt: run.startedAt ?? null, finishedAt: run.finishedAt ?? null, childId: run.childId ?? null, label: run.label ?? null,
        }))
        const reviews = store.listReviews({ taskId: id }).map((review) => ({
          reviewId: review.reviewId, seq: review.seq ?? null, source: review.source, verdict: review.verdict,
          reviewerRole: review.reviewerRole ?? null, notes: review.notes ?? null, decision: review.decision ?? null,
          ownerRunId: review.ownerRunId ?? null, submittedAt: review.submittedAt ?? null,
        }))
        const coverage = store.evidenceCoverage(id)
        const evidence = coverage.rows.map((row) => {
          const record = row.evidenceId === null ? undefined : store.getEvidence(row.evidenceId)
          return {
            index: row.index, command: row.command, expectedExitCode: row.expectedExitCode, exitCode: row.exitCode,
            passed: row.passed, evidenceId: row.evidenceId, executionMode: record?.executionMode ?? null, isolationMode: record?.isolationMode ?? null,
            sandboxMode: record?.sandboxMode ?? null, createdAt: record?.createdAt ?? null, preview: record?.preview ?? null,
          }
        })
        const reports = typeof store.listReports === 'function' ? store.listReports({ taskId: id }) : []
        const phase = deriveTaskPhase({ task, runs, reviews, coverage })
        return sendJson(res, 200, { task, phase, runs, reviews, evidence, coverage: { complete: coverage.complete, commandCount: coverage.commandCount }, reports })
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) })
      }
    }
    const rejectHandler = async (req, res) => {
      const rejection = authorized(req)
      if (rejection !== undefined) return sendJson(res, rejection.status ?? 403, { error: rejection.message ?? 'forbidden' })
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      if (config.httpHumanActions !== true) return sendJson(res, 403, httpHumanDisabled)
      try {
        const body = await readBody(req)
        if (typeof body?.taskId !== 'string' || body.taskId.trim() === '') throw new Error('taskId is required')
        const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : undefined
        return sendJson(res, 200, store.rejectTaskByHuman(body.taskId.trim(), note === undefined ? {} : { note }))
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) })
      }
    }
    const historyImportHandler = async (req, res) => {
      const rejection = authorized(req)
      if (rejection !== undefined) return sendJson(res, rejection.status ?? 403, { error: rejection.message ?? 'forbidden' })
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      if (config.httpHumanActions !== true) return sendJson(res, 403, httpHumanDisabled)
      try {
        const body = await readBody(req)
        const inventory = readProjects(scope)
        return sendJson(res, 200, importHistoryWork(store, body?.items, { projects: inventory.projects, actor: 'human', via: 'http' }))
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) })
      }
    }
    // Human acceptance surface: the browser trust fence is the "human" proof.
    // No agent tool reaches this store method, so an agent cannot accept itself.
    const httpHumanDisabled = { error: 'HTTP 人工动作已禁用（默认安全）：请在对话里通过宿主 approval 弹窗批准（superbot_task_accept / superbot_onboarding_confirm）。若确需面板直连，请在 config 显式设置 httpHumanActions=true 并接受 cookie 可伪造的风险。' }
    const acceptHandler = async (req, res) => {
      const rejection = authorized(req)
      if (rejection !== undefined) return sendJson(res, rejection.status ?? 403, { error: rejection.message ?? 'forbidden' })
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      if (config.httpHumanActions !== true) return sendJson(res, 403, httpHumanDisabled)
      try {
        const body = await readBody(req)
        if (typeof body?.taskId !== 'string' || body.taskId.trim() === '') throw new Error('taskId is required')
        const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : undefined
        const result = store.acceptTaskByHuman(body.taskId.trim(), note === undefined ? {} : { note })
        return sendJson(res, 200, { task: result.task, review: result.review })
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) })
      }
    }
    const onboardingHandler = async (req, res) => {
      const rejection = authorized(req)
      if (rejection !== undefined) return sendJson(res, rejection.status ?? 403, { error: rejection.message ?? 'forbidden' })
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      try {
        const inventory = readProjects(scope)
        return sendJson(res, 200, scanInventory({ store, workspaceSnapshot: inventory, dshHome: dshHomeOf(stateDir) }))
      } catch (error) {
        return sendJson(res, 500, { error: String(error?.message ?? error) })
      }
    }
    // First-run confirmation is a HUMAN decision: the browser trust fence is the
    // human proof, and no agent tool can post here (manager has no shell).
    const onboardingConfirmHandler = async (req, res) => {
      const rejection = authorized(req)
      if (rejection !== undefined) return sendJson(res, rejection.status ?? 403, { error: rejection.message ?? 'forbidden' })
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
      if (config.httpHumanActions !== true) return sendJson(res, 403, httpHumanDisabled)
      try {
        const body = await readBody(req)
        const inventory = store.confirmInventory({
          projects: body?.projects,
          ...(typeof body?.note === 'string' && body.note.trim() !== '' ? { note: body.note.trim() } : {}),
          via: 'http',
        })
        return sendJson(res, 200, { inventory })
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) })
      }
    }
    const disposers = [
      webServer.register({ kind: 'exact', path: '/superbot/config', handler }),
      webServer.register({ kind: 'exact', path: '/superbot/status', handler: statusHandler }),
      webServer.register({ kind: 'exact', path: '/superbot/overview', handler: overviewHandler }),
      webServer.register({ kind: 'exact', path: '/superbot/compose', handler: composeHandler }),
      webServer.register({ kind: 'exact', path: '/superbot/history/import', handler: historyImportHandler }),
      webServer.register({ kind: 'exact', path: '/superbot/reject', handler: rejectHandler }),
      webServer.register({ kind: 'exact', path: '/superbot/task', handler: taskDetailHandler }),
      webServer.register({ kind: 'exact', path: '/superbot/accept', handler: acceptHandler }),
      webServer.register({ kind: 'exact', path: '/superbot/onboarding', handler: onboardingHandler }),
      webServer.register({ kind: 'exact', path: '/superbot/onboarding/confirm', handler: onboardingConfirmHandler }),
    ]
    if (typeof scope.effect === 'function') scope.effect(() => () => { for (const disposer of disposers) { try { disposer?.() } catch { /* ignore */ } } })
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => { registerRoutes(scope) })
  } else {
    registerRoutes(ctx)
  }
}
