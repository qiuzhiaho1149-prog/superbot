/**
 * Structured-intent composer: turn a user's natural-language intent into a
 * high-energy, laddered work contract WITHOUT writing the ledger.
 *
 * The user edits one form; the server returns:
 *   - a normalized draft task (same shape the ledger would accept),
 *   - a 10-section worker brief preview (reuses buildTaskBrief),
 *   - a manager-facing prompt that asks the manager to decompose/verify first,
 *   - a quality report (missing fields, vague terms, contradictions, score).
 *
 * This is deliberately pure: no store, no dispatch, no approval. The user still
 * sends the generated brief/prompt into a Manager session, where the normal
 * planning + review-isolation pipeline takes over.
 */

import { validateTaskSpec } from './task-engine.js'
import { checkAcceptanceCommand, SAFE_COMMAND_EXAMPLES } from './command-policy.js'
import { buildTaskBrief } from './dispatch-tools.js'

const MAX_INTENT_CHARS = 4000
const MAX_TEXT_CHARS = 500
const MAX_ARRAY_ITEMS = 20
const MAX_COMMANDS = 10

const VAGUE_TERMS = [
  '优化', '改进', '更好', '好看', '尽快', '适当', '差不多', '随便', '尽量',
  '完善一下', '提升一下', '处理一下', '帮我搞', '搞一下', '弄一下', '差不多就行',
]

const RISKS = new Set(['low', 'high'])

const asString = (value) => (typeof value === 'string' ? value.trim() : '')

/** Accepts arrays or newline/comma-separated strings; trims + dedupes + bounds. */
function asList(value, { max = MAX_ARRAY_ITEMS, maxChars = MAX_TEXT_CHARS } = {}) {
  const raw = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/\r?\n|,|，/) : [])
  const seen = new Set()
  const items = []
  for (const entry of raw) {
    const text = asString(entry).slice(0, maxChars)
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    items.push(text)
    if (items.length >= max) break
  }
  return items
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/** Rough token estimate used for the "is this worth sending?" display. */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text === '') return 0
  return Math.ceil(text.length / 1.75)
}

/** Independent auto-accept prediction: mirrors the ledger policy, never grants it. */
function predictAutoAccept({ risk, reversible, externalSideEffects, tags }) {
  const reasons = []
  if (risk !== 'low') reasons.push('risk-not-low')
  if (reversible !== true) reasons.push('irreversible')
  if (externalSideEffects === true) reasons.push('external-side-effects')
  for (const tag of Array.isArray(tags) ? tags : []) reasons.push(`tag:${tag}`)
  return { eligible: reasons.length === 0, reasons }
}

/** Heuristic quality: structural completeness beats wording polish. */
function scoreDraft({ intent, acceptance, commands, constraints, nonGoals, risk, reversible, externalSideEffects, background }) {
  const missing = []
  const warnings = []
  let score = 100

  if (intent === '') {
    missing.push('intent（意图）')
    score -= 40
  } else if (intent.length < 12) {
    warnings.push('意图太短：补充「现状 / 目标 / 为什么现在做」')
    score -= 12
  }
  const vague = VAGUE_TERMS.filter((term) => intent.includes(term))
  if (vague.length > 0) {
    warnings.push(`意图含模糊词：${vague.join('、')}；改成可观察的结果`)
    score -= Math.min(24, vague.length * 8)
  }
  if (intent !== '' && !/[。.!?！？]/.test(intent) && intent.length > 120) {
    warnings.push('意图是一整段长句：建议拆成「背景 / 目标 / 约束」三行')
    score -= 5
  }
  if (acceptance.length === 0) {
    missing.push('acceptance（可验收标准）')
    score -= 25
  } else if (acceptance.length < 2) {
    warnings.push('验收标准只有 1 条：建议至少「行为验收 + 机器验收」两类')
    score -= 6
  }
  if (commands.length === 0) {
    missing.push('acceptanceCommands（机器验收命令）')
    score -= 20
  }
  if (constraints.length === 0) {
    missing.push('constraints（范围/约束）')
    score -= 8
  }
  if (nonGoals.length === 0) {
    warnings.push('没有非目标：容易顺手重构/扩范围')
    score -= 6
  }
  if (background === '') {
    warnings.push('缺背景：worker 不知道为什么要改，容易做错方向')
    score -= 4
  }
  if (risk === 'high' && reversible === true) {
    warnings.push('风险=high 但声明可逆：确认是否真的可回滚')
  }
  if (risk === undefined) {
    missing.push('risk（风险等级）')
    score -= 5
  }
  if (risk === 'low' && externalSideEffects === true) {
    warnings.push('声明外部副作用但风险低：可能被 policy 自动验收，建议提高风险或转人工')
    score -= 10
  }
  if (reversible === undefined) {
    missing.push('reversible（是否可逆）')
    score -= 5
  }
  if (externalSideEffects === undefined) {
    missing.push('externalSideEffects（是否有外部副作用）')
    score -= 5
  }

  const finalScore = clamp(Math.round(score), 0, 100)
  const grade = finalScore >= 85 ? 'A' : finalScore >= 70 ? 'B' : finalScore >= 50 ? 'C' : 'D'
  return { score: finalScore, grade, missing, warnings }
}

/** The ladder shown in the editor: what each level needs before moving up. */
function buildLadder({ intent, acceptance, commands, constraints, nonGoals, risk, reversible }) {
  return [
    {
      level: 'L0',
      title: '意图',
      status: intent === '' ? 'missing' : 'ok',
      needs: '现状 + 目标 + 为什么现在做',
    },
    {
      level: 'L1',
      title: '可验收需求',
      status: acceptance.length === 0 ? 'missing' : 'ok',
      needs: '至少 1 条可观察的验收标准',
    },
    {
      level: 'L2',
      title: '边界与约束',
      status: constraints.length === 0 || nonGoals.length === 0 ? 'partial' : 'ok',
      needs: '范围/约束 + 明确的非目标',
    },
    {
      level: 'L3',
      title: '任务 brief',
      status: commands.length === 0 ? 'partial' : 'ok',
      needs: `机器验收命令（模板白名单，如 ${SAFE_COMMAND_EXAMPLES[0]}）`,
    },
    {
      level: 'L4',
      title: '证据与验收',
      status: 'later',
      needs: 'plan → worker run → verifier evidence → policy/human 验收（由账本保证）',
    },
  ]
}

/** Manager-facing prompt: high bar up front, ask only blocking questions. */
function buildManagerPrompt({ intent, title, project, background, acceptance, commands, constraints, nonGoals, risk, reversible, externalSideEffects, draftTask }) {
  const lines = []
  lines.push('# 调度请求（结构化意图，来自用户）')
  lines.push('')
  lines.push(`- 项目：${project?.title ?? '（未指定）'}（workspaceId: ${project?.workspaceId ?? '未知'}）`)
  lines.push(`- 任务标题（草稿）：${title}`)
  lines.push('')
  lines.push('## 意图')
  lines.push(intent)
  if (background !== '') {
    lines.push('')
    lines.push('## 背景')
    lines.push(background)
  }
  lines.push('')
  lines.push('## 验收标准（不可自行放宽）')
  for (const item of acceptance) lines.push(`- ${item}`)
  if (commands.length > 0) {
    lines.push('')
    lines.push('## 机器验收命令（必须原样进入 plan 的 acceptanceCommands）')
    for (const command of commands) lines.push(`- \`${command}\``)
  }
  lines.push('')
  lines.push('## 范围/约束')
  for (const item of constraints) lines.push(`- ${item}`)
  if (nonGoals.length > 0) {
    lines.push('')
    lines.push('## 非目标（明确不做）')
    for (const item of nonGoals) lines.push(`- ${item}`)
  }
  lines.push('')
  lines.push('## 风险与变更属性')
  lines.push(`- risk: ${risk ?? '未声明'}`)
  lines.push(`- reversible: ${reversible === undefined ? '未声明' : reversible ? '是' : '否'}`)
  lines.push(`- externalSideEffects: ${externalSideEffects === undefined ? '未声明' : externalSideEffects ? '有' : '无'}`)
  lines.push('')
  lines.push('## 给 Manager 的要求（按顺序）')
  lines.push('1. 先判断意图是否可验收：只问**阻塞执行的**澄清问题，最多 3 个；能合理默认的不要问。')
  lines.push('2. 用 `superbot_requirement_submit` 记录需求，再用 `superbot_plan_create` 拆成可派工任务；每条任务必须有 acceptance 与 acceptanceCommands（白名单命令）。')
  lines.push('3. 明确非目标、约束、风险、可逆性；高风险/不可逆/有外部副作用的任务必须走人工验收。')
  lines.push('4. 不要自己改代码；按调度三原则派给 worker，verifier 独立执行验收命令。')
  lines.push('5. 如果用户信息不足且无法合理默认，先只回复需要用户决定的点，不要建 plan。')
  lines.push('')
  lines.push('## 机器可读草稿（原样落账；不要改写 acceptanceCommands）')
  lines.push('```json')
  lines.push(JSON.stringify({
    projectId: draftTask.projectId,
    title: draftTask.title,
    priority: draftTask.priority,
    acceptance: draftTask.acceptance,
    acceptanceCommands: draftTask.acceptanceCommands,
    ...(draftTask.context === undefined ? {} : { context: draftTask.context }),
    ...(draftTask.constraints === undefined ? {} : { constraints: draftTask.constraints }),
    ...(draftTask.nonGoals === undefined ? {} : { nonGoals: draftTask.nonGoals }),
    ...(draftTask.risk === undefined ? {} : { risk: draftTask.risk }),
    ...(draftTask.reversible === undefined ? {} : { reversible: draftTask.reversible }),
    ...(draftTask.externalSideEffects === undefined ? {} : { externalSideEffects: draftTask.externalSideEffects }),
  }, null, 2))
  lines.push('```')
  return lines.join('\n')
}

/**
 * Compose a draft from a user form. Never writes the ledger.
 * @param {Record<string, unknown>} input
 * @param {{projects?: ReadonlyArray<Record<string, unknown>>}} [context]
 */
export function composeDraft(input, { projects = [] } = {}) {
  const errors = []
  const rawIntent = asString(input?.intent)
  if (rawIntent.length > MAX_INTENT_CHARS) errors.push({ field: 'intent', message: `意图最多 ${MAX_INTENT_CHARS} 字符（当前 ${rawIntent.length}）` })
  const intent = rawIntent.slice(0, MAX_INTENT_CHARS)
  const projectId = asString(input?.projectId)
  const project = projects.find((item) => String(item.workspaceId ?? '') === projectId)
  if (intent === '') errors.push({ field: 'intent', message: '意图不能为空' })
  if (projectId === '') errors.push({ field: 'projectId', message: '必须选择一个项目' })
  else if (project === undefined) errors.push({ field: 'projectId', message: '项目不存在或不属于当前控制面' })

  const rawRisk = asString(input?.risk)
  const risk = rawRisk === '' ? undefined : rawRisk
  if (risk === 'normal') errors.push({ field: 'risk', message: 'risk 只能是 low 或 high（账本不接受 normal；不确定就选 high）' })
  else if (risk !== undefined && !RISKS.has(risk)) errors.push({ field: 'risk', message: 'risk 只能是 low 或 high' })

  const commands = asList(input?.acceptanceCommands, { max: MAX_COMMANDS, maxChars: 300 })
  for (const command of commands) {
    const check = checkAcceptanceCommand(command)
    if (!check.ok) errors.push({ field: 'acceptanceCommands', message: `「${command}」不是合法验收命令：${check.reason}` })
  }

  const acceptance = asList(input?.acceptance)
  const constraints = asList(input?.constraints)
  const nonGoals = asList(input?.nonGoals)
  const background = asString(input?.background).slice(0, MAX_INTENT_CHARS)
  const title = asString(input?.title).slice(0, 120) || (intent === '' ? '未命名任务' : intent.split(/[。.!?！？\n]/)[0].slice(0, 60))
  const priorityInput = asString(input?.priority)
  const priority = ['high', 'normal', 'low'].includes(priorityInput) ? priorityInput : 'normal'
  const reversible = typeof input?.reversible === 'boolean' ? input.reversible : undefined
  const externalSideEffects = typeof input?.externalSideEffects === 'boolean' ? input.externalSideEffects : undefined

  const draftTask = {
    id: 'draft',
    title,
    projectId,
    priority,
    acceptance,
    acceptanceCommands: commands.map((command) => ({ command })),
    context: (background === '' ? intent : `${background}\n\n意图：${intent}`).slice(0, 2000),
    constraints,
    nonGoals,
    ...(risk === undefined ? {} : { risk }),
    ...(reversible === undefined ? {} : { reversible }),
    ...(externalSideEffects === undefined ? {} : { externalSideEffects }),
  }
  // Hard gate: the draft must be a legal ledger payload (task-engine contract).
  const validated = validateTaskSpec(draftTask)
  if (!validated.ok) {
    for (const issue of validated.errors) errors.push({ field: issue.path, message: issue.message })
  }
  // Hard gate: L1 must be observable and machine-checkable for normal tasks.
  const blockers = []
  if (acceptance.length === 0) blockers.push({ field: 'acceptance', message: '至少一条可观察的验收标准（L1 不通过）' })
  if (commands.length === 0) blockers.push({ field: 'acceptanceCommands', message: '至少一条机器验收命令（L1 不通过）' })
  if (intent === '') blockers.push({ field: 'intent', message: '意图不能为空（L0 不通过）' })
  const quality = scoreDraft({ intent, acceptance, commands, constraints, nonGoals, risk, reversible, externalSideEffects, background })
  const ladder = buildLadder({ intent, acceptance, commands, constraints, nonGoals, risk, reversible })
  const allErrors = [...errors, ...blockers]
  const ok = allErrors.length === 0

  if (!ok) {
    return {
      ok,
      errors: allErrors,
      blockers,
      quality: { ...quality, score: Math.min(quality.score, 59), grade: 'D' },
      ladder,
      tokenEstimate: { brief: 0, managerPrompt: 0 },
    }
  }

  const brief = buildTaskBrief(draftTask, { workspaceId: project.workspaceId, cwd: project.path })
  const managerPrompt = buildManagerPrompt({
    intent, title, project, background, acceptance, commands, constraints, nonGoals, risk, reversible, externalSideEffects, draftTask,
  })
  const coverageWarnings = []
  if (acceptance.length > 1 && commands.length === 1) {
    coverageWarnings.push(`1 条机器命令可能覆盖不了 ${acceptance.length} 条验收标准：确认哪些走人工验收`)
  }
  const autoAccept = predictAutoAccept({ risk, reversible, externalSideEffects, tags: Array.isArray(input?.tags) ? input.tags : [] })
  return {
    ok,
    errors: [],
    blockers: [],
    draft: { requirement: { projectId, title, text: intent, background }, task: draftTask },
    quality: { ...quality, warnings: [...quality.warnings, ...coverageWarnings] },
    ladder,
    brief,
    managerPrompt,
    tokenEstimate: { brief: estimateTokens(brief), managerPrompt: estimateTokens(managerPrompt) },
    autoAccept,
  }
}
