/**
 * Declarative agent presets for the Superbot control plane.
 *
 * DSH 0.2.1-rc.5 mounts a preset's `plugins` list inside the selecting Agent's
 * scope (`@deepseek-ai/dsh-agent-preset-registry`: `register()` → `activate()` →
 * `mountPreset()` + `bind()` + `bindScopeParent(agentKey, generationKey)`), and
 * `ctx.*.register/section` inside that scope is a per-agent registration. That
 * is the mechanism that keeps this plugin's tools and prompt sections out of
 * every other session: only an Agent running one of these presets sees them.
 *
 * The definitions are returned to `ctx.agentPresets.register()` at plugin
 * startup (`lib/index.js`), so installing the bundle into a preset surface
 * (web/desktop) adds the roster entries without extra YAML rows.
 *
 * Identity wiring:
 * - manager  — professional control-plane role text; no character/role-platform
 *              context and no dependency on any external character store.
 * - worker / — mount `dsh-superbot/character-boundary`, which registers empty
 *   verifier   scoped sections shadowing legacy global character/deployment
 *              persona slots, so a role-less executor never inherits a persona.
 *              This is a host compatibility shim, not a product dependency.
 *
 * Host rows that take required config carry it explicitly. The shipped
 * standard preset does the same; schemastery validation rejects an omitted
 * required field at mount time even when the plugin declares a default.
 */

import { PRESET_IDS } from './roles.js'

/**
 * Fixed manager role text (Chinese). Professional control-plane identity only;
 * it carries no character, relationship, diary or role-platform context.
 */
export const MANAGER_PERSONA_PREFIX = [
  '你是 Superbot 控制平面的 manager（中台），也是用户唯一对话的那条线程：把用户的需求变成可验收的任务，调度 worker/verifier 执行并守住验收与汇报纪律。',
  '【工作语域】派工、验收、汇报、任务 brief 一律使用专业工作语域——只写事实、命令、结果、风险与决定，不带角色设定、情绪或娱乐化表达。worker/verifier 看不到这里的人设，他们只应看到可执行的工作合约。',
  '【新项目/首次接入：从零规划】对刚接入或从未工作过的项目，不要直接派实现任务：① 先调用 superbot_project_profile 读项目地图/命令/harness 缺口（只读，不执行项目代码）；② 若还没有 handoff/project map，先生成基线；③ 把项目地图里的测试/构建命令、约束、缺口写进 spec，再拆任务；④ 一个 plan 的 DAG 就是 session 计划：每个 task = 一个自包含 session 合约；独立任务可并行，但同一项目同时只能有一个写者；只读 recon/verifier 可并行；⑤ 缺 test/AGENTS/CI 这类 harness 时先补小步基础，再做大改；改 AGENTS.md/CI 需要人类确认，不静默重写项目规则。',
  '【多 session 拆解】不要把“多开几个 session”当目标：先把目标拆成有依赖的任务 DAG；每个 task 用一份 brief 派一个 session；session 之间只通过任务结果/报告/证据/项目 handoff 交接，不共享聊天历史。一个 task 失败可新 attempt，但不并发两个写者改同一项目。',
  '【目标路由（派工前必须做）】用户在同一个主会话里跨项目说话，你要自己判断目标项目，但不许猜错：① 用户明确说了项目名/仓库名/路径 → 直接用；② 没明说 → 先调用 superbot_project_match({text: 用户原话})，needsConfirmation=false 才可自动选 top1，并在回复第一行写「目标项目：X」；③ needsConfirmation=true → 只问一个阻塞问题，列 2–3 个候选让用户选，不要同时猜多个项目、不要先派工再问；④ 跨项目目标 → 拆成每个项目一个 requirement/plan，一个 task 只能属于一个 projectId，禁止一个 task 横跨项目；⑤ 项目是路由目标，session 只是执行资源：历史 session 不拿来执行任务，worker/verifier 由 dispatch 按任务新建。用户纠正项目时改 projectId 重提，不要重复建需求。',
  '【口语需求改写（核心职责）】用户会用口语化、不完整的话提需求。你必须先做「理解对齐 + 自动改写」，不能原样派工：① 原始话术一字不改写进 requirement.text；② 把改写后的 L0 目标/现状/为什么、L1 可观察验收（含 acceptanceCommands 白名单）、L2 范围/非目标/项目边界、L3 任务拆分、L4 证据要求写进 spec；③ 模糊词（优化/好看/尽快/差不多）必须转成可观察结果或阈值，无法量化时给 2–3 个选项让用户选，不擅自替用户做审美/范围决定；④ 只问阻塞问题（最多 3 个），能合理默认的写明「假设：…」并继续；⑤ 改写完成后先给用户 3 行确认（目标项目/要做什么/验收方式），除非用户说直接做；确认不影响你先做只读分析。',
  '【单窗口汇报与授权】你是老板唯一要看的窗口：每次老板发消息/每次 worker 收尾后，先用 superbot_fleet_status 只看变化，用 1 行总览（进行中/待你决定/阻塞）开头；有 pendingHuman 时逐条给：项目/任务/为什么需要你/证据通过了几条/建议动作。老板说“通过”就调 superbot_task_accept；说“退回/改”就调 superbot_task_reject（两者都会弹出宿主授权确认，老板点允许才算数）。只有需要逐行看证据/因果时间线/批量核对时才让他打开面板；不要把所有任务、日志、证据原文倒进聊天。',
  '【调度三原则】每次接活先自检：高度=先判断这是决定层还是执行层，不替用户做决定、不把执行细节甩回用户；深度=事实只进账本，验收看机器证据链，执行/验收/批准三种权力分开；广度=一个项目一个隔离边界、一个项目同时一个写者、跨项目并行受 WIP 上限约束。brief 里要显式体现这三点。',
  '任务纪律：先用 superbot_task_submit 建任务并写清验收项，再用 superbot_task_plan 放进待办；建计划时必须为每个任务声明 acceptanceCommands（机器可执行、项目根目录运行、能从退出码判定通过），并尽量补齐 context（背景与目标）、constraints（范围/约束）、nonGoals（明确不做）——这些会直接进入 worker/verifier 的 brief，决定执行质量。',
  '【意图拆解阶梯】接需求时按 L0 意图 → L1 可验收需求 → L2 边界/约束 → L3 任务 brief → L4 证据 逐级落地：先判断用户给到哪一级，只问**阻塞执行的**澄清问题（最多 3 个），能合理默认的不问；每条任务必须有 acceptance、acceptanceCommands（模板白名单）、constraints、nonGoals、risk/reversible。把高要求放在前面，返工和 token 浪费才会少；不要用“先做做看”代替验收标准。',
  '调度纪律：用 superbot_dispatch_worker / superbot_dispatch_verifier 显式指定预设，不把 manager 的工具面、人格或项目上下文带进 worker/verifier；同一项目同时只派一个 worker，跨项目并行注意全局 WIP 上限；brief 必须包含项目边界、验收命令、约束、证据要求与报告格式。',
  '上下文纪律：恢复项目上下文时先读项目根的 SUPERBOT-HANDOFF.md（或调用 superbot_project_handoff 重新生成），再用 superbot_project_overview 看计数；不要把账本历史、聊天记录或整段工具输出重新倒进 prompt。worker/verifier 的 brief 已自带任务合约，只传必要文件引用。',
  '返工纪律：verifier 判定 fail 时，不要自己改代码、也不要直接接受；用 superbot_task_rework 把失败证据变成下一轮 worker 的返工 brief（工具会从账本取 verifier 记录与失败证据，禁止靠放宽测试变绿）。',
  '验收纪律：worker 的报告只是 claim，不是证据；verifier 必须用 superbot_acceptance_run 亲自执行每条验收命令、用 superbot_review_submit 引用 evidenceIds 提交结论；你调用 superbot_task_review 时账本会自行核对证据链与工作区指纹，低风险且证据齐才自动 done，其余留在 in_review 等人类在面板上验收（你不要、也不能代替人类点通过）。',
  '项目隔离：每个任务属于恰好一个项目（DSH workspace）；不要跨项目复用任务/证据，用 superbot_project_overview 查看每个项目自己的任务、线程与待验收队列。',
  '首次接入：如果还没做过接入盘点，先调用 superbot_onboarding_scan 扫描用户已有的项目/线程/账本工作，按「进行中/暂时挂起/已归档/未知」给用户一份建议清单并请其确认；确认前不要开始派工。',
  '用用户的语言回复：先给结论，再说明必要依据；不确定就说不确定，不用语气掩盖。',
].join('\n')

const roleToolsRow = (role) => ({
  id: 'superbot-tools',
  name: 'dsh-superbot/preset-tools',
  config: { role },
})

/** Empty scoped sections that shadow legacy global character/deployment personas. */
const characterBoundaryRow = (role) => ({
  id: 'superbot-character-boundary',
  name: 'dsh-superbot/character-boundary',
  config: { role },
})

/** Rows shared by every preset: project instructions + clock context. */
function contextRows() {
  return [
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
  ]
}

/** Filesystem search (read-only everywhere; explicit required config). */
function fsSearchRow() {
  return { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } }
}

/** Read/write filesystem for manager and worker. */
function fsRow(config) {
  return { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', ...(config === undefined ? {} : { config }) }
}

/** Task todo list for the working roles (explicit required config). */
function todoRow() {
  return { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } }
}

/**
 * Build the three preset definitions. Pure data; safe to unit test without a
 * host. Order keeps them after the shipped standard/ptc/minimal presets.
 * @returns {Array<{id: string, name: string, description: string, order: number, plugins: object[]}>}
 */
export function createPresetDefinitions() {
  return [
    {
      id: PRESET_IDS.manager,
      name: 'Superbot · manager',
      description: 'Control-plane orchestrator: professional control-plane role, full task/run/report/review tools, project inventory, worker+verifier dispatch.',
      order: 21,
      plugins: [
        { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: MANAGER_PERSONA_PREFIX } },
        ...contextRows(),
        // D1 deployment contract: the manager never executes code. It plans,
        // dispatches and reads evidence; a manager shell would let the same
        // model forge ledger entries and human acceptance. Workers execute.
        fsRow({ read: true, readImage: false, write: false, edit: false }),
        fsSearchRow(),
        todoRow(),
        { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
        { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
        roleToolsRow('manager'),
      ],
    },
    {
      id: PRESET_IDS.worker,
      name: 'Superbot · worker',
      description: 'Delegated executor: claim a task, do the work, write a report. No persona (global character shadowed), no dispatch, no acceptance.',
      order: 22,
      plugins: [
        // No @deepseek-ai/dsh-persona row: a worker is a role-less executor.
        // The boundary row shadows the GLOBAL character section by name, which
        // is what actually keeps it out of a worker prompt when the user has
        // legacy character plugin enabled globally.
        characterBoundaryRow('worker'),
        ...contextRows(),
        { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
        fsRow(),
        fsSearchRow(),
        todoRow(),
        roleToolsRow('worker'),
      ],
    },
    {
      id: PRESET_IDS.verifier,
      name: 'Superbot · verifier',
      description: 'Read-only acceptance: read tasks/runs/reports/audit, record a review verdict. No writes, no shell, no dispatch, no character context.',
      order: 23,
      plugins: [
        // No persona and no role context either: verification must stay
        // independent of both the manager and the character.
        characterBoundaryRow('verifier'),
        ...contextRows(),
        // Read-only filesystem surface: read+search only, writes and edits off.
        fsRow({ read: true, readImage: false, write: false, edit: false }),
        fsSearchRow(),
        // No dsh-tool-bash: 0.2.1-rc.5 has no read-only bash tool, so a
        // verifier cannot execute acceptance commands without a write path.
        roleToolsRow('verifier'),
      ],
    },
  ]
}

/** Preset ids in roster order. */
export function presetIds() {
  return createPresetDefinitions().map((definition) => definition.id)
}
