/**
 * Role/tool-scope matrix for the Superbot control plane.
 *
 * The list is data, not behavior: `lib/tools.js` builds the catalog and
 * `createSuperbotTools({ role })` filters it. A role never receives a tool that
 * is absent here, and a preset row never registers tools outside its role.
 *
 * Roles:
 * - manager  — user-facing orchestrator: full task/plan/run/report/review surface,
 *              project inventory and worker/verifier dispatch.
 * - worker   — delegated executor: claim a task, read work state, write a report.
 *              No dispatch, no task creation/planning, no acceptance.
 * - verifier — read-only acceptance: read tasks/runs/reports/audit, submit a review
 *              verdict. No task transition, no filesystem write tool, no dispatch.
 *
 * DSH 0.2.1-rc.5 exposes `ctx.agentPresets.register(definition)` and scoped
 * `ctx.tools.register`; a preset plugin runs inside the agent's scope, so these
 * tool sets stay per-session instead of leaking into every global session.
 */

/** Agent preset identities registered by this plugin. */
export const PRESET_IDS = Object.freeze({
  manager: 'superbot-manager',
  worker: 'superbot-worker',
  verifier: 'superbot-verifier',
})

/** All roles this plugin knows. */
export const ROLES = Object.freeze(Object.keys(PRESET_IDS))

/** Full tool catalog (name → owning role is defined below). */
export const TOOL_NAMES = Object.freeze({
  requirementSubmit: 'superbot_requirement_submit',
  requirementList: 'superbot_requirement_list',
  specRecord: 'superbot_spec_record',
  planCreate: 'superbot_plan_create',
  planGet: 'superbot_plan_get',
  planDispatch: 'superbot_plan_dispatch',
  taskSubmit: 'superbot_task_submit',
  taskPlan: 'superbot_task_plan',
  taskList: 'superbot_task_list',
  taskGet: 'superbot_task_get',
  taskClaim: 'superbot_task_claim',
  taskReview: 'superbot_task_review',
  taskReport: 'superbot_task_report',
  reportList: 'superbot_report_list',
  runList: 'superbot_run_list',
  runFinish: 'superbot_run_finish',
  reviewSubmit: 'superbot_review_submit',
  reviewList: 'superbot_review_list',
  auditExport: 'superbot_audit_export',
  workRebuild: 'superbot_work_rebuild',
  handoff: 'superbot_handoff',
  projectHandoff: 'superbot_project_handoff',
  projectList: 'superbot_project_list',
  projectMatch: 'superbot_project_match',
  projectOverview: 'superbot_project_overview',
  dispatchWorker: 'superbot_dispatch_worker',
  dispatchVerifier: 'superbot_dispatch_verifier',
  acceptanceRun: 'superbot_acceptance_run',
  taskAccept: 'superbot_task_accept',
  taskRework: 'superbot_task_rework',
  taskCancel: 'superbot_task_cancel',
  historyImport: 'superbot_history_import',
  fleetStatus: 'superbot_fleet_status',
  onboardingScan: 'superbot_onboarding_scan',
  onboardingConfirm: 'superbot_onboarding_confirm',
})

const {
  requirementSubmit, requirementList, specRecord, planCreate, planGet, planDispatch,
  taskSubmit, taskPlan, taskList, taskGet, taskClaim, taskReview, taskReport,
  reportList, runList, runFinish, reviewSubmit, reviewList, auditExport,
  workRebuild, handoff, projectHandoff, projectList, projectMatch, projectOverview, dispatchWorker,
  dispatchVerifier, acceptanceRun, taskAccept, taskRework, taskCancel, historyImport, fleetStatus, onboardingScan, onboardingConfirm,
} = TOOL_NAMES

/**
 * Tool names per role. Read-only verifier: no mutating task tool, no
 * filesystem-write capability beyond the read-only preset rows.
 */
export const ROLE_TOOLS = Object.freeze({
  manager: Object.freeze([
    requirementSubmit, requirementList, specRecord, planCreate, planGet, planDispatch,
    taskSubmit, taskPlan, taskList, taskGet, taskClaim, taskReview, taskAccept, taskRework, taskCancel, historyImport, fleetStatus, taskReport,
    reportList, runList, runFinish, reviewList, auditExport, workRebuild, handoff, projectHandoff,
    projectList, projectMatch, projectOverview, onboardingScan, onboardingConfirm,
    dispatchWorker, dispatchVerifier,
  ]),
  worker: Object.freeze([
    taskGet, taskList, taskClaim, taskReport, reportList, handoff,
  ]),
  // The verifier is read-only on the filesystem and has no shell. Its only
  // mutating capability is `acceptanceRun`, a ledger-declared command executor
  // that records signed machine evidence — the structural answer to
  // "agents approve each other's prose".
  verifier: Object.freeze([
    taskGet, taskList, reportList, runList, acceptanceRun, reviewSubmit, reviewList, auditExport,
  ]),
})

export class RoleError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RoleError'
  }
}

/** Assert a role name; returns the frozen tool list. */
export function toolsForRole(role) {
  if (!Object.hasOwn(ROLE_TOOLS, role)) {
    throw new RoleError(`unknown role: ${String(role)} (expected one of ${ROLES.join(', ')})`)
  }
  return ROLE_TOOLS[role]
}

/** Whether `role` may register `toolName`. */
export function isToolAllowed(role, toolName) {
  return Object.hasOwn(ROLE_TOOLS, role) && ROLE_TOOLS[role].includes(toolName)
}

/**
 * Bundles whose presence means the profile mounts the agent-presets registry.
 * On those surfaces this plugin registers no global tools at all; the legacy
 * global row in `cordis.patch.yml` is disabled through the same predicate.
 */
export const PRESET_SURFACE_BUNDLES = Object.freeze(['@deepseek-ai/dsh-web-app'])

/** Pure form of the `!!js` predicate used in `cordis.patch.yml`. */
export function hasPresetSurface(startedBundles = []) {
  return Array.isArray(startedBundles) && startedBundles.some((name) => PRESET_SURFACE_BUNDLES.includes(name))
}
