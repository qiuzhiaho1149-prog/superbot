/**
 * Session rotation policy: when to continue, compact, or hand off to a new session.
 * Pure functions; no host imports.
 */

/**
 * Decide what to do with the current session at a step boundary.
 * Quality is not the limit (calibration up to ~264k tokens showed no drop);
 * the budget is a cost/latency guard, so defaults are deliberately practical.
 * @param {{
 *   promptTokens: number,
 *   budgetTokens?: number,
 *   taskBoundary?: boolean,
 *   compactionCount?: number,
 * }} input
 * @returns {{action: 'continue'|'compact'|'handoff', reason: string, ratio: number, budget: number}}
 */
export function decideSessionAction({
  promptTokens,
  budgetTokens = 150_000,
  taskBoundary = false,
  compactionCount = 0,
} = {}) {
  const budget = Number.isFinite(budgetTokens) && budgetTokens > 0 ? budgetTokens : 150_000
  const tokens = Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : 0
  const ratio = tokens / budget
  const result = (action, reason) => ({ action, reason, ratio, budget })

  if (taskBoundary) return result('handoff', 'task-boundary')
  if (!Number.isInteger(compactionCount) || compactionCount < 0) compactionCount = 0
  if (compactionCount >= 2) return result('handoff', 'compaction-repeat')
  if (ratio >= 0.9) return result('handoff', 'budget-exhausted')
  if (ratio >= 0.7) return result('compact', 'budget-pressure')
  return result('continue', 'within-budget')
}

/**
 * 5-line handoff for rotation/recovery.
 * @param {{goal: string, status: string, next: string, blockers?: string, evidence?: string[]}} input
 * @returns {string}
 */
export function formatHandoff({ goal, status, next, blockers = '无', evidence = [] } = {}) {
  return [
    `目标：${goal ?? ''}`,
    `现状：${status ?? ''}`,
    `下一步：${next ?? ''}`,
    `未决：${blockers}`,
    `证据：${Array.isArray(evidence) && evidence.length > 0 ? evidence.join('; ') : '无'}`,
  ].join('\n')
}
