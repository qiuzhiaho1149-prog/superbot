> **产品主设计**：`research/Superbot-完整产品设计-v1.md`（需求→拆解→派工→执行→验收→记忆→汇报→分析）。本文保留为插件实现细节。

# Superbot · DSH 插件设计（重做版）

- 日期：2026-11-03
- 形态纠正：**一个 DSH 插件 bundle，装进现有 DeepSeek Harness**。不是 App、不 fork DSH、不需要 Apple 账号/签名/公证/appId/DMG/独立 daemon。
- 旧设计和旧代码已删除；旧稿归档在 `research/archive/`（仅历史参考）。
- 本文件是当前**唯一有效的插件设计**。

---

## 0. DSH 插件逻辑要点（本设计遵守）

| 机制 | 用法 |
|---|---|
| **bundle** | 包声明 `dsh.bundle.patch`，`cordis.patch.yml` 用 `insert` 把服务/工具/preset 行插进 profile |
| **agent preset** | 用 `@deepseek-ai/dsh-agent-preset` 定义「经理模式」「工人模式」；**agent 能看哪些工具由 preset 的 plugins 列表决定** |
| **工具** | 插件入口 `apply(ctx)` 里用 host 的 `ctx.tools.register(...)`（裸 JSON Schema；**不 import 宿主包**） |
| **客户端** | 包声明 `dsh.client { platform: 'web', inject: [...] }`；client 入口用 `ctx.slots.register` 注册侧栏/主面板/插件设置页 |
| **会话** | host 侧用 `ctx.sessionController`、`ctx.agents`、`session/event`、`ctx.subagents`；角色注入用 `agent.ctx.systemPrompt.section()` |
| **定时** | `ctx.schedule`（宿主已有）；不装系统服务 |
| **数据** | 插件自己的 state 目录（JSONL/SQLite），不写别人的插件目录 |
| **安装** | 现有「插件 → 添加插件」：npm 包名或 GitHub `owner/repo#commit`；本地开发可 `link:` 目录 |
| **测试** | 纯逻辑 `node --test`；插件层用 `dsh --profile web --dump-config` + 无头 `dsh web --no-open` + Playwright；**不启动第二个 App** |

---

## 1. 产品定义

- **名字**：Superbot
- **形态**：`dsh-superbot` 插件 bundle；装进现有 DSH 后出现：
  - 一个「Superbot」模式（agent preset）
  - 一个侧栏入口 + 主面板（任务/决策/待办/团队/记忆/角色）
  - 一个插件设置页（数据目录、默认角色、自动化等级、面板选项）
- **默认角色**：Superbot（复用 dsh-persona-legacy 人设库；可切换阿哲/自定义）
- **工作管理**：本地 Git 优先；GitHub 只做插件发布 + 可选远程备份/PR
- **在线边界**：DSH 运行即插件在线；DSH 关闭即停止；开机自启由用户设置 DSH，插件不装系统服务
- **分发**：GitHub 仓库/npm 包，经 DSH 插件管理器安装；无签名/公证

---

## 2. 插件包结构

```
dsh-superbot/
├─ package.json
│   ├─ name: dsh-superbot
│   ├─ type: module
│   ├─ exports: ".", "./tools", "./client", "./locale/*.json", "./package.json"
│   ├─ dsh.bundle.patch: ./cordis.patch.yml
│   └─ dsh.client: { platform: "web", inject: [client-locale, settings, sidebar, layout, workspace, renderer] }
├─ cordis.patch.yml
│   ├─ insert: superbot-task 服务行（任务引擎/存储/调度/审计）
│   ├─ insert: superbot-character 服务行（角色包/注入/适配器/渲染）
│   ├─ insert: 两个 preset 行（superbot 经理 / superbot-worker 工人）
│   └─ insert: ui-superbot 客户端行
├─ lib/
│   ├─ index.js      Host 入口（服务 + 工具注册 + session/agent 钩子）
│   ├─ tools.js      Manager/Worker 工具定义（preset 按需挂载）
│   ├─ client.js     Client 入口（slots）
│   ├─ task/*.js     任务领域（契约/状态机/调度/审计/存储）
│   └─ character/*.js 角色运行时（角色包/记忆适配/双寄存器渲染）
├─ locale/zh.json, en.json
├─ prompts/manager.md, worker.md
├─ skills/superbot/SKILL.md
└─ README.md
```

**工具可见性**：工具作为模块被 preset 的 `plugins` 列表挂载（经理/工人各自不同），不全局污染用户会话；如需全局行，必须 `ctx.tools.restrict` 收窄。

---

## 3. 两个 preset（模式）

| preset id | 给谁 | 工具 |
|---|---|---|
| `superbot` | 你在 DSH 里对话的经理 | `task_*`、`decision_*`、`todo_*`、`dispatch_worker`、`verify_task`、`character_*`、`memory_query`、`ask_user`、`present`、基础只读/bash |
| `superbot-worker` | 被派出去的工人 | `task_read`、`task_report`、完整工程工具（bash/fs/search/jobs/skills），**不含派发/团队工具**；不注入角色 |

- 经理默认不写代码；工人不跟用户说话（单声道）。
- 工人通过 `ctx.subagents.startActivation({ cwd, agentPreset: 'superbot-worker', delivery: 'parent' })` 启动；完成通知回经理（或由 host 服务接收后进任务板）。

---

## 4. 宿主服务与工具（Host 侧）

### 4.1 服务

| 行 id | 职责 |
|---|---|
| `superbot-task` | TaskStore（JSONL/后续 SQLite）+ 状态机 + 确定性调度 + 审计 + 查询投影；不依赖模型 |
| `superbot-character` | 角色包注册/读取、前台注入（`agent.ctx.systemPrompt.section()`）、fish/outfit 记忆只读适配、WorkReport 双寄存器渲染 |
| `ui-superbot` | 客户端面板（阶段 P3） |

配置（profile patch 里）：
```yaml
- id: superbot-task
  config:
    stateDir: /Users/<user>/.dsh/state/superbot   # 绝对路径；插件自己写
- id: superbot-character
  config:
    defaultPack: legacy
```

### 4.2 工具（Manager preset 挂载）

| 工具 | 作用 | 输入要点 |
|---|---|---|
| `task_submit` | 把对话里的需求变成 TaskSpec（校验通过才入队） | projectId/kind/priority/title/goal/scope/acceptance/deps/delivery |
| `task_list` / `task_get` | 任务板查询/详情 | view/projectId/status/limit |
| `task_update` | 状态迁移/优先级/备注 | id + transition + reason |
| `dispatch_worker` | 按 task 启动 worker（deterministic 选择 cwd/preset） | taskId |
| `verify_task` | 跑 acceptance gate，决定 review/done/返工 | taskId + evidence |
| `decision_list` / `decision_answer` | 待你决定队列 | id/option/note |
| `todo_create` / `todo_list` / `todo_update` | 待办（你要做的/提醒/等外部） | type/title/due/status |
| `character_get` / `character_switch` | 当前角色/切换（只影响前台注入） | packId |
| `memory_query` | 只读查 fish/outfit 记忆（按场景） | space/query/limit |

Worker preset 工具：`task_read`（读自己的 TaskSpec + 约束）、`task_report`（提交 WorkReport JSON；schema 校验后写任务板/审计）。

### 4.3 关键约束（防止人格污染后台）

- 工具实现里**不读角色包文本**；任务规则/优先级/验收/worker prompt 全部模板化；
- 工人 preset 的 plugins 列表不含 persona 注入；
- 加单测：worker prompt 组装结果不得包含角色包内容；WorkReport 事实由代码校验。

---

## 5. 客户端面板（阶段 P3）

- 注册 slot：`sidebar.panellist`（侧栏入口）+ `main`（主面板）+ `plugins.row.config`（插件设置页）；
- 面板 tabs：**今日 / 任务 / 待你决定 / 待办 / 团队 / 项目 / 归档**；
- 任务卡 + 详情抽屉：进度（步骤 x/y 或阶段 + 最近活动，不伪造百分比）、决策历史、交付事实；
- 决策卡：问题 + 选项 + 后果 + 默认 + 一键回答；
- 待办：与任务严格分开（你要做的 vs Bot 做的）；
- 双寄存器展示：工作结果用 work 卡片（结论/改动/验证/风险/下一步），陪伴用 casual；
- 数据通道：Host 通过 DSH 的 Host webserver 注册管理路由（参考 DSH Host Management API；P0 验证具体 API），同一 loopback + 登录态；**不新开端口/不装服务**。
- 构建：client 入口需要打包（React/TSX → ESM）；开发用小体积构建工具，产物随插件分发（目标插件包 ≤5MB）。

---

## 6. 数据与记忆

| 数据 | 位置 | 说明 |
|---|---|---|
| 任务/决策/待办/审计 | `<stateDir>/tasks.jsonl`、`decisions.jsonl`、`todos.jsonl`、`audit.jsonl`（或 SQLite） | 插件自有；只追加审计；导出/备份 |
| 角色包 | 复用 `~/.dsh/storages/dsh-persona-legacy/personas.json` | 插件只读人设库，角色包引用 persona id |
| Superbot记忆 | `~/.legacy-store/` | **只读适配**（events/diary/身份）；不写、不迁移 |
| 阿哲记忆 | `~/.dsh-outfit/` | **只读适配**（wardrobe/sessions/moments）；不写、不迁移 |
| 工作项目 | 本地 git 仓库 | 任务分支 `agent/t-*`；提交由 worker 做；可选推到远端 |
| 插件设置 | DSH profile patch 里的 config | stateDir/defaultPack/自动等级等 |

**不双写**：旧插件的数据仍归旧插件；新插件只存任务/决策/待办/审计与角色关系摘要。

---

## 7. 安装与测试（严格按插件逻辑）

### 7.1 开发期安装

1. 把 `dsh-superbot/` 放到项目目录；
2. DSH 侧栏「插件 → 添加插件」→ 本地目录（`link:`）→ 启用（参考现有 `dsh-outfit-assistant` 的安装方式）；
3. 改代码后：插件页开关触发 profile 重新组合（热加载），必要时重启 DSH；
4. 卸载走插件页；数据目录保留。

### 7.2 测试分层

| 层 | 方法 | 不做什么 |
|---|---|---|
| 领域逻辑 | `node --test`（零依赖；Node 26 TS 擦除） | 不装 monorepo 依赖 |
| bundle 组合 | `dsh --profile web --dump-config`（隔离 DSH_HOME） | 不启动 GUI |
| Host 集成 | 隔离 DSH_HOME 下 `dsh web --no-open`，curl/HTTP 断言工具与 API | 不启第二个 App |
| 客户端 UI | Playwright 打开无头 web 地址截图/点击 | 不用系统截屏 |
| 桌面安装 | 用户按插件页安装（link/npm/github） | 不构建/不签名 App |

---

## 8. 功能映射（旧设计 → 插件实现）

| 旧设计功能 | 插件实现 | 阶段 |
|---|---|---|
| 角色可切换/人设可编辑 | 复用 legacy 人设库；`superbot-character` 按角色包注入 | P2 |
| Superbot工具/记忆/设置 | 保留 legacy-store 插件不动；`memory_query` 只读适配；面板给入口 | P2 |
| 阿哲衣橱/温度/会话状态 | 保留 dsh-outfit-assistant；只读适配 `~/.dsh-outfit` | P2 |
| 任务面板（今日/任务/待决定/待办/团队/项目/归档） | client `main` 面板 + host 管理 API | P3 |
| 任务进度（步骤/阶段/最近活动） | TaskStore steps + Worker Report + 面板渲染 | P1/P3 |
| 决策（问题/选项/后果/默认） | `decision_*` 工具 + DecisionStore + 面板卡 | P1/P3 |
| 待办（你要做的/提醒/等外部） | `todo_*` 工具 + TodoStore；可接 moments 适配 | P1/P3 |
| 双寄存器汇报 | `superbot-character` 渲染 WorkReport → work/casual | P2 |
| 后台正规/人格隔离 | 纯任务引擎 + worker preset 无 persona + 单测 | P1 |
| 本地 Git 优先 | worker cwd + `agent/t-*` 分支 + 本地提交；可选 remote | P1 |
| GitHub 仅发布/可选远程 | 插件仓库；可选 `git push/PR` 工具或 skill | P4 |
| 全天候 | DSH 运行时在线；schedule 定时；不装 daemon | P2 |
| Superbot默认版 | 默认角色包 legacy + 现有三插件共装说明 | P4 |
| 包体精简 | 插件包 ≤5MB；不打包宿主运行时 | P4 |

---

## 9. 路线（插件版）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0（1–2 天）** | bundle 骨架：package.json + cordis.patch.yml + 一个 hello 服务/工具 + manager preset；`link:` 装进一个隔离 web profile | `dump-config` 出现行；无头 web 里工具可见/可调用；不污染现有会话 |
| **P1（3–5 天）** | 任务引擎（契约/状态机/调度/审计/存储）+ `task_*`/`dispatch_worker`/`task_report` + worker preset（mock 派发） | 一条任务从 TaskSpec → mock worker → WorkReport 闭环；单测通过 |
| **P2（3–5 天）** | 角色运行时：角色包读取/注入、fish/outfit 只读适配、双寄存器渲染、memory_query | 换角色语气变、事实不变；worker prompt 无角色文本 |
| **P3（3–7 天）** | 客户端面板 + 管理 API + 决策/待办卡 + 双寄存器卡片 | 现有 DSH 里完成任务全流程；Playwright 截图 PASS |
| **P4（2–3 天）** | Superbot默认包 + 与三插件共装说明 + GitHub 仓库/npm 分发 | 另一台 DSH 安装成功；卸载回滚干净 |

---

## 10. 需要先验证/待拍板

**P0 前要验证（写代码前）**
1. 插件 bundle 用本地 `link:` 装进 desktop/web profile 的具体可用方式（桌面插件页 vs CLI）；
2. preset 行挂载本包内工具模块的模块解析方式（`dsh-superbot/tools`）；
3. Host 管理 API 的注册方式（Host webserver 路由 / remote namespace）；
4. 客户端 slot 注册与构建产物格式（React 版本/外部化）；
5. `agent.ctx.systemPrompt.section()` 动态注入在 0.2.1-rc.5 的可用性（fish 已用，需在本包验证）。

**待拍板**
1. 插件名：`dsh-superbot` 还是 `dsh-legacy`？
2. 先 P0 骨架（推荐）还是直接 P1 任务引擎？
3. 默认角色包只做Superbot，还是同时阿哲？
4. 客户端面板 P3 是否必须首发，还是先 Host 工具跑通再补？


## 12. 相关插件调研后的修订（2026-11-03，见吸收矩阵 §0）

调研了社区相关插件（taskboard / agent-board / kanban / personal-workbench / task-engine / git-worktree / agent-teams / persona-shell / persona-switcher / memory 系 / sidebar-todo / workflow-map 等）后，对本设计做如下修订：

1. **不复制完整看板**：社区已有成熟看板（5 列/19 工具/拖拽/日历）；我们的差异是角色前台 + 注重“待你决定”的注意力管理 + 现有 fish/outfit 记忆 + 本地 Git 优先。首发面板只做侧栏一个入口 + 任务/决策/待办/团队/进度，不做拖拽看板。
2. **任务模型借 agent-board/taskboard**：`draft→pending→in_progress→verifying→resolved→archived` + blocked；依赖 DAG + 环检测；DoD/验收命令；**验收权只属于人**（agent 不能把任务移到 done）；`waitingForHuman`；驳回包；执行报告。
3. **派发先一次性 worker + 可选 verifier**：不引入常驻池；文件级排他 `touches`；精确 `git add`；worker prompt 写死禁止 checkout/reset/clean；每任务 worktree 放 P4。
4. **角色切换 = 会话级 prompt section**（persona-switcher 模式）：注册独立 section、`agent/created` 绑定、会话状态持久化；**不 recompose preset**（实测重绑会掉工具），不动工具/技能/模型。
5. **双寄存器改写用 persona-shell 模式**：WorkReport 原文是权威；work 寄存器确定性渲染（结论/改动/验证/风险/下一步）；casual 作为**后处理改写**（可选、可关、额外模型调用要标注），原文随时可看；技术字面量先保护。
6. **记忆不自建**：只读适配 fish/outfit；关系摘要用明文小文件 + 有界注入 + 人可查/删；不建向量库；不引入新 memory 服务。
7. **进度必须有来源**：步骤/事件/自报/时间基线四类来源，不伪造百分比；进展只在有产物时上报、静默不刷屏（agent-board 模式）。
8. **安装先本地 `link:`/绝对路径**：桌面「插件 → 添加插件」支持本地绝对路径；Web 用 `dsh plugin --profile web add link:<path>`；`dsh --profile web --dump-config` 验证层；客户端 inject `["slots"]`；单 bundle 一行。
9. **与现有插件共存**：不全局挂工具；不接管已有看板；提供“只读导入/不自动接管”说明；legacy-store/legacy/outfit 保持原样。
10. **风险**：与已有看板插件功能重叠、工具面冲突；明确本插件不是“又一个看板”，差异点在角色与注意力。
11. **人设注入**：用 `agent.ctx.systemPrompt.section()`（legacy-store 模式）；段名 `superbot:persona` 类前缀、不占 `deployment:persona*` 保留名；order 先 `getSectionOrder` 再 fallback；动态 text；按 cwd/工作区判据只挂经理会话；worker 不挂。角色选择存会话侧车（如 `<stateDir>/session-persona.json`），不 recompose preset。
12. **缓存纪律**：同一会话第二轮起常驻段逐字节相同；任务计数/时间/余额等易变内容不进常驻段（改放首轮、工具查询或面板）。
13. **只读适配根解析**：fish 用 `DSH_FISH_HOME` + `~/.legacy-store-location.json`；outfit 用 `DSH_OUTFIT_HOME`；找不到就降级为空，不写、不迁。
14. **面板数据通道**：`ctx.webServer.register` 回环路由 + 同源 fetch；写带 `rev`（400/409）；实时用 SSE；不新开端口；配置页用 `plugins.bundle.config`。
15. **主动行为（P4）**：宿主调度 + 每日上限 + 免打扰 + `min_idle` 顺延 + 静默墓碑 + 唤醒 framing；只给事实、必须 refs、频率是上限不是行为要求。
16. **许可注意**：dsh-tavern 是 PolyForm-NC，只学设计不抄代码；社区代码逐仓库核对 LICENSE。
17. **任务状态机**：`draft / todo / in_progress / in_review / blocked / done / canceled`；`done` 由“工具面收窄 + pre-execute 拒绝”代码层把关，agent 不可完成验收；`waitingForHuman` 独立字段。
18. **派发**：首发一次性 Worker（`startActivation`），落定后主动 interrupt；续跑子会话后置；重复结算按日志 seq 增量记账。失败处理每轮扫描“running 且无 endedAt”，不依赖 setTimeout。
19. **待你决定**：独立队列 + 三态（待定/已定/过期）+ 侧栏角标；escalate 去抖、投递前重读、已裁决静默丢；不塞进任务卡。
20. **存储**：JSON/JSONL 起步，`schemaVersion` + 原子写（tmp→fsync→rename）+ 腐坏隔离 + 有界历史（每卡 20 条 run）+ 卸载不删数据；SQLite 后置。
21. **客户端**：单文件构建产物（client entry 被 `new Function` 求值，不能运行时 import）；首发 `sidebar.panellist` 行 + `main` seat；不新开端口/浮窗。
22. **P0 先验证宿主签名**：`subagents.startActivation(spec)` 在 0.2.1-rc.5 的实际参数；`ctx.webServer.register` 路由；`ctx.slots` 注册与 feature-detect。


## 13. 长会话与上下文策略（2026-11-03 专项）

> 详见 `research/长会话上下文与任务调度.md`。这里只列会改变插件设计的约束。

### 13.1 会话拓扑

| 会话 | 生命周期 | 看什么 | 不看什么 |
|---|---|---|---|
| manager | 长、跨天，但上下文预算 ≤30% | 任务摘要、决策、待你决定、最近 WorkReport、角色段 | 完整执行日志、大文件、worker 思考 |
| worker | 短（单任务/单尝试） | TaskSpec + 验收 + 文件引用 + handoff | 角色文本、其他任务、经理闲聊 |
| verifier | 新会话、一次性 | TaskSpec + 验收 + diff/提交 + WorkReport | worker 辩解、角色 |
| memory adapter | 按需 | 只读 fish/outfit 少量事实 | 全量库、写权限 |

### 13.2 调度

- 单 worker 任务 10–30 分钟；大任务 epic+子任务 DAG；
- 就绪队列确定性排序；`maxWorkers` 槽位 + 给人留 1 个额外槽；
- 文件/项目写锁；`git add` 精确路径；冲突跳过并显示“等文件释放”；
- 模型路由：manager/verifier 强，worker 性价比；按 task size 分档；
- 租约+心跳+每轮扫描失败收口（不依赖 setTimeout）；人工等待独立于 blocked。

### 13.3 上下文预算与换会话

- 常驻 10–15%（稳定、逐字节不变，易变状态不进）；任务规格 ≤10%；检索 20–30%；最近对话 20–30%；余量 ≥20%。
- 55–65%：提示到自然边界交接；70%：允许一次压缩（复用官方 `compaction-basic` + `tool-result-pruner`），压缩后重锚；
- 压缩 ≥2 次或仍 >70%：换新会话；任务完成/阶段切换：无条件换（verifier 另起）。
- handoff 5 行写盘：目标/现状/下一步/未决/证据；新 worker 拿 TaskSpec + handoff + 文件引用，不拿旧历史。

### 13.4 防推理衰减与度量

- 短工作集、重锚（目标/验收/约束/当前步/已决策）、独立 verifier、checklist、模型路由；
- 不在 worker/verifier 注入角色；经理上下文也设上限；
- 度量：按上下文长度/轮次的成功率、返工率、token/任务、缓存命中、压缩次数；阈值用本机任务集校准。

### 13.5 插件实现

- 复用官方：compaction-basic、tool-result-pruner、spill、token-meter、session-checkpoint-policy；
- 自建服务：`superbot-orchestrator`（队列/槽/锁/租约）、`superbot-session`（worker/verifier 创建与 prompt 组装）、`superbot-context`（预算/阈值/handoff/重锚）；
- 工具：`task_dispatch`、`task_report`、`task_verify`、`context_status`、`handoff_write`；
- P0 验证：`ctx.tokenMeter`、压缩触发/读数接口、`ctx.subagents.startActivation(spec)`、`ctx.webServer.register`。


## 14. 实验与开源结构之后的修订（2026-11-03）

### 14.1 会话策略改为“warm session + 轮换”，不是每任务必切

- 本机实验：一条 warm session 在 10 个连续任务上 10/10、测验 5/5，未缓存输入仅为“每任务新会话”的约 1/10，耗时约 42%。
- 所以：**同一项目/阶段的连续任务复用一条 worker 会话**；独立任务/高风险/验收才新会话；verifier 永远新会话。
- 轮换触发：**先按成本/延迟预算，而不是按“质量阈值”**。校准实验（0/100k/200k/300k 注入）到约 26 万 token 仍 6/6 + 测验 5/5，质量没掉；300k 臂任务 token 约为 0k 的 17×。
- 初始策略：交互场景工作预算 **120–200k**，批量场景可到 **300k+**；超过预算或任务边界/独立任务/验收/上下文污染/跑偏时轮换；官方 compaction 80% 是防溢出，不是质量保险。
- 不要机械按 40%/60% 轮换；质量没坏时轮换只增加 re-prime 成本；verifier 始终新会话，handoff 5 行。
- 仍需补：多样化/干扰上下文、长程依赖、50–80 万 token、小窗口模型、并发/失败注入。

### 14.2 任务引擎借结构（不搬实现）

- **任务表**：`task_claims` 部分唯一索引 + `expected_task_version`；`task_activities(before/after)` 审计；`HUMAN_ONLY` 白名单，agent 只能到 `in_review`。
- **等待表（waitpoint）**：id/resume token、taskId+stepName（路径限定，循环内唯一）、type、status(PENDING/COMPLETED)、deadline（创建即固定）、resume_payload；liveness 下限写死，任何配置不能永久等待。
- **失败三态**：failed / crashed / late 分开；显式放弃终态；租约 TTL/2、心跳、stalled 计数；排队超时交给人而不是重试。
- **终止条件清单**：轮数、token、超时、显式 handoff、人工叫停、失败——是数据不是散落 if。
- **handoff**：Goal/State/Highlights/Next/Files + 关键标识符；`input_filter` 只传 TaskSpec+handoff+文件引用，不传旧会话全文。

### 14.3 上下文视图与缓存

- 简化 `ContextView`：工具调用/结果配对、任务规格块原子性、用户回合边界 → 可计算合法切点；
- 压缩分级：工具结果落盘/清理 → 裁剪旧历史 → 摘要；`minimum_progress`（至少压掉 10%）防“压了没变小”；
- 裁剪边界按步数量化（SWE-agent polling 思路），保持前缀稳定、cache 命中；
- soft threshold 后台预生成 handoff/summary，hard limit 再切换，避免临时压。

### 14.11 验收策略（2026-11-04）

- task-engine：`classifyAcceptance` + `acceptByPolicy`；低风险+verifierPassed+可逆+无外部副作用+无主观标签 → done（acceptedBy policy）；审美/UX/设计/文案/安全/高风险 → in_review + waitingForHuman。
- `superbot_task_review` 支持风险参数；隔离 headless 实测通过。
- “done 只能人”原则改为：**高风险/审美类只能人；低风险策略可自动，但审计可重开**。

### 14.10 P0 设置页（2026-11-04）

- `lib/client.js` 通过 `settings.section` 注册「Superbot」设置页；`dsh.client = {platform:'web'}`。
- Host 侧 `lib/config.js`：默认值/校验/原子写；`GET/POST /superbot/config`（`ctx.inject(['webServer'])` 注册，headless 无 webServer 时自动跳过）。
- 配置项：dedupeToolResults、toolsEnabled、budgetTokens、compactAt、handoffAt、cacheDir；落盘 `<DSH_HOME>/storages/dsh-superbot/config.json`。
- 隔离 Web + Playwright 验证 PASS：设置页出现、修改并保存、「已保存」、配置文件更新。
- 后续：设置变化对工具/preset 的即时生效、任务持久化、人工 accept 面。

### 14.9 P0 任务工具集成（2026-11-04）

- `dsh-superbot/lib/tools.js` 注册 `superbot_task_submit/plan/list/claim/review` + `superbot_handoff`，底层复用 task-engine。
- 隔离 headless 验证：submit(draft)→plan(todo)→claim(in_progress)→review(in_review)→list，全部通过；**没有 accept 工具，agent 不能 done**，人工验收留给后续面板/CLI。
- 当前限制：工具全局注册、内存存储；下一步改 preset 作用域 + 持久化 + 人工 accept 面 + 会话轮换接入。

### 14.8 P0 实现状态（2026-11-04）

- 插件骨架 `superlegacy/packages/dsh-superbot` 已可在隔离 headless profile 用 `link:` 安装，`dump-config` 可见；单测 6/6。
- `tools/post-execute` 去重已集成验证（重复命令结果被替换为短通知 + 原文路径）。
- 大输出预览复用官方 `dsh-spill-policy`，不在插件重复实现。
- **reasoning 保留被宿主冻结挡住**：`llm/stream` 的 request options/messages 是 frozen，插件无法改历史；纯策略保留，改由“会话轮换 + 5 行 handoff”实现短上下文。
- 下一步：任务引擎骨架（TaskSpec/状态机/waitpoint）+ 会话轮换策略 + preset 工具面收窄。

### 14.7 消融结果与策略（2026-11-04）

- 同 6 任务：base 6/6 + 测验 5/5，534,793 token；strip 旧 reasoning 两次 6/6，测验 4/5 & 5/5，token 361k/425k（-20~32%），输出 -30~61%；dedupe 6/6 + 5/5 但未触发大输出（只裁 187 字符）；both 6/6 + 5/5。
- 策略：**旧 reasoning 只保留最近 K 步（K=1~2），更早的摘要化/丢弃**；一次测验 4/5 说明需保守并多轮验证。
- 工具结果去重/预览必须在**工具出生点**做。补测已验证：一次任务产生 ~300K 字符大输出后，dedupe 使后续 S2 token **-80%**、QUIZ **-81%**、cache read **-83%**，任务与测验仍全过；both 再叠加 reasoning 裁剪，S2 **-85%**。保留原文回读路径（artifacts/<hash>.txt）。
- 工具 schema 按 preset 收窄（75 工具 → worker/verifier 的少量工具）。
- 验收：任务成功率 + 回忆测验 + token/任务 + uncached input + cache hit + 延迟 + 返工，至少 3–5 次重复。

### 14.6 上下文浪费审计结论（2026-11-04）

本机 51 个 session 审计：assistant 内容 47.7%（reasoning 22.5% + tool-call 参数 24.4%）、tool results 38.6%、tool schemas 8.6%、user 3.7%、system 1.4%；tool result 中 45.6% 字符来自 >8K 的大结果，18% 是完全重复；首轮 prompt 中位 22,388 token，prompt/step 中位 187,355。

插件侧优先级：
1. **P0**：旧 reasoning 不重放（保留最近 1–2 步或摘要）；工具结果按内容 hash 去重、重复调用直接返回引用；重复读同路径（未变）给短引用。
2. **P1**：工具结果出生即落盘/头尾预览（>8K），不等到 compaction；工具 schema 按 preset 收窄，worker/verifier 不挂 75 个工具。
3. **P2**：上下文编译器（按步骤渲染最小充分证据集）+ 预算；handoff/摘要 schema。
4. 验收：A/B 消融测成功率、回忆测验、token/任务、uncached input、cache hit、延迟、返工；不能只按字符数砍。

### 14.5 多代理 / 摘要 / 记忆上限的硬约束

- **多代理只用于只读侦察/并行检索**；写代码的 worker 串行（一个项目一个写者），决策由 manager 做；不把“多 agent 讨论”作为默认。
- **摘要六段 schema**：意图/已完成/错误与用户纠正/进行中/待办/关键标识符；JSON 输出，宁缺勿编。
- **handoff 只传摘要 + TaskSpec + 文件引用**，不传 reasoning/tool 原文；OpenAI Agents SDK 的 filter 思路。
- **记忆/常驻索引加硬上限**（如 200 行/25KB），超限整行截断并标 `[earlier memory truncated]`；大正文落盘按需读。
- **压缩是能力协议**：先探测宿主是否有 compaction/tokenMeter，再决定策略；不假设一定存在。

### 14.4 不要做的

- 不写 supervisor/orchestrator 库；不做 Temporal 式重放/集群；不做通用 DAG 执行器；不做独立 agent-server；不把角色文本注入 worker/verifier。

## 11. 与既有文档

- 总纲/三线现状：`方案地图.md`
- 既有插件研究（已归档，不在本仓库）
- 阿哲系统：`其他项目助手角色设计/`
- Superbot系统：`README-交付说明.md` 等
- 旧稿归档：`research/archive/`
- C0 自定义 App 验证（仅参考）：`研究-系统状态/C0验证/`
