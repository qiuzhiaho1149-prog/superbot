# Superbot · 审核隔离与多项目多线程层级设计（v1）

- 日期：2026-11-06
- 触发：真机闭环验收（`（历史验收证据已归档，不在本仓库）`）暴露「Agent 互相审批自夸自满」与「多线程/多项目边界不清」
- 性质：**结构性设计**，不是提示词修补。落地在 `packages/dsh-superbot` 与 `packages/task-engine`，全部改动有单测与真机证据
- 结论先行：把「谁说、谁验、谁批」拆成四层不同主体，用**账本 + 受限执行器 + 证据引用**做结构性隔离；把「项目 / 线程 / 作业」做成显式层级，每个项目一个隔离边界，所有计数按项目投影

---

## 0. 问题：为什么 Agent 互审一定会自夸

真机跑完一次闭环后，审计账本里出现了这些问题（每条都有事件证据）：

| 现象 | 账本证据 | 根因 |
|---|---|---|
| worker 的「测试通过」是自己写的报告 | `report/submitted` 的 `evidence` 是字符串数组，由 worker 自填 | **claim 被当成了 evidence**；没有机器可复核的产物 |
| verifier 只能静态看文件 + 引用 worker 报告 | `rv-13` notes 明说「我无法独立复跑 node --test」 | verifier 没有执行能力，**独立验收名不副实** |
| manager 传 `verifierPassed:true` 就能 policy done | 旧 `tools.js` 不查账本，直接 `classifyAcceptance(verifierPassed: args.verifierPassed)` | **验收信任的是调用参数，不是事实** |
| review 的 reviewer 被记成 worker 的 runId | 旧 `task_review` 用 `args.owner` 当 reviewer/actor | 归因错误，审计上像**自审自受** |
| run 摘要抓到子代理的过渡独白 | `run/finished` summary 是 verifier 的思考文本 | 摘要函数把 reasoning 当答案 |

**深层原因不是模型坏，而是结构允许**：

1. **同一证据源**：worker、verifier、manager 读的是同一份「谁都能写」的工作区与同一段自然语言报告；
2. **同一裁决权**：验收结论由「一段话」触发，代码不校验这段话背后有没有事实；
3. **同一身份**：owner / reviewer / acceptor 三个角色在账本里可以指向同一个人；
4. **提示词约束**：靠「请不要自夸」这类文字约束，模型的合规率不可证明。

结论：**必须让"自夸"在结构上无效，而不是让模型"更诚实"**。

---

## 1. 设计原则

1. **信任分层**：claim（声明）≠ evidence（机器事实）≠ verdict（裁决）≠ acceptance（验收决定）。四层各有不同的写入者与校验规则。
2. **结构性防止优先**：能用代码拒绝的，不靠 prompt；能用账本校验的，不靠模型自述。
3. **验收与执行分离**：谁写代码谁不能验收；谁能验收谁不能改代码；谁能批准谁不能是 agent。
4. **单一事实源**：append-only 账本 `events.jsonl`；投影可丢可重建；报告/摘要只是视图。
5. **项目即隔离边界**：`projectId = DSH workspaceId`；任何越界（文件、任务、证据、依赖）在工具层拒绝。
6. **人只做决定**：低风险由策略验收（有审计、可重开），高风险/审美/证据不足强制人验；人类入口只有宿主 HTTP 面，agent 摸不到。
7. **不引入过度防御**：不做签名/区块链/分布式重放；在 DSH 插件约束内用「账本 + 本机受限执行」解决 90% 问题，残余风险显式记录。

---

## 2. 审核隔离：四层信任模型

```
┌──────────────────────────────────────────────────────────────────┐
│ L1 CLAIM（声明，可错/可夸大）                                      │
│   worker 报告：summary + 自测输出（字符串）                        │
│   写入者：worker 会话   校验：只做长度/结构约束                     │
└───────────────────────────┬──────────────────────────────────────┘
                            │ 不能直接升级为验收依据
┌───────────────────────────▼──────────────────────────────────────┐
│ L2 EVIDENCE（机器事实，不可自造）                                  │
│   evidence/recorded：command + exitCode + timedOut + digest       │
│   + artifact 路径 + runId + projectId + 时间戳                     │
│   写入者：唯一受限执行器 superbot_acceptance_run（verifier 专用）   │
│   校验：命令必须等于账本里 task.acceptanceCommands[index]；         │
│         执行者 run 必须是该 task 的 verifier run；worker 无此工具   │
└───────────────────────────┬──────────────────────────────────────┘
                            │ 必须被引用，不能口头通过
┌───────────────────────────▼──────────────────────────────────────┐
│ L3 VERDICT（独立裁决）                                             │
│   review/submitted：source=verifier, runId, evidenceIds[]         │
│   写入者：verifier 会话（读工具 + 受限执行器，无写文件/无 shell）   │
│   校验：pass 必须覆盖每条 acceptanceCommand 的通过证据；           │
│         证据必须由「本 verifier run」产生（不可复用别人的证据）     │
└───────────────────────────┬──────────────────────────────────────┘
                            │ 裁决不等于验收
┌───────────────────────────▼──────────────────────────────────────┐
│ L4 ACCEPTANCE（验收决定）                                          │
│   a) policy：账本自查（verifier pass + 证据齐 + risk low/可逆/    │
│      无外部副作用/无人类保留标签）→ done，acceptedBy=policy        │
│   b) human：POST /superbot/accept（浏览器信任栅栏）→ done，         │
│      acceptedBy=human，记录 note 与 acceptedAt                    │
│   禁止：任何 agent 工具都不能写出 done（task-engine 硬规则）       │
└──────────────────────────────────────────────────────────────────┘
```

### 2.1 新增/修改的账本事件

| 事件 | 谁写 | 关键字段 | 作用 |
|---|---|---|---|
| `evidence/recorded` | verifier 的受限执行器 | `evidenceId, taskId, projectId, runId, index, command, exitCode, expectedExitCode, timedOut, durationMs, outputDigest, outputPath, preview, createdAt` | 把「一次真实执行」变成不可自造的记录 |
| `review/submitted`（扩展） | verifier / policy / human | `reviewerRole, runId, evidenceIds[], reviewedOwner, decision, source` | 裁决必须引用证据；归因明确 |
| `task/transition`（done） | policy / human | `acceptedBy: 'policy' \| 'human'`, `acceptedAt`, `acceptanceNote` | 验收主体可审计 |

### 2.2 结构性约束清单（每条都在代码里强制）

1. `acceptanceCommands` 只能由 manager 在 plan/task 创建时声明，之后不可改（append-only）。
2. worker 角色没有 `superbot_acceptance_run`；即使有 worker run 也无法写 evidence（store 校验 run.agentPreset）。
3. evidence 的 command 必须**逐字等于**账本声明值；自由 shell 进不了证据链。
4. evidence 只能由「绑定到该 task 的 verifier run」写；worker run / manager run 一律拒绝。
5. verifier 的 `pass` 必须带 `evidenceIds`，且覆盖**全部** `acceptanceCommands` 索引；缺一条即拒绝。
6. evidence 必须由**提交 verdict 的那个 run** 产生；换 run 复用证据被拒绝。
7. `task_review` 不再接受 `verifierPassed` 参数；它只查账本（verifier pass + coverage）。
8. policy 自动验收还要求：`risk=low`、`reversible`、无外部副作用、无人类保留标签（美学/安全/迁移等）。
9. 不满足时任务停在 `in_review` 并返回 `waitingForHuman` + `blocking` 原因列表。
10. `done` 只有 `actor === 'human'` 或 `policy` 两条路；agent 工具无法调用 human 路径。
11. 人类验收走 `POST /superbot/accept`，与浏览器同源信任栅栏一致；agent 没有这个工具。
12. review 归因：verifier 记 `reviewerRole=verifier + runId`；policy 记 `reviewerRole=manager, reviewer=policy, reviewedOwner=owner`；human 记 `reviewerRole=human`。
13. **验收事实不可由 manager 传参覆盖**：`task_review` 没有 risk/tags/reversible 参数；risk 缺省按 `high`、reversible 缺省按 `false`（fail-closed），tags 只取任务快照。
14. **命令必须是单条无 shell 元字符的调用**：拒绝 `; && || | $ \` > <` 换行；`expectExitCode` 只允许 0（不允许"声明失败视为通过"）。
15. **裁决与证据必须来自同一个会话**：verifier 工具不接受模型传 runId，由 `exec.agent.id`（子会话）解析 run；store 校验 `session ↔ run ↔ childId`；review 只接受"本 run 产生"的 evidenceIds。
16. **最新裁决生效**：policy 取当前 attempt 的最新 verifier review；pass 之后出现 fail/pending 一律拒绝。
17. **工作区指纹**：dispatch 记录 `baselineProtectedDigest`；evidence 记录 `workspaceDigest/protectedDigest`；验收时重算，篡改测试或证据后改文件 → 强制人工。
18. **人类验收两条人类入口**：面板 `POST /superbot/accept`（`acceptanceVia=http`）与宿主 approval 对话框（`superbot_task_accept` → `via=host-approval`）——后者 agent 无法自答。
19. **验收命令固定 argv 白名单**：只接受无参数的标准命令（`node --test` / `npm|pnpm|yarn test` / `pytest` / `cargo test` / `go test ./...` / `make test|check` 等）；任何 flag/path/参数都会被拒绝（flag 可让 runner 零执行却 exit 0）。`plan_create` / `task_submit` / `acceptance_run` 三层校验；自定义检查只能写进项目 `package.json` 的 test 脚本。
20. **单实例文件锁（原子）**：`WorkStore` 用 `openSync(...,'wx')` 原子抢占 `<stateDir>/work/instance.lock`（pid + token + fsync）；并发启动时只有一个进程成功，其余拒绝激活；崩溃残留锁按 pid 存活检测接管；插件 dispose 释放。
21. **沙箱模式入证据**：verifier 执行验收命令时记录 `sandboxMode`；policy 验收时若任一证据来自 `danger-full-access`，强制转人工（`verifier-sandbox-full-access`），面板显示「验收环境不可信」；宿主无 `sandboxPolicy` 服务时记未知、不阻断（显式承认的残余风险）。
22. **必须存在真实 worker attempt**：verifier 派工要求该 task 已有**已结束的 worker run**；`task_review` 要求 `task.owner` 解析为 `agentPreset=superbot-worker` 且 `taskId` 匹配的 run，否则 `no-worker-attempt` 强制人工。manager 用字符串 owner 自 claim + 直派 verifier 不再能 auto-done。
23. **裁决按 append seq 排序**：review/evidence 记录写入事件的单调 `seq`，所有「最新裁决/最新证据」按数值 seq 取，不再用 `submittedAt/id` 字典序（同毫秒 pass→fail 不可颠倒）。
24. **盘点确认状态约束调度**：dispatch 前读 `confirmedProjectStatus`——`paused/archived` 永远阻断（无论 `requireOnboarding`），未确认项目在 gate 开启时阻断；plan readiness 同步 skip。
25. **D3 代码闸门**：workspace 路径包含 ledger stateDir 时拒绝派工（`ledger-inside-workspace`），不依赖部署文档自觉。
26. **验收执行走宿主 shell + 一次性副本**：`superbot_acceptance_run` 把工作树复制到临时目录（排除 .git/node_modules/dist 等，依赖树软链只读），在副本里用 `ctx.shell` + `sandboxPolicy` 执行，结束后删除副本；evidence 记录 `executionMode/sandboxed/sandboxMode/isolationMode`。裸 exec 或 `in-place` 结果在 `requireSandboxedEvidence`（默认 true）下强制人工。残余：同用户读权限与网络未隔离（需更强 sandbox runner）。
27. **HTTP 人工动作默认关闭**：`httpHumanActions=false` 时 `/superbot/accept`、`/superbot/onboarding/confirm` 返回 403，人类验收/确认只走宿主 approval 弹窗；显式开启才允许面板直连（opt-in，接受 cookie 伪造风险）。

### 2.3 残留风险（显式承认，不靠模型自觉）

| 风险 | 现状（S5 实测后） | 缓解 / 归属 | 是否结构性 |
|---|---|---|---|
| manager 声明弱验收命令（如 `true`） | **已缓解**：非标准测试命令在 `plan_create`/`task_submit` 直接拒绝，`acceptance_run` 二次校验；自定义检查只能写进项目 test 脚本（用户可审查） | `command-policy.js` | 结构性（无任意 shell） |
| TOCTOU：验收后改文件 | **已缓解**：evidence 记录工作区/保护路径 digest，验收时重算，变化→强制人工 | `workspace-snapshot.js` | 结构性 |
| 改测试变绿 | **已缓解**：dispatch 前记录验收 harness 基线（test/、package.json、lockfile），worker 改测试 → `acceptance-harness-changed` → 人工 | 同上 | 结构性 |
| verifier 与 worker 同一模型、"放水"不执行 | **已缓解**：pass 必须引用本会话 run 的 evidence（exitCode+digest）；不执行拿不到 evidenceId | ledger 校验 | 结构性 |
| 验收命令有副作用 | 在真实项目根执行；超时 120s、输出截断、env 剥离凭据类变量 | 下一步：一次性 worktree | 半结构 |
| 账本被同用户进程直接改 | `applyWorkEvent` 校验 from/version，简单伪造被忽略；**但 full-access 下可写"内部一致"的假链** | 依赖部署契约 D2/D3；本轮不宣称账本完整性 | 非结构（部署相关） |
| manager 自己改代码/伪造验收 | **已缓解（D1）**：manager 无 shell、fs 只读；人工验收走 approval/面板 | presets + tools | 结构性（D1 成立时） |
| cookie 被伪造为"人类" | 面板 HTTP accept 仍是 UI 便捷入口；agent 侧有 approval seam | D2 沙箱 + D1 无 shell；账本记录 `acceptanceVia` | 半结构 |
| 双实例同 DSH_HOME | **已缓解（D5）**：第二个进程拒绝激活插件并给出 stateDir 占用信息（真机复现，见 S7 报告）；崩溃残留锁按 pid 存活接管 | `instance.lock`（pid+token） | 结构性（单机） |
| 多 manager 线程并发 | 部分：进程内写串行（append 时同步折叠）；跨进程由 D5 锁挡住 | 同一进程内仍允许并发调用，但每个事件 append 是同步的；未做多线程压力验证 | 半结构 |
| verifier 在 danger-full-access 下跑验收 | **已缓解（可检测时）**：证据记录 `sandboxMode`，policy 见 full-access 强制人工；宿主无 sandboxPolicy 服务时未知、不阻断 | `evidence/recorded.sandboxMode` + `task_review` | 半结构（依赖宿主服务） |

### 2.4 部署契约（不成立时只能宣称"提高成本"，不能宣称"结构性隔离"）

| # | 契约 | 检查方式 |
|---|---|---|
| D1 | manager 无 shell、fs 只读；worker/verifier 才执行/写 | preset 定义 + 真机会话工具面 |
| D2 | worker/verifier permission preset ∈ {read-only, workspace-write}，**不得 danger-full-access** | profile/permission 配置；可检测时由 `sandboxMode` 证据强制人工 |
| D3 | 插件 stateDir（账本）不在任何项目 workspace 内 | `config.stateDir` 与 workspace 路径比对 |
| D4 | 人类验收只走面板或宿主 approval 对话框 | 账本 `acceptanceVia` 字段 |
| D5 | 单实例使用（文件锁已实现；插件未激活即拒绝） | `<stateDir>/work/instance.lock` + 启动日志 |
| D6 | 验收命令项目根执行、超时、输出截断、env 剥离凭据 | `evidence-runner.js` |

> S5 真机验收为了在同一隔离环境跑通全链用了 `danger-full-access`，因此结论是"**功能验证 PASS**"；
> 只有当 D1/D2/D3/D4/D6 都成立时才升级为"**安全边界 PASS**"。这是对 critic 威胁模型的正式回应（见 `（历史验收证据已归档，不在本仓库）` §5）。

### 2.4.1 P1 加固落地（S7，2026-11-06）

| 项 | 实现 | 验证 |
|---|---|---|
| 命令白名单（约束 19） | `lib/command-policy.js`；`plan_create` / `task_submit` 前置校验、`acceptance_run` 执行前二次校验 | 单测：非模板命令（`node -e` / `echo` / `rm`）被拒；模板命令通过 |
| 单实例锁（D5） | `lib/work-store.js` `acquireInstanceLock` + `dispose` | 真机：第二实例插件不激活并报 stateDir 占用；崩溃残留锁接管；单测跨进程 |
| 沙箱模式证据（D2 可检测部分） | `acceptance_run` 记录 `sandboxMode`；`task_review` 检测 full-access → 强制人工；overview 新 reason `sandbox-untrusted` | 单测：danger-full-access 下证据不会自动通过 |

证据与复现命令：`（历史验收证据已归档，不在本仓库）`。仍未修：一次性 worktree（副作用隔离）、自定义命令的宿主 approval 通道、锁的 NFS/容器语义。

### 2.4.2 盲测审计修正（2026-11-06，三个独立 Agent）

见 `（历史审计报告已归档，不在本仓库）`。已修：固定 argv 白名单、真实 worker attempt 绑定、review/evidence seq 排序、原子文件锁、D3 代码闸门、盘点 per-project 状态约束调度、attention 队列不受筛选影响、onboarding 读取失败可见、调度会话入口改 `connectWorkspace` 可观测路径、无 connection 时路由 fail-closed、harness protected 集扩展。

**P0 修复（2026-11-06 第二轮）**：
0. **失败返工闭环**：新增 manager 工具 `superbot_task_rework`——要求最新 verifier 结论为 fail，回退任务（in_review→in_progress→todo），把 verifier 记录与失败 evidence 写进新一轮 worker brief，并创建新的 worker run（旧 attempt 保留）；禁止通过改测试/验收命令变绿。
1. **验收执行改走宿主 `ctx.shell` + `sandboxPolicy`**：evidence 记录 `executionMode` / `sandboxed` / `sandboxMode`；宿主无 shell 时裸 `child_process` 结果会被标记 `direct-exec`，`task_review` 在 `requireSandboxedEvidence=true`（默认）下强制人工（`unsandboxed-evidence`）。真机 `/superbot/status` 显示 `runtime.shell=true, sandboxPolicy=true`。剩余：一次性 worktree/网络隔离尚未做。
2. **HTTP 人工动作默认关闭**：`httpHumanActions` 默认 `false`，面板验收/盘点确认改提示「在对话里通过 approval 弹窗批准」，路由返回 403；部署显式开启才允许面板直连（仍承认 cookie 可伪造风险，属 opt-in）。app 默认部署不再暴露可被 worker 伪造的 HTTP 人类入口。

### 2.5 与替代方案对比

| 方案 | 结论 | 原因 |
|---|---|---|
| pristine worktree / git commit 绑定 | **推荐作为下一步**，当前未做 | 能解决 TOCTOU；需要 worker 提交、verifier 在 clean checkout 上跑，成本中等 |
| out-of-process checker（独立进程/容器） | 过度设计（当前） | DSH 插件形态内不值得；本机受限执行器已足够 |
| 不同 provider/模型分档给 verifier | 有价值但非结构 | 只能降低同谋概率，不能防止"没证据也 pass"；可作为增强 |
| 确定性 CI hook | 概念正确 | 需要外部 CI，超出插件边界；可作为后续 P4 |
| 密码学签名 | 过度设计 | 单机单用户场景收益低；账本已 append-only |

---

## 3. 多项目 / 多线程层级设计

### 3.1 先回答：一个"线程"是什么

用户说"我有多个线程要交给一个线程管理"。在本系统里要拆成三个不同对象，不能混：

| 对象 | 定义 | 生命周期 | 谁创建 | 隔离边界 |
|---|---|---|---|---|
| **控制线程（manager thread）** | 用户对话的那个会话，跑 `superbot-manager` 预设 | 长（跨任务） | 用户 | 可见全部项目（中台），但一次只与一个项目集合交互 |
| **执行线程（worker/verifier thread）** | 每个 run 一个子会话，跑 `superbot-worker` / `superbot-verifier` | 短（单任务/单验收） | manager 派工 | cwd = 任务所属项目；只看到自己那份 brief |
| **项目（project）** | DSH workspace（workspaceId + path + title） | 长 | DSH 用户/中台 | **数据隔离边界**：任务、证据、计数、依赖、文件都按它隔离 |

**一个 manager 线程可以管理多个项目**（跨项目调度），但：
- 每个任务必须属于**恰好一个**项目；
- 每个执行线程只在一个项目内工作（cwd、brief、验收命令都在项目内）；
- 账本全局只有一份（审计需要），但**计数/视图按项目投影**（`superbot_project_overview`、`/superbot/overview`）。

### 3.2 层级图

```
L0  用户（唯一）
     │ 对话 / 决定 / 人工验收
L1  控制平面（每个 DSH_HOME 一个账本 + 一个插件实例）
     │  manager thread(s)
     │   ├─ thread M1（superbot-manager）：长会话，派工/验收/汇报
     │   └─ thread M2（可选）：另一个 manager 会话，读写同一账本
     │
L2  项目（DSH workspace，隔离边界）
     │   project P1（workspaceId ws-1, path /…/proj-1）
     │   project P2（workspaceId ws-2, path /…/proj-2）
     │   不变量：task.projectId 必须解析到 inventory；跨项目依赖/派工拒绝
     │
L3  线程（run = 一个执行子会话，带 provenance）
     │   run r-6（worker, task t-3, parentSessionId=M1, childId=a714…, cwd=P1）
     │   run r-11（verifier, task t-3, parentSessionId=M1, childId=d4ec…, cwd=P1）
     │   不变量：一个任务同时最多一个活动 run；一个项目同时最多一个 worker
     │
L4  工作项（账本实体）
     requirement → spec → plan → task → run → report → review → evidence
     每个工作项都携带 projectId（或可由 task 派生 projectId），审计可回溯到项目
```

### 3.3 关系与不变量（可测试）

| # | 不变量 | 强制位置 | 测试 |
|---|---|---|---|
| 1 | `task.projectId` 必须是已注册 DSH workspace | `plan_create` 校验、`plan_dispatch` ready 判定 | planning / dispatch-plan |
| 2 | 跨项目依赖拒绝（plan 外依赖也必须在同一项目） | `createPlan` 校验 | planning（扩展） |
| 3 | 执行线程 cwd = 任务项目路径；brief 里写死项目边界 | `dispatcher.dispatch` + `buildTaskBrief` | dispatch-plan |
| 4 | 同一项目同时最多 1 个活动 worker；全局 WIP 上限可配（默认 2） | `task-engine.planDispatch`（项目互斥 + WIP） | dispatch-plan |
| 5 | 同一任务同时最多 1 个活动 run | `precheckTask` | dispatch-plan |
| 6 | 证据只能在同一项目、同一任务内产生 | `recordEvidence` 校验 projectId/taskId/runId | review-isolation |
| 7 | 每个 run 记录 `parentSessionId` + `childId` + `agentPreset` | `startRun/bindRun` | overview / dispatch-plan |
| 8 | 计数/待办/证据全部按项目投影 | `buildOverview` | overview |
| 9 | 项目离开 inventory 后，历史仍可见（标 `inInventory:false`） | `buildOverview` | overview |
| 10 | 人工验收入口只有宿主 HTTP 面 | `/superbot/accept` + 无 agent 工具 | review-isolation |

### 3.4 前端信息架构（用户看到的层级）

```
┌ Superbot · 控制台 ───────────────────────────────────────────────┐
│ 今日：3 个项目活跃 · 1 个待你验收 · 0 阻塞                        │
├──────────────────────────────┬───────────────────────────────────┤
│ 项目（按最近活动排序）          │ 待你决定 / 待验收（唯一注意力入口）  │
│ ● 项目一  ws-1  /path        │ ① [t-3] 修复 add 函数             │
│   任务 3 · 运行 2 · 待验 1    │    evidence ✓ 3/3 · verifier pass │
│   ▸ 线程 r-6 worker 已结束     │    [通过] [驳回]  ← POST /accept  │
│   ▸ 线程 r-11 verifier pass   │ ② [t-9] 高风险：配色方案           │
│ ● 项目二  ws-2  /path        │    策略要求人工验收                │
│   任务 1 · 运行 1（进行中）    │                                   │
├──────────────────────────────┴───────────────────────────────────┤
│ 图例：✅done 🟡in_review ⚪todo 🔵in_progress ⛔blocked            │
└──────────────────────────────────────────────────────────────────┘
```

数据来源：`GET /superbot/overview`（项目 → 线程 → 任务 + pendingHuman），
人类动作：`POST /superbot/accept {taskId, note}`（浏览器信任栅栏 = 人类身份证明）。

### 3.5 高度 / 深度 / 广度复盘

**高度（要不要做、做到哪一层）**

- 控制平面与执行平面分离：中台只做「需求→计划→派工→验收→汇报」，执行细节（branch/worktree/session）是资源不是界面对象。
- 一个用户、一个控制平面、多个项目；不引入第二套项目注册表（DSH workspace 是事实源）。
- 不做独立 App/daemon/远端服务：插件在线即系统在线。
- 验收标准是「真实项目闭环」，不是功能列表；本轮用真机闭环证明。

**深度（数据/权限/状态机）**

- 状态机：`draft → todo → in_progress → in_review → done`，另有 `blocked/canceled`；`done` 仅 human/policy。
- 证据链：claim → evidence → verdict → acceptance，四层可回溯，账本事件全带 actor/reason/seq。
- 权限：preset 决定工具面（manager 25 / worker 6 / verifier 8）；verifier 无 shell/无写文件，只有受限执行器。
- 失败恢复：投影可丢可重建（删 projection 重启即重放）；run 状态需显式收尾（后续补自动回收）。
- 并发：task claim 乐观锁；项目内单写者；全局 WIP 上限。

**广度（多项目/多线程/扩展）**

- 多项目：任务/证据/计数/依赖/派工全部按项目隔离；跨项目调度由 manager 统一决策。
- 多线程：一个 manager 线程可派生 N 个 worker/verifier 线程；线程是短生命周期，账本保留 provenance。
- 多 manager：允许（共享账本，审计合并），但默认一个，避免注意力分裂。
- 扩展：git commit 绑定证据、一次性 worktree、CI hook、成本/注意力指标、记忆分层——按需再加，不提前建体系。

**权衡**

- 为什么账本全局单文件而项目分投影：审计要「一件事一条线」，分布式分账本会破坏跨项目追溯；隔离用 projectId + 校验，不用多文件。
- 为什么允许 manager 跨项目管理：用户明确「一个线程管理多个线程/项目」，中台的价值就是跨项目调度；但执行严格单项目。
- 为什么保留 policy 自动验收：低风险高频任务的注意力成本是产品核心问题；用「证据链 + 风险分类 + 可重开」控制风险，而不是全部人验。

### 3.6 人设层：语域分离与 brief 质量（S5.1）

人设层不是「把角色演给 worker 看」，而是**用户侧的语气层** + **执行侧的合同层**：

| 层 | 用什么 | 禁止 |
|---|---|---|
| 与用户对话 | 角色语气（温和、直接、有记忆感） | 用情绪/关系替代事实与决定 |
| 派工 brief（worker/verifier） | 纯工作语域：边界、背景、范围/非目标、验收命令、证据要求、报告格式、失败处理 | 角色设定、情绪叙述、模糊形容词 |
| 验收/汇报 | 事实 + 命令 + exitCode + 风险 + 待决定项 | 「她很努力/应该没问题」式结论 |

manager persona 强制：三原则自检、语域分离、角色数据只读不虚构、首次接入先盘点。
`buildTaskBrief` 输出 10 段工作合约（项目边界/背景目标/范围非目标/验收+机器命令/依赖/风险/工作流程/报告格式/失败处理/额外指示），
任务契约为此新增 `context / constraints / nonGoals` 字段，让 manager 的"理解"变成可传递、可审计的输入。

### 3.7 首次接入盘点（Onboarding Inventory，S5.1）

用户接入时通常已有大量项目/线程在飞。调度前必须：

```
scan（只读）→ 分类建议 → 用户确认 → 写入 inventory/confirmed → 才允许调度
```

- 数据源：workspaceRegistry（项目）+ `$DSH_HOME/sessions/**/session.v4.jsonl.zstd`（线程：header/title/最后活动/归档/lock 判活，有界读取）+ 账本（既有工作）。
- 分类：`active`（有未完成任务 / live 线程 / 3 天内有活动）、`paused`（有历史但长期无活动且无未完成工作）、
  `archived`（全部线程归档且无未完成工作）、`unknown`（无历史）。
- 输出：每项目建议状态、依据、线程清单（顶层/子线程/live）、未完成任务、待确认问题；`readOnly:true`，不改任何会话。
- 确认入口：面板「首次接入盘点」按钮（`POST /superbot/onboarding/confirm`，`via=http`）或宿主 approval 对话框
  （`superbot_onboarding_confirm`，`via=host-approval`）；账本记录 `inventory/confirmed`，`status.onboarding` 可查。
- 未完成：确认目前是流程约束（persona+AGENTS.md），工具层硬闸门留到 S5.2。

---

## 4. 落地改动清单（本版已实现）

| 文件 | 改动 |
|---|---|
| `packages/task-engine/lib/index.js` | `acceptanceCommands` 契约；`acceptByHuman`；`planDispatch` 支持 `knownById`（跨计划依赖） |
| `packages/dsh-superbot/lib/work-store.js` | `evidence/recorded` 事件 + 投影；`recordEvidence/listEvidence/evidenceCoverage`；`submitReview` 证据链校验与归因；`acceptTaskByHuman`；run `parentSessionId` |
| `packages/dsh-superbot/lib/evidence-runner.js` | 受限命令执行器（账本命令、项目 cwd、超时、digest、artifact、预览） |
| `packages/dsh-superbot/lib/overview.js` | 项目→线程→任务层级快照 + 每项目计数 + 待人工队列 + 隔离说明 |
| `packages/dsh-superbot/lib/tools.js` | `superbot_acceptance_run`（verifier）；`review_submit` 强制 evidenceIds；`task_review` 改成账本自查；`project_overview`；`task_list` 项目过滤；全工具族接入 toolsEnabled |
| `packages/dsh-superbot/lib/dispatch-tools.js` | verifier brief 要求自己执行命令；worker brief 声明自测只是 claim；run 记 parentSessionId；摘要只取消息正文（不取 reasoning） |
| `packages/dsh-superbot/lib/planning-tools.js` | plan 声明 `acceptanceCommands`；派工用 task-engine 确定性调度（项目互斥 + WIP 上限） |
| `packages/dsh-superbot/lib/roles.js` | manager 25 / worker 6 / verifier 8；acceptance_run 只给 verifier |
| `packages/dsh-superbot/lib/index.js` | `GET /superbot/overview`、`POST /superbot/accept`；status 带 pendingHuman |
| `packages/dsh-superbot/lib/client.js` | 设置页新增 WIP；**侧栏总览面板（项目→线程→任务，含人工验收按钮）** |
| `packages/dsh-superbot/lib/config.js` | `wipLimit` 配置 |
| `packages/dsh-superbot/lib/workspace-snapshot.js` | 工作区 / 验收 harness 指纹与比对（TOCTOU、改测试检测） |
| `packages/dsh-superbot/lib/onboarding.js` | 首次接入盘点：项目/线程/账本只读扫描 + 状态建议 |
| `packages/dsh-superbot/lib/workspace-service.js` | 暴露 archivedSessionIds（归档判定） |
| `AGENTS.md` | 调度三原则、提示词质量、首次接入盘点（本线程规则） |
| `packages/dsh-superbot/lib/evidence-runner.js` | 受限命令执行（env 剥离、超时、digest、artifact） |
| 测试 | `review-isolation.test.js`（9 条）+ `overview.test.js`（4 条）+ 既有 101 条全部更新 |

---

## 5. 演进路线（S5 之后）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **S5（本版）** | 审核隔离 + 多项目层级 + 总览面板 + 人工验收入口 | 真机跑通：独立证据验收、人工验收、双项目隔离 |
| **S5.1（本版）** | 人设层提示词质量（语域分离/10 段 brief）+ 首次接入盘点（扫描线程/任务/确认） | 真机：先盘点后调度、worker 收到工作合约、面板确认入账 |
| **P1 加固（本轮）** | 命令模板白名单、单实例文件锁（D5）、沙箱模式证据与 D2 闸门；盘点硬闸门已在 S5.1 | 非模板命令被拒；第二实例拒绝激活；full-access 证据不自动通过 |
| S6 | 证据增强：git commit 绑定、自定义命令 approval 通道、失败后人工/策略确认的返工（`superbot_task_rework` 已落地：verifier fail → 返工 brief → 新 worker run） | TOCTOU 消除；驳回→返工闭环 |
| S7 | 记忆/汇报：WorkReport 双寄存器、每日 digest、成本与注意力指标 | 汇报可读、指标可行动 |
| S8 | 分发：打包、版本策略（桌面 App 0.2.2-rc.x 兼容）、eval | 另一台 DSH 安装可用 |

---

## 6. 本设计的验收标准（已真机执行）

1. verifier **必须**执行账本里的验收命令才能提交 pass；只写"看起来没问题"被账本拒绝。
2. worker 的自测输出**不能**被当作验收证据（账本无 worker evidence）。
3. policy 自动 done 必须同时满足：verifier pass + 每条命令的通过证据 + 低风险/可逆/无副作用/无人类标签。
4. 高风险任务即使证据齐备也停在 `in_review`，只能由 `POST /superbot/accept` 人工通过。
5. 两个项目并行时，计数、线程、待办、证据互不串味；同一项目同时只有一个 worker。
6. UI 上能一眼看到「项目 → 线程 → 任务 → 待你验收」，并能点按人工验收。

真机证据见 `（历史验收证据已归档，不在本仓库）`（S4 旧闭环）与 `（历史验收证据已归档，不在本仓库）`（本版 37 条事件、两张面板截图、4 个真实子会话日志）。
S5 结果：1–6 全部 PASS（在 §2.5 部署契约的 D1/D4/D6 下已实测；D2 因隔离测试环境使用 full-access 而标注为"功能验证"）。
