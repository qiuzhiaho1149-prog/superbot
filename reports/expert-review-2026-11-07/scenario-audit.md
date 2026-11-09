# 专家组 C · 端到端场景与审计因果复审

- 日期：2026-11-07（America/New_York）
- 工作区：`/Users/afraxx/Documents/DeepSeekProjects/superbot-next`
- 任务：task-12（专家组 C，独立完成）。只读代码；本文件是唯一写入。
- 复审对象：Superbot 调度系统（`packages/dsh-superbot` + `packages/task-engine`）当前工作树。
- **代码快照**：2026-11-07T12:53 ET，`HEAD=2dc8df1` + 未提交工作树（S5/S5.1/P1/P2/盲测修复后的 WIP）。
  ⚠ 复审窗口内 `lib/task-phase.js`（新建）、`lib/overview.js`、`lib/client.js` 正在被并发修改（mtime 12:49–12:50），
  行号以本快照为准（关键文件 sha256 见附录 A）。若后续代码再变动，先按哈希核对再引用行号。
- 当前事实性基线：`packages/dsh-superbot` `node --test test/*.test.js` = **143 pass / 0 fail / 33 suites**（本次实测）；
  新增的 `lib/task-phase.js` **没有任何测试**（test/ 内 grep 无 `deriveTaskPhase`）。
- 结论口径：区分「账本/代码事实」「单测已验证」「真机已验证」「未实现/未验证」。未标 PASS 的都按 NOT RUN 处理。

---

## 0. 结论先行（给老板/评审的 10 句话）

1. **这不是自动流水线，而是经理驱动的半自动流水线**：派 verifier、触发 policy 裁决、失败返工、收尾 run 都需要 Manager（模型）主动调用工具；
   账本里没有 scheduler/timer/hook 在 worker 完成后自动派审计。UI 的「审计中」有时只是「等经理动手」。
2. **证据→裁决→验收三段账本链可重建且校验很硬**（指令白名单、会话绑定、证据引用、指纹、沙箱、seq 排序都在）；
   但 **claim（worker 报告）这一段是可选的、且未绑定会话**，policy 自动验收不要求存在 report，审计上「谁声明了什么」可能缺环。
3. **最致命的端到端缺口是「卡住」和「取消」**：没有超时/心跳/自动收尾，`wait=false` 的 run 永远 `running` 并阻塞后续验证/返工；
   没有任务取消/回滚工具，`run_finish canceled` 只关账本不停子会话。
4. **「两个任务竞争同一项目」在 plan 路径有单写者保护，在 direct dispatch 路径没有**（已知残余 P0）：两 worker 可同时写同一项目。
5. **面板无法驳回/返工**：`needs-you` 文案写着「通过/驳回」，但 UI 只有「通过验收」；人不满意时只能回到对话让 Manager 调 `superbot_task_rework`（且要求 verifier fail）。
6. **新项目未盘点会形成 UI 死锁**：首次确认后，面板的盘点卡只剩一行状态，没有「重新盘点/确认」按钮；而 dispatch 硬闸门会拒绝未确认项目。
   同时 `confirmInventory` 是「最新快照整体覆盖」，只补确认一个新项目会让旧项目全部变「未确认」。
7. **任务详情没有因果时间线**：抽屉只有 11 行摘要 + 一个线程框；report 正文、逐条证据（命令/exitCode/耗时/digest/输出预览）、verifier notes、
   policy reasons、human note 都看不到。老板只能看到「证据 2/2 · 结论 pass」，无法判断证据真伪与失败原因。
8. **phase 推导有两类误标**：返工后的新一轮执行仍显示「返工」（latest verdict 未按 attempt 过滤）；worker run 失败或无人派审计时显示「审计中」而非「异常/需经理行动」。
9. **不该让老板看见的实现细节仍会漏出**：policy 转人工的完整性原因（`no-worker-attempt`、`unsandboxed-evidence`、`acceptance-harness-changed`…）
   没有中文词典，会原样显示机器码；`blocked/canceled` 任务在任务板没有泳道，会直接「消失」。
10. **优先级建议**：P0 修「取消+超时+自动审计驱动+direct dispatch 单写者+盘点重确认+claim 绑定」；P1 修「人可驳回+因果时间线+
   新项目/异常队列+phase attempt 过滤+证据明细」；P2 修「标签词典/waitpoint/要求生命周期/多 manager 可观测」。

---

## 1. 系统真实控制流：自动化到底自动在哪

### 1.1 一次闭环的真实驱动链（代码事实）

| # | 步骤 | 谁触发 | 写入事件 | 关键代码 |
|---|---|---|---|---|
| 1 | requirement 落库 | Manager 调 `superbot_requirement_submit` | `requirement/created` | `planning-tools.js:108-132`；`work-store.js:1016-1031` |
| 2 | spec 落库 | Manager 调 `superbot_spec_record` | `spec/recorded` | `planning-tools.js:150-177` |
| 3 | plan+task 落库（DAG 校验后 todo） | Manager 调 `superbot_plan_create` | `task/created`、`task/transition`、`plan/created` | `planning-tools.js:180-243`；`work-store.js:1079-1129` |
| 4 | 首次接入闸门 | Manager 调 `superbot_onboarding_scan` / `_confirm` | `inventory/confirmed` | `tools.js:609-663`；`work-store.js:841-886` |
| 5 | 派 worker | Manager 调 `superbot_plan_dispatch` 或 `superbot_dispatch_worker` | `run/started`、`run/bound`、`task/transition`(claim, worker 侧)、`report/submitted` | `planning-tools.js:263-330`；`dispatch-tools.js:254-360`；`tools.js:147-162/322-349` |
| 6 | worker 交付 | worker 子会话自行 claim/report；**不会**改任务状态 | `task/transition`(todo→in_progress)、`report/submitted` | `dispatch-tools.js:160-172`（brief 指令） |
| 7 | 派 verifier | **Manager 必须手动**调 `superbot_dispatch_verifier`（带 taskId） | `run/started`、`run/bound` | `tools.js:433-442`；`dispatch-tools.js:435-441` |
| 8 | 执行验收命令 | verifier 调 `superbot_acceptance_run` | `evidence/recorded` | `tools.js:454-546`；`work-store.js:749-803` |
| 9 | 提交裁决 | verifier 调 `superbot_review_submit` | `review/submitted`(source=verifier) | `tools.js:548-584`；`work-store.js:909-974` |
| 10 | policy 裁决 | **Manager 必须手动**调 `superbot_task_review` | `task/transition`(→in_review)、`review/submitted`(source=policy)、auto 时 `task/transition`(→done) | `tools.js:164-290` |
| 11 | 人工验收 | 人点 approval（`superbot_task_accept`）或 HTTP（默认关闭） | `review/submitted`(source=human)、`task/transition`(→done) | `tools.js:292-321`；`index.js:318-333` |
| 12 | 失败返工 | **Manager 手动**调 `superbot_task_rework` | `task/transition`(rework-start/rework-requeue)、`run/started` | `dispatch-tools.js:444-491` |

**关键判断（P0）**：第 7、10 步没有任何自动触发点。全仓 grep 无 timer/scheduler/run-finished hook；
唯一的 hook 是 `tools/post-execute` 的去重（`index.js:145-183`）。worker 结束后 run 也不会自动收尾
（`dispatch-tools.js:342`：`if (args.wait !== true) return base`），账本里留一个 `running` run。
所以「自动审计」= **审计执行与裁决是自动化的（受限执行器 + 账本校验 + policy）**，
但「审计流程的推进」是经理/用户驱动的，不是系统驱动。UI 需要显式区分「审计中」与「等 Manager 派审计」。

### 1.2 事件种类（当前账本能表达什么）

`WORK_EVENT_KINDS`（`work-store.js:40-57`）：
`requirement/created`、`spec/recorded`、`plan/created`、`task/created`、`task/transition`、
`run/started`、`run/bound`、`run/finished`、`report/submitted`、`review/submitted`、
`evidence/recorded`、`inventory/confirmed`。

**缺失的事件（与场景直接相关）**：run 心跳/超时（`run/heartbeat`、`run/timed-out`）、run 取消（`run/canceled` 独立事件或 child 终止）、
审计开始/完成（可推断但无事件）、任务取消原因（`task/cancel-requested`）、任务被新需求替代（`task/superseded`）、
waitpoint（task-engine 有 `createWaitpoint`，dsh-superbot **零引用**）、blocked 结构化原因、任务重开（reopen）。
这些缺失直接导致 UI「为什么在等/卡在哪」只能靠推断（见 §4、§6）。

---

## 2. 场景矩阵（触发 → 账本事件 → 系统状态 → 用户可见 → 缺口）

> 表中 `P0/P1/P2` 对应 §6 缺口编号。验证状态=「单测 PASS / 真机 PASS / NOT RUN」中与场景直接相关的最强一项。

### S1 老板说一句模糊需求（"把登录优化一下"）

| 项 | 内容 |
|---|---|
| 触发 | 用户在 Manager 会话里说模糊需求 |
| 账本事件 | 对话本身**不写账本**；Manager 合规时先问 ≤3 个阻塞问题（AGENTS.md「意图拆解阶梯」），再 `requirement/created`（原文 8000 字上限，标题取首行 80 字）→ `spec/recorded` → `plan/created` + tasks |
| 系统状态 | requirement.status 恒为 `'submitted'`（`work-store.js:1026`，无任何状态迁移）；spec/plan 只追加不可改；面板看不到 requirement/spec 原文 |
| 用户可见/下一步 | 对话里被追问/被确认；面板「任务」tab 只有 task 卡（`client.js:1391-1395`）；「结构化发单」可先做质量评分/阶梯（`client.js:783-855`，`compose.js`），但草稿只在 localStorage（`client.js:133-134, 1019-1023`），不入账本 |
| 缺口 | **P1-13** 需求/规格在面板不可见、compose 草稿与最终 plan 无关联 id（模型重述可能漂移）；**P2-20** requirement 无生命周期/澄清记录；**P1-9**（部分）"为什么这样理解"没有可审计记录 |
| 验证状态 | 单测 PASS（planning 覆盖 requirement append/校验）；真机 S6 有过「盘点→小任务」真机（`（历史验收证据已归档，不在本仓库）`），**模糊需求澄清流程未单独验证 = NOT RUN** |

### S2 多项目并行

| 项 | 内容 |
|---|---|
| 触发 | 两个项目各有一批 todo 任务；Manager 调 `superbot_plan_dispatch`（或 direct dispatch） |
| 账本事件 | `run/started` ×N（`workspaceId`/`workspacePath`/cwd 各自项目） |
| 系统状态 | 不同项目可并行；同项目互斥只在 **plan_dispatch** 路径：`runningByProject` + `wipLimit`（默认 2，`config.js:19`；`planning-tools.js:288-302`；task-engine `planDispatch` 项目互斥 `task-engine/lib/index.js:261-283`） |
| 用户可见/下一步 | 项目 tab 每项目独立计数/线程/待验收（`overview.js:117-232`；`client.js:678-730`）；任务 tab 卡片带项目名 |
| 缺口 | **P0-4** direct dispatch 路径无项目单写者检查（`dispatch-tools.js:222-252` 只查任务级 active run，不查同项目其它 active worker）→ `superbot_dispatch_worker` 可让两个 worker 同时写同一项目；**P2-19?** wipLimit 不作用于 direct dispatch；**P1-15** `createPlan` 未校验 `task.projectId == requirement.projectId`，也不校验 dep 是否同项目（`work-store.js:1079-1129` 只查 dep 存在），与设计文档 §3.3 不变量 #2 不符 |
| 验证状态 | 单测 PASS（dispatch-plan 双项目/项目互斥）；真机 S5 双项目隔离 PASS；**direct dispatch 绕过单写者 = NOT RUN/无测试**（`（历史审计报告已归档，不在本仓库）` §2 自认剩余 P0） |

### S3 worker 执行中

| 项 | 内容 |
|---|---|
| 触发 | `superbot_dispatch_worker`/`plan_dispatch` 起 worker 子会话 |
| 账本事件 | `run/started`（`taskId/agentPreset/workspaceId/label/parentSessionId/workspacePath/baseline*Digest`）→ `run/bound(childId)` → worker 侧 `task/transition`(todo→in_progress, actor=runId) → `report/submitted`；`wait:true` 时最后 `run/finished`，否则**无收尾事件** |
| 系统状态 | task `in_progress`、owner=worker runId、run `running`；phase=`executing`（`task-phase.js:74-75`）；UI 显示「执行中」 |
| 用户可见/下一步 | 任务卡：阶段/原因/「审计证据 0/N」/线程入口（`client.js:887-918`）；「调度中」tab 列 active 子线程并可打开会话（`client.js:1408-1430`） |
| 缺口 | **P0-2** 无进度/心跳/最后活动字段（run 只有 `startedAt`；`overview.js:166-180`），`wait:false` run 不自动收尾（`dispatch-tools.js:342`）→ 子会话已死/结束但账本仍 `running`；**P1-12** run 失败不入 attention 队列；**P1-7** 面板不展示 `parentSessionId`（哪个经理会话派的）；**P2** worker 未 claim 时 task 仍 todo 但 phase 显示 executing（run 存在即算） |
| 验证状态 | 单测 PASS（run 绑定/fake 子会话）；真机 S4/S5 有真实 worker 执行 PASS；**后台未收尾 = NOT RUN** |

### S4 verifier 自动审计（命令/证据/结论）

| 项 | 内容 |
|---|---|
| 触发 | Manager 调 `superbot_dispatch_verifier({taskId})`（要求该 task 已有 finished worker run）→ verifier 执行 `superbot_acceptance_run(index)` ×N → `superbot_review_submit` |
| 账本事件 | `run/started`(verifier)+`run/bound` → `evidence/recorded`（`runId/childId/index/command/exitCode/expectedExitCode/timedOut/durationMs/outputDigest/outputPath/preview/workspaceDigest/protectedDigest/sandboxMode/executionMode/sandboxed/isolationMode/ownerRunId/taskVersion`，`work-store.js:749-803`）→ `review/submitted`(source=verifier, runId, childId, evidenceIds, verdict) → `run/finished` |
| 系统状态 | 审计进行中 = 存在 active verifier run（`task-phase.js:74`）；verifier pass/fail **不改任务状态**（`submitReview` 只追加，`work-store.js:909-974`；`tools.js:548-584`） |
| 用户可见/下一步 | 任务卡「审计中 + 证据 n/n + 结论」；待你队列只在 task 进 in_review 后才出现 |
| 缺口 | **P0-3** 无自动派审计（见 §1.1）；**P1-9** 任务详情看不到逐条命令/exitCode/耗时/digest/输出预览（drawer 只有计数，`client.js:952`）；**P2** 无 `audit/started|finished` 事件（只能靠 run 推断） |
| 验证状态 | 单测 PASS（review-isolation：证据门/覆盖/重放/seq/沙箱）；真机 S5 verifier 独立执行命令 PASS；**自动派审计 = NOT RUN** |

### S5 审计通过自动完成

| 项 | 内容 |
|---|---|
| 触发 | Manager 调 `superbot_task_review(id)`（task in_progress 或 in_review） |
| 账本事件 | `task/transition`(in_progress→in_review, manager) → `review/submitted`(source=policy, verdict=pass, decision=auto, evidenceIds, reviewerRole=manager) → `task/transition`(in_review→done, actor=policy) → task 快照 `acceptedBy='policy'` |
| 系统状态 | 前置：latest verifier pass + 每条命令通过证据 + 真实 worker attempt + 指纹未变 + 沙箱契约 + `classifyAcceptance` auto（risk low/reversible/无外部副作用/无人类标签）（`tools.js:180-290`；`task-engine/lib/index.js:320-334,374-389`） |
| 用户可见/下一步 | 任务卡「已完成」；老板无需操作；审计里可看到 policy 事件 |
| 缺口 | **P0-6** auto 不要求存在 `report/submitted`（claim 可缺）→ 审计链「worker 声明」环节可能完全空白；**P2** review/transition 的字段足够重建（这一点是好的） |
| 验证状态 | 单测 PASS（多次）；真机 S4 低风险 policy 自动 done PASS |

### S6 审计失败 → 返工 → 再审

| 项 | 内容 |
|---|---|
| 触发 | verifier 提交 fail → Manager 调 `superbot_task_rework(id)` |
| 账本事件 | `review/submitted`(verifier, fail) → `task/transition`(rework-start/rework-requeue → todo) → `run/started`(worker 新 run，brief 含 verifier 记录+失败证据) → 新 attempt 的 claim/report/evidence/review → 再 `task_review` |
| 系统状态 | 旧 attempt 全部保留；evidence/review 带 `ownerRunId`，policy/coverage 按当前 `task.owner` 过滤（`work-store.js:806-837`；`tools.js:188-192`）→ 主要隔离正确；phase 判定：`latestVerifier.verdict==='fail' && !activeVerifier` → `rework`（`task-phase.js:71-73`） |
| 用户可见/下一步 | 任务卡「返工」+「第 N 次尝试」（N>1 才显示，`client.js:909`）；下一步文案「让 Manager 调用 superbot_task_rework」 |
| 缺口 | **P0-5/P1-7** 面板没有「驳回/要求返工」按钮，人只能回对话；**P1-8** phase 用全局 latest verifier fail（未按 attempt 过滤）：返工派新 worker 后仍显示「返工」，新 attempt 交付后也仍可能显示「返工」；**P2-18** 返工触发关系未持久化（`reworkOf` 只在工具返回值 `dispatch-tools.js:486`，`run/started` 无 `reworkOf/attempt` 字段）→ 无法从账本重建「这次尝试因哪条裁决而来」；**P2** fail review 可无 evidenceIds（文字失败），rework brief 的「失败证据」可能为空 |
| 验证状态 | 单测 PASS（requeue + 证据嵌入 brief + 拒绝非 fail）；**真机返工闭环 = NOT RUN**（S5 §8.5、P1 §5.3 明确未验证） |

### S7 高风险/审美 → 人工

| 项 | 内容 |
|---|---|
| 触发 | task 带 `risk=high` / 人类保留 tag / 不可逆 / 外部副作用；verifier 已 pass；Manager 调 `task_review` |
| 账本事件 | `task/transition`(→in_review) + `review/submitted`(source=policy, verdict=pending, decision.mode='human', reasons=[risk-not-low/tag:...])；人工通过时 `review/submitted`(source=human) + `task/transition`(→done, actor=human) + task 快照 `acceptedBy='human'/acceptanceVia/acceptanceNote/acceptedAt` |
| 系统状态 | task 停在 in_review；overview 生成 `pendingHuman.reason='policy-human-required'`（`overview.js:52-66`） |
| 用户可见/下一步 | 「待你验收」队列显示「策略要求人工验收」+ 中文 reasons（`client.js:212-243, 506-560`）；默认 `httpHumanActions=false` → 面板只显示「需在对话中批准」（`client.js:514-525`），人必须回对话让 Manager 调 `superbot_task_accept` 触发 approval 弹窗 |
| 缺口 | **P0-5** 面板不能直接完成人工验收（默认安全设计，但产品路径割裂：没有「请求老板批准」按钮/通知）；**P1-11** TaskDrawer 在 `httpHumanActions=true` 时的「通过验收」按钮**没有二次确认/风险提示**（`client.js:983-986`），与 AttentionRow 的 risky 二次确认不一致 → 一键误验收；**P1-12** 高风险任务在 Manager 忘记 `task_review` 前不会进入待你队列（attention 只扫 in_review） |
| 验证状态 | 单测 PASS（高风险/标签强制人工、human accept 仅 in_review）；真机 S5 人工验收面板 PASS；**approval 弹窗真机 = NOT RUN**（S5 §8.4） |

### S8 证据不足 / 命令非法

| 项 | 内容 |
|---|---|
| 触发 | plan/task 声明非法命令；或任务没有/缺少 `acceptanceCommands` 证据；或 verifier 只写文字结论 |
| 账本事件 | 非法命令在 `plan_create`/`task_submit`/`acceptance_run` 三层被拒，**不写账本**（`command-policy.js:24-99`；`planning-tools.js:233-234`；`tools.js:87-90, 476-478`）；无证据/证据不全时 policy 落 `review/submitted`(pending, decision.mode='human')；verifier prose pass 被 store 拒绝（`work-store.js:930-946`） |
| 系统状态 | 无 `acceptanceCommands` 的任务 `evidenceCoverage.complete=false` → 永远不能自动完成（`work-store.js:806-837`）；overview reason=`evidence-incomplete`（`overview.js:45-51`） |
| 用户可见/下一步 | 创建计划时对话里报错（含白名单示例）；任务卡「机器验收命令 0 条」；待你队列「证据不完整」+「仍要通过验收…」二次确认（`client.js:527-536`） |
| 缺口 | **P1-10** 没有「必须声明机器验收命令」的产品约束：`acceptanceCommands` 在 task_submit/plan_create 都是可选（`tools.js:63-73`；`planning-tools.js:204-215`），只有 compose 做预测（`compose.js`）→ 低风险任务也可能永久人工，且面板直到 in_review 才提示；**P1-9** 被拒命令/失败命令在 UI 没有可看的明细；**P2** 拒绝动作无审计记录（设计取舍） |
| 验证状态 | 单测 PASS（flag/链式/非模板拒绝）；**真机拒绝/无命令转人工 = NOT RUN**（白名单为 P1 后新增，报告无真机拒绝记录） |

### S9 两个任务竞争同一项目

| 项 | 内容 |
|---|---|
| 触发 | 同项目两个 todo 任务都 ready；两个 Manager 会话或两条路径同时派 |
| 账本事件 | plan 路径：一个 `run/started`，另一个 skip `project-busy`（task-engine 项目互斥）；direct 路径：**两个都写 `run/started`** |
| 系统状态 | plan_dispatch 内项目互斥（`planning-tools.js:288-302` + `task-engine/lib/index.js:266-278`）；direct dispatch 无此检查（`dispatch-tools.js:222-252`） |
| 用户可见/下一步 | 项目「线程 2」+ 两个「执行中」子线程；没有冲突提示 |
| 缺口 | **P0-4** direct dispatch 单写者缺口（同上，`（历史审计报告已归档，不在本仓库）` §2 剩余 P0）；**P1-15** plan_dispatch 与 direct dispatch 混用时没有统一互斥；**P2-24?** UI 不提示「同项目多 active worker」 |
| 验证状态 | 单测 PASS（plan 项目互斥）；**direct/bypass = NOT RUN（无测试）**；真机未构造该竞争 |

### S10 worker 长时间卡住/超时

| 项 | 内容 |
|---|---|
| 触发 | 子会话卡死/网络断了/模型长跑；`wait:false` 派工后无人收尾 |
| 账本事件 | **没有新事件**。`run/started` 后状态永远 `running`；无 `run/heartbeat`/`run/timed-out`/`run/canceled`（`work-store.js:40-57` 事件种类；grep `timeout` 只命中验收命令 120s） |
| 系统状态 | phase=`executing`（或 worker 结束但 run 未收 → 仍 `executing`）；verifier dispatch / rework / 再次 dispatch 全被 `unfinished run` 挡住（`dispatch-tools.js:245-247, 463-464`）；attention 队列为空（只含 in_review） |
| 用户可见/下一步 | 任务卡「执行中」+ 相对时间（用的是 `task.updatedAt`，不会随 run 刷新，`client.js:910`）；调度中 tab 显示线程「进行中」；**没有任何「疑似卡住」提示**。唯一恢复：Manager 调 `superbot_run_list` + `superbot_run_finish`（`tools.js:426-452`） |
| 缺口 | **P0-2** 无超时/心跳/自动收尾/告警；**P1-12** run 失败/疑似卡死无异常队列；**P2-17** waitpoint/blocked 未接线（`createWaitpoint` 只在 task-engine，dsh-superbot 零引用）；**P2-21** `run_finish` 只写账本、不杀子会话（`tools.js:448-451`）→ 账本与真实会话可能不一致；README「重复派工守卫的边界」自述此风险 |
| 验证状态 | **NOT RUN（无实现）**；单测只覆盖「activation 抛错 → run failed」（`dispatch-plan.test.js`） |

### S11 用户中途改需求

| 项 | 内容 |
|---|---|
| 触发 | worker 执行中老板说「不这么做，改成 X」 |
| 账本事件 | requirement/spec/plan 只有 append（无 update/replace/delete 事件，`work-store.js:40-57`）；只能新建 requirement/spec/plan；在途 task 的 `acceptanceCommands` 不可改（task-engine spec 校验 + append-only；无 update 工具） |
| 系统状态 | 新旧任务并存；旧 run 继续写同一项目；没有 supersedes/版本关系；plan_dispatch 的依赖只能引用任务 id |
| 用户可见/下一步 | 对话里解释；任务板旧任务与新任务并列，没有「已废弃/被替代」标签；老板无法一键终止旧任务 |
| 缺口 | **P0-1** 取消/替代在途任务的能力缺失（见 S12）；**P1-13** 面板无需求/规格视图与变更记录；**P2-20** requirement 无生命周期、无「需求被新版本替代」字段（plan 只存 requirementId/specId，`work-store.js:1120-1127`） |
| 验证状态 | **NOT RUN（仅设计层面的 append-only，无真机/单测场景）** |

### S12 回滚 / 取消

| 项 | 内容 |
|---|---|
| 触发 | 老板说「这个别做了」/「回滚」 |
| 账本事件 | **无**。工具面没有任何 cancel/rollback：`ROLE_TOOLS` 无 cancel（`roles.js:78-96`）；`tools.js` 无 transition 到 canceled；task-engine 迁移表允许 canceled（`task-engine/lib/index.js:35-43`）但产品面无人调用；唯一近似是 `superbot_run_finish status='canceled'`（`tools.js:437-451`），只关闭账本 run |
| 系统状态 | 任务仍 todo/in_progress；子会话可能继续运行并写 report/claim（`submitReport`/`taskClaim` 不校验 run 是否为 canceled）；没有「任务已取消」事件 |
| 用户可见/下一步 | 面板无法取消；只能等任务结束，或经理手动 `run_finish`（子会话还在跑）；回滚代码不由本系统负责（需要新任务） |
| 缺口 | **P0-1** 取消/回滚能力缺失（账本状态机支持但产品面未暴露；且没有「取消原因/谁取消」字段）；**P2-21** run_finish 与实际子会话不一致；**P2** plan/requirement 级取消也没有 |
| 验证状态 | **NOT RUN（无实现）** |

### S13 新项目未盘点（已有确认后新建 workspace）

| 项 | 内容 |
|---|---|
| 触发 | 首次盘点已确认；用户新建一个 workspace 并在其中建任务 |
| 账本事件 | `plan/created`/`task/created` 可以写入（`createPlan` 不校验 projectId 在 inventory，`work-store.js:1079-1129`）→ dispatch 被拒：`project ... has not been confirmed ... (reason: project-not-confirmed)`（`dispatch-tools.js:226-234`）；`plan_dispatch` 的 ready 计算**不** skip 未确认项目（只 skip 已确认的 paused/archived，`planning-tools.js:77-81`）→ 会在 dispatch 阶段变成 `failed[]` 行（`planning-tools.js:307-320`） |
| 系统状态 | 任务 todo 不能派；项目行 badge「未确认」（`client.js:696-700`）；overview `confirmedStatus=null` |
| 用户可见/下一步 | 面板「首次接入盘点」在已有确认时**只显示一行状态**（`client.js:450-460`），**没有重新盘点/确认按钮**；唯一路径是回对话让 Manager 调 `superbot_onboarding_confirm`（approval）。且 `confirmInventory` 最新快照**整体覆盖**（`work-store.js:841-886`），只确认新项目会让旧项目全部变未确认 → 旧项目派工也被锁 |
| 缺口 | **P0-5** 面板无重新盘点/增补确认入口（gate 卡死且不可自助恢复）；**P0-5b** confirm 是全量替换语义、无 merge/版本 → 误操作会锁住其它项目；**P1-16?** plan_create 不提前校验 projectId 在 inventory/已确认（到 dispatch 才失败）；**P2-8?** 未确认任务在 UI 的 phase 仍是 queued，无「为什么不能派」原因 |
| 验证状态 | 单测 PASS（dispatch gate / plan readiness / onboarding confirm）；真机首次盘点 S6 PASS；**新增项目增补 = NOT RUN** |

### S14 多 manager 会话

| 项 | 内容 |
|---|---|
| 触发 | 用户开两个 `superbot-manager` 会话，共享同一账本派工/验收 |
| 账本事件 | 同进程同一 `WorkStore` 同步 append（seq 单调）；跨进程由 `instance.lock` 挡住（`work-store.js:162-232`；`work-store-lock.test.js` PASS）；run 记录 `parentSessionId`（`dispatch-tools.js:294`），但任务/plan 不绑定经理会话 |
| 系统状态 | 任务级 active-run / terminal 守卫可防重复派工/重复验收；项目互斥只在 plan 路径；两个经理可重复创建 requirement/plan，或同时推进同一任务的不同阶段（后到者按状态机报错） |
| 用户可见/下一步 | 面板 manager 会话列表来自 onboarding 扫描（`client.js:1217-1231`），可打开最近会话；线程表**不显示** `parentSessionId`（`overview.js:170` 有字段，`client.js:589-613` 未渲染） |
| 缺口 | **P1-14** 多 manager 并发无冲突检测（重复 plan/requirement），run 归属在 UI 不可见；**P2** 多 manager 压力未验证；**P2-23** onboarding `sessionDirName` 与宿主 projectKey 在中文/空格路径可能错配（盲测已指出，INTEGRATION §2） |
| 验证状态 | 单测 PASS（文件锁/并发抢锁）；**多 manager 并发闭环 = NOT RUN**（S5 §8.6、P1 §5.5 自述未验证） |

---

## 3. 审计因果链：能否从账本完整重建？

### 3.1 四层链逐段核对

| 层 | 事件/字段 | 写入者 | 绑定强度 | 缺口 |
|---|---|---|---|---|
| L1 claim（worker 声明） | `report/submitted`（`reportId/taskId/runId?/author/summary/evidence[]`，`work-store.js:711-726`）；`task/transition`(todo→in_progress, actor=owner) | worker（任意会话可调） | **弱**：`taskId`/`runId` 都是调用参数；`runId` 只校验存在、不校验归属；无 `exec.agent.id` 绑定；无 taskVersion；无 childId | **P0-6**；report 非 policy 必需；`run/finished.summary` 可替代但不在 report 集合里 |
| L2 evidence（机器事实） | `evidence/recorded`：`evidenceId/seq/taskId/projectId/runId/childId/ownerRunId/taskVersion/index/command/exitCode/expectedExitCode/timedOut/durationMs/outputDigest/outputPath/preview/workspace+protected digest/sandbox*`（`work-store.js:749-803`） | 仅 verifier 会话的 `acceptance_run`（`tools.js:454-546`） | **强**：run 必须是绑定该 task 的 verifier run 且在 running；命令逐字等于账本声明；childId 必须匹配；ownerRunId=当前 attempt | 无 `reportId` 关联（不要求有 claim）；无「谁发起审计」的 manager session（可用 parentSessionId 推断） |
| L3 verdict（独立裁决） | `review/submitted`(source=verifier)：`runId/childId/evidenceIds/reviewerRole/reviewedOwner/ownerRunId/seq/notes/verdict`（`work-store.js:909-974`） | verifier 会话（run 由 childId 解析，不接受模型传 runId，`tools.js:548-584`） | **强**：pass 必须引用本 run 的证据且覆盖全部命令；fail 不要求证据 | fail 可仅文字（可接受，但 rework brief 失败证据会空）；无 `attemptId` |
| L4a policy | `review/submitted`(source=policy)：`decision{mode,reasons}/evidenceIds/reviewerRole=manager/reviewedOwner/ownerRunId` | Manager 调 `task_review`（账本自查，不信任参数） | **强**：acceptance 事实取 task 快照/账本，不接受 risk/tags 参数（`tools.js:164-290`） | integrity 原因码很多（9 种）但在 L4b 的 UI 词典缺失 |
| L4b human | `review/submitted`(source=human) + `task/transition`(done, actor=human) + task 快照 `acceptedBy='human'/acceptedAt/acceptanceVia/acceptanceNote`（`task-engine/lib/index.js:344-372`；`work-store.js:981-997`） | 仅宿主 approval 或 HTTP（默认关闭） | **强**：无 agent 工具直达（`tools.js:292-321` 的 approval seam） | 无 person/身份字段（单用户设计可接受）；面板按钮与 approval 是两套入口 |

### 3.2 重建结论

- **证据→verdict→policy→acceptance 这条主链可以从账本完整重建**：事件带 `seq`、`runId/childId`、`evidenceIds`、`evidence/recorded` 带 `ownerRunId/taskVersion/digests`，policy/human 验收字段在事件+task 快照里，顺序由 append seq 决定。
- **但有 4 个「断点」会让因果链不完整**：
  1. **claim 环节可缺失且不可信来源**：policy 不要求 `report/submitted`；report 的 runId 不校验 task 匹配、不与 `exec.agent.id` 绑定（P0-6）。
  2. **attempt 不是一等实体**：attempt 只能由「第几次 worker run + ownerRunId 匹配」推断；没有 `attemptId`、没有 `run/rework-of` 事件；`task_rework` 的 `reworkOf` 只在工具返回值里（`dispatch-tools.js:486`），不落账（P2-18）。
  3. **审计开始/结束/卡住无事件**：只能由 run 状态推断；run 失败/未收尾/超时没有对应事件，导致 UI 无法区分「审计中」「等经理派审计」「审计已死」（P0-2/P0-3）。
  4. **取消/替代/阻塞原因无事件**：`blocked/canceled` 状态可由 task-engine 表达，但产品面没有入口，也没有 reason 字段；waitpoint 未接线（P0-1/P2-17）。

### 3.3 自动审计的状态判定（账本推导 vs 当前实现）

| 语义状态 | 账本判定（建议的唯一定义） | 当前实现 | UI 应显示 |
|---|---|---|---|
| 待开始 | task `draft/todo` 且无 active run | `queued`（`task-phase.js:81`） | 待开始/等待派工；若因依赖/项目挂起，显示原因 |
| 执行中 | 存在 active `superbot-worker` run 且 task ∈ {todo,in_progress} | `executing`（`task-phase.js:74-75`） | 执行中 + 谁在执行 + 已运行时长 + 最后活动 |
| **等待派审计**（缺失） | 有 finished worker run、无 active run、无该 attempt 的 verifier run、task 仍 in_progress | 被归入 `auditing`（`task-phase.js:77-79` 的 reason 反而是「等待自动审计派工」） | **需经理行动**/「等待自动审计」——不能显示为「审计中」 |
| 审计中 | 存在 active verifier run | `auditing`（`task-phase.js:74`） | 审计中 + verifier 线程 + 证据进度 |
| 等待裁决 | latest verifier pass + coverage complete，但无 source=policy review（未调 `task_review`）且 task in_progress/in_review | 归入 `auditing`（`task-phase.js:76-78`） | 等待 Manager 裁决 → 或系统自动触发（P0-3） |
| 转人工 | task `in_review` 且 `humanWaitReason` 非空（6 种 code） | `needs-you`（`task-phase.js:68-70` + overview `pendingHuman`） | 需你决定 + 具体原因 + 证据完整性 |
| 返工 | 该 **attempt** 的 latest verifier verdict=fail 且无 active run | `rework`，但用的是全局 latest（`task-phase.js:71-73`） | 返工 + 为什么失败 + 第几次尝试 + 返工入口 |
| 完成 | task done（acceptedBy policy/human） | `done` | 已完成 + 通过方式（自动/人工） |
| 取消/阻塞 | task canceled/blocked | 有 phase 但 UI 无泳道（`client.js:878-885` 缺两项） | 已取消/阻塞 + 原因/谁操作的 |
| **异常（缺失）** | 存在 failed run 且任务未完成；或 run 长期 running 超过阈值；或重试无进展 | 无（会误标 executing/auditing） | 异常/卡住 + 可执行动作（重试/收尾/取消） |

**「审计进行中」的三种现实**（当前 UI 无法区分，这是 P0）：① verifier 真在跑命令；② worker 已交付但没人派 verifier（纯等经理）；
③ 裁决已完成但没人调 `task_review`（等经理）。三者都显示「审计中」。

---

## 4. 给 UI 的场景要求

### 4.1 任务卡片（结果导向）应显示什么

以「3 秒回答：现在结果是什么 / 正在做什么 / 谁在做 / 下一个 gate / 需不需要老板」为标准：

| 槽位 | 建议内容（来源字段） | 反例/当前问题 |
|---|---|---|
| 当前结果 | phase + **一句话结果**：审计结论 `pass/fail/pending` + 证据 n/N + 是否达标（`task.audit.*`） | 现在只有「审计证据 1/2 · 结论 fail」，没有「失败：第 2 条命令 exit 1」 |
| 正在做什么 | 动作：执行中/审计中/等待你验收/返工中/卡住；**是否有真实活动**（run 最后活动时间/已运行时长） | 无最后活动；`updatedAt` 是任务更新时间，不是 run 心跳 |
| 谁在做 | Manager 会话（parentSessionId）、worker/verifier 线程短号、是否有人接手 | 只有 `owner` 短号/线程按钮；manager 会话不显示 |
| 下一个 gate | 「等 verifier」「等你验收」「等 Manager 返工/收尾」「无需操作」 | `phaseNext` 有文案但语义混（审计中=可能是等经理） |
| 需不需要老板 | 是否 `in_review` + `need-you` 原因；是否需要批准 | 只靠 phase 颜色；默认 httpHumanActions=false 时「需在对话中批准」只出现在队列行 |
| 风险/失败痕迹 | 高风险/人类标签、失败原因、证据不足、卡住 N 分钟、第 N 次尝试 | 标签词典不全，完整性 reason 机器码直出 |

### 4.2 各类状态的文案建议（中文、结果导向、不恐吓）

| 状态 | 卡片主文案 | 副文案（原因） | 主操作 |
|---|---|---|---|
| 执行中 | 执行中 · 已运行 12 分钟 | worker `worker · 2d193253` 正在改 `<project>`；最后活动 2 分钟前 | 打开线程（只读观察） |
| 等待审计派工 | **需经理派审计** | worker 已交付但还没有审计线程；这条不会自己开始 | 打开经理会话（预填「对 t-12 派 verifier」） |
| 审计中 | 审计中 · 证据 2/3 | verifier 正在执行第 3 条验收命令 | 打开验收线程 |
| 需你决定 | **需你验收** | 证据齐备/策略要求人工：高风险、涉及审美；通过会记入账本 | 通过验收 / 要求返工（二次确认） |
| 返工 | **返工中** | 上一轮审计失败：第 2 条命令 exit 1（evidence ev-…）；第 2 次尝试已派 worker | 打开返工线程 |
| 已完成 | 已完成 | 自动验收（低风险）或 人工验收 via approval | 查看审计链 |
| 卡住 | **疑似卡住** | 执行线程 45 分钟无新活动；可能子会话已断开 | 收尾并重试 / 取消任务（二次确认） |
| 审计失败但无人处理 | **审计失败待处理** | verifier 结论 fail，但还没有返工线程 | 要求返工 |
| 阻塞/取消 | 已阻塞/已取消 | 原因（谁、为什么、时间） | 重新激活（P2） |
| 项目挂起/未盘点 | 无法派工 | 项目未确认/已挂起；去确认盘点 | 重新盘点/确认 |

### 4.3 任务详情应展示的「因果时间线」（当前完全没有）

建议抽屉改为「时间线 + 证据」两区，全部来自账本事件（按 `seq` 排序，绝对时间可展开）：

1. **意图**：需求原文摘要 → spec 摘要 → plan（`requirement/created`、`spec/recorded`、`plan/created`）。
2. **派工**：run `r-N`（worker）由经理会话 `<parentSessionId 短号>` 派出，项目 `<ws>`，cwd，工作区基线 digest 短号；`run/started`。
3. **认领（claim）**：`task/transition` todo→in_progress，actor=`r-N`；若缺失，标注「无 claim 记录（审计链断点）」。
4. **执行报告（claim）**：`report/submitted` 的 summary + 自述 evidence[]（明确标注「自述，不是验收证据」）。
5. **run 收尾**：`run/finished` status/summary；若仍是 running，标注「未收尾（可能卡住）」。
6. **审计派工**：verifier run `r-M`（`run/started`，parentSessionId）。
7. **机器证据**：逐条 `evidence/recorded` 行：`[index]` command、`exitCode`/expected、`timedOut`、耗时、digest 短号、artifact 路径（可下载/展开预览）、sandbox/isolation 标签。
8. **裁决**：`review/submitted`(verifier)：pass/fail/pending、notes、引用的 evidenceIds、reviewer、seq。
9. **policy 裁决**：`review/submitted`(policy)：自动/转人工 + reasons（中文 humanize）+ integrity 明细。
10. **验收**：`task/transition` done（actor=policy/human；human 显示 via/note/时间）。
11. **返工链**：若存在下一 attempt，显示「第 N 次尝试 ← 因 rv-… fail 返工」，可切换历史 attempt（需要服务端补 attempt 视图）。

**服务端需要新增的数据契约**（当前 `/superbot/overview` 只给聚合，`overview.js:271-311`；`/superbot/status` 无任务详情）：
- `GET /superbot/tasks/:id`（或 overview 内可选 `include=timeline`）：返回 `task + runs[] + reports[] + evidence[] + reviews[] + transitions[]`，
  每条只给渲染必需字段，限制数量（如最近 100 条事件、每证据 preview ≤2000 字），全部按 `seq` 升序。
- 或在 overview tasks 行上增加 `timelineUrl` / `auditChain`（事件 id 列表，面板按需拉取）。
- 建议同时给 `attempts[]`：`{ attemptIndex, workerRunId, verifierRunId, verdict, evidenceIds, startedAt, endedAt }`（可由 run + review 推导，需在服务端固化）。

### 4.4 phase / 标签字典（建议与后端 `task-phase.js` 对齐）

**Phase（8+2 项）**：

| code | 中文 | tone | 账本推导（唯一依据） | 老板可做 |
|---|---|---|---|---|
| `queued` | 待开始 | idle | task draft/todo，无 active run | 无（等派工）；因依赖/项目挂起时显示原因 |
| `executing` | 执行中 | business | 有 active worker run | 打开线程；收尾/取消（若支持） |
| `auditing` | 审计中 | business | 有 active verifier run | 打开验收线程 |
| `awaiting-manager`（新增） | 待经理推进 | warn | worker 已结束 / verifier 已 pass，但无人派审计或裁决 | 一键「继续」（打开经理会话并发起下一步） |
| `needs-you` | 需你决定 | warn | task in_review 且 humanWaitReason 非空 | 通过验收 / 要求返工（二次确认） |
| `rework` | 返工 | danger | **当前 attempt** latest verifier fail 且无 active run | 打开返工线程/要求返工 |
| `done` | 已完成 | success | task done | 查看审计链 |
| `blocked` | 阻塞 | danger | task blocked | 解除阻塞（P2） |
| `canceled` | 已取消 | idle | task canceled | 无 |
| `stalled`（新增） | 疑似卡住 | danger | active run 超过阈值无新事件（需要 run heartbeat/lastActivity） | 收尾/重试/取消 |

**标签（可行动、少而稳）**：
- 证据：`证据 2/3`（passed/total）；`结论 pass|fail|pending`；`第 N 次尝试`；`无机器验收命令（必转人工）`。
- 需你原因（现有 6 种，保持）：`等待验证`、`验证未通过`、`证据不完整`、`策略要求人工验收`、`验收环境不可信`、`等待人工验收`。
- **需补齐的中文映射**（当前 `REASON_CODE_HUMAN` 缺失，会原样显示机器码，`client.js:220-231`）：
  `no-worker-attempt=没有真实执行记录`、`unsandboxed-evidence=验收未在沙箱执行`、`in-place-evidence=验收直接在项目目录执行`、
  `acceptance-harness-changed=验收脚本/测试被改动`、`workspace-changed-since-evidence=验收后文件又变了`、
  `workspace-scan-truncated=项目过大无法完整校验`、`project-unresolved=项目找不到`、`no-workspace-fingerprint=缺少工作区指纹`、
  `verifier-sandbox-full-access=验收环境不可信`。
- 风险：`高风险`、`涉及审美/设计/文案/安全/权限/凭据`、`不可逆`、`有外部副作用`。
- 项目：`未确认`、`已挂起`、`已归档`、`历史（已离开清单）`。
- 线程：`执行 · t-12`、`验收 · t-12`、`进行中/完成/失败/取消`。
- 动作：`通过验收`（风险用例 `仍要通过验收…` 二次确认）、`要求返工`（新增）、`取消任务`（新增，二次确认+原因）、
  `收尾并重试`（新增，针对 stalled）、`请求老板批准`（新增，httpHumanActions=false 时替代禁用按钮）。

### 4.5 防误操作规则（不能一键代替审计）

1. **「通过验收」只出现在「需你决定」队列 + 任务详情**；默认 `httpHumanActions=false` 时按钮不可用，显示「请求老板批准」而不是灰按钮（当前显示 Pill「需在对话中批准」，可接受但要给出动作）。
2. **风险/证据不足的验收必须二次确认**：队列里已有（`client.js:527-536`），但 **TaskDrawer 没有**（`client.js:983-986`）——必须补齐同规则。
3. **验收前必须能看证据**：在抽屉里展示逐条证据与预览；证据不全/审计中时禁用「通过验收」，改为「仍要通过验收…」二次确认（并明示会覆盖缺失证据、记入账本）。
4. **要求返工**必须填写原因（写 `review/submitted` notes 或新事件），不能是「一键打回」空动作。
5. **取消任务**必须二次确认 + 原因 + 说明「已执行的改动不会自动回滚」。
6. **不允许**在任务卡片上直接出现「完成/通过」按钮（现在没有，保持）；完成任务只能走 policy/human 两条账本路径。
7. **不展示看似可点的假动作**：默认关闭 HTTP 人工入口时，不能用「通过验收」再弹 403；应前置提示路径（对话 approval）。
8. **审计中/卡住时禁用验收**：避免老板在 verifier 还在跑时覆盖结论（目前服务端只要求 in_review，未检查 active run）。

---

## 5. 缺口清单（P0 / P1 / P2）

> 编号与 §2 对应；「验证」列是建议的最小验证方式。file:line 以 §附录 A 快照为准。

### P0（下一版必须修，否则真实使用会卡死或误验收）

| # | 缺口 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| P0-1 | **没有取消/回滚**：无 task/plan/requirement 取消工具与路由；`run_finish canceled` 不停子会话 | `roles.js:78-96`；`tools.js:437-451`；task-engine 迁移表 `task-engine/lib/index.js:35-43`；S5 报告无取消验证 | 老板说「别做了」时系统无法执行；幽灵子会话继续跑 | 增加 `superbot_task_cancel(id, reason)`（manager→canceling→canceled，写 reason/actor/时间；有 active run 时同时标记 run canceled 并尽量 abort child）；`task/supersededBy` 字段 |
| P0-2 | **卡住/超时不可检测、run 不收尾**：`wait:false` 后 run 永久 running；无 heartbeat/timeout 事件与阈值 | `dispatch-tools.js:342`；`work-store.js:40-57`；README「重复派工守卫的边界」 | 一次卡死会堵塞该任务的验证/返工/重派；UI 永远「执行中」 | run 增加 `lastActivityAt/heartbeatAt`；dispatch 注册超时收尾（如 30–60min 未结束→run failed + attention）；或至少 UI 显示「最后活动/已运行时长」并给「收尾并重试」动作 |
| P0-3 | **自动审计无驱动**：worker 完成/verifier pass 后无人自动派 verifier / 调 task_review | `dispatch-tools.js:342-359`；`index.js:145-183` 只有 dedupe hook；`tools.js:164-290` 需 manager 调用 | 「自动审计」名不副实；用户不说「继续」流程就停住 | 二选一：①真自动（run/finished 钩子 → 自动派 verifier + 自动 task_review，受 wipLimit/项目互斥约束）；②在 UI 明确标「待经理推进」并给一键继续 + 通知。推荐先做②+可选① |
| P0-4 | **direct dispatch 绕过项目单写者**（已知残余） | `dispatch-tools.js:222-252` 无项目 active 检查；`planning-tools.js:288-302` 只有 plan 路径；INTEGRATION §2 | 两个 worker 同时写同一项目 → 冲突/丢改动 | 把项目互斥检查移到 `createDispatcher.dispatch()` 内部（所有入口共享），并在 plan_dispatch 里复用同一函数 |
| P0-5 | **盘点确认 UI 死锁**：已有确认后无重新盘点/确认按钮；confirm 全量替换 | `client.js:450-460`（确认态无动作）；`work-store.js:841-886`（latest wins，无 merge）；`dispatch-tools.js:226-234` | 新建项目后无法在面板恢复调度；误确认锁旧项目 | 面板增加「重新盘点/确认新项目」入口；`confirmInventory` 支持 merge（按 projectId 更新，保留未提交项目）或返回 diff 让人确认；dispatch 错误给出面板路径 |
| P0-6 | **claim 层不可信/可缺**：report 的 runId 未绑定会话与 task；policy 不要求 report | `work-store.js:711-726`（无 run-task 校验、无 session）；`tools.js:322-349`（taskReport 无 exec 绑定）；`tools.js:180-290` 不检查 report | 审计链「worker 声明」缺环；可伪造归因/无报告也能自动 done | worker 工具也用 `exec.agent.id` 解析 run（类似 verifier 的 `findRunByChildId`）；`submitReport` 校验 run.taskId===taskId；policy 对自动验收要求存在该 attempt 的 report（或明确允许 run summary 并在 UI 标注） |

### P1（真实使用体验/可审计性缺陷）

| # | 缺口 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| P1-7 | 面板无「要求返工/驳回」；`needs-you` 文案却写「通过/驳回」 | `client.js:878-885`、`506-560`、`944-988`；`task-phase.js:69` | 不合格交付只能回对话；人无法留驳回原因 | 增加 `superbot_task_reject`/面板「要求返工」：写 human review(fail) + rework 事件（与 P0-1 的取消区分）；TaskDrawer 加按钮 |
| P1-8 | phase 判定错误：rework 未按 attempt 过滤；blocked/canceled 无泳道 | `task-phase.js:71-75`；`client.js:878-885` | 返工派新 worker 后仍显示「返工」；block/cancel 任务消失 | `deriveTaskPhase` 用「当前 attempt 的 latest review」；泳道补 blocked/canceled/awaiting-manager/stalled |
| P1-9 | 任务详情无因果时间线/证据明细 | `client.js:944-988`（只有 11 行摘要）；`overview.js:271-311`（无 reports/evidence/reviews 明细）；无 task 详情路由（`index.js:367-371`） | 老板无法审核证据；失败原因不可见 | 按 §4.3 新增 `GET /superbot/tasks/:id` + 抽屉时间线/证据区；先只读 |
| P1-10 | 无「必须声明机器验收命令」约束/提示 | `tools.js:63-73`（可选）；`planning-tools.js:204-215`（可选）；只有 compose 预测 | 低风险任务也可能永久人工，老板预期落空 | plan_create/task_submit 对 risk=low 且无 acceptanceCommands 给明确警告（或硬要求）；任务卡加「无机器验收命令→必人工」标签 |
| P1-11 | policy 转人工原因词典不全 | `client.js:220-231` vs `tools.js:203-254` 的 integrity 列表 | 老板看到 `no-worker-attempt` 等机器码 | 补齐 §4.4 中文映射；服务端直接输出可读 reason 或 code+label |
| P1-12 | 无异常/急停队列：attention 只含 in_review | `overview.js:132-157`；`task-phase.js` 无 failed/stalled | run 失败/审计死/卡住都不会提醒老板 | overview 增加 `attention` 类型（run-failed/stalled/awaiting-manager），面板「待你处理」分组展示 |
| P1-13 | 需求/规格/compose 草稿不可见、无与 plan 关联 | `client.js:1217-1231`（只列会话）；`client.js:133-134`（localStorage）；`work-store.js:1020-1030`（status 恒 submitted） | 「我到底要了什么」在面板无记录 | 面板加需求/规格只读视图；compose 生成时返回 `requestId`/草稿 id，manager 建 plan 时引用 |
| P1-14 | 多 manager 无冲突检测、run 归属不可见 | `dispatch-tools.js:294`（记 parentSessionId）；`client.js:589-613` 未显示；plan/requirement 无唯一性 | 两个经理重复建计划/互相覆盖阶段；排障难 | 面板线程显示「经理会话」；plan_create 对同一 requirement 的多个 plan 给确认；可加乐观版本 |
| P1-15 | 项目隔离校验不全：plan 不校验 task.projectId 与 requirement/project 一致、不校验 dep 同项目 | `work-store.js:1079-1129`；设计文档 §3.3 不变量 2 | 跨项目任务/依赖混入，破坏隔离 | `createPlan` 校验 requirement.projectId===task.projectId（或显式允许跨项目并标注）；dep 需同项目或显式跨项目标记 |
| P1-16 | 新项目到 dispatch 才失败，plan/ready 阶段不提示 | `planning-tools.js:48-93` 不检查未确认；`planning-tools.js:307-320` 变 failed 行 | plan_dispatch 返回零散 failed；排查成本 | `selectReadyPlanTasks` 增加 `project-unconfirmed` skip reason；UI 显示原因与确认入口 |

### P2（下一轮打磨）

| # | 缺口 | 证据 | 建议 |
|---|---|---|---|
| P2-17 | waitpoint/blocked 设计未接线 | task-engine `createWaitpoint`（`task-engine/lib/index.js:217-240`）在 dsh-superbot 零引用；无 waitpoint 事件 | 若要「为什么等」结构化，增加 `waitpoint/created|resolved` 事件 + UI「待决定」卡 |
| P2-18 | attempt 无一等实体，reworkOf 不落账 | `dispatch-tools.js:486` 仅返回值；`run/started` 字段无 reworkOf/attempt | run 加 `attemptIndex/reworkOf`；或新增 `attempt/started` 事件 |
| P2-19 | 缺 heartbeat/timeout/cancel/audit 事件 | `work-store.js:40-57` | 与 P0-1/P0-2 一起补事件 |
| P2-20 | requirement 生命周期缺失 | `work-store.js:1026`（恒 submitted）；无 requirement 状态迁移 | `requirement/status` 或事件（submitted→planned→superseded） |
| P2-21 | run_finish 与实际子会话可能不一致 | `tools.js:448-451`；`submitReport` 不校验 run 状态（`work-store.js:711-726`） | run_finish 校验/记录来源；对已收尾 run 的报告标注 stale |
| P2-22 | UI phase 集合与服务端不同步 | `client.js:878-885` vs `task-phase.js:17-26` | 从服务端下发 phase/label/tone 字典，客户端只渲染 |
| P2-23 | onboarding 会话目录映射可能错配（中文/空格路径） | `onboarding.js:39-44` `sessionDirName`；盲测 INTEGRATION §2 | 用宿主 projectKey/registry 映射；无法映射时降级并标注 |
| P2-24 | 同项目多 active worker 无 UI 警告 | 无渲染/校验 | 项目行/任务卡加「同项目并发」提示（修 P0-4 后可移除） |
| P2-25 | 列表上限/分页：overview tasks 200 行、openTasks 20 行、threads 未截断 | `overview.js:198, 271-311` | 任务详情按需拉取；面板分页 |

---

## 6. 验证状态表（PASS / FAIL / NOT RUN + 验证对象）

| # | 验证对象 | 状态 | 证据/说明 |
|---|---|---|---|
| 1 | 当前 dsh-superbot 单测（`node --test test/*.test.js`） | **PASS** | 本次实测 143 pass / 0 fail / 33 suites（2026-11-07T12:5x） |
| 2 | task-engine 单测 | **PASS（继承昨日基线；本次未重跑）** | 2026-11-06 实测 18/18；本任务未改动 task-engine |
| 3 | 证据链结构约束（命令白名单/证据引用/会话绑定/seq/沙箱/指纹） | **PASS（单测）** | `review-isolation.test.js`（证据门/重放/沙箱/指纹/最新裁决）；`work-store-lock.test.js` |
| 4 | 审核隔离全链 + 双项目 + 人工验收面板 | **PASS（真机 S5）** | `（历史验收证据已归档，不在本仓库）`（37 事件/4 子会话/截图） |
| 5 | 首次接入盘点 + 先盘点后调度 + 10 段 brief | **PASS（真机 S5.1）** | `（历史验收证据已归档，不在本仓库）` |
| 6 | 失败→返工→再审闭环 | **NOT RUN（真机）**；单测 PASS | S5 §8.5「未验证」、P1 §5.3；`review-isolation.test.js` 有 requeue 单测 |
| 7 | approval 弹窗人工验收真机路径 | **NOT RUN** | S5 §8.4 明确只有单测 |
| 8 | 多 manager 会话并发写/并发调度 | **NOT RUN** | S5 §8.6、P1 §5.5；只有进程内同步 append + 跨进程锁单测 |
| 9 | 同项目 direct dispatch 竞争（单写者） | **NOT RUN（无测试）** | INTEGRATION §2 剩余 P0；代码 `dispatch-tools.js:222-252` |
| 10 | worker 卡住/超时/自动收尾 | **NOT RUN（无实现）** | 无 heartbeat/timeout 事件与代码（§2 S10） |
| 11 | 任务取消/回滚 | **NOT RUN（无实现）** | 无工具/路由（§2 S12） |
| 12 | 中途改需求（supersede 在途任务） | **NOT RUN** | append-only 设计，无场景验证 |
| 13 | 新项目（已有确认后新增 workspace）盘点/派工恢复 | **NOT RUN** | 首次盘点真机 PASS，增补场景无记录；UI 无入口（`client.js:450-460`） |
| 14 | 非法验收命令真机拒绝 + 无命令任务转人工体验 | **NOT RUN** | 白名单为 P1 后新增，只有单测 |
| 15 | UI 任务详情因果时间线 | **FAIL（不存在）** | `client.js:944-988` 无时间线/证据明细；无 task 详情 API |
| 16 | UI 驳回/返工动作 | **FAIL（不存在）** | `client.js:506-560, 944-988` 只有通过验收 |
| 17 | blocked/canceled 任务在面板可见 | **FAIL（泳道缺失）** | `client.js:878-885` 无 blocked/canceled lane |
| 18 | 新 phase 推导（`task-phase.js`）测试 | **FAIL（无测试）** | test/ 内无 `deriveTaskPhase`；当前 143 测试未覆盖 |

> 说明：FAIL 只用于「验证对象明确失败/缺失」；不存在的能力用 NOT RUN（无实现）；单测与真机状态分开标注，未把单测 PASS 冒充真机 PASS。

---

## 7. 附：本次场景走查的关键事实索引（便于其它专家/实现者复核）

- 事件种类：`work-store.js:40-57`；事件投影/完整性：`work-store.js:264-368`；append/seq：`work-store.js:498-518`。
- run 生命周期：`work-store.js:646-700`；dispatch 收尾分支：`dispatch-tools.js:320-359`。
- 证据写入校验：`work-store.js:749-803`；覆盖率：`work-store.js:806-837`；review 证据门：`work-store.js:909-974`。
- policy 决策/完整性原因：`tools.js:180-290`；人工验收：`tools.js:292-321`、`work-store.js:981-997`、`task-engine/lib/index.js:344-372`。
- 返工：`dispatch-tools.js:444-491`（`reworkOf` 仅返回值：486）。
- 派工闸门：`dispatch-tools.js:197-252`（项目盘点/已结束 worker/active run）；plan readiness：`planning-tools.js:48-93`。
- 自动审计状态推导：`task-phase.js:39-83`（新 WIP；无测试）；human 等待原因：`overview.js:34-67`。
- 面板：phase 泳道 `client.js:878-885`；卡片 `887-918`；任务板 `920-942`；抽屉 `944-988`；待你队列 `506-560`；盘点块 `448-501`；tabs `1369-1389`。
- 路由：`index.js:284-374`（overview/compose/accept/onboarding/status；无 task detail/cancel/reject）。
- 配置默认：`config.js:10-28`（`wipLimit=2`、`requireOnboarding=true`、`requireSandboxedEvidence=true`、`httpHumanActions=false`、`acceptanceIsolation='copy'`）。
- 已知残余（他方报告）：`（历史审计报告已归档，不在本仓库）` §2；`（历史验收证据已归档，不在本仓库）` §8；`P1-HARDENING.md` §5。

## 附录 A · 复审快照

- 时间：2026-11-07T12:53 ET；`git rev-parse HEAD` = `2dc8df1818d44607d37f7bd1d59480b80e16f158`（工作树有未提交改动）
- 复审窗口内被并发修改（mtime 12:49–12:50）：`lib/client.js`（sha256 `dc235d40…`）、`lib/overview.js`（`0a9392a3…`）、`lib/task-phase.js`（`3f95947d…`，untracked）
- 其它引用文件 sha256（前缀即可核对）：
  `work-store.js 28314df9…`、`tools.js 289da7cc…`、`dispatch-tools.js aa155acf…`、`planning-tools.js 1d34bf89…`、
  `index.js dfece5a2…`、`onboarding.js 6b7dc6e4…`、`task-engine/lib/index.js 1cc58617…`
- 若代码随后继续变动：先核对哈希；若不一致，行号需重新定位（建议实现者以函数名为锚点，而不是只用行号）。

## 8. 给 Lead 的 10 行摘要

```
1. 场景复审完成（14 场景矩阵 + 审计因果链 + UI 要求 + 缺口 P0×6/P1×13/P2×9），报告已写入 reports/expert-review-2026-11-07/scenario-audit.md。
2. 系统是"经理驱动的半自动流水线"：受限执行器+账本校验+policy 是自动的；派 verifier、调 task_review、失败返工、收尾 run 都要 Manager 主动调工具（无 hook/timer）。
3. 证据→verdict→policy→human 主链可从账本重建（seq/runId/evidenceIds/digests 齐全）；断点在 claim 层（report 可选、runId 未绑定会话/task）。
4. P0：取消/回滚缺失；卡住/超时不可检测且 wait=false run 永久 running 阻塞验证/返工；自动审计无驱动；direct dispatch 绕过项目单写者；盘点重确认 UI 死锁；claim 不绑定。
5. 返工闭环已实现且有单测，但真机未验证；reworkOf 只在工具返回值、未落账；phase 用全局 latest fail，返工后新尝试仍显示"返工"。
6. UI 只有任务卡/抽屉摘要，没有因果时间线：report 正文、逐条 evidence（命令/exitCode/耗时/digest/预览）、verifier notes、policy reasons、human note 全不可见。
7. 面板无"驳回/要求返工"、无"取消"、无"重新盘点"；needs-you 文案写"通过/驳回"但只有通过；抽屉"通过验收"缺少队列已有的二次确认（误操作风险）。
8. 标签：需补 9 种 integrity reason 中文（no-worker-attempt/unsandboxed-evidence/acceptance-harness-changed 等）；blocked/canceled 无泳道会消失；建议 phase 增 awaiting-manager/stalled。
9. 已验证：单测 143 PASS（task-phase 无测试）；真机 S5 审核隔离/双项目/人工验收、S6 盘点 PASS；NOT RUN：返工真机、approval 弹窗真机、多 manager、同项目竞争、卡住/取消/改需求/新项目增补、非法命令真机。
10. 建议优先级：P0-1/2/3（取消+超时收尾+审计驱动）→P0-4/5/6→P1 驳回+时间线+异常队列+phase attempt 过滤；明细见报告 §5。
```
