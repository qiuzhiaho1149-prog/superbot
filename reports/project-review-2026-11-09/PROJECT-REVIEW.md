# 全项目 Review（2026-11-09）

范围：`packages/dsh-superbot`（20 个 lib 文件）+ `packages/task-engine` + 测试 + 文档/前端。
方法：全量代码/测试扫描 + 最近专家组三份报告（backend-logic / ux-benchmark / scenario-audit）+ 真机历史安装测试。
结论：**核心闭环成立，但尚未收敛**；缺 9 项功能、7 个逻辑错误、8 类冗余/性能问题，外加文档与测试缺口。

## 0. 规模与基线

| 项 | 数值 |
|---|---|
| dsh-superbot lib | 8,444 行（client.js 1,720，work-store 1,148，tools 768，dispatch-tools 517） |
| task-engine | 389 行，零依赖 |
| 测试 | dsh-superbot 150 + task-engine 18 = 168 PASS（2026-11-09） |
| 客户端测试 | **0**；路由测试覆盖 8 条路由中的部分；无 E2E/安装测试 |
| 文档计数 | 已过期：README 写 161/143 条，实际 168/150 |

## 1. 缺失（没开发/没接完）

| 级别 | 缺口 | 证据/影响 |
|---|---|---|
| P0 | **自动审计驱动器缺失**：verifier 派工、task_review、返工、收尾 run 都要 Manager 主动调工具；无 hook/timer | 专家 A/C：全仓仅 tools/post-execute 去重钩子；任务可能永久停在「审计中/执行中」 |
| P0 | **取消/回滚无工具**；task-engine 支持 canceled，但工具面没有 cancel | 用户无法中止错误任务；任务只能 forward |
| P0 | **卡住/超时无检测**：无 stalled 检测、无 aging；`wait:false` 已修成自动收尾，但子会话本身挂住仍无告警 | 专家 C P0 |
| P0 | **人类驳回路径缺失**：面板文案「验收/驳回」，实际只有 accept；verifier pass 但 policy 判人工时只能通过 | client 文案 vs 工具面 |
| P1 | **任务因果时间线 API 缺失**：report/逐条 evidence/verifier notes/policy reasons/human note 不可见 | 专家 A/B；详情抽屉只有字段表 |
| P1 | **历史工作批量导入 UI 缺失**：`superbot_history_import` 工具 + `/superbot/history/import` 路由已实现，面板只有逐条「交给 Superbot 分析」，没有多选批量导入 | HISTORY-TEST |
| P1 | **自动审计/停滞/异常没有面板入口**：blocked/canceled 任务在阶段板完全不显示 | client PHASE_LANES 仅 6 lane |
| P1 | **桌面端安装/升级兼容未验**：只在 CLI 0.2.1-rc.5 隔离环境跑过；桌面 App 0.2.2-rc.x 未测 | 安装交付缺口 |
| P2 | 资产治理：事件日志无压缩/轮转，`work/artifacts/*.log` 无 GC | 长期运行膨胀 |

## 2. 逻辑错误 / 理解偏差

| 级别 | 问题 | 证据 |
|---|---|---|
| P0 | **humanWaitReason 用「最新 pass」而不是「最新 verdict」**：pass→fail 后仍可能报 awaiting-human/证据问题，而不是 verifier-failed | overview.js:36 `latestOf(reviews.filter(pass))` |
| P0 | **task_rework 的 fail 不按 attempt 过滤**：取全任务最新 verifier review，旧 attempt 的 fail 可能触发新 attempt 的返工 | dispatch-tools.js:489-492 |
| P1 | **blocked/canceled 任务从任务视图消失**：PHASE_LANES 无这两个 phase，任务筛选后不渲染 | client.js:879-886 |
| P1 | **config.stateDir 是死配置**：config 文件里的 stateDir 只做校验/持久化，插件启动只用 initialConfig.stateDir/DSH_HOME | config.js:17,66；index.js:55-58 |
| P1 | **task_review 无 active-run guard**：attempt run 尚未结束时即可裁决；acceptance_run 与 run_finish 存在竞态窗口 | 专家 A R1-R5 |
| P1 | **phase 标签双轨**：服务端 phase/task-phase 已中文化，客户端 PHASE_LANES 又维护一套 label/hint，容易漂移 | task-phase.js vs client.js:879 |
| P1 | **claim 层不绑定真实 run**：report 可选、runId 未校验 task/会话；policy 自动验收不要求 report | 专家 C 因果断点 |
| P2 | verifier pass 后 fail 的 UI 展示顺序依赖 overview latest 逻辑（同上） | 同上 |

## 3. 冗余 / 性能 / 过长代码

| 级别 | 问题 | 证据与建议 |
|---|---|---|
| P0（性能） | **每次 append 都重写整个 projection.json**：事件越多越慢，O(n²) | work-store.js:516 `#writeProjection()` 在 `#append` 内；建议 debounce/批量、或投影增量落盘 |
| P0（性能） | **overview 对每个任务重复查询**：taskRows 最多 200 个任务，每个 `listRuns/listReviews/evidenceCoverage`；项目循环里还先算过一次 coverage | overview.js:136 与 276-278；建议单次聚合 Map |
| P0（性能） | **客户端每 15s 同时拉 overview + onboarding + status**；onboarding 每次全盘扫描最多 300 session/1.5s deadline | client.js:1065 轮询、1040 onboarding；建议 onboarding 按需/缓存，只轮询 overview |
| P1 | **client.js 1,720 行**：设置页/面板/看板/抽屉/compose/聊天 launcher 混在一个文件；已有死代码 | composerOpen/heroText/sendHero（1005/1008/1184）已不再使用；`openManagerSession` 注入重复两份且实现不同（1653/1682） |
| P1 | **双份历史导入入口**：HTTP 路由 + manager 工具，校验逻辑可用但 UI 未接；短期可只留工具/路由之一 | index.js historyImportHandler、tools historyImport |
| P1 | **compose 高级表单 vs 对话优先产品**：结构化发单与 Manager 对话/意图阶梯重复，用户明确不该填边界；建议降级/删除或仅内部用 | compose.js 334 行、client ComposeCard |
| P1 | **onboarding 扫描结果被当全量展示**：MAX_SESSIONS/20 threads 截断无 available/skipped 提示 | onboarding.js |
| P2 | **status 路由为算 pendingHuman 调 buildOverview({projects:[]})**，无谓全账本 fold | index.js buildStatus |
| P2 | **角色上下文/persona/fish-context 共 ~500 行**，对工程经理主流程是可选项，且增加 prompt token | fish-context.js 263、persona-boundary 135、role-context 113；建议默认精简 |
| P2 | TaskDrawer 固定 overlay 无 focus trap/Escape；任务板每渲染重复 filter/count | 前端 a11y/微性能 |
| P2 | 事件日志/产物无压缩轮转 | 长期运行 |
| P2 | 死配置/文档计数过期（README 161/143 vs 实际 168/150） | 文档漂移 |

## 4. 建议修复顺序

**S0（让系统能自己跑、不空转）**
1. 自动审计驱动：run 结束/worker report 事件后触发 verifier 派工+hook；task_review 自动裁决（或 supervisor tick）。
2. 取消/停滞：task cancel 工具 + stalled/aging phase + 面板异常区。
3. humanWaitReason 最新 verdict 修复；task_rework attempt 过滤。

**S1（让老板能判断/退回）**
4. 人类驳回 `POST /superbot/reject`（in_review→in_progress + note）与面板二次确认。
5. 任务因果时间线 API + 抽屉三段式（执行记录/审计证据/决定记录）。
6. 多选历史导入 UI 接 `superbot_history_import`。

**S2（收敛与性能）**
7. projection 写入批量化/增量；overview 单次聚合；onboarding 缓存/按需。
8. client 拆分模块、删死代码、合并重复注入；phase 字典只保留服务端一份。
9. 文档计数/状态更新；补客户端关键交互测试与安装 E2E（CLI + 桌面端）。

## 5. 明确不建议做的（避免过度开发）

- 不要把 compose 表单做成主入口（产品已定对话优先）；保留为高级工具或删除。
- 不要为任务板再做一套甘特/日历（当前数据只有 updatedAt/startedAt，没有真实排期与工时）。
- 不要在客户端再实现一套 phase 状态机；服务端 `task-phase.js` 是唯一事实源。
- 不要继续给 role/persona 加功能；工程经理核心是调度与验收，不是角色平台。

## 6. 本轮已修（S0 第一刀，2026-11-09）

- `humanWaitReason` 改为「最新 verifier verdict」：pass→fail 正确显示 verifier-failed。
- `task_rework` 的 fail 按 attempt（task.owner run）过滤；不再被旧轮 fail 触发。
- `task_review` 增加 active **worker** run guard（防止执行中提前裁决）。
- 新增 `superbot_task_cancel`（manager）：取消非终态任务并关闭活跃 run。
- `task-phase` 新增 `stalled`（活跃 run >30 分钟无收尾）并在阶段板展示「疑似卡住」泳道。
- 新增 **线程地图（甘特）** tab：每条 worker/verifier 线程一条时间条（最近 7 天，颜色=运行/成功/失败/取消），点击打开子会话。
- 测试：dsh-superbot 151 + task-engine 18 = 169 PASS。

未做（S0 剩余）：自动审计驱动器（hook/timer）、多选历史导入 UI、任务因果时间线 API。

## 7. 第二轮 S0（2026-11-09 晚）

- **自动审计驱动器**：task-bound worker 结束后（wait 路径与 fire-and-forget observer 路径），若 `autoAudit=true`（默认）、任务有验收命令且尚无 verifier run，自动派 verifier 并等待结果；policy acceptance 仍由 task_review/人工完成（下一轮再做自动裁决）。
- **完整地图仪表盘**：任务条（createdAt→updatedAt，颜色=phase）+ 线程条（startedAt→finishedAt/now）+ 项目前缀 + 24h/7d/30d 时间窗口 + 图例；点击线程条打开子会话。
- 配置新增 `autoAudit`（默认 true，可关）。
- 测试：dsh-superbot 151 + task-engine 18 = 169 PASS。

## 8. UI 专家组（U1/U2/U3）+ 本轮落地（2026-11-08）

三个 UI 专家报告：`reports/expert-review-2026-11-09/`（ui-timeline-redesign.md / ui-timeline-data.md / ui-visual-system.md）。
- 选型：**three.js 否**；纯 CSS Grid + DSH token 是正解（三份报告一致）。
- 对齐根因（U1/U3）：坐标系未定死、now 线写死 100%、minWidth 混排、ISO 解析、任务条时长语义、跨项目 cap 饥饿、三套时钟。
- 本轮已落地：
  1. 服务端 `lib/timeline.js`：数值 t0/t1/durationMs/state/missingTime + 单一 now + lanes/truncated；`/superbot/overview` 返回 `now`+`timeline`。
  2. 地图重写：共享网格（220px 标签列+1fr）、轴/网格线/条共用一个 pct 函数、now 线按 pct(now) 且窗口留 4% headroom、任务=细条+末端点、线程=胶囊条、点击任务开抽屉/点击线程开会话、缩放持久化。
  3. `task-phase` PHASE_META 补 stalled；`deriveTaskPhase` 接受 now 参数。
  4. 修复错误色 token bug：`--dsw-alias-label-error` 不存在 → 改用 `--dsw-alias-state-error-primary`（错误提示真正变红）。
  5. 新增 timeline 测试；测试 154 + 18 = 172 PASS。
- 下一步（按 U2 规范）：一次性 sb-* CSS 骨架迁移（Quiet Control Room）、合并侧栏双入口与 5 个对话入口、首屏 Focus 区、11→5 级字号、12 枚 SVG 图标、空/加载/错误态。

## 9. 第三轮（目标轮 1）：性能 / 视觉 token / 安装文档

- overview 聚合：runs/reviews/evidence 改为单次 Map 聚合 + coverage 缓存，去掉每任务 3 次全量查询（200 任务 -> O(n)）。
- 视觉系统落地第一层：`sb-badge / sb-btn / sb-btn-sm / sb-card / sb-drawer / sb-empty / sb-tab-active` 类 + DSH radius/elevation token；Pill/Button/Card/Drawer/EmptyLine 切类。
- 新增 `docs/INSTALL.md`（安装/首次接入/配置/自检/升级）。
- 测试 154 + 18 = 172 PASS。
- 仍差：U2 全量 272 内联迁移、桌面端安装验证、projection 批量写、真实闭环真机复测。

## 10. 目标轮 2：字体/圆角收敛 + 全新安装自检

- 字号从 11 种收敛为 5 级（11/12/13/15/20）；圆角从 9 种收敛到 6/8/10（条形 2/3 保留）。
- tab 改 `.sb-tab/.sb-tab-active`；status 暴露 autoAudit。
- 全新 DSH_HOME 安装自检通过：preset-scoped、policy 正确、runtime shell/sandbox 可用、onboarding 未确认、扫描 2 项目/9 线程。
- 测试 154 + 18 = 172 PASS。
- 剩余：U2 其余内联样式迁移、桌面端验证、projection 批写、真实自动审计闭环复测。

## 11. 目标轮 3：自动审计测试 / projection 批写 / SVG 图标 / 安装自检

- 新增 `test/auto-audit.test.js`：直接测 `dispatcher.autoReview`——低风险+完整证据→policy auto done；最新 verdict fail→保持 in_review。
- projection 写入批处理：事件 ≤500 同步写（测试/工具语义不变），>500 合并 100ms；dispose 前 flush。
- 地图图标 SVG 化（任务/执行/审计三类），字号 5 级；地图 24h/7d/30d 缩放验证。
- 全新 DSH_HOME 安装自检通过（preset-scoped / policy / runtime shell+sandbox / onboarding=false / 2 项目 9 线程）。
- 测试 156 + 18 = 174 PASS。

## 12. 目标轮 4：自动审计端到端测试 / 历史导入 E2E / 版本兼容确认

- 新增 `test/auto-audit-e2e.test.js`：fake host 下完整链路 **worker 结束 → 自动派 verifier → verifier 执行验收命令+提交 pass → autoReview → policy done**，1 用例通过。
- 历史导入 E2E（模拟 2–3 个月旧 DSH、全新账本）：扫描→勾选数据→`POST /superbot/history/import` → ledger tasks=1、phase=queued；证据 `reports/install-history-test-2026-11-08/evidence/history-import-*.json`。
- 版本确认：CLI 0.2.1-rc.5（PASS），桌面 App 0.2.2-rc.1（engines 明确排除：`>=0.2.1-rc.5 <0.2.2-0`，**NOT RUN**）。
- 测试 154 + 18 = 172 PASS。

## 13. 目标轮 5：DSH 0.2.2-rc.1 兼容实测

- `npm install @deepseek-ai/dsh@0.2.2-rc.1` 隔离安装后，用同一插件 profile 启动：原 engines 拒绝激活。
- 将 engines 放宽为 `>=0.2.1-rc.5 <0.3.0` 后重新启动：plugin 正常加载，manager/worker/verifier preset 全部 registered；`/superbot/status`、`/superbot/onboarding`（2 项目/9 线程）、`/superbot/overview`（timeline lanes 2）、面板 UI 加载全部通过。
- 证据：`reports/install-history-test-2026-11-08/evidence/dsh-0.2.2-smoke.txt`。
- 桌面 App 内核即 0.2.2-rc.1：core 兼容已验证；桌面安装流程仍 NOT RUN（未改本机桌面 profile）。

## 14. 目标轮 7：真实模型 E2E + 商店定稿 + 上架检查表

- 真实 DeepSeek 模型在 DSH 0.2.1-rc.5 下，Manager preset 成功调用 `superbot_fleet_status`，并基于账本事实汇报（2 项目/3 任务/1 worker 运行中/1 待验收）；证据与截图落盘。
- 商店素材：深/浅色任务板、地图、历史、真实会话截图（`reports/store-v1/`）。
- 新增 `docs/上架检查表.md`：15 项 PASS/PARTIAL/NOT RUN 汇总；剩桌面 App 安装（需授权）、U2 样式收尾、文案复核。
- 测试 154 + 18 = 172 PASS。
