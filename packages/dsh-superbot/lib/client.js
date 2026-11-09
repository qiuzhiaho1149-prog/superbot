window.__ModuleLoader__.load({
  id: 'dsh-superbot',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const CONFIG_URL = '/superbot/config'
    const FIELDS = [
      { key: 'dedupeToolResults', label: '重复工具结果去重', type: 'boolean', hint: '相同输出只保留一份并给出原文路径' },
      { key: 'toolsEnabled', label: '启用任务工具', type: 'boolean', hint: '关闭后所有 superbot_* 工具一律拒绝执行' },
      { key: 'budgetTokens', label: '会话预算（token）', type: 'number', hint: '预留：用于后续自动轮换；当前不改变执行' },
      { key: 'compactAt', label: '压缩阈值', type: 'number', hint: '预留：压缩阈值；当前未接入自动压缩' },
      { key: 'handoffAt', label: '交接阈值', type: 'number', hint: '预留：交接阈值；当前未接入自动交接' },
      { key: 'cacheDir', label: '去重原文目录', type: 'text', hint: '留空使用系统临时目录' },
      { key: 'wipLimit', label: '跨项目并发上限', type: 'number', hint: '同时推进的项目数（单个项目永远只允许一个 worker）；默认 2' },
    ]

    function numberInput(value, onChange) {
      return h('input', {
        type: 'number', step: '0.01', value,
        style: { width: '140px', padding: '6px 8px', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '6px', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' },
        onChange: (event) => onChange(event.target.value === '' ? '' : Number(event.target.value)),
      })
    }

    function SuperbotSettings() {
      const [config, setConfig] = useState(null)
      const [status, setStatus] = useState('loading')
      const [note, setNote] = useState('')
      const [error, setError] = useState('')

      const load = useCallback(async () => {
        setStatus('loading'); setError('')
        try {
          const response = await fetch(CONFIG_URL, { cache: 'no-store' })
          const body = await response.json()
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
          setConfig(body.config)
          setStatus('ready')
        } catch (cause) {
          setError(String(cause?.message ?? cause))
          setStatus('error')
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const update = (key, value) => setConfig((current) => ({ ...current, [key]: value }))
      const save = async () => {
        setStatus('saving'); setNote(''); setError('')
        try {
          const response = await fetch(CONFIG_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              dedupeToolResults: config.dedupeToolResults,
              toolsEnabled: config.toolsEnabled,
              budgetTokens: config.budgetTokens,
              compactAt: config.compactAt,
              handoffAt: config.handoffAt,
              cacheDir: config.cacheDir,
              wipLimit: config.wipLimit,
            }),
          })
          const body = await response.json()
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
          setConfig(body.config)
          setStatus('ready')
          setNote('已保存')
        } catch (cause) {
          setError(String(cause?.message ?? cause))
          setStatus('error')
        }
      }

      if (status === 'loading' && config === null) return h('p', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '正在读取配置…')

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '680px' } },
        h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', lineHeight: '20px' } },
          '控制 Superbot 插件的工具与上下文策略。任务/运行/报告/审查写入本地追加式事件日志（重启可读）。工具只在 manager/worker/verifier preset 会话中挂载，不在普通会话全局出现。'),
        ...FIELDS.map((field) => {
          const value = config?.[field.key]
          const control = field.type === 'boolean'
            ? h('input', { type: 'checkbox', checked: Boolean(value), onChange: (event) => update(field.key, event.target.checked) })
            : field.type === 'number'
              ? numberInput(value, (next) => update(field.key, next))
              : h('input', {
                  type: 'text', value: value ?? '', style: { width: '320px', padding: '6px 8px', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: '6px', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)' },
                  onChange: (event) => update(field.key, event.target.value),
                })
          return h('label', { key: field.key, style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('span', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 500 } }, control, field.label),
            h('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' } }, field.hint))
        }),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
          h('button', {
            type: 'button',
            disabled: status === 'saving' || config === null,
            onClick: () => { void save() },
            style: { padding: '7px 16px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
          }, status === 'saving' ? '保存中…' : '保存'),
          h('button', {
            type: 'button',
            onClick: () => { void load() },
            style: { padding: '7px 16px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l4)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' },
          }, '重新读取'),
          note ? h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, note) : null,
          error ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, `保存失败：${error}`) : null),
        h('p', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', margin: 0 } },
          `配置文件：${config?.stateDir ?? ''}/config.json`))
    }
    // ════════════════════════════════════════════════════════════════════
    // Superbot 总览面板
    //
    // 信息层级（从注意力到原始审计）：
    //   ① 概要条：项目 / 未完成 / 待你验收 / 活跃线程 / 已完成
    //   ② 首次接入盘点（未确认时展开，确认后折叠成一行）
    //   ③ 待你处理：唯一需要人动手的队列（验收 / 需求决定）
    //   ④ 项目组合：一行一个项目（状态 / 进度 / 线程 / 最近活动），展开看任务与线程
    //   ⑤ 原始标识与隔离说明：默认折叠
    // ════════════════════════════════════════════════════════════════════

    const OVERVIEW_URL = '/superbot/overview'
    const ACCEPT_URL = '/superbot/accept'
    const REJECT_URL = '/superbot/reject'
    const ONBOARDING_URL = '/superbot/onboarding'
    const ONBOARDING_CONFIRM_URL = '/superbot/onboarding/confirm'
    const COMPOSE_URL = '/superbot/compose'
    const COMPOSE_KEY = 'superbot:panel:compose:v2'
    const INIT_PROMPT = '你是我的核心调度员工（Superbot）。先自动了解我已有的项目和线程：调用 superbot_onboarding_scan 读取全部项目/线程/历史工作摘要，给我一份「现状快照 + 哪些在进行、哪些挂起、哪些没结果」的接管建议；不要自动派工，先让我确认。若我还没有任何历史，请帮我建立最小工作流（需求→可验收任务→派工→自动审计→人工验收），并从我的第一条需求开始落地。'
    const COMPOSE_KEY_V1 = 'superbot:panel:compose:v1'
    const PANEL_ID = 'superbot'
    const PANEL_LABEL = 'Superbot'
    const POLL_MS = 15000
    const VIEW_KEY = 'superbot:panel:view:v1'
    const FILTERS = [
      { value: 'all', label: '全部' },
      { value: 'attention', label: '待你验收' },
      { value: 'active', label: '进行中' },
      { value: 'idle', label: '空闲' },
    ]
    const SORTS = [
      { value: 'activity', label: '最近活动' },
      { value: 'attention', label: '待处理优先' },
      { value: 'name', label: '名称' },
    ]

    function loadSavedView() {
      const defaults = { filter: 'all', sort: 'activity', q: '' }
      try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(VIEW_KEY)
        if (raw === null) return defaults
        const parsed = JSON.parse(raw)
        return {
          filter: FILTERS.some((item) => item.value === parsed.filter) ? parsed.filter : 'all',
          sort: SORTS.some((item) => item.value === parsed.sort) ? parsed.sort : 'activity',
          q: typeof parsed.q === 'string' ? parsed.q : '',
        }
      } catch {
        return defaults
      }
    }

    function overviewUrl(view) {
      const params = new URLSearchParams()
      if (view.filter !== 'all') params.set('filter', view.filter)
      if (view.sort !== 'activity') params.set('sort', view.sort)
      const query = typeof view.q === 'string' ? view.q.trim() : ''
      if (query !== '') params.set('q', query)
      const suffix = params.toString()
      return suffix === '' ? OVERVIEW_URL : `${OVERVIEW_URL}?${suffix}`
    }

    // 仅使用 DSH 主题 token，深浅色自动适配；颜色只承担语义，不做装饰。
    const C = {
      bg: 'var(--dsw-alias-bg-base)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      surface2: 'var(--dsw-alias-bg-layer-2)',
      line: 'var(--dsw-alias-border-l2)',
      lineStrong: 'var(--dsw-alias-border-l3)',
      control: 'var(--dsw-alias-border-l4)',
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      text3: 'var(--dsw-alias-label-tertiary)',
      caption: 'var(--dsw-alias-label-caption)',
      business: 'var(--dsw-alias-state-business-primary)',
      button: 'var(--dsw-alias-button-primary-fill)',
      onButton: 'var(--dsw-alias-label-primary-inverted)',
      errorText: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      mono: 'ui-monospace, "SF Mono", Menlo, monospace',
    }

    const TASK_STATUS = {
      draft: { label: '草稿', tone: C.idle },
      todo: { label: '待办', tone: C.idle },
      in_progress: { label: '进行中', tone: C.business },
      in_review: { label: '待验收', tone: C.warn },
      blocked: { label: '阻塞', tone: C.danger },
      done: { label: '完成', tone: C.success },
      canceled: { label: '取消', tone: C.text3 },
    }
    const RUN_STATUS = { running: '进行中', succeeded: '完成', failed: '失败', canceled: '取消' }
    const PRIORITY_LABEL = { high: '高', normal: '中', low: '低' }
    const REASON_LABEL = {
      'awaiting-verifier': '等待验证',
      'verifier-failed': '验证未通过',
      'evidence-incomplete': '证据不完整',
      'policy-human-required': '策略要求人工验收',
      'sandbox-untrusted': '验收环境不可信',
      'awaiting-human': '等待人工验收',
    }
    const REASON_CODE_HUMAN = {
      'risk-not-low': '高风险',
      irreversible: '不可逆变更',
      'external-side-effects': '有外部副作用',
      'tag:aesthetic': '涉及审美',
      'tag:design': '涉及设计',
      'tag:copy': '涉及文案',
      'tag:security': '涉及安全',
      'tag:credentials': '涉及凭据',
      'tag:permissions': '涉及权限',
      'verification-not-passed': '验收未通过',
    }

    /** 把策略机器码翻成人话：`策略要求人工验收：risk-not-low, tag:aesthetic` → `…：高风险、涉及审美`。 */
    function humanizeDetail(detail) {
      if (typeof detail !== 'string' || detail === '') return ''
      const separator = detail.includes('：') ? '：' : (detail.includes(':') ? ':' : null)
      if (separator === null) return detail
      const index = detail.indexOf(separator)
      const head = detail.slice(0, index)
      const tokens = detail.slice(index + 1).split(/,\s*/).map((token) => token.trim()).filter(Boolean)
      if (tokens.length === 0) return detail
      return `${head}${separator}${tokens.map((token) => REASON_CODE_HUMAN[token] || token).join('、')}`
    }

    const PROJECT_STATUS = {
      active: { label: '进行中', tone: C.business },
      paused: { label: '暂时挂起', tone: C.warn },
      archived: { label: '已归档', tone: C.text3 },
      unknown: { label: '未知', tone: C.idle },
    }

    // ── 格式化 ───────────────────────────────────────────────────────────
    const numeric = (value) => (Number.isFinite(value) ? value : 0)
    const textNum = (value) => String(numeric(value))

    function relativeTime(iso) {
      if (typeof iso !== 'string' || iso === '') return { text: '—', title: '' }
      const time = Date.parse(iso)
      if (!Number.isFinite(time)) return { text: '—', title: iso }
      const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
      let text
      if (seconds < 60) text = '刚刚'
      else if (seconds < 3600) text = `${Math.floor(seconds / 60)} 分钟前`
      else if (seconds < 86400) text = `${Math.floor(seconds / 3600)} 小时前`
      else if (seconds < 86400 * 30) text = `${Math.floor(seconds / 86400)} 天前`
      else text = new Date(time).toLocaleDateString()
      return { text, title: new Date(time).toLocaleString() }
    }

    function absoluteTime(iso) {
      if (typeof iso !== 'string' || iso === '') return '—'
      const time = Date.parse(iso)
      if (!Number.isFinite(time)) return iso
      const date = new Date(time)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function shortId(id) {
      if (typeof id !== 'string' || id === '') return '—'
      const match = /^session-(.+)$/.exec(id)
      const raw = match === null ? id : match[1]
      return raw.length > 8 ? raw.slice(0, 8) : raw
    }

    function ownerLabel(owner, threads) {
      if (typeof owner !== 'string' || owner === '') return '—'
      const thread = Array.isArray(threads) ? threads.find((row) => row.runId === owner) : undefined
      if (thread === undefined) return '执行者未知'
      return `${presetLabel(thread.agentPreset)} · ${shortId(owner)}`
    }

    function threadTitle(thread) {
      const label = typeof thread.label === 'string' ? thread.label : ''
      const match = /^(worker|verifier|verify):(.+)$/.exec(label)
      if (match !== null) return `${match[1] === 'worker' ? '执行' : '验收'} · ${match[2]}`
      if (label !== '') return label
      return thread.runId || '—'
    }

    const presetLabel = (preset) => (typeof preset === 'string' && preset.startsWith('superbot-') ? preset.slice('superbot-'.length) : (preset || '—'))

    function projectHeadline(project) {
      const counts = project.counts || {}
      const tasks = counts.tasks || {}
      const pending = Array.isArray(project.pendingHuman) ? project.pendingHuman.length : 0
      if (pending > 0) return { label: `待你验收 ${pending}`, tone: C.warn }
      if (numeric((counts.runs || {}).active) > 0) return { label: '进行中', tone: C.business }
      return { label: '空闲', tone: C.text3 }
    }

    function projectProgress(project) {
      const tasks = (project.counts || {}).tasks || {}
      const total = numeric(tasks.total)
      const done = numeric(tasks.done) + numeric(tasks.canceled)
      return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
    }

    function overviewTotals(overview) {
      const totals = overview && overview.totals ? overview.totals : {}
      const byStatus = totals.tasksByStatus || {}
      const done = numeric(byStatus.done) + numeric(byStatus.canceled)
      const total = numeric(totals.tasks)
      return {
        projects: numeric(totals.projects),
        openTasks: Math.max(0, total - done),
        pendingHuman: numeric(totals.pendingHuman),
        activeRuns: numeric(totals.activeRuns),
        done,
      }
    }

    // 一次性注入的样式表：inline style 表达不了 hover/容器查询/焦点环。
    function ensurePanelCss() {
      if (typeof document === 'undefined') return
      if (document.getElementById('superbot-panel-css') !== null) return
      const style = document.createElement('style')
      style.id = 'superbot-panel-css'
      style.textContent = [
        '.sb-page-inner{container-type:inline-size}',
        '.sb-row{transition:background-color 120ms ease}',
        '.sb-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.sb-row-toggle{background:none;border:0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;padding:4px 6px;border-radius:4px;line-height:1}',
        '.sb-row-toggle:hover{color:var(--dsw-alias-label-primary)}',
        '.sb-btn{transition:background-color 120ms ease,border-color 120ms ease}',
        '.sb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.sb-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}',
        '.sb-row-toggle:focus-visible,.sb-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
        '.sb-surface{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1)}',
        '.sb-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
        '.sb-chip:hover{border-color:var(--dsw-alias-border-l3)}',
        '.sb-badge{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:6px;font-size:11px;line-height:18px;font-weight:500;white-space:nowrap}',
        '.sb-btn{height:28px;padding:0 10px;border-radius:8px;font-size:12px;font-weight:500;white-space:nowrap}',
        '.sb-btn-sm{height:24px;padding:0 8px;border-radius:6px}',
        '.sb-card{border-radius:10px;background:var(--dsw-alias-bg-layer-1);transition:border-color 120ms ease,background-color 120ms ease}',
        '.sb-card:hover{border-color:var(--dsw-alias-border-l3)}',
        '.sb-drawer{background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-panel,rgba(0,0,0,.25) -16px 0 40px)}',
        '.sb-tab-active{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom:2px solid var(--dsw-alias-state-business-primary)}',
        '.sb-topbar{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-base)}',
        '.sb-mask{background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.35))}',
        '.sb-alert{display:flex;gap:8px;align-items:baseline;padding:10px 12px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-primary)}',
        '.sb-empty{padding:16px 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
        '.sb-tab{border:none;background:transparent;cursor:pointer;color:var(--dsw-alias-label-tertiary)}',
        '.sb-tab:hover{color:var(--dsw-alias-label-primary)}',
        '@media (prefers-reduced-motion: reduce){.sb-row,.sb-btn,.sb-chip{transition:none}}',
        '@container (max-width:860px){.sb-col-threads,.sb-col-recent{display:none}}',
        '@container (max-width:680px){.sb-col-status{display:none}}',
      ].join('\n')
      document.head.appendChild(style)
    }

    const EMPTY_COMPOSE = {
      intent: '', projectId: '', title: '', background: '', acceptance: '',
      acceptanceCommands: 'node --test', constraints: '', nonGoals: '',
      risk: 'low', reversible: true, externalSideEffects: false,
    }

    function loadComposeDraft() {
      try {
        const raw = typeof localStorage === 'undefined' ? null : (localStorage.getItem(COMPOSE_KEY) ?? localStorage.getItem(COMPOSE_KEY_V1))
        if (raw === null) return { ...EMPTY_COMPOSE }
        const parsed = JSON.parse(raw)
        const merged = { ...EMPTY_COMPOSE, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
        if (merged.risk === 'normal') merged.risk = 'high'
        return merged
      } catch {
        return { ...EMPTY_COMPOSE }
      }
    }

    // ── 基础组件 ─────────────────────────────────────────────────────────
    function Dot({ tone = C.idle, size = 6 }) {
      return h('span', {
        'aria-hidden': 'true',
        style: { width: `${size}px`, height: `${size}px`, borderRadius: '50%', background: tone, display: 'inline-block', flex: '0 0 auto' },
      })
    }

    function Pill({ tone = C.idle, children, strong = false, title }) {
      return h('span', {
        title,
        className: 'sb-badge',
        style: {
          color: C.text2,
          background: strong ? C.surface2 : 'transparent',
          border: `1px solid ${C.lineStrong}`,
        },
      }, h(Dot, { tone }), children)
    }

    function Button({ children, onClick, primary = false, disabled = false, title, size = 'md' }) {
      return h('button', {
        type: 'button',
        onClick,
        disabled,
        title,
        className: `sb-btn${size === 'sm' ? ' sb-btn-sm' : ''}${primary ? ' sb-btn-primary' : ''}`,
        style: {
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          color: primary ? C.onButton : C.text,
          background: primary ? C.button : 'transparent',
          border: `1px solid ${primary ? C.button : C.control}`,
        },
      }, children)
    }

    function Bar({ percent, tone = C.brand }) {
      return h('span', {
        'aria-hidden': 'true',
        style: { display: 'inline-block', width: '56px', height: '4px', borderRadius: '2px', background: C.line, overflow: 'hidden', flex: '0 0 auto' },
      }, h('span', { style: { display: 'block', height: '100%', width: `${Math.max(0, Math.min(100, percent))}%`, background: tone, borderRadius: '2px' } }))
    }

    function SectionHeading({ title, count, hint, action }) {
      return h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '0 0 8px' } },
        h('h2', { style: { margin: 0, fontSize: '13px', fontWeight: 600, letterSpacing: '0.01em' } }, title),
        count === undefined ? null : h('span', { style: { fontSize: '11px', color: C.text3 } }, count),
        hint === undefined ? null : h('span', { style: { fontSize: '11px', color: C.text3 } }, hint),
        h('span', { style: { flex: '1 1 auto' } }),
        action === undefined ? null : action)
    }

    function EmptyLine({ children }) {
      return h('div', { className: 'sb-empty', style: { padding: '14px 0', borderBottom: `1px solid ${C.line}` } }, children)
    }

    function Time({ iso }) {
      const value = relativeTime(iso)
      return h('span', { title: value.title, style: { fontSize: '12px', color: C.text3, whiteSpace: 'nowrap' } }, value.text)
    }

    function Meta({ children, style }) {
      return h('span', { style: { fontSize: '11px', color: C.text3, ...(style || {}) } }, children)
    }

    // ── 首次接入盘点 ─────────────────────────────────────────────────────
    function OnboardingBlock({ inventory, busy, onConfirm, httpHumanAllowed = true }) {
      if (!inventory) return null
      if (inventory.confirmation) {
        const confirmation = inventory.confirmation
        return h('div', {
          style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 0', borderBottom: `1px solid ${C.line}` },
        },
        h(Dot, { tone: C.success }),
        h('span', { style: { fontSize: '12px', color: C.text2 } },
          `接入盘点已确认 · ${textNum(confirmation.projects && confirmation.projects.length)} 个项目 · ${absoluteTime(confirmation.confirmedAt)}`),
        h('span', { style: { flex: '1 1 auto' } }),
        h(Meta, null, `via ${confirmation.via || 'http'}`))
      }
      const projects = Array.isArray(inventory.projects) ? inventory.projects : []
      const totals = inventory.totals || {}
      const rows = projects.map((project) => {
        const status = PROJECT_STATUS[project.proposedStatus] || PROJECT_STATUS.unknown
        return h('tr', { key: project.projectId },
          h('td', { style: TD },
            h('div', { style: { fontSize: '12px', fontWeight: 500 } }, project.title || project.projectId),
            h('div', { style: { fontSize: '11px', color: C.text3, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '300px' } }, project.path || project.projectId)),
          h('td', { style: TD }, h(Pill, { tone: status.tone }, status.label)),
          h('td', { style: { ...TD, fontSize: '12px', color: C.text2 } },
            `${textNum((project.counts || {}).threads)} 线程`),
          h('td', { style: { ...TD, fontSize: '12px', color: C.text2 } },
            `${textNum((project.counts || {}).openTasks)} 未完成`),
          h('td', { style: { ...TD, fontSize: '11px', color: C.text3 } }, (project.proposedReasons || []).join('；') || '—'))
      })
      return h('section', {
        className: 'sb-surface',
        style: { margin: '16px 0 4px', padding: '16px 18px' },
        'aria-label': '首次接入盘点',
      },
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
        h('h2', { style: { margin: 0, fontSize: '13px', fontWeight: 600 } }, '首次接入盘点'),
        h(Pill, { tone: C.warn, strong: true }, '需要你确认'),
        h('span', { style: { flex: '1 1 auto' } }),
        h(Meta, null, `扫描 ${textNum(totals.projects)} 项目 · ${textNum(totals.threads)} 顶层线程 · ${textNum(totals.childThreads)} 子线程 · ${textNum(totals.openTasks)} 未完成任务`)),
      h('p', { style: { margin: '6px 0 12px', fontSize: '12px', color: C.text2, lineHeight: '18px' } },
        '接入前先确认：这些项目/线程现在是「进行中」还是「暂时挂起」。确认后才会开始调度；盘点只读，不会改动任何会话。'),
      h('table', { style: TABLE },
        h('thead', null, h('tr', null,
          h('th', { style: TH }, '项目'),
          h('th', { style: TH }, '建议状态'),
          h('th', { style: TH }, '线程'),
          h('th', { style: TH }, '未完成任务'),
          h('th', { style: TH }, '依据'))),
        h('tbody', null, rows)),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '12px' } },
        httpHumanAllowed
          ? h(Button, { primary: true, disabled: busy === 'onboarding' || projects.length === 0, onClick: () => onConfirm(projects.map((project) => ({ projectId: project.projectId, status: project.proposedStatus, ...(project.title ? { title: project.title } : {}), ...(project.path ? { path: project.path } : {}) }))) },
            busy === 'onboarding' ? '确认中…' : '确认盘点结果')
          : h(Pill, { tone: C.warn }, '需在对话中批准'),
        h(Meta, null, httpHumanAllowed ? '确认即认可「进行中 / 暂时挂起」划分；之后仍可重新盘点。' : '面板确认已禁用：让 Manager 调用 superbot_onboarding_confirm，在 approval 弹窗批准。')))
    }

    // ── 待你处理 ─────────────────────────────────────────────────────────
    const RISKY_REASONS = new Set(['awaiting-verifier', 'verifier-failed', 'evidence-incomplete', 'sandbox-untrusted'])

    function AttentionRow({ item, projectTitle, busy, onAccept, onReject, openSession, httpHumanAllowed = true }) {
      const [note, setNote] = useState('')
      const [confirming, setConfirming] = useState(false)
      const accepting = busy === item.taskId
      const risky = RISKY_REASONS.has(item.reason)
      const reason = REASON_LABEL[item.reason] || item.reason || '待人工验收'
      const canOpen = typeof openSession === 'function' && typeof item.workerChildId === 'string' && item.workerChildId !== ''
      const actions = []
      if (!httpHumanAllowed) {
        actions.push(h(Pill, { key: 'approval-only', tone: C.warn }, '需在对话中批准'))
        if (canOpen) actions.push(h(Button, { key: 'open', onClick: () => openSession(item.workerChildId) }, '打开执行会话'))
        return h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '12px 0', borderBottom: `1px solid ${C.line}` } },
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
              h('span', { style: { fontSize: '13px', fontWeight: 500 } }, item.title || item.taskId),
              h(Pill, { tone: risky ? C.warn : C.success }, reason),
              projectTitle ? h(Meta, null, projectTitle) : null),
            h('div', { style: { marginTop: '4px', fontSize: '11px', color: C.text3 } },
              '面板直连人工验收已禁用（默认安全）：让 Manager 调用 superbot_task_accept，在宿主 approval 弹窗批准；或部署显式开启 httpHumanActions。')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' } }, ...actions))
      }
      if (risky) {
        if (canOpen) actions.push(h(Button, { key: 'open', onClick: () => openSession(item.workerChildId) }, '打开执行会话'))
        actions.push(h(Button, {
          key: 'accept',
          disabled: accepting,
          onClick: () => {
            if (confirming) onAccept(item.taskId, note.trim() === '' ? undefined : note.trim())
            else setConfirming(true)
          },
        }, accepting ? '提交中…' : confirming ? '确认通过？' : '仍要通过验收…'))
      } else {
        actions.push(h(Button, { key: 'accept', primary: true, disabled: accepting, onClick: () => onAccept(item.taskId, note.trim() === '' ? undefined : note.trim()) },
          accepting ? '提交中…' : '通过验收'))
        if (typeof onReject === 'function') actions.push(h(Button, { key: 'reject', disabled: accepting, onClick: () => onReject(item.taskId, note.trim() === '' ? undefined : note.trim()) },
          '退回返工'))
      }
      return h('div', {
        style: { display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '12px 0', borderBottom: `1px solid ${C.line}` },
      },
      h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { fontSize: '13px', fontWeight: 500 } }, item.title || item.taskId),
          h(Pill, { tone: risky ? C.warn : C.success }, reason),
          projectTitle ? h(Meta, null, projectTitle) : null),
        h('div', { style: { marginTop: '4px', display: 'flex', gap: '14px', flexWrap: 'wrap' } },
          h(Meta, null, `证据 ${item.evidenceComplete ? '完整' : '不完整'} · ${textNum(item.commandCount)} 条验收命令`),
          item.detail ? h(Meta, null, humanizeDetail(item.detail)) : null,
          risky ? h(Meta, null, '人工通过会覆盖证据不足并记入账本') : null)),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto' } },
        h('input', {
          type: 'text', value: note, placeholder: '备注（可选）', 'aria-label': `验收备注 ${item.taskId}`,
          disabled: accepting, onChange: (event) => setNote(event.target.value),
          style: { width: '150px', height: '28px', padding: '0 8px', fontSize: '12px', borderRadius: '6px', border: `1px solid ${C.control}`, background: C.bg, color: C.text },
        }),
        ...actions))
    }

    // ── 表格 ─────────────────────────────────────────────────────────────
    const TABLE = { width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }
    const TH = { textAlign: 'left', fontSize: '11px', fontWeight: 500, color: C.text3, height: '30px', padding: '0 10px', borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap' }
    const TD = { fontSize: '12px', height: '42px', padding: '0 10px', borderBottom: `1px solid ${C.line}`, verticalAlign: 'middle', color: C.text2 }

    function TaskTable({ tasks, threads }) {
      const rows = tasks.map((task) => {
        const status = TASK_STATUS[task.status] || { label: task.status, tone: C.idle }
        return h('tr', { key: task.taskId },
          h('td', { style: { ...TD, color: C.text } }, h('span', { style: { fontSize: '12px' } }, task.title || task.taskId)),
          h('td', { style: TD }, h(Pill, { tone: status.tone }, status.label)),
          h('td', { style: { ...TD, fontSize: '12px', color: C.text3 } }, PRIORITY_LABEL[task.priority] || '—'),
          h('td', { style: { ...TD, fontSize: '12px', color: C.text3 } }, ownerLabel(task.owner, threads)),
          h('td', { style: { ...TD, fontSize: '12px', color: C.text3 } }, task.acceptanceCommands > 0 ? `${textNum(task.acceptanceCommands)} 条命令` : '—'),
          h('td', { style: { ...TD, textAlign: 'right' } }, h(Time, { iso: task.updatedAt })))
      })
      return h('table', { style: TABLE },
        h('thead', null, h('tr', null,
          h('th', { style: { ...TH, width: '38%' } }, '任务'),
          h('th', { style: { ...TH, width: '12%' } }, '状态'),
          h('th', { style: { ...TH, width: '10%' } }, '优先级'),
          h('th', { style: { ...TH, width: '16%' } }, '执行者'),
          h('th', { style: { ...TH, width: '12%' } }, '验收命令'),
          h('th', { style: { ...TH, width: '12%', textAlign: 'right' } }, '更新'))),
        h('tbody', null, rows))
    }

    function ThreadTable({ threads, onOpenSession }) {
      const rows = threads.map((thread) => {
        const active = thread.active === true
        return h('tr', { key: thread.runId },
          h('td', { style: { ...TD, color: C.text } },
            h('div', { style: { fontSize: '12px' } }, threadTitle(thread)),
            h('div', { style: { fontSize: '11px', color: C.text3, fontFamily: C.mono } }, shortId(thread.childId))),
          h('td', { style: TD }, h(Pill, { tone: thread.agentPreset === 'superbot-verifier' ? C.business : C.success }, presetLabel(thread.agentPreset))),
          h('td', { style: TD }, h(Pill, { tone: active ? C.business : C.text3 }, active ? '进行中' : (RUN_STATUS[thread.status] || thread.status || '—'))),
          h('td', { style: { ...TD, fontSize: '12px', color: C.text3 } }, thread.taskId || '—'),
          h('td', { style: { ...TD, textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px', borderBottom: `1px solid ${C.line}` } },
            h(Time, { iso: thread.startedAt }),
            typeof thread.childId === 'string' && thread.childId !== '' && typeof onOpenSession === 'function'
              ? h(Button, { size: 'sm', onClick: () => onOpenSession(thread.childId) }, '打开会话')
              : null))
      })
      return h('table', { style: TABLE },
        h('thead', null, h('tr', null,
          h('th', { style: { ...TH, width: '30%' } }, '线程'),
          h('th', { style: { ...TH, width: '14%' } }, '角色'),
          h('th', { style: { ...TH, width: '14%' } }, '状态'),
          h('th', { style: { ...TH, width: '16%' } }, '任务'),
          h('th', { style: { ...TH, width: '26%', textAlign: 'right' } }, '开始 / 操作'))),
        h('tbody', null, rows))
    }

    function RawDetails({ project }) {
      const lines = [
        ['项目 ID', project.projectId],
        ['任务', textNum((project.counts || {}).tasks ? project.counts.tasks.total : 0)],
        ['账本线程', textNum((project.counts || {}).threads)],
        ['最近任务', (project.taskIds || []).slice(-1)[0] || '—'],
        ...(project.history === undefined ? [] : [
          ['历史会话', textNum(project.history.threads)],
          ['子会话', textNum(project.history.childThreads)],
        ]),
      ]
      return h('details', { style: { marginTop: '10px' } },
        h('summary', { style: { cursor: 'pointer', fontSize: '11px', color: C.text3 } }, '原始标识'),
        h('div', { style: { display: 'grid', gridTemplateColumns: '120px 1fr', gap: '4px 12px', marginTop: '8px', fontSize: '11px', fontFamily: C.mono, color: C.text3 } },
          lines.map(([key, value]) => h('div', { key }, h('span', { style: { opacity: 0.7 } }, key), h('span', { style: { marginLeft: '8px', color: C.text2 } }, String(value))))))
    }

    // ── 项目行 + 展开详情 ────────────────────────────────────────────────
    function HistorySessions({ sessions }) {
      const rows = sessions.map((session) => {
        const last = relativeTime(session.lastActiveAt)
        return h('tr', { key: session.sessionId },
          h('td', { style: { ...TD, color: C.text } },
            h('div', { style: { fontSize: '12px' } }, session.title || '无标题会话'),
            h('div', { style: { fontSize: '11px', color: C.text3, fontFamily: C.mono } }, shortId(session.sessionId))),
          h('td', { style: TD }, h(Pill, { tone: session.archived ? C.text3 : (session.live ? C.business : C.idle) },
            session.archived ? '已归档' : (session.live ? '可能进行中' : '已停止'))),
          h('td', { style: { ...TD, textAlign: 'right' } }, h('span', { title: last.title, style: { fontSize: '12px', color: C.text3 } }, last.text)))
      })
      return h('table', { style: TABLE },
        h('thead', null, h('tr', null,
          h('th', { style: { ...TH, width: '58%' } }, '会话'),
          h('th', { style: { ...TH, width: '22%' } }, '推断状态'),
          h('th', { style: { ...TH, width: '20%', textAlign: 'right' } }, '最后活动'))),
        h('tbody', null, rows))
    }

    function ProjectDetail({ project, busy, onAccept, openSession }) {
      const tasks = Array.isArray(project.openTasks) ? project.openTasks : []
      const pending = Array.isArray(project.pendingHuman) ? project.pendingHuman : []
      const threads = Array.isArray(project.threads) ? project.threads : []
      const blocks = []
      if (tasks.length > 0) {
        blocks.push(h('div', { key: 'tasks', style: { marginTop: blocks.length > 0 ? '14px' : '4px' } },
          h('div', { style: { fontSize: '12px', fontWeight: 500, marginBottom: '2px' } }, `未完成任务 ${tasks.length}`),
          h(TaskTable, { tasks, threads })))
      }
      blocks.push(h('div', { key: 'threads', style: { marginTop: '14px' } },
        h('div', { style: { fontSize: '12px', fontWeight: 500, marginBottom: '2px' } }, `账本线程 ${threads.length}`),
        threads.length === 0
          ? h('div', { style: { fontSize: '12px', color: C.text3, padding: '10px 0', borderBottom: `1px solid ${C.line}` } }, '还没有由 Superbot 派出的执行线程')
          : h(ThreadTable, { threads, onOpenSession: openSession })))
      const historySessions = project.history && Array.isArray(project.history.sessions) ? project.history.sessions : []
      if (historySessions.length > 0) {
        blocks.push(h('div', { key: 'history', style: { marginTop: '14px' } },
          h('div', { style: { fontSize: '12px', fontWeight: 500, marginBottom: '2px' } }, `历史会话 ${historySessions.length}`),
          h('div', { style: { fontSize: '11px', color: C.text3, margin: '0 0 4px' } }, '来自 DSH 已有线程（只读扫描，不是 Superbot 的账本线程）'),
          h(HistorySessions, { sessions: historySessions })))
      }
      blocks.push(h(RawDetails, { key: 'raw', project }))
      return h('div', { style: { padding: '12px 10px 16px 24px' } }, blocks)
    }

    function ProjectRow({ project, history, expanded, onToggle, busy, onAccept, openSession }) {
      const headline = projectHeadline(project)
      const progress = projectProgress(project)
      const counts = project.counts || {}
      const runs = counts.runs || {}
      const tasks = counts.tasks || {}
      const last = relativeTime(project.lastActivityAt || (history && history.lastActiveAt))
      const inReview = numeric(tasks.in_review)
      return h(React.Fragment, null,
        h('tr', {
          className: 'sb-row',
          onClick: onToggle,
          style: { cursor: 'pointer' },
        },
        h('td', { style: { ...TD, color: C.text, width: '33%' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
            h('span', { style: { fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, project.title || project.projectId),
            project.inInventory === false ? h(Pill, { tone: C.text3 }, '历史') : null,
            project.confirmedStatus === null || project.confirmedStatus === undefined
              ? h(Pill, { tone: C.warn }, '未确认')
              : project.confirmedStatus === 'active'
                ? null
                : h(Pill, { tone: project.confirmedStatus === 'paused' ? C.warn : C.text3 }, project.confirmedStatus === 'paused' ? '已挂起' : project.confirmedStatus === 'archived' ? '已归档' : '状态未知')),
          h('div', { style: { fontSize: '11px', color: C.text3, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, project.path || project.projectId)),
        h('td', { style: { ...TD, width: '14%' } }, h(Pill, { tone: headline.tone, strong: numeric(headline.label.split(' ').pop()) > 0 || headline.label === '进行中' }, headline.label)),
        h('td', { className: 'sb-col-progress', style: { width: '18%', ...TD } },
          progress.total === 0
            ? h('span', { style: { fontSize: '12px', color: C.text3 } }, '—')
            : h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h(Bar, { percent: progress.percent, tone: numeric(tasks.in_review) > 0 ? C.warn : C.business }),
              h('span', { style: { fontSize: '12px', color: C.text2, fontVariantNumeric: 'tabular-nums' } }, `${textNum(progress.done)}/${textNum(progress.total)}`)),
          inReview > 0 ? h('div', { style: { marginTop: '2px' } }, h(Meta, null, `待验收 ${inReview}`)) : null),
        h('td', { className: 'sb-col-threads', style: { width: '13%', ...TD } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' }, title: '活跃线程 / 总线程' },
            h(Dot, { tone: numeric(runs.active) > 0 ? C.business : C.lineStrong }),
            h('span', { style: { fontSize: '12px', color: C.text2, fontVariantNumeric: 'tabular-nums' } }, `${textNum(runs.active)}`),
            h('span', { style: { fontSize: '11px', color: C.text3 } }, `/ ${textNum((counts || {}).threads)}`)),
          history && numeric(history.threads) > 0
            ? h('div', { style: { marginTop: '2px' } }, h(Meta, null, `历史 ${textNum(history.threads)} 会话`))
            : null),
        h('td', { className: 'sb-col-recent', style: { width: '20%', ...TD } }, h('span', { title: last.title, style: { fontSize: '12px', color: C.text3 } }, last.text)),
        h('td', { style: { width: '3%', ...TD, textAlign: 'right' } },
          h('button', {
            type: 'button',
            className: 'sb-row-toggle',
            'data-sb-row-toggle': 'true',
            'aria-expanded': expanded === true,
            'aria-label': `${expanded ? '收起' : '展开'}项目 ${project.title || project.projectId}`,
            onClick: (event) => { event.stopPropagation(); onToggle() },
          }, expanded ? '▾' : '▸'))),
        expanded ? h('tr', null, h('td', { colSpan: 6, style: { padding: 0, borderBottom: `1px solid ${C.line}`, background: C.surface } },
          h(ProjectDetail, { project: { ...project, history }, busy, onAccept, openSession }))) : null)
    }

    function ViewToolbar({ view, onChange }) {
      const chip = (item) => h('button', {
        key: item.value,
        type: 'button',
        className: 'sb-btn',
        'aria-pressed': view.filter === item.value,
        onClick: () => onChange({ ...view, filter: item.value }),
        style: {
          height: '24px', padding: '0 9px', borderRadius: '6px', fontSize: '11px', cursor: 'pointer',
          color: view.filter === item.value ? C.text : C.text2,
          background: view.filter === item.value ? C.surface2 : 'transparent',
          border: `1px solid ${view.filter === item.value ? C.lineStrong : 'transparent'}`,
        },
      }, item.label)
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' } },
        h('div', { role: 'group', 'aria-label': '项目筛选', style: { display: 'flex', alignItems: 'center', gap: '2px' } }, FILTERS.map(chip)),
        h('select', {
          value: view.sort,
          'aria-label': '排序',
          onChange: (event) => onChange({ ...view, sort: event.target.value }),
          style: { height: '24px', padding: '0 6px', fontSize: '11px', borderRadius: '6px', border: `1px solid ${C.control}`, background: C.bg, color: C.text2 },
        }, SORTS.map((item) => h('option', { key: item.value, value: item.value }, item.label))),
        h('input', {
          type: 'search', value: view.q, placeholder: '搜索项目', 'aria-label': '搜索项目',
          onChange: (event) => onChange({ ...view, q: event.target.value }),
          style: { width: '150px', height: '24px', padding: '0 8px', fontSize: '11px', borderRadius: '6px', border: `1px solid ${C.control}`, background: C.bg, color: C.text },
        }),
        view.filter !== 'all' || view.q !== ''
          ? h('button', {
            type: 'button', className: 'sb-btn',
            onClick: () => onChange({ ...loadSavedView(), filter: 'all', sort: view.sort, q: '' }),
            style: { height: '24px', padding: '0 8px', borderRadius: '6px', fontSize: '11px', cursor: 'pointer', color: C.text3, background: 'transparent', border: 'none' },
          }, '清除')
          : null)
    }

    const FIELD_INPUT = {
      width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: '12px', lineHeight: '18px',
      borderRadius: '6px', border: `1px solid ${C.control}`, background: C.bg, color: C.text, fontFamily: 'inherit',
    }
    const FIELD_LABEL = { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: C.text3, flex: '1 1 220px', minWidth: 0 }

    function FormField({ label, hint, children, wide = false }) {
      return h('label', { style: { ...FIELD_LABEL, ...(wide ? { flexBasis: '100%' } : {}) } },
        h('span', null, label),
        children,
        hint === undefined ? null : h('span', { style: { fontSize: '11px', color: C.text3 } }, hint))
    }

    const LADDER_TONE = { ok: C.success, partial: C.warn, missing: C.danger, later: C.text3 }

    function ComposeCard({ form, onChange, projects, result, busy, error, onCompose, onCopy, onOpenManager, onReset }) {
      const set = (patch) => onChange({ ...form, ...patch })
      const quality = result && result.quality
      const errors = result && Array.isArray(result.errors) ? result.errors : []
      return h('section', {
        'aria-label': '结构化发单',
        className: 'sb-surface',
        style: { marginTop: '22px', padding: '14px 16px' },
      },
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
        h('h2', { style: { margin: 0, fontSize: '13px', fontWeight: 600 } }, '结构化发单'),
        h(Pill, { tone: C.business }, '高要求前置'),
        h('span', { style: { fontSize: '11px', color: C.text3 } }, '意图 → 阶梯校验 → 高能量 brief（只生成草稿，不写账本）'),
        h('span', { style: { flex: '1 1 auto' } }),
        h(Button, { size: 'sm', onClick: onReset, title: '清空表单' }, '清空')),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 14px', marginTop: '12px' } },
        h(FormField, { label: '意图（必填）', hint: '写清现状 / 目标 / 为什么现在做；避免「优化一下」这类模糊词', wide: true },
          h('textarea', { value: form.intent, rows: 4, style: { ...FIELD_INPUT, resize: 'vertical' }, placeholder: '例：登录页在移动端点击提交后没有反馈，需要 300ms 内出现 loading，失败时显示可读错误。', onChange: (event) => set({ intent: event.target.value }) })),
        h(FormField, { label: '项目（必填）' },
          h('select', { value: form.projectId, style: FIELD_INPUT, onChange: (event) => set({ projectId: event.target.value }) },
            h('option', { value: '' }, '选择项目'), projects.map((project) => h('option', { key: project.projectId, value: project.projectId }, project.title || project.projectId)))),
        h(FormField, { label: '任务标题（可选）' },
          h('input', { value: form.title, style: FIELD_INPUT, placeholder: '默认取意图第一句', onChange: (event) => set({ title: event.target.value }) })),
        h(FormField, { label: '背景（可选）', wide: true },
          h('textarea', { value: form.background, rows: 2, style: { ...FIELD_INPUT, resize: 'vertical' }, placeholder: '现状、约束的来源、用户反馈等', onChange: (event) => set({ background: event.target.value }) })),
        h(FormField, { label: '验收标准（一行一条）', hint: '至少一条行为验收；能机器验证的写进下一栏' },
          h('textarea', { value: form.acceptance, rows: 2, style: { ...FIELD_INPUT, resize: 'vertical' }, placeholder: '点击提交 300ms 内出现 loading', onChange: (event) => set({ acceptance: event.target.value }) })),
        h(FormField, { label: '机器验收命令（一行一条）', hint: '白名单模板：node --test / npm test / pnpm test / pytest / cargo test / go test / make check' },
          h('textarea', { value: form.acceptanceCommands, rows: 2, style: { ...FIELD_INPUT, fontFamily: C.mono, resize: 'vertical' }, onChange: (event) => set({ acceptanceCommands: event.target.value }) })),
        h(FormField, { label: '约束 / 范围（一行一条）' },
          h('textarea', { value: form.constraints, rows: 2, style: { ...FIELD_INPUT, resize: 'vertical' }, placeholder: '只改 src/login/*，不改后端接口', onChange: (event) => set({ constraints: event.target.value }) })),
        h(FormField, { label: '非目标（一行一条）', hint: '写清不做什么，防止顺手重构/扩范围' },
          h('textarea', { value: form.nonGoals, rows: 2, style: { ...FIELD_INPUT, resize: 'vertical' }, placeholder: '不重做登录页视觉 / 不改依赖', onChange: (event) => set({ nonGoals: event.target.value }) })),
        h(FormField, { label: '风险' },
          h('select', { value: form.risk, style: FIELD_INPUT, onChange: (event) => set({ risk: event.target.value }) },
            h('option', { value: 'low' }, 'low（满足条件可自动验收）'),
            h('option', { value: 'high' }, 'high（强制人工验收）'))),
        h(FormField, { label: '变更属性' },
          h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', height: '30px', fontSize: '11px', color: C.text2 } },
            h('label', { style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } },
              h('input', { type: 'checkbox', checked: form.reversible === true, onChange: (event) => set({ reversible: event.target.checked }) }), '可逆'),
            h('label', { style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } },
              h('input', { type: 'checkbox', checked: form.externalSideEffects === true, onChange: (event) => set({ externalSideEffects: event.target.checked }) }), '有外部副作用')))),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', flexWrap: 'wrap' } },
        h(Button, { primary: true, disabled: busy || form.intent.trim() === '', onClick: onCompose }, busy ? '生成中…' : '生成结构化 brief'),
        error ? h('span', { role: 'alert', style: { fontSize: '11px', color: C.errorText } }, error) : null,
        quality ? h('span', { style: { fontSize: '11px', color: C.text2 } },
          `评分 ${quality.score} / ${quality.grade}`,
          errors.length === 0 && quality.missing.length === 0 && quality.warnings.length === 0 ? ' · 结构完整' : '',
          quality.missing.length > 0 ? ` · 缺 ${quality.missing.length} 项` : '',
          quality.warnings.length > 0 ? ` · ${quality.warnings.length} 条提醒` : '',
          result && result.tokenEstimate ? ` · brief ≈ ${result.tokenEstimate.brief} tok` : '',
          result && result.autoAccept ? ` · 自动验收候选：${result.autoAccept.eligible ? '是' : `否（${result.autoAccept.reasons.join('、')}）`}` : '') : null,
        result && result.ok ? h('span', { style: { flex: '1 1 auto' } }) : null,
        result && result.ok ? h(Button, { primary: true, onClick: onOpenManager }, '打开调度会话') : null),
      errors.length > 0 ? h('div', { role: 'alert', style: { marginTop: '8px' } },
        h('div', { style: { fontSize: '11px', color: C.errorText, marginBottom: '2px' } }, '阻断项（修好才能生成可发送的 brief）'),
        h('ul', { style: { margin: 0, paddingLeft: '18px', fontSize: '11px', color: C.errorText } }, errors.map((row, index) => h('li', { key: index }, `${row.field}: ${row.message}`)))) : null,
      quality && (quality.missing.length > 0 || quality.warnings.length > 0) ? h('div', { style: { marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '4px 16px', fontSize: '11px', color: C.text3 } },
        quality.missing.length > 0 ? h('span', null, `缺：${quality.missing.join('、')}`) : null,
        quality.warnings.map((row, index) => h('span', { key: index }, `· ${row}`))) : null,
      result && Array.isArray(result.ladder) ? h('div', { style: { display: 'flex', gap: '10px', marginTop: '12px', flexWrap: 'wrap' } },
        result.ladder.map((row) => h('span', { key: row.level, style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: C.text2 } },
          h(Dot, { tone: LADDER_TONE[row.status] || C.text3 }), `${row.level} ${row.title}`, row.status === 'later' ? '' : ''))) : null,
      result && result.brief ? h('div', { style: { marginTop: '12px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
          h('span', { style: { fontSize: '12px', fontWeight: 500 } }, 'Worker brief 预览'),
          h(Button, { size: 'sm', onClick: () => onCopy(result.brief, 'brief') }, '复制 brief'),
          h(Button, { size: 'sm', onClick: () => onCopy(result.managerPrompt, 'Manager 提示词') }, '复制 Manager 提示词')),
        h('pre', { style: { margin: 0, padding: '10px 12px', maxHeight: '240px', overflow: 'auto', background: C.bg, border: `1px solid ${C.line}`, borderRadius: '6px', fontSize: '11px', lineHeight: '16px', fontFamily: C.mono, whiteSpace: 'pre-wrap' } }, result.brief),
        h('details', { style: { marginTop: '8px' } },
          h('summary', { style: { cursor: 'pointer', fontSize: '11px', color: C.text3 } }, 'Manager 提示词（发送给调度会话）'),
          h('pre', { style: { margin: '8px 0 0', padding: '10px 12px', maxHeight: '220px', overflow: 'auto', background: C.bg, border: `1px solid ${C.line}`, borderRadius: '6px', fontSize: '11px', lineHeight: '16px', fontFamily: C.mono, whiteSpace: 'pre-wrap' } }, result.managerPrompt))) : null)
    }

    function ManagerMenu({ sessions, projects, onOpenSession, onNewSession, onClose }) {
      return h('div', {
        style: { marginTop: '10px', padding: '10px 12px', border: `1px solid ${C.lineStrong}`, borderRadius: '8px', background: C.surface, display: 'flex', flexDirection: 'column', gap: '8px' },
      },
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
        h('span', { style: { fontSize: '11px', color: C.text3 } }, sessions.length > 0 ? '继续最近的调度会话' : '还没有 Manager 会话'),
        h('span', { style: { flex: '1 1 auto' } }),
        h('button', { type: 'button', onClick: onClose, style: { background: 'none', border: 'none', color: C.text3, cursor: 'pointer', fontSize: '11px' } }, '关闭')),
      sessions.length > 0 ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
        sessions.map((session) => h('button', {
          key: session.sessionId,
          type: 'button',
          className: 'sb-btn',
          onClick: () => onOpenSession(session.sessionId),
          style: { textAlign: 'left', background: 'transparent', border: 'none', padding: '4px 6px', borderRadius: '6px', cursor: 'pointer', color: C.text, fontSize: '12px' },
        }, `${session.title || '无标题会话'} · ${session.projectTitle || ''}`))) : null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
        h('span', { style: { fontSize: '11px', color: C.text3 } }, '新建：'),
        projects.map((project) => h(Button, { key: project.projectId, size: 'sm', onClick: () => onNewSession(project.projectId) }, project.title || project.projectId))))
    }

    const PHASE_LANES = [
      { phase: 'needs-you', label: '需你决定', hint: '只能你拍板：验收/驳回', tone: C.warn },
      { phase: 'stalled', label: '疑似卡住', hint: '子线程运行超过 30 分钟无收尾', tone: C.danger },
      { phase: 'rework', label: '返工', hint: '自动审计未通过，等待新一次尝试', tone: C.danger },
      { phase: 'auditing', label: '审计中', hint: 'verifier 正在跑验收命令/等待裁决', tone: C.business },
      { phase: 'executing', label: '执行中', hint: 'worker 正在做', tone: C.business },
      { phase: 'queued', label: '待开始', hint: '已计划，尚未派工', tone: C.idle },
      { phase: 'done', label: '已完成', hint: '已通过验收', tone: C.success },
    ]

    function TaskCard({ task, onSelect, onOpenSession }) {
      const phase = PHASE_LANES.find((lane) => lane.phase === task.phase) ?? PHASE_LANES[4]
      const audit = task.audit ?? {}
      const verdict = audit.latestVerdict
      return h('div', {
        role: 'button',
        tabIndex: 0,
        className: 'sb-card',
        'aria-label': `任务 ${task.title || task.taskId}`,
        onClick: () => onSelect(task),
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(task) } },
        style: { border: `1px solid ${C.line}`, borderLeft: `3px solid ${phase.tone}`, padding: '10px 12px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '6px' },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' } },
        h(Pill, { tone: phase.tone }, task.phaseLabel || phase.label),
        h(Meta, null, task.projectTitle || task.projectId),
        h('span', { style: { flex: '1 1 auto' } }),
        task.priority === 'high' ? h(Pill, { tone: C.warn }, '高') : null),
      h('div', { style: { fontSize: '13px', fontWeight: 500, lineHeight: '19px', color: C.text } }, task.title || task.taskId),
      h('div', { style: { fontSize: '11px', color: C.text3, lineHeight: '17px' } }, task.phaseReason),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11px', color: C.text3, flexWrap: 'wrap' } },
        h('span', null, `审计证据 ${textNum(audit.evidencePassed)}/${textNum(audit.evidenceTotal)}`),
        verdict ? h('span', null, `结论 ${verdict}`) : null,
        audit.attempts > 1 ? h('span', null, `第 ${textNum(audit.attempts)} 次尝试`) : null,
        h('span', null, relativeTime(task.updatedAt).text),
        task.thread && typeof task.thread.childId === 'string' && typeof onOpenSession === 'function'
          ? h('button', {
            type: 'button',
            onClick: (event) => { event.stopPropagation(); onOpenSession(task.thread.childId) },
            style: { marginLeft: 'auto', background: 'none', border: 'none', color: C.text3, cursor: 'pointer', fontSize: '11px', padding: 0 },
          }, '打开线程 ›')
          : null))
    }

    function TaskBoard({ tasks, onSelect, onOpenSession }) {
      if (tasks.length === 0) return h(EmptyLine, null, '还没有任务：在对话里告诉 Superbot 要做什么，它会创建并派工。')
      const counts = new Map()
      for (const task of tasks) counts.set(task.phase, (counts.get(task.phase) ?? 0) + 1)
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '14px' } },
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          PHASE_LANES.map((lane) => h('span', {
            key: lane.phase,
            style: { display: 'inline-flex', alignItems: 'center', gap: '6px', height: '26px', padding: '0 10px', borderRadius: '6px', border: `1px solid ${C.line}`, background: C.surface, fontSize: '11px', color: C.text2 },
          }, h(Dot, { tone: lane.tone }), lane.label, h('span', { style: { color: C.text3 } }, textNum(counts.get(lane.phase) ?? 0))))),
        PHASE_LANES.map((lane) => {
          const items = tasks.filter((task) => task.phase === lane.phase)
          if (items.length === 0) return null
          return h('section', { key: lane.phase, 'aria-label': lane.label, className: 'sb-surface', style: { padding: '10px 12px' } },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '6px' } },
              h(Dot, { tone: lane.tone }),
              h('span', { style: { fontSize: '12px', fontWeight: 600 } }, lane.label),
              h('span', { style: { fontSize: '11px', color: C.text3 } }, textNum(items.length)),
              h('span', { style: { fontSize: '11px', color: C.text3 } }, lane.hint)),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '8px' } },
              items.map((task) => h(TaskCard, { key: task.taskId, task, onSelect, onOpenSession }))))
        }))
    }

    function TaskDrawer({ task, onClose, onOpenSession, onAccept, onReject, openManager, httpHumanAllowed, busy }) {
      const [chain, setChain] = useState(null)
      useEffect(() => {
        let alive = true
        setChain(null)
        if (!task || typeof task.taskId !== 'string') return undefined
        fetch(`/superbot/task?id=${encodeURIComponent(task.taskId)}`, { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : null))
          .then((body) => { if (alive) setChain(body) })
          .catch(() => { if (alive) setChain({ error: true }) })
        return () => { alive = false }
      }, [task && task.taskId])
      if (!task) return null
      const status = TASK_STATUS[task.status] || { label: task.status, tone: C.idle }
      const rows = [
        ['项目', task.projectTitle || task.projectId],
        ['阶段', task.phaseLabel || task.phase || status.label],
        ['当前原因', task.phaseReason || '—'],
        ['下一步', task.phaseNext || '—'],
        ['自动审计', `证据 ${textNum(task.audit?.evidencePassed)}/${textNum(task.audit?.evidenceTotal)}${task.audit?.latestVerdict ? ` · 结论 ${task.audit.latestVerdict}` : ''}${task.audit?.attempts > 1 ? ` · 第 ${textNum(task.audit.attempts)} 次尝试` : ''}`],
        ['状态', status.label],
        ['优先级', PRIORITY_LABEL[task.priority] || task.priority || '—'],
        ['执行者', task.owner ? `已分配（${shortId(task.owner)}）` : '待认领'],
        ['机器验收命令', task.acceptanceCommands > 0 ? `${textNum(task.acceptanceCommands)} 条` : '无'],
        ['创建', absoluteTime(task.createdAt)],
        ['更新', absoluteTime(task.updatedAt)],
      ]
      return h('div', { style: { position: 'fixed', inset: 0, zIndex: 60, display: 'flex', justifyContent: 'flex-end' }, role: 'dialog', 'aria-label': '任务详情' },
        h('div', { onClick: onClose, className: 'sb-mask', style: { flex: '1 1 auto' } }),
        h('aside', { className: 'sb-drawer', style: { width: 'min(440px, 92vw)', height: '100%', overflowY: 'auto', padding: '18px 20px' } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
            h('h2', { style: { margin: 0, fontSize: '15px', fontWeight: 600, flex: '1 1 auto' } }, task.title || task.taskId),
            h('button', { type: 'button', onClick: onClose, style: { background: 'none', border: 'none', color: C.text3, fontSize: '15px', cursor: 'pointer' } }, '×')),
          h('div', { style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
            h(Pill, { tone: status.tone }, status.label),
            task.priority === 'high' ? h(Pill, { tone: C.warn }, '高优先级') : null,
            task.thread ? h(Pill, { tone: C.business }, presetLabel(task.thread.agentPreset)) : null),
          h('div', { style: { display: 'grid', gridTemplateColumns: '96px 1fr', gap: '6px 12px', marginTop: '14px', fontSize: '12px' } },
            rows.flatMap(([label, value]) => [h('span', { key: `${label}-k`, style: { color: C.text3 } }, label), h('span', { key: `${label}-v`, style: { color: C.text2 } }, String(value))])),
          task.thread
            ? h('div', { style: { marginTop: '14px', padding: '10px 12px', border: `1px solid ${C.line}`, borderRadius: '8px' } },
              h('div', { style: { fontSize: '12px', fontWeight: 500 } }, '关联调度线程'),
              h('div', { style: { marginTop: '4px', fontSize: '11px', color: C.text3 } },
                `${presetLabel(task.thread.agentPreset)} · ${RUN_STATUS[task.thread.status] || task.thread.status || '—'} · ${absoluteTime(task.thread.startedAt)}`),
              typeof task.thread.childId === 'string' && typeof onOpenSession === 'function'
                ? h(Button, { size: 'sm', onClick: () => onOpenSession(task.thread.childId) }, '打开执行会话')
                : null)
            : null,
          chain && !chain.error
            ? h('div', { style: { marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '12px' } },
              h('div', null,
                h('div', { style: { fontSize: '12px', fontWeight: 500, marginBottom: '6px' } }, '执行记录'),
                (chain.runs ?? []).length === 0 ? h(Meta, null, '还没有运行记录')
                  : (chain.runs ?? []).map((run) => h('div', { key: run.runId, style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: C.text2, padding: '4px 0' } },
                    h(Pill, { tone: run.agentPreset === 'superbot-verifier' ? C.business : C.success }, presetLabel(run.agentPreset)),
                    h('span', null, RUN_STATUS[run.status] || run.status || '—'),
                    h('span', { style: { flex: '1 1 auto' } }),
                    h(Time, { iso: run.startedAt }),
                    typeof run.childId === 'string' && typeof onOpenSession === 'function'
                      ? h(Button, { size: 'sm', onClick: () => onOpenSession(run.childId) }, '打开')
                      : null))),
              h('div', null,
                h('div', { style: { fontSize: '12px', fontWeight: 500, marginBottom: '6px' } }, '审计证据'),
                (chain.evidence ?? []).length === 0 ? h(Meta, null, '还没有机器证据')
                  : (chain.evidence ?? []).map((row) => h('div', { key: row.index, style: { fontSize: '11px', color: C.text2, padding: '4px 0', fontFamily: C.mono } },
                    `${row.passed === true ? '✓' : '✗'} ${row.command} → exit ${String(row.exitCode)}${row.executionMode ? ` · ${row.executionMode}` : ''}`))),
              h('div', null,
                h('div', { style: { fontSize: '12px', fontWeight: 500, marginBottom: '6px' } }, '决定记录'),
                (chain.reviews ?? []).length === 0 ? h(Meta, null, '还没有决定')
                  : (chain.reviews ?? []).map((review) => h('div', { key: review.reviewId, style: { fontSize: '11px', color: C.text2, padding: '4px 0' } },
                    h(Pill, { tone: review.source === 'human' ? C.warn : review.source === 'verifier' ? C.business : C.success }, review.source),
                    h('span', { style: { marginLeft: '6px' } }, review.verdict),
                    review.notes ? h('span', { style: { marginLeft: '6px', color: C.text3 } }, String(review.notes).slice(0, 120)) : null))))
            : null,
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '18px' } },
            typeof openManager === 'function' ? h(Button, { onClick: () => openManager(task.projectId) }, '在对话中继续') : null,
            task.status === 'in_review'
              ? (httpHumanAllowed
                ? h(Button, { primary: true, disabled: busy === task.taskId, onClick: () => onAccept(task.taskId) }, busy === task.taskId ? '提交中…' : '通过验收')
                : h(Pill, { tone: C.warn }, '需在对话中批准'))
              : null,
            task.status === 'in_review' && httpHumanAllowed && typeof onReject === 'function'
              ? h(Button, { disabled: busy === task.taskId, onClick: () => onReject(task.taskId, '老板退回') }, '退回返工')
              : null)))
    }

    function KindIcon({ kind = 'task', size = 12 }) {
      const color = 'currentColor'
      if (kind === 'verifier') return h('svg', { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: color, strokeWidth: 1.3, 'aria-hidden': 'true' }, h('path', { d: 'M6 1.5 10.5 6 6 10.5 1.5 6Z' }))
      if (kind === 'worker') return h('svg', { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: color, strokeWidth: 1.3, 'aria-hidden': 'true' }, h('circle', { cx: 6, cy: 6, r: 3.5 }))
      return h('svg', { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: color, strokeWidth: 1.3, 'aria-hidden': 'true' }, h('rect', { x: 2.5, y: 2.5, width: 7, height: 7, rx: 1.5 }))
    }

    const MAP_ROW = 30
    const MAP_LABEL = 220

    function ThreadMap({ projects, tasks, onOpenSession, model, onSelect }) {
      const [windowHours, setWindowHours] = useState(() => {
        try {
          const saved = Number(localStorage.getItem('superbot:panel:mapWindow') ?? '')
          return saved === 24 || saved === 168 || saved === 720 ? saved : 168
        } catch {
          return 168
        }
      })
      const taskById = new Map((Array.isArray(tasks) ? tasks : []).map((task) => [task.taskId, task]))
      let lanes = []
      if (model && Array.isArray(model.lanes)) {
        lanes = model.lanes.map((lane) => ({
          title: lane.title,
          rows: (Array.isArray(lane.items) ? lane.items : []).map((item) => {
            if (item.kind === 'thread') {
              return {
                kind: 'thread',
                thread: {
                  runId: item.key, childId: item.childId, agentPreset: item.preset, label: item.label,
                  status: item.state === 'running' ? 'running' : item.state, active: item.state === 'running', taskId: item.taskId,
                },
                task: item.taskId === null ? undefined : taskById.get(item.taskId),
                start: item.t0, end: item.t1,
              }
            }
            return {
              kind: 'task',
              task: taskById.get(item.taskId) ?? { taskId: item.taskId, title: item.taskId, phase: 'queued', phaseLabel: '待开始', updatedAt: item.t1 === null ? undefined : new Date(item.t1).toISOString() },
              start: item.t0, end: item.t1,
            }
          }),
        })).filter((lane) => lane.rows.length > 0)
      } else {
        lanes = []
        for (const project of Array.isArray(projects) ? projects : []) {
          const lane = { title: project.title || project.projectId, rows: [] }
          for (const thread of Array.isArray(project.threads) ? project.threads : []) {
            const start = Date.parse(String(thread.startedAt ?? ''))
            if (!Number.isFinite(start)) continue
            const end = Date.parse(String(thread.finishedAt ?? ''))
            lane.rows.push({ kind: 'thread', thread, task: taskById.get(thread.taskId), start, end: Number.isFinite(end) ? end : null })
          }
          for (const task of Array.isArray(tasks) ? tasks : []) {
            if (task.projectId !== project.projectId) continue
            const start = Date.parse(String(task.createdAt ?? task.updatedAt ?? ''))
            if (!Number.isFinite(start)) continue
            const end = Date.parse(String(task.updatedAt ?? ''))
            lane.rows.push({ kind: 'task', task, start, end: Number.isFinite(end) ? end : null })
          }
          lane.rows.sort((a, b) => a.start - b.start)
          if (lane.rows.length > 0) lanes.push(lane)
        }
      }
      if (lanes.length === 0) return h(EmptyLine, null, '还没有工作：在对话里让 Superbot 派工后，这里会出现任务/线程时间条。')
      const now = Date.now()
      const starts = lanes.flatMap((lane) => lane.rows.map((row) => row.start))
      const windowStart = Math.max(Math.min(...starts), now - windowHours * 3_600_000)
      const range = Math.max(now - windowStart, 60_000) * 1.04
      const pct = (time) => Math.max(0, Math.min(100, ((time - windowStart) / range) * 100))
      const fmt = (ms) => new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      const TICKS = [0, 0.25, 0.5, 0.75, 1]

      const tickRow = h('div', { style: { display: 'grid', gridTemplateColumns: `${MAP_LABEL}px 1fr`, alignItems: 'center', height: '24px' } },
        h('div', { style: { fontSize: '11px', color: C.text3, paddingRight: '8px', textAlign: 'right' } }, '时间轴'),
        h('div', { style: { position: 'relative', height: '100%' } },
          TICKS.map((ratio) => h('span', {
            key: ratio,
            style: { position: 'absolute', left: `${ratio * 100}%`, transform: 'translateX(-50%)', fontSize: '11px', color: C.text3, whiteSpace: 'nowrap', top: '4px', padding: '0 2px', background: C.bg },
          }, fmt(windowStart + range * ratio)))))

      const legend = h('div', { style: { display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', padding: '8px 0 6px' } },
        [['任务', C.text3, 'bar'], ['执行中', C.business, 'bar'], ['成功', C.success, 'bar'], ['失败/阻塞', C.danger, 'bar'], ['进行中·无结束', C.business, 'bar']].map(([label, tone]) => h('span', { key: label, style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: C.text3 } },
          h('span', { style: { width: '12px', height: '6px', borderRadius: '3px', background: tone, display: 'inline-block' } }), label)),
        h('span', { style: { flex: '1 1 auto' } }),
        [[24, '24h'], [168, '7d'], [720, '30d']].map(([hours, label]) => h('button', {
          key: hours, type: 'button', onClick: () => { setWindowHours(hours); try { localStorage.setItem('superbot:panel:mapWindow', String(hours)) } catch { /* best effort */ } },
          style: { height: '22px', padding: '0 8px', borderRadius: '6px', border: `1px solid ${windowHours === hours ? C.lineStrong : 'transparent'}`, background: windowHours === hours ? C.surface2 : 'transparent', color: windowHours === hours ? C.text : C.text3, fontSize: '11px', cursor: 'pointer' },
        }, label)))

      return h('div', { style: { border: `1px solid ${C.line}`, borderRadius: '10px', padding: '10px 12px', background: C.surface, overflowX: 'auto' } },
        legend,
        tickRow,
        lanes.map((lane) => h('div', { key: lane.title, style: { marginTop: '4px' } },
          h('div', { style: { height: '24px', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: C.text2, borderBottom: `1px solid ${C.line}` } },
            h(Dot, { tone: C.business }), h('span', { style: { fontWeight: 600 } }, lane.title), h(Meta, null, `${textNum(lane.rows.length)} 项`)),
          lane.rows.map((row) => {
            const running = row.end === null
            const end = running ? now : row.end
            const startPct = pct(row.start)
            const endPct = pct(end)
            const width = Math.max(0.8, endPct - startPct)
            const isTask = row.kind === 'task'
            const task = row.task
            const status = !isTask && (row.thread.active === true ? 'running' : row.thread.status)
            const tone = isTask
              ? (task.phase === 'needs-you' ? C.warn : task.phase === 'rework' || task.phase === 'stalled' ? C.danger : task.phase === 'done' ? C.success : task.phase === 'queued' ? C.text3 : C.business)
              : status === 'running' ? C.business : status === 'succeeded' ? C.success : status === 'failed' ? C.danger : C.text3
            const label = isTask ? `◻ ${task.title || task.taskId}` : `${row.thread.agentPreset === 'superbot-verifier' ? '◇' : '◉'} ${row.thread.label || row.task?.title || row.thread.taskId || row.thread.runId}`
            const title = isTask
              ? `${task.phaseLabel || task.phase} · ${relativeTime(task.updatedAt).text} · ${task.phaseReason || ''}`
              : `${fmt(row.start)} → ${running ? '进行中' : fmt(end)} · ${row.thread.runId}`
            return h('div', { key: `${row.kind}:${isTask ? task.taskId : row.thread.runId}`, style: { display: 'grid', gridTemplateColumns: `${MAP_LABEL}px 1fr`, height: `${MAP_ROW}px`, alignItems: 'center', borderBottom: `1px solid ${C.line}` } },
              h('button', {
                type: 'button',
                onClick: () => { if (!isTask && typeof onOpenSession === 'function' && typeof row.thread.childId === 'string') onOpenSession(row.thread.childId) },
                title,
                style: { textAlign: 'left', background: 'none', border: 'none', padding: '0 8px 0 0', cursor: isTask ? 'default' : 'pointer', color: C.text2, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', minWidth: 0 } },
                h(KindIcon, { kind: isTask ? 'task' : (row.thread.agentPreset === 'superbot-verifier' ? 'verifier' : 'worker') }),
                h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label))),
              h('div', { style: { position: 'relative', height: '100%' } },
                TICKS.map((ratio) => h('span', { key: ratio, 'aria-hidden': 'true', style: { position: 'absolute', left: `${ratio * 100}%`, top: 0, bottom: 0, width: '1px', background: ratio === 0 || ratio === 1 ? C.lineStrong : C.line } })),
                h('span', { 'aria-hidden': 'true', style: { position: 'absolute', left: `${pct(now)}%`, top: 0, bottom: 0, width: '2px', background: C.business, opacity: 0.7 } }),
                h('span', {
                  title,
                  onClick: isTask ? (typeof onSelect === 'function' ? () => onSelect(row.task) : undefined) : (typeof onOpenSession === 'function' && typeof row.thread.childId === 'string' ? () => onOpenSession(row.thread.childId) : undefined),
                  style: { position: 'absolute', left: `${startPct}%`, top: isTask ? '12px' : '9px', width: `${width}%`, height: isTask ? '3px' : '10px', borderRadius: isTask ? '2px' : '5px', background: tone, opacity: isTask ? 0.8 : (row.thread?.active === true ? 0.95 : 0.65), minWidth: '5px', cursor: (isTask && typeof onSelect === 'function') || (!isTask && typeof onOpenSession === 'function') ? 'pointer' : 'default' },
                },
                isTask ? h('span', { style: { position: 'absolute', left: `${endPct}%`, top: '10px', width: '7px', height: '7px', borderRadius: '50%', background: tone, transform: 'translateX(-50%)' } }) : null)))
          }))))
    }

    // ── 主面板 ───────────────────────────────────────────────────────────
    function SuperbotOverview(props) {
      const openSession = props && props.openSession
      const openManagerSession = props && props.openManagerSession
      const inSettings = typeof (props && props.close) === 'function'
      const [state, setState] = useState({ status: 'loading', data: null, error: '' })
      const [onboarding, setOnboarding] = useState(null)
      const [onboardingError, setOnboardingError] = useState('')
      const [httpHumanAllowed, setHttpHumanAllowed] = useState(true)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [actionError, setActionError] = useState('')
      const [expanded, setExpanded] = useState({})
      const [view, setView] = useState(loadSavedView)
      const [composerOpen, setComposerOpen] = useState(false)
      const [tab, setTab] = useState('tasks')
      const [selectedTaskId, setSelectedTaskId] = useState('')
      const [historySelected, setHistorySelected] = useState({})
      const [heroText, setHeroText] = useState('')
      const [composeForm, setComposeForm] = useState(loadComposeDraft)
      const [composeResult, setComposeResult] = useState(null)
      const [composeBusy, setComposeBusy] = useState(false)
      const [composerError, setComposerError] = useState('')
      const [managerMenu, setManagerMenu] = useState(false)
      useEffect(() => { ensurePanelCss() }, [])
      useEffect(() => {
        try {
          if (typeof localStorage !== 'undefined') localStorage.setItem(VIEW_KEY, JSON.stringify(view))
        } catch { /* view persistence is best effort */ }
      }, [view])
      useEffect(() => {
        try {
          if (typeof localStorage !== 'undefined') localStorage.setItem(COMPOSE_KEY, JSON.stringify(composeForm))
        } catch { /* draft persistence is best effort */ }
      }, [composeForm])

      const load = useCallback(async (silent, currentView) => {
        if (!silent) setState((current) => ({ ...current, status: current.data === null ? 'loading' : 'refreshing' }))
        try {
          const response = await fetch(overviewUrl(currentView || loadSavedView()), { cache: 'no-store' })
          const text = await response.text()
          let body
          try {
            body = text === '' ? {} : JSON.parse(text)
          } catch {
            throw new Error(`总览接口不可用（HTTP ${response.status}）：宿主未加载 /superbot/overview`)
          }
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
          setState({ status: 'ready', data: body, error: '' })
          if (silent) return
          try {
            const onboardingResponse = await fetch(ONBOARDING_URL, { cache: 'no-store' })
            if (!onboardingResponse.ok) throw new Error(`HTTP ${onboardingResponse.status}`)
            setOnboarding(await onboardingResponse.json())
            setOnboardingError('')
          } catch (cause) {
            setOnboarding(null)
            setOnboardingError(String(cause && cause.message ? cause.message : cause))
          }
          try {
            const statusResponse = await fetch('/superbot/status', { cache: 'no-store' })
            if (statusResponse.ok) {
              const status = await statusResponse.json()
              if (status && status.policy && typeof status.policy.httpHumanActions === 'boolean') {
                setHttpHumanAllowed(status.policy.httpHumanActions)
              }
            }
          } catch { /* status is advisory; accept will surface a 403 anyway */ }
        } catch (cause) {
          setState((current) => ({ ...current, status: current.data === null ? 'error' : 'ready', error: String(cause && cause.message ? cause.message : cause) }))
        }
      }, [])

      useEffect(() => { void load(false, view) }, [load, view])
      useEffect(() => {
        if (POLL_MS <= 0) return undefined
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') void load(true, view)
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [load, view])

      const accept = useCallback(async (taskId, note) => {
        setBusy(taskId)
        setNotice('')
        setActionError('')
        try {
          const payload = note === undefined ? { taskId } : { taskId, note }
          const response = await fetch(ACCEPT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
          setNotice(`已通过验收：${taskId}`)
          setBusy('')
          await load(true, view)
        } catch (cause) {
          setBusy('')
          setActionError(`验收失败：${String(cause && cause.message ? cause.message : cause)}`)
        }
      }, [load])

      const rejectTask = useCallback(async (taskId, note) => {
        setBusy(taskId)
        setNotice('')
        setActionError('')
        try {
          const response = await fetch(REJECT_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(note === undefined ? { taskId } : { taskId, note }) })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
          setNotice(`已退回返工：${taskId}`)
          setBusy('')
          await load(true, view)
        } catch (cause) {
          setBusy('')
          setActionError(`退回失败：${String(cause && cause.message ? cause.message : cause)}`)
        }
      }, [load, view])

      const importHistory = useCallback(async () => {
        const items = Object.keys(historySelected).filter((key) => historySelected[key]).map((key) => JSON.parse(key))
        if (items.length === 0) return
        setBusy('history-import')
        setNotice('')
        setActionError('')
        try {
          const response = await fetch('/superbot/history/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
          setNotice(`已导入 ${body.count} 条历史工作为任务（只读调查、人工验收）`)
          setHistorySelected({})
          setBusy('')
          await load(true, view)
        } catch (cause) {
          setBusy('')
          setActionError(`历史导入失败：${String(cause && cause.message ? cause.message : cause)}`)
        }
      }, [historySelected, load, view])

      const confirmOnboarding = useCallback(async (projects) => {
        setBusy('onboarding')
        setNotice('')
        setActionError('')
        try {
          const response = await fetch(ONBOARDING_CONFIRM_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projects }) })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
          setNotice('接入盘点已确认')
          setBusy('')
          await load(true, view)
        } catch (cause) {
          setBusy('')
          setActionError(`确认失败：${String(cause && cause.message ? cause.message : cause)}`)
        }
      }, [load])

      const openManager = useCallback(async (projectId, prompt) => {
        setManagerMenu(false)
        setNotice('')
        setActionError('')
        if (typeof openManagerSession !== 'function') {
          setActionError('当前宿主不支持打开会话（uiWorkspace 未注入）；请在左侧 New Session 选择 Superbot Manager preset')
          return
        }
        if (typeof projectId !== 'string' || projectId === '') {
          setActionError('没有可用项目：先在 DSH 里创建 workspace')
          return
        }
        setNotice('正在打开调度会话…')
        try {
          const hasPrompt = typeof prompt === 'string' && prompt.trim() !== ''
          await openManagerSession(projectId, hasPrompt ? prompt : undefined)
          setNotice(hasPrompt
            ? '已打开调度会话：提示词已尝试填入输入框（若已有草稿则保留原草稿），检查后发送即可'
            : '已打开调度会话：在对话框里用自然语言下需求，或先点「结构化发单」生成 brief')
        } catch (cause) {
          setNotice('')
          setActionError(`打开调度会话失败：${String(cause && cause.message ? cause.message : cause)}`)
        }
      }, [openManagerSession])

      const compose = useCallback(async () => {
        setComposeBusy(true)
        setComposerError('')
        setComposeResult(null)
        try {
          const response = await fetch(COMPOSE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(composeForm),
          })
          const body = await response.json().catch(() => ({}))
          if (typeof body !== 'object' || body === null) throw new Error(`HTTP ${response.status}`)
          setComposeResult(body)
          if (!response.ok && !Array.isArray(body.errors)) throw new Error(body.error || `HTTP ${response.status}`)
        } catch (cause) {
          setComposerError(`生成失败：${String(cause && cause.message ? cause.message : cause)}`)
        } finally {
          setComposeBusy(false)
        }
      }, [composeForm])

      const composeQuiet = useCallback(async () => {
        try {
          const response = await fetch(COMPOSE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(composeForm),
          })
          const body = await response.json().catch(() => ({}))
          if (typeof body === 'object' && body !== null) setComposeResult(body)
        } catch {
          // live preview is advisory; the explicit button reports errors
        }
      }, [composeForm])

      useEffect(() => {
        if (!composerOpen) return undefined
        const timer = setTimeout(() => { void composeQuiet() }, 800)
        return () => clearTimeout(timer)
      }, [composerOpen, composeQuiet])

      const copyText = useCallback(async (text, label) => {
        if (typeof text !== 'string' || text === '') return
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
            await navigator.clipboard.writeText(text)
            setNotice(`已复制${label}`)
            return
          }
        } catch { /* fall through */ }
        setNotice('复制失败：浏览器未授权剪贴板，请手动选择文本复制')
      }, [])

      const sendHero = useCallback(async () => {
        const text = heroText.trim()
        if (text === '') return
        const projectId = composeForm.projectId || projects[0]?.projectId || ''
        await openManager(projectId, text)
        setHeroText('')
      }, [heroText, composeForm.projectId, openManager])

      const data = state.data
      const overview = data || { projects: [] }
      const projects = Array.isArray(overview.projects) ? overview.projects : []
      const totals = overviewTotals(overview)
      const attention = Array.isArray(overview.attention)
        ? overview.attention.map((item) => ({ item, project: { title: item.projectTitle, projectId: item.projectId } }))
        : (() => {
          const rows = []
          for (const project of projects) {
            for (const item of Array.isArray(project.pendingHuman) ? project.pendingHuman : []) rows.push({ item, project })
          }
          return rows
        })()
      const historyByProject = {}
      if (onboarding && Array.isArray(onboarding.projects)) {
        for (const row of onboarding.projects) {
          if (!row || typeof row.projectId !== 'string') continue
          historyByProject[row.projectId] = {
            threads: numeric((row.counts || {}).threads),
            childThreads: numeric((row.counts || {}).childThreads),
            liveThreads: numeric((row.counts || {}).liveThreads),
            lastActiveAt: row.lastActiveAt,
            sessions: Array.isArray(row.threads) ? row.threads.slice(0, 20) : [],
          }
        }
      }
      const managerSessions = []
      if (onboarding && Array.isArray(onboarding.projects)) {
        for (const row of onboarding.projects) {
          for (const thread of Array.isArray(row.threads) ? row.threads : []) {
            if (thread.agentPreset !== 'superbot-manager' || typeof thread.sessionId !== 'string') continue
            managerSessions.push({
              sessionId: thread.sessionId,
              title: thread.title,
              lastActiveAt: thread.lastActiveAt,
              projectTitle: row.title || row.projectId,
            })
          }
        }
        managerSessions.sort((left, right) => String(right.lastActiveAt ?? '').localeCompare(String(left.lastActiveAt ?? '')))
      }

      const historyThreads = []
      if (onboarding && Array.isArray(onboarding.projects)) {
        for (const row of onboarding.projects) {
          for (const thread of Array.isArray(row.threads) ? row.threads : []) {
            if (thread.archived === true) continue
            if (typeof thread.title !== 'string' && thread.digest === null) continue
            historyThreads.push({
              ...thread,
              projectId: row.projectId,
              projectTitle: row.title || row.projectId,
              proposedStatus: row.proposedStatus,
            })
          }
        }
        historyThreads.sort((left, right) => String(right.lastActiveAt ?? '').localeCompare(String(left.lastActiveAt ?? '')))
      }

      const activeThreadRows = []
      const threadByTask = new Map()
      for (const project of projects) {
        for (const thread of Array.isArray(project.threads) ? project.threads : []) {
          if (typeof thread.taskId === 'string' && !threadByTask.has(thread.taskId)) threadByTask.set(thread.taskId, thread)
          if (thread.active === true || thread.status === 'running') {
            activeThreadRows.push({ ...thread, projectTitle: project.title || project.projectId })
          }
        }
      }

      const updated = overview.generatedAt ? relativeTime(overview.generatedAt) : { text: '—', title: '' }
      const loading = state.status === 'loading'
      const refreshing = state.status === 'refreshing'
      const pageStyle = inSettings
        ? { height: 'auto', minHeight: 0, color: C.text, fontSize: '13px', background: 'transparent' }
        : { height: '100%', overflowY: 'auto', boxSizing: 'border-box', color: C.text, fontSize: '13px', background: C.bg }

      const summaryItem = (value, label, tone) => h('span', { key: label, style: { display: 'inline-flex', alignItems: 'baseline', gap: '6px' } },
        h('span', { style: { fontSize: '15px', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: tone || C.text } }, value),
        h('span', { style: { fontSize: '11px', color: C.text3 } }, label))

      const onProjectTableKeyDown = (event) => {
        if (!['j', 'k', 'ArrowDown', 'ArrowUp'].includes(event.key)) return
        const target = event.currentTarget
        if (target === null || typeof target.querySelectorAll !== 'function') return
        const buttons = Array.from(target.querySelectorAll('[data-sb-row-toggle]'))
        if (buttons.length === 0) return
        event.preventDefault()
        const index = buttons.indexOf(document.activeElement)
        const down = event.key === 'j' || event.key === 'ArrowDown'
        let next
        if (index === -1) next = down ? buttons[0] : buttons[buttons.length - 1]
        else next = down ? buttons[Math.min(buttons.length - 1, index + 1)] : buttons[Math.max(0, index - 1)]
        next.focus()
      }

      const isolationRows = [
        h('span', { key: 'k1' }, '账本目录'),
        h('span', { key: 'v1', style: { fontFamily: C.mono, color: C.text2, wordBreak: 'break-all' } }, (overview.controlPlane && overview.controlPlane.stateDir) || '—'),
        h('span', { key: 'k2' }, '事件数'),
        h('span', { key: 'v2', style: { color: C.text2 } }, textNum(overview.controlPlane && overview.controlPlane.events)),
        h('span', { key: 'k3' }, '项目边界'),
        h('span', { key: 'v3' }, (overview.isolation && overview.isolation.projectBoundary) || 'task.projectId = DSH workspaceId'),
        h('span', { key: 'k4' }, '线程边界'),
        h('span', { key: 'v4' }, (overview.isolation && overview.isolation.threadBoundary) || '一个 run = 一个子会话'),
      ]
      const footer = h('footer', { style: { marginTop: '30px', paddingTop: '12px', borderTop: `1px solid ${C.line}` } },
        h('details', null,
          h('summary', { style: { cursor: 'pointer', fontSize: '11px', color: C.text3 } }, '账本与隔离边界'),
          h('div', { style: { marginTop: '8px', display: 'grid', gridTemplateColumns: '120px 1fr', gap: '4px 12px', fontSize: '11px', color: C.text3 } }, isolationRows)))

      return h('div', { style: pageStyle, role: 'region', 'aria-label': PANEL_LABEL },
        h('div', { className: 'sb-page-inner', style: { maxWidth: '1120px', margin: '0 auto', padding: inSettings ? '0 0 24px' : '0 28px 56px' } },
          // ① 头部 + 概要
          h('header', {
            className: inSettings ? undefined : 'sb-topbar',
            style: inSettings
              ? { padding: '4px 0 10px', borderBottom: `1px solid ${C.line}` }
              : { padding: '18px 0 12px', borderBottom: `1px solid ${C.line}` },
          },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px' } },
            h('h1', { style: { margin: 0, fontSize: '20px', fontWeight: 600, letterSpacing: '-0.01em' } }, 'Superbot'),
            h('span', { style: { fontSize: '11px', color: C.text3 } }, '工程经理控制台'),
            h('span', { style: { flex: '1 1 auto' } }),
            inSettings ? null : h(Button, {
              primary: true,
              disabled: projects.length === 0,
              title: managerSessions.length > 0 ? `继续最近的调度会话：${managerSessions[0].title || managerSessions[0].sessionId}` : '新建 Manager 调度会话',
              onClick: () => {
                if (managerSessions.length > 0) {
                  if (typeof openSession === 'function') openSession(managerSessions[0].sessionId)
                  else void openManager(projects[0]?.projectId)
                } else {
                  void openManager(projects[0]?.projectId)
                }
              },
            }, '调度对话'),
            inSettings ? null : h(Button, { onClick: () => setManagerMenu((current) => !current), title: '选择最近会话或按项目新建' }, '▾'),
            h('span', { style: { fontSize: '11px', color: C.text3 }, title: updated.title }, `更新于 ${updated.text}`),
            h(Button, { onClick: () => { void load(false, view) }, disabled: loading || refreshing, title: '重新读取总览与接入盘点' },
              loading ? '读取中…' : refreshing ? '刷新中…' : '刷新')),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px', flexWrap: 'wrap' } },
            ['needs-you', 'rework', 'auditing', 'executing', 'stalled', 'done'].map((phase) => {
              const count = (Array.isArray(overview.tasks) ? overview.tasks : []).filter((task) => task.phase === phase).length
              const meta = {
                'needs-you': [C.warn, 'verify'], rework: [C.danger, 'tasks'], auditing: [C.business, 'tasks'],
                executing: [C.business, 'tasks'], stalled: [C.danger, 'tasks'], done: [C.success, 'tasks'],
              }[phase] ?? [C.text3, 'tasks']
              return h('button', {
                key: phase,
                type: 'button',
                className: 'sb-chip',
                onClick: () => setTab(meta[1]),
                style: { borderLeft: `3px solid ${meta[0]}` },
              }, phase === 'needs-you' ? '需你决定' : phase === 'rework' ? '返工' : phase === 'auditing' ? '审计中' : phase === 'executing' ? '执行中' : phase === 'stalled' ? '疑似卡住' : '已完成',
                h('span', { style: { fontWeight: 600 } }, textNum(count)))
            }))),
          !inSettings && managerSessions.length === 0
            ? h('div', { style: { marginTop: '6px', fontSize: '11px', color: C.text3 } },
              '对话入口：点「调度对话」新建 Manager 会话；也可在左侧 New Session 里选择 Superbot Manager preset。本页负责总览与验收，具体工作对话在会话里进行。')
            : null,
          managerMenu
            ? h(ManagerMenu, {
              sessions: managerSessions.slice(0, 5),
              projects,
              onOpenSession: (sessionId) => { setManagerMenu(false); if (typeof openSession === 'function') openSession(sessionId) },
              onNewSession: (projectId) => { void openManager(projectId) },
              onClose: () => setManagerMenu(false),
            })
            : null,
          // ② 首屏提示/错误
          state.error ? h('div', { role: 'alert', style: { margin: '12px 0 0', padding: '8px 10px', fontSize: '12px', color: C.errorText, border: `1px solid ${C.lineStrong}`, borderRadius: '6px' } }, `读取失败：${state.error}`) : null,
          notice ? h('div', { role: 'status', style: { margin: '12px 0 0', fontSize: '12px', color: C.text2 } }, notice) : null,
          actionError ? h('div', { role: 'alert', style: { margin: '12px 0 0', fontSize: '12px', color: C.errorText } }, actionError) : null,
          // ③ 首次接入盘点（读取失败必须可见，否则 dispatch gate 会卡死且用户不知道）
          onboardingError
            ? h('div', { role: 'alert', style: { margin: '16px 0 4px', padding: '10px 12px', border: `1px solid ${C.lineStrong}`, borderRadius: '8px', background: C.surface, fontSize: '12px', color: C.errorText } },
              `接入盘点读取失败：${onboardingError}。调度会被「首次接入确认」挡住；请点刷新重试。`)
            : null,
          h(OnboardingBlock, { inventory: onboarding, busy, onConfirm: confirmOnboarding, httpHumanAllowed }),
          // ④ 对话入口：使用 DSH 原生会话（完整输入/流式/工具），面板不再自造聊天框
          !inSettings
            ? h('section', { 'aria-label': 'Superbot 对话', style: { marginTop: '22px', padding: '14px 16px', border: `1px solid ${C.lineStrong}`, borderRadius: '10px', background: C.surface } },
              h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
                h('h2', { style: { margin: 0, fontSize: '13px', fontWeight: 600 } }, '对话在原生会话来里进行'),
                h(Meta, null, '这里的输入框/流式/工具调用都由 DSH 会话提供；Superbot 在对话背后调度 worker/verifier 线程')),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
                h(Button, {
                  primary: true,
                  onClick: () => {
                    if (managerSessions.length > 0 && typeof openSession === 'function') openSession(managerSessions[0].sessionId)
                    else void openManager(projects[0]?.projectId, INIT_PROMPT)
                  },
                }, '进入 Superbot 对话'),
                h(Button, { onClick: () => { void openManager(projects[0]?.projectId, INIT_PROMPT) }, disabled: projects.length === 0 }, '新建对话'),
                h(Meta, null, managerSessions.length > 0 ? `最近：${managerSessions[0].title || managerSessions[0].sessionId}` : '还没有 Manager 会话')),
              managerSessions.length > 1
                ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '8px' } },
                  managerSessions.slice(0, 4).map((session) => h('button', {
                    key: session.sessionId,
                    type: 'button',
                    className: 'sb-btn',
                    onClick: () => { if (typeof openSession === 'function') openSession(session.sessionId) },
                    style: { textAlign: 'left', background: 'transparent', border: 'none', padding: '3px 4px', borderRadius: '6px', cursor: 'pointer', color: C.text2, fontSize: '11px' },
                  }, `${session.title || '无标题会话'} · ${session.projectTitle || ''}`)))
                : null)
            : null,
          // ⑤ Tabs：任务列表（默认）/ 验收 / 项目 / 高级
          !inSettings
            ? h('div', { role: 'tablist', 'aria-label': '视图', style: { display: 'flex', alignItems: 'center', gap: '4px', marginTop: '18px', borderBottom: `1px solid ${C.line}` } },
              [
                ['tasks', `任务${typeof overview.taskCount === 'number' ? ` ${textNum(overview.taskCount)}` : ''}`],
                ['dispatch', `调度中${activeThreadRows.length > 0 ? ` ${textNum(activeThreadRows.length)}` : ''}`],
                ['map', '地图'],
                ['history', `历史${historyThreads.length > 0 ? ` ${textNum(historyThreads.length)}` : ''}`],
                ['verify', `待你验收${attention.length > 0 ? ` ${textNum(attention.length)}` : ''}`],
                ['projects', `项目 ${textNum(totals.projects)}`],
                ['advanced', '高级'],
              ].map(([value, label]) => h('button', {
                key: value,
                type: 'button',
                role: 'tab',
                'aria-selected': tab === value,
                onClick: () => setTab(value),
                className: `sb-tab${tab === value ? ' sb-tab-active' : ''}`,
                style: { height: '30px', padding: '0 10px', borderBottom: `2px solid ${tab === value ? C.business : 'transparent'}` },
              }, label)))
            : null,
          // ⑥ 任务：按项目泳道 + 状态列（飞书式任务板），点卡片看详情
          !inSettings && tab === 'tasks' ? h(TaskBoard, {
            tasks: Array.isArray(overview.tasks) ? overview.tasks : [],
            onSelect: (task) => setSelectedTaskId(task.taskId),
            onOpenSession: openSession,
          }) : null,
          selectedTaskId !== ''
            ? h(TaskDrawer, {
              task: (overview.tasks ?? []).find((task) => task.taskId === selectedTaskId),
              onClose: () => setSelectedTaskId(''),
              onOpenSession: openSession,
              onAccept: (taskId) => { void accept(taskId) },
              onReject: (taskId, note) => { void rejectTask(taskId, note) },
              openManager,
              httpHumanAllowed,
              busy,
            })
            : null,
          // ⑥a 地图：线程甘特图，看到每条线程在哪、跑了多久
          !inSettings && tab === 'map' ? h('section', { 'aria-label': '线程地图', style: { marginTop: '16px' } },
            h(SectionHeading, { title: '线程地图', hint: '每条 worker/verifier 线程一条时间条；点条打开会话' }),
            h(ThreadMap, { projects, tasks: overview.tasks ?? [], onOpenSession: openSession, model: overview.timeline, onSelect: (task) => setSelectedTaskId(task.taskId) }))
            : null,
          // ⑥a 历史工作：旧 DSH 线程的 digest，可勾选批量导入或逐条交给 Superbot
          !inSettings && tab === 'history'
            ? h('section', { 'aria-label': '历史工作', style: { marginTop: '18px' } },
              h(SectionHeading, {
                title: '历史工作',
                count: textNum(historyThreads.length),
                hint: historyThreads.length > 0 ? '勾选后「导入为历史工作项」：落成只读调查任务，人工验收后才继续' : '首次接入盘点后，这里会出现你已有的线程摘要',
                action: httpHumanAllowed && Object.values(historySelected).some(Boolean)
                  ? h(Button, { primary: true, disabled: busy === 'history-import', onClick: () => { void importHistory() } }, `导入选中（${textNum(Object.values(historySelected).filter(Boolean).length)}）`)
                  : undefined,
              }),
              historyThreads.length === 0
                ? h(EmptyLine, null, '没有扫描到可展示的历史线程。')
                : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
                  historyThreads.map((thread) => {
                    const selectedKey = JSON.stringify({ projectId: thread.projectId, sessionId: thread.sessionId, title: thread.title ?? undefined, intent: thread.digest?.intent ?? undefined })
                    return h('div', { key: `${thread.projectId}:${thread.sessionId}`, style: { border: `1px solid ${C.line}`, borderRadius: '8px', background: C.surface, padding: '10px 12px' } },
                      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
                        httpHumanAllowed ? h('input', { type: 'checkbox', checked: historySelected[selectedKey] === true, 'aria-label': '选择导入', onChange: (event) => setHistorySelected((current) => ({ ...current, [selectedKey]: event.target.checked })) }) : null,
                        h('span', { style: { fontSize: '13px', fontWeight: 500 } }, thread.title || thread.digest?.intent?.slice(0, 50) || '无标题会话'),
                        h(Meta, null, thread.projectTitle),
                        h(Pill, { tone: thread.proposedStatus === 'active' ? C.business : C.text3 }, thread.proposedStatus === 'active' ? '进行中' : thread.proposedStatus === 'paused' ? '已挂起' : '历史'),
                        h(Meta, null, relativeTime(thread.lastActiveAt).text)),
                      thread.digest?.intent
                        ? h('div', { style: { marginTop: '4px', fontSize: '11px', color: C.text3, lineHeight: '17px' } }, thread.digest.intent.slice(0, 260), thread.digest.intent.length > 260 ? '…' : '')
                        : null,
                      h('div', { style: { marginTop: '6px', display: 'flex', gap: '8px' } },
                        h(Button, {
                          size: 'sm',
                          onClick: () => {
                            const summary = thread.digest?.intent ?? thread.title ?? '（无摘要）'
                            void openManager(thread.projectId, `请分析我过去的一条历史工作，并给我接管建议（先不要自动派工）：\n- 项目：${thread.projectTitle}\n- 线程：${thread.title || '无标题'}\n- 最后活动：${absoluteTime(thread.lastActiveAt)}\n- 当时的意图摘要：${summary}\n请判断：它现在是什么状态、有没有留下结果、是否需要我确认后转成 Superbot 任务继续推进。`)
                          },
                        }, '交给 Superbot 分析'),
                        typeof thread.sessionId === 'string' && typeof openSession === 'function'
                          ? h(Button, { size: 'sm', onClick: () => openSession(thread.sessionId) }, '打开原会话')
                          : null))
                  })))
            : null,
          // ⑥b 调度中：Superbot 背后派出的 worker/verifier 线程（中间层可视化）
          !inSettings && tab === 'dispatch' ? h('section', { 'aria-label': '调度中', style: { marginTop: '18px' } },
            h(SectionHeading, { title: '调度中', count: textNum(activeThreadRows.length), hint: activeThreadRows.length > 0 ? '这些是 Manager 会话派出的子线程；点「打开会话」查看真实执行' : undefined }),
            activeThreadRows.length === 0
              ? h(EmptyLine, null, loading ? '正在读取…' : '当前没有运行中的子线程。Superbot 会在 Manager 对话里派 worker/verifier，派工后这里实时出现。')
              : h('table', { style: TABLE },
                h('thead', null, h('tr', null,
                  h('th', { style: { ...TH, width: '12%' } }, '角色'),
                  h('th', { style: { ...TH, width: '20%' } }, '线程'),
                  h('th', { style: { ...TH, width: '26%' } }, '任务'),
                  h('th', { style: { ...TH, width: '16%' } }, '项目'),
                  h('th', { style: { ...TH, width: '14%' } }, '开始'),
                  h('th', { style: { ...TH, width: '12%', textAlign: 'right' } }, '操作'))),
                h('tbody', null, activeThreadRows.map((thread) => h('tr', { key: thread.runId, className: 'sb-row' },
                  h('td', { style: TD }, h(Pill, { tone: thread.agentPreset === 'superbot-verifier' ? C.business : C.success }, presetLabel(thread.agentPreset))),
                  h('td', { style: { ...TD, color: C.text } }, threadTitle(thread)),
                  h('td', { style: { ...TD, fontSize: '12px', color: C.text2 } }, (overview.tasks ?? []).find((task) => task.taskId === thread.taskId)?.title || thread.taskId || '—'),
                  h('td', { style: { ...TD, fontSize: '12px', color: C.text3 } }, thread.projectTitle),
                  h('td', { style: TD }, h(Time, { iso: thread.startedAt })),
                  h('td', { style: { ...TD, textAlign: 'right' } },
                    typeof thread.childId === 'string' && typeof openSession === 'function'
                      ? h(Button, { size: 'sm', onClick: () => openSession(thread.childId) }, '打开会话')
                      : null))))))
            : null,
          // ⑦ 待你处理
          !inSettings && tab === 'verify' ? h('section', { 'aria-label': '待你处理', style: { marginTop: '22px' } },
            h(SectionHeading, {
              title: '待你处理',
              count: attention.length > 0 ? textNum(attention.length) : undefined,
              hint: attention.length === 0 ? '没有需要你决定或验收的事项' : '按项目聚合，处理完自动消失',
            }),
            attention.length === 0
              ? null
              : attention.map(({ item, project }) => h(AttentionRow, {
                key: `${project.projectId}:${item.taskId}`,
                item,
                projectTitle: project.title,
                busy,
                onAccept: (taskId, note) => { void accept(taskId, note) },
                openSession,
                httpHumanAllowed,
              }))) : null,
          // ⑤ 结构化发单（只生成草稿，不写账本）
          !inSettings && tab === 'advanced'
            ? h(ComposeCard, {
              form: composeForm,
              onChange: setComposeForm,
              projects,
              result: composeResult,
              busy: composeBusy,
              error: composerError,
              onCompose: () => { void compose() },
              onCopy: (text, label) => { void copyText(text, label) },
              onOpenManager: () => { void openManager(composeForm.projectId, composeResult && composeResult.managerPrompt) },
              onReset: () => {
                setComposeForm({ ...EMPTY_COMPOSE, projectId: composeForm.projectId })
                setComposeResult(null)
                setComposerError('')
              },
            })
            : null,
          // ⑥ 项目组合
          !inSettings && tab === 'projects' ? h('section', { 'aria-label': '项目', style: { marginTop: '26px' }, onKeyDown: onProjectTableKeyDown },
            h(SectionHeading, {
              title: '项目',
              count: (overview.view && overview.view.matchedProjects !== undefined && overview.view.matchedProjects !== overview.view.totalProjects)
                ? `${textNum(overview.view.matchedProjects)} / ${textNum(overview.view.totalProjects)}`
                : textNum(projects.length),
              hint: projects.length > 0 ? '点行或 J/K 切换 · Enter 展开 · 视图自动记住' : undefined,
              action: h(ViewToolbar, { view, onChange: setView }),
            }),
            projects.length === 0
              ? h(EmptyLine, null, loading
                ? '正在读取总览…'
                : (view.filter !== 'all' || view.q !== '')
                  ? '没有匹配的项目：换个筛选条件，或点「清除」'
                  : '还没有项目：在 DSH 里新建一个 workspace 后刷新')
              : h('table', { style: TABLE },
                h('thead', null, h('tr', null,
                  h('th', { style: { ...TH, width: '33%' } }, '项目'),
                  h('th', { className: 'sb-col-status', style: { ...TH, width: '13%' } }, '状态'),
                  h('th', { style: { ...TH, width: '18%' } }, '任务进度'),
                  h('th', { className: 'sb-col-threads', style: { ...TH, width: '13%' } }, '线程'),
                  h('th', { className: 'sb-col-recent', style: { ...TH, width: '20%' } }, '最近活动'),
                  h('th', { style: { ...TH, width: '3%' } }, ''))),
                h('tbody', null, projects.map((project) => h(ProjectRow, {
                  key: project.projectId,
                  project,
                  expanded: expanded[project.projectId] === true,
                  onToggle: () => setExpanded((current) => ({ ...current, [project.projectId]: current[project.projectId] !== true })),
                  history: historyByProject[project.projectId],
                  busy,
                  onAccept: (taskId, note) => { void accept(taskId, note) },
                  openSession,
                }))))) : null,
          footer))
    }

    // ════════════════════════════════════════════════════════════════════
    // 「Superbot 对话」入口：点击后直接打开原生 Manager 会话，不在面板里造聊天 UI
    // ════════════════════════════════════════════════════════════════════
    function SuperbotChatLauncher(props) {
      const openSession = props && props.openSession
      const openManagerSession = props && props.openManagerSession
      const [state, setState] = useState('opening')
      const [message, setMessage] = useState('')
      useEffect(() => {
        let alive = true
        const run = async () => {
          try {
            let latest
            try {
              const response = await fetch(ONBOARDING_URL, { cache: 'no-store' })
              if (response.ok) {
                const inventory = await response.json()
                for (const project of Array.isArray(inventory.projects) ? inventory.projects : []) {
                  for (const thread of Array.isArray(project.threads) ? project.threads : []) {
                    if (thread.agentPreset !== 'superbot-manager' || typeof thread.sessionId !== 'string') continue
                    if (latest === undefined || String(thread.lastActiveAt ?? '') > String(latest.lastActiveAt ?? '')) latest = thread
                  }
                }
              }
            } catch { /* fall through to create */ }
            if (latest !== undefined && typeof openSession === 'function') {
              if (alive) setState('opened')
              openSession(latest.sessionId)
              return
            }
            let projectId = ''
            try {
              const response = await fetch(OVERVIEW_URL, { cache: 'no-store' })
              if (response.ok) {
                const overview = await response.json()
                projectId = overview?.projects?.[0]?.projectId ?? ''
              }
            } catch { /* handled below */ }
            if (projectId !== '' && typeof openManagerSession === 'function') {
              await openManagerSession(projectId, INIT_PROMPT)
              if (alive) setState('opened')
              return
            }
            if (alive) {
              setState('manual')
              setMessage('还没有 Manager 会话或项目：先在左侧 New Session 选择 Superbot Manager preset。')
            }
          } catch (cause) {
            if (alive) {
              setState('manual')
              setMessage(`打开对话失败：${String(cause && cause.message ? cause.message : cause)}`)
            }
          }
        }
        void run()
        return () => { alive = false }
      }, [openSession, openManagerSession])
      return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: '40px', background: C.bg, color: C.text } },
        h('div', { style: { maxWidth: '420px', textAlign: 'center' } },
          h('div', { style: { fontSize: '15px', fontWeight: 600, marginBottom: '8px' } }, 'Superbot 对话'),
          h('div', { style: { fontSize: '12px', color: C.text2, lineHeight: '19px' } },
            state === 'opening' ? '正在打开最近的 Manager 会话…' : message),
          h('div', { style: { fontSize: '11px', color: C.text3, marginTop: '10px' } },
            '对话、流式输出、工具调用都在原生会话里完成；面板负责总览与验收。')))
    }

    // ════════════════════════════════════════════════════════════════════
    // 侧栏图标
    // ════════════════════════════════════════════════════════════════════
    function SuperbotPanelIcon({ size = 16, active = false }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: active ? 1.6 : 1.2,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
      },
        h('rect', { x: 2, y: 2.5, width: 12, height: 4.5, rx: 1.5 }),
        h('rect', { x: 2, y: 9, width: 5, height: 4.5, rx: 1.5 }),
        h('circle', { cx: 11, cy: 11.25, r: 2 }))
    }

    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'superbot', order: 9, label: () => 'Superbot' },
        SuperbotSettings,
      ))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => PANEL_LABEL },
        SuperbotPanelIcon,
      ))
      ctx.slots.inject('main', () => ctx.slots.register(
        {
          name: 'main',
          key: PANEL_ID,
          inject: () => ({
            openSession: (id) => {
              try {
                return ctx.get('uiWorkspace')?.openSession?.(id)
              } catch {
                return undefined
              }
            },
            openManagerSession: (workspaceId, prompt) => {
              try {
                const service = ctx.get('uiWorkspace')
                if (service === undefined) throw new Error('宿主没有 uiWorkspace 服务（当前入口不支持新建会话）')
                if (typeof service.connectWorkspace !== 'function') {
                  throw new Error('宿主不支持新建会话（缺少 connectWorkspace）')
                }
                // Observable path first: connectWorkspace creates/reuses the blank
                // session and rejects on unknown workspace / Host create failure.
                const created = service.connectWorkspace(workspaceId, { agentPreset: 'superbot-manager' })
                return Promise.resolve(created).then((sessionId) => {
                  if (typeof prompt === 'string' && prompt.trim() !== '' && typeof service.startSession === 'function') {
                    // Reuse the just-created blank and initialize its draft. The
                    // session already exists, so a failure here cannot fake the
                    // "session opened" part; the notice wording stays hedged.
                    service.startSession(workspaceId, { agentPreset: 'superbot-manager', prompt })
                    return sessionId
                  }
                  if (typeof service.openSession === 'function') service.openSession(sessionId)
                  return sessionId
                })
              } catch (cause) {
                return Promise.reject(cause)
              }
            },
          }),
        },
        SuperbotOverview,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    exports.SuperbotSettings = SuperbotSettings
    exports.SuperbotOverview = SuperbotOverview
    exports.SuperbotPanelIcon = SuperbotPanelIcon
    return module.exports
  },
})
