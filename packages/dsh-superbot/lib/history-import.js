/**
 * Import selected historical DSH threads as ledger-managed "history work items".
 *
 * The import is deliberately conservative: it creates a requirement + a
 * high-risk investigation task per selected thread (read-only, no code change,
 * human acceptance). It never dispatches automatically and never rewrites the
 * original session. The digest is the bounded first-user-intent extracted by
 * the onboarding scan.
 */

export const MAX_HISTORY_IMPORT = 10

const nonEmpty = (value) => typeof value === 'string' && value.trim() !== ''
const clip = (value, max) => String(value).slice(0, max)

/**
 * @param {import('./work-store.js').WorkStore} store
 * @param {ReadonlyArray<Record<string, unknown>>} items
 * @param {{projects?: ReadonlyArray<Record<string, unknown>>, actor?: string, via?: string}} options
 */
export function importHistoryWork(store, items, { projects = [], actor = 'human', via = 'http' } = {}) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) throw new Error('history import requires at least one item')
  if (list.length > MAX_HISTORY_IMPORT) throw new Error(`history import accepts at most ${MAX_HISTORY_IMPORT} items`)
  const projectById = new Map((Array.isArray(projects) ? projects : []).map((project) => [project.workspaceId, project]))
  const imported = []
  for (const item of list) {
    const projectId = typeof item?.projectId === 'string' ? item.projectId.trim() : ''
    if (projectId === '' || !projectById.has(projectId)) throw new Error(`unknown project for history import: ${String(item?.projectId)}`)
    const project = projectById.get(projectId)
    const title = (nonEmpty(item?.title) ? item.title : (nonEmpty(item?.intent) ? item.intent : '未命名历史工作')).trim().slice(0, 120)
    const intent = nonEmpty(item?.intent) ? clip(item.intent, 600) : ''
    const sessionId = nonEmpty(item?.sessionId) ? clip(item.sessionId, 120) : ''
    const requirement = store.submitRequirement({
      projectId,
      title: `历史工作：${title}`,
      text: intent !== '' ? intent : `从历史 DSH 线程导入：${title}`,
    })
    const { plan, tasks } = store.createPlan({
      requirementId: requirement.id,
      title: '历史工作接管',
      tasks: [{
        title: `核对历史工作：${title}`,
        projectId,
        priority: 'normal',
        acceptance: [
          '给出该历史工作的当前真实状态（已完成/进行中/已放弃）及证据（文件、提交、测试结果）',
          '给出可执行的下一步建议；不自行执行旧计划',
        ],
        risk: 'high',
        reversible: true,
        externalSideEffects: false,
        context: [
          `这是从用户已有 DSH 线程导入的历史工作，原会话 ${sessionId || '（未记录）'}。`,
          '目标不是重做旧工作，而是核对现状并给出下一步；不要修改项目代码，不要改动历史会话。',
          intent === '' ? '' : `当时的意图摘要：${intent}`,
        ].filter(Boolean).join('\n'),
        constraints: ['只读调查；不修改项目代码/测试/依赖', '不自动执行旧计划'],
        nonGoals: ['不重写历史会话', '不在核对阶段改代码'],
      }],
    })
    imported.push({ projectId, projectTitle: project.title ?? projectId, requirementId: requirement.id, planId: plan.id, taskId: plan.taskIds[0], title })
  }
  return { count: imported.length, imported, via, actor }
}
