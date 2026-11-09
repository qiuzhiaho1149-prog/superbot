# 结果导向任务/审计控制台 UX Benchmark

> 专家组 B · 外部产品 benchmark + 当前面板诊断 + 可直接实现的信息架构
> 评估快照：2026-11-07 12:50（`client.js` 1674 行、`overview.js` 354 行、`task-phase.js` 83 行）。截图与代码存在时间差：`panel-task-board.png`/`panel-task-drawer.png` 为 12:14 的旧状态列版本，`panel-result-board.png` 为 12:51 的 phase 版本——报告以 12:50 代码为准，截图仅用来说明演化中的反例。
> 只读仓库，未改代码；本文件是唯一写入。

---

## 0. 结论先行（老板打开 3 秒应该看到什么）

**老板打开 3 秒只问四件事**：

1. **有什么结果交付了？**（不是"有多少任务"）
2. **现在谁在做什么、卡在哪？**
3. **有什么需要我拍板？最久等了多久？**
4. **有没有异常/返工需要我兜底？**

因此首屏的正确配方是：**一句简报（结果语义）+ 决策队列（需你决定，按等待时长排序）+ 阶段列表（执行/审计/返工分列）+ 最近交付（结果时间线入口）**。当前面板给出的是「4 个活动计数 + 一个对话入口大卡 + 一组阶段泳道卡片」，回答的是"系统里有多少东西"，不是"我的钱花出什么结果、我现在要做什么"。

**核心设计判断（本报告的 6 个决定）**：

| # | 判断 | 一句话理由 |
|---|---|---|
| D1 | **默认视图 = 结果简报 + 决策队列 + 阶段列表（列表形态）**，泳道是次视图，时间线只做时效不做甘特 | 调度型任务"少而重"，老板要对比结果与异常，不是看进度条；空列/空组是最大噪音源 |
| D2 | **执行与审计用两个空间 + 一条时间轴分开**：列表按阶段分组；详情抽屉固定三段——「执行记录 / 审计证据 / 决定记录」；绝不把 `状态`、`证据`、`结论`、`决定` 塞进同一张字段表 | 现在抽屉把阶段、raw status、审证计数混排，老板分不清"谁在干活"和"谁在检查" |
| D3 | **因果链 = 不可变事件序列**：谁（角色+ID）→ 在哪条线程/run → 做了什么（report）→ 证据（command/exit/output/digest）→ 结论（verifier/policy）→ 谁决定（human/policy）。垂直时间线，节点可展开原始 payload | 这是「老板 ↔ 中央员工」信任的全部来源；当前抽屉只有一行"关联调度线程"，链断层 |
| D4 | **状态字典 = 6 个可行动阶段 + 4 个次要徽章**；raw status（draft/todo/…）只在技术详情；verdict 等英文值必须中文化 | 太少不够排程，太多不可行动；当前 UI 有"阶段+状态"双轨和 `pass/fail` 英文直出 |
| D5 | **详情用 side peek（480–560px，可拖宽，保留列表上下文）**；窄容器退化为全屏 sheet；全屏只用于"审计深链/证据对比" | 老板在列表里连续处理多个决定，不该每点一次就跳页 |
| D6 | **异常/返工是一等公民**：blocked/canceled/审计失败/超时/停滞都要有入口和计数；当前 `PHASE_LANES` 只有 6 个阶段，**blocked/canceled 任务在板上完全不显示**（见 §6 反例 #4） | 老板最需要知道的就是"哪里不对"，而不是只看到顺利的 |

---

## 1. 研究范围与一手资料

本报告只用一手官方文档/产品页核对模式，不引用二手测评。资料清单见 §8。覆盖：

- **飞书任务 / 飞书项目**：任务中心（按角色/状态/清单查看）、任务详情、任务清单、看板/甘特/仪表盘；飞书项目的多视图（列表/看板/甘特/树形/全景）、节点流工作流、自动化。
- **Linear**：Inbox/Triage（单一注意力队列 + 就地处理）、Project/Initiative updates（健康度 On track/At risk/Off track + 结构化更新 + 历史 + agent 辅助起草 + staleness）。
- **Asana / Monday**：Portfolio Progress（状态：on track / at risk / off track / on hold / complete / dropped；status update 模板块：完成了什么 / 阻塞 / 下一步 / 图表）；Monday Dashboards（跨 board 汇总 widget）。
- **Notion（/ Height）**：View 属性显隐、group/sub-group、side peek；Height 作为"AI 自动 triage/状态更新"的历史模式参考（其官方站点已不可访问，不作为现行标杆）。
- **Mission control 类**：PagerDuty Operations Console（实时事件台、列选择/排序/筛选、side panel、Pin、Live/Paused、批量动作、按服务健康度下钻）；GitHub Actions（run 级 in progress/completed + conclusion success/failure/canceled/neutral + 每 job 日志）。

---

## 2. Benchmark（抄什么 / 不抄什么）

### 2.1 飞书任务 + 飞书项目（中文协作任务台）

| 维度 | 一手资料里的模式 | 抄什么 | 不抄什么 |
|---|---|---|---|
| 信息入口 | 任务中心按**角色**（我负责的/我关注的/我创建的/我分配的）与**状态**（未完成/已完成）、任务清单查看；客户可建清单分组 | "按我的角色切视图" + 任务清单作为项目边界；负责人/关注人分离（老板是关注人+审批者，不是执行者） | 面向全员的"我的待办"注意力模型——老板要的是**结果与决定**，不是个人 todo |
| 任务详情 | 点击任务进入详情页设置负责人/关注人/截止/子任务/重复任务 | 任务详情承载元数据 + 子任务；关注人字段 | 任务"完成即终态"：我们是**完成 ≠ 验收**，必须有审计/决定层 |
| 多视图 | 飞书项目支持列表、看板、甘特、树形、全景；表格可快捷编辑/流转/批量；甘特看排期；看板拖拽改状态 | **列表为默认**（密度高、可排序），看板/甘特按需切换；树形视图表达任务层级 | 全景/树形/甘特的完整配置能力（对老板-员工工具是过度设计） |
| 流程 | 飞书项目用**节点流**定义工作流，每个节点有负责人与**交付物**，节点可自动流转/自动化 | "节点 = 交付物 + 负责人 + 流转条件"——正好映射我们的 执行→审计→决定 | 用户自定义工作流编辑器（我们流程由账本状态机固定） |
| 仪表盘 | 飞书任务有 Dashboard tab，可配 block、过滤、自动发送 | 只读结果统计（交付数/返工率/平均等待）放页脚或第二屏 | 首屏放统计图表（老板先看具体事项，不先看聚合图） |

关键引用：飞书任务「快速上手任务」（任务中心按角色/状态/清单查看、负责人/关注人、子任务）<https://www.feishu.cn/hc/zh-CN/articles/210653614514-快速上手任务>；飞书任务功能更新（Dashboard tab、任务清单模板）<https://www.feishu.cn/hc/en-US/articles/744682473644-tasks-updates>；飞书项目产品页（多视图、节点流、自动化）<https://project.feishu.cn/home/landing-product>。

**对本产品的映射**：飞书是"协作工具"，老板只是其中一种角色；我们要做的是"老板 + 中央员工"，老板只出现在**决定层**。所以抄它的**视图与详情结构**，不抄它的角色平权模型。

### 2.2 Linear（Inbox/Triage + 项目健康度）

| 维度 | 一手资料里的模式 | 抄什么 | 不抄什么 |
|---|---|---|---|
| 注意力 | Inbox 有 Priority tab，把"需要你注意"的通知与其余更新分开；列表可 J/K、snooze、右键就地动作 | 全页唯一"需你决定"队列；队列项就地处理；按注意力而非按项目平铺 | 多套 inbox 规则/订阅模型 |
| 分诊 | Triage 是团队唯一收件队列；进入 Triage 的 issue 用 1 接受/2 拒绝/3 重复/H 推迟，接受后才进入正常流程 | 决定动作成对（通过/退回），不只是通过；拒绝/返工有明确去向 | "未接受即不计入工作"的三态门禁（我们已有 in_review） |
| 结果表达 | Project/Initiative updates：**健康度三态**（On track/At risk/Off track）+ 结构化叙述（进度、挑战、下一步）+ 历史更新 + staleness 过期提醒；"Write with Agent" 生成更新草稿由人修订 | 项目/任务摘要用**健康度 + 三行叙述**（交付了什么/卡在哪/下一步），而不是纯计数；staleness 检测（多久没更新）；AI 起草、人确认 | 周报节奏/提醒配置/emoji 反应 |
| 历史 | Updates tab 按时间顺序展示所有更新与属性变化 | 详情里的"更新/事件历史"按时间线呈现（这就是审计链的轻量版） | 项目级 target date/lead 等重字段 |

关键引用：Linear Inbox <https://linear.app/docs/inbox>；Triage <https://linear.app/docs/triage>；Initiative and project updates（健康度、更新历史、staleness、Write with Agent）<https://linear.app/docs/initiative-and-project-updates>。

**映射**：Linear 的 "health + update history" 就是老板视角的结果层；我们把它落到**每个任务的结果摘要 + 事件时间线**，而不是只做项目周报。

### 2.3 Asana / Monday（Portfolio 与状态更新）

| 维度 | 一手资料里的模式 | 抄什么 | 不抄什么 |
|---|---|---|---|
| 组合视角 | Asana Portfolio Progress：整体状态（on track/at risk/off track/on hold/complete/dropped）+ 各状态项目数 + 最新 status update | 老板首屏用**组合健康度三态**（正常/有风险/阻塞）表达跨项目结果 | 六种组合状态（对我们过细；我们 3 态 + 异常） |
| 状态更新 | Asana status update 模板：标题、进度、负责人/日期、附件、摘要、**完成了什么 / 阻塞 / 下一步**，可拖入高亮项目/图表 | 简报固定三段：**已完成 / 阻塞中 / 下一步**；可附证据/线程链接 | 手写周报式维护（我们的三段应由账本自动生成后允许人补一句） |
| 仪表盘 | Portfolio Dashboard：任务数卡 + 可定制图表；Monday Dashboard 跨 board 汇总 widget | 只读聚合放页脚/第二屏（交付数、返工率、平均等待、审计通过率） | 首屏放图表墙 |
| 时间线 | Monday timeline / Asana timeline 表达跨项目排期 | "等待时长/交付时长"用条形/色块表达，不做编辑型甘特 | 完整资源排期/依赖编辑 |

关键引用：Asana Portfolio progress and reporting <https://help.asana.com/hc/en-us/articles/22872284856731-Portfolio-progress-and-reporting>；Monday Configure your Dashboard <https://support.monday.com/hc/en-us/articles/26233702292114-Configure-your-Dashboard>。

**映射**：首屏简报直接照 Asana 的 "完成了什么 / 阻塞 / 下一步"；但数据必须来自账本（report/review/evidence），不要求老板手写。

### 2.4 Notion（/ Height）：渐进展开与 AI 原生任务

| 维度 | 一手资料里的模式 | 抄什么 | 不抄什么 |
|---|---|---|---|
| 详情 | Notion database row 默认 **side peek** 打开详情，列表保持可交互；可切换 center peek/full page；属性可按视图显隐；group/sub-group | side peek 做默认详情；属性显隐（老板视图只看结果字段，审计视图才看 ID）；分组 | 多视图配置的复杂度、属性自由增删 |
| AI 原生 | Height 曾以自主 PM 著称（AI 自动 triage、backlog grooming、状态更新）；但其服务已停止（官方站点不可达），仅作历史参考 | 方向：AI 生成"状态/结果摘要草稿"，**人做决定**；AI 不替老板通过验收 | 把 AI 推断的状态当成事实（我们的 phase 只能由账本派生） |
| 结构 | 每行是 page，可嵌套子项 | 任务详情可挂子任务/证据链接 | 数据库式自由建模 |

关键引用：Notion Views, filters, sorts & groups（side peek、属性显隐、group/sub-group）<https://www.notion.com/help/views-filters-and-sorts>。Height 仅作历史模式说明，不引用为现行标杆。

**映射**：side peek + 属性显隐直接采用；AI 只能生成"给人读的摘要"，不能生成 phase/决定。

### 2.5 Mission control 类：PagerDuty Operations Console + GitHub Actions

| 维度 | 一手资料里的模式 | 抄什么 | 不抄什么 |
|---|---|---|---|
| 实时台 | PagerDuty Operations Console：一个高密度表格承载全部事件，列选择/排序/筛选、Pin 最多 5 条、**Live/Paused**、side panel 看详情、批量动作、按服务健康度下钻 | 单表 + side panel + Pin 关键事项 + Live/Paused（老板可暂停自动刷新避免跳动）+ 列显隐 | incident 优先级/on-call/值班表等 IM 领域模型 |
| 执行分层 | GitHub Actions：run 级状态（in progress / completed）+ **conclusion**（success/failure/canceled/neutral）；每个 job 有独立日志；失败可查看/搜索日志后重跑 | 执行（run/job）与结论（conclusion）分离表达；事实（日志/证据）可下钻、不可改写 | 完整 CI 日志查看器（我们链接到会话/证据预览即可） |
| 状态表达 | "in progress" ≠ "success"：过程态与结果态分开；失败可重跑 | 我们的 "审计中"（过程）与 "返工/通过"（结果）必须分开；attempt 次数可见 | 红色/绿色即全部的简化 |

关键引用：PagerDuty Operations Console <https://docs.pagerduty.com/ai-automation/aiops/operations-console>；GitHub Actions workflow run logs（run 状态与 conclusion、日志/重跑）<https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs>。

**映射**：这是最接近"老板 ↔ 中央员工"的形态：**一个实时台 + 可下钻的不可变事实 + 明确的人工动作**。但 PagerDuty 面向"事件"，我们面向"结果与验收"，首屏必须多一句"交付了什么"。

### 2.6 Benchmark 汇总结论

| 问题 | 从 benchmark 得到的最佳实践 | 落到本产品 |
|---|---|---|
| 注意力 | 单一队列 + 就地动作（Linear Inbox/Triage） | 「需你决定」队列，按等待时长排序，通过/退回就地完成 |
| 结果表达 | 健康度三态 + 三段叙述（Linear updates / Asana status update） | 一句简报 + 每个任务一行"结果摘要" |
| 执行 vs 审计 | run 过程与 conclusion 分离（GitHub Actions）；审证在侧栏（PagerDuty side panel） | 阶段分组 + 详情三段：执行/审计/决定 |
| 因果 | 更新历史按时间线（Linear Updates tab）+ 不可变事件（GitHub run logs） | 每任务垂直事件时间线，节点可展开原始 payload |
| 细节 | side peek + 属性显隐（Notion）；可拖宽 side panel（PagerDuty） | 任务详情 side peek 480–560px，可拖宽 |
| 异常 | staleness（Linear）+ 失败可重跑（GitHub）+ 服务健康下钻（PagerDuty） | 异常中心 + 返工 lane + aging 标记 |
| 多视图 | 列表/看板/甘特/树形按需（飞书项目） | 列表默认；监控泳道次之；时间线只做时效 |

---

## 3. 七个研究问题的答案

### Q1. 老板打开 3 秒要看什么？

**四问**：①交付了什么结果？②谁在做什么、卡在哪？③什么要我拍板、等了多久？④有没有异常/返工？

**首屏信息配方（只允许这些）**：

1. **状态行（1 行，≤3 个数字）**：`已交付 N · 待你决定 M · 异常 K`（异常=blocked+失败+超时+停滞，K>0 时红色，否则灰）；右侧 `更新于 12 秒前 · 自动刷新 [暂停]`。
2. **简报（2–3 行，结果语义）**：
   - `过去 24h 交付 2 项：修复 slugify（已验证）、导出 CSV（已交付，待你验收）`
   - `进行中：登录页主色（执行中，第 2 次尝试）；审计中：迁移测试（证据 2/3）`
   - `最久等待：调整登录页主色 · 3h12m（需你决定）`
3. **决策队列（最多 5 条，第 6 条起折叠）**：每条 = 结果一句话 + 原因 + 证据 n/m + 等待时长 + `[查看证据][通过][退回]`。
4. **阶段列表**：执行中 / 审计中 / 返工 / 待开始 四组；已完成默认折叠（7 天内可展开）。每组只显示**有内容的行**，空组收成一行 chip。
5. **最近交付（第二屏入口）**：结果时间线，最近 5 条：时间 · 结果 · 由谁 · 证据状态 · 打开。

**首屏明确不显示**：项目数/任务总数/线程数等"活动量"（移到第二屏统计）；原始 ID；接入盘点的详细状态（折叠成系统状态一行）；大块对话入口（降级为 header 按钮）；空阶段/空分组（折叠为 chip）；图表墙。

> 检验方法：截图 1280×720，遮住标题后问"交付了什么/要我做什么/有什么异常"——应在 3 秒内从简报+队列读出，无需点击。

### Q2. 「执行」与「审计」怎么呈现才不混？

**两个空间 + 一条时间轴**：

- **空间 A 执行（execution）**：worker 在做什么。字段：run（r-N）、child session、开始时间、当前 attempt、report（做了什么/改动文件/自测命令）。语义色：品牌蓝（进行中）。
- **空间 B 审计（audit）**：verifier/policy 在验什么、凭什么。字段：verifier run、逐条 acceptance command + exitCode + 耗时 + 输出预览 + workspace/protected digest、verifier verdict、policy decision（mode/reasons）。语义色：先蓝（审计中）→ 绿（通过）/红（未通过）。
- **时间轴（决定）**：human/policy 在哪一刻、依据什么、做了什么决定（通过/退回/自动通过）、谁、备注。

**UI 规则**：
1. 列表按**阶段**分组（`needs-you/rework/auditing/executing/queued/done`），不同阶段不同 lane——**不要把执行中与审计中放进同一列**。
2. 详情抽屉固定三段（顺序不可变）：`执行记录` → `审计证据` → `决定记录`；每段标题带状态点与计数。
3. 卡片/行只显示"当前阶段"一个主状态；**raw status 不进主视图**，只在技术详情。
4. 审计中的任务不显示"通过验收"按钮；只有 `needs-you` 才出现决定动作（与任务阶段绑定，而不是与 raw status 绑定）。
5. 返工是审计的**结果**，不是执行阶段：`rework` lane 显示"第 N 次尝试 + 上次未通过原因 + 失败证据链接"。

### Q3. 因果链（谁→做了什么→证据→结论→谁决定）怎么呈现？

**形态**：详情抽屉中的**垂直事件时间线**（不是字段表），按账本 `seq` 升序；每节点 5 要素：

```
[图标] 标题（动词短语）                      相对时间
       行为者：角色 + 人读名（manager/worker/verifier/human）
       摘要：一句话（report summary / 命令 + exit / 结论）
       [展开原始字段 ▸]  refs: runId/reportId/evidenceId/reviewId（可复制）
```

节点序列（与账本事件先一一对应）：

| 节点 | 账本事件 | 显示内容 | 行为者 |
|---|---|---|---|
| 提出 | `task/created`（+ 上游 requirement/spec） | 需求一句话；来源（人类对话/结构化发单） | human / manager |
| 派工 | `run/started`（agentPreset=worker） | run r-N、子会话（打开）、第 N 次尝试 | manager |
| 执行交付 | `run/finished` + `report/submitted` | 报告摘要 ≤5 行、变更文件、自测命令（claim，非证据） | worker |
| 提交审计 | `run/started`（verifier） | verifier run、开始时间 | manager |
| 证据 | `evidence/recorded` × commands | 每条：命令、exitCode（期望0）、耗时、输出预览（≤2000 字符）、workspace/protected digest 是否匹配 | verifier |
| 结论 | `review/submitted`（source=verifier） | 通过/未通过 + notes + evidenceIds | verifier |
| 策略 | `review/submitted`（source=policy） | mode=auto/human + reasons（中文） | policy |
| 决定 | human `review/submitted` + `task/transition` | 通过/退回 + 备注 + 人 + 时间；或"自动通过"标记 | human / policy |
| 返工 | 新 run + transition | 第 N 次尝试；上次失败证据链接 | manager/worker |

**交互**：默认折叠每节点摘要（3 行内）；点击展开原始 JSON/完整输出；证据行可打开输出文件路径或预览；时间线只读、不可编辑（append-only 语义），复制只复制 ID；底部 `导出原始审计（最近 50 条）` 链接到 `GET /superbot/tasks/:id/audit?raw=1` 或 `superbot_audit_export` 等价数据。

**数据前提**：当前 `/superbot/overview` 的 `tasks[]` 只有 `audit` 摘要（evidencePassed/Total、latestVerdict、attempts）与最新 thread（`overview.js:265-300`），**不足以渲染链**。需新增只读接口 `GET /superbot/tasks/:taskId/audit`（§4.4），由 `WorkStore` 内存事件流（`work-store.js` 的 append-only `#events`）投影；不改账本 schema。

### Q4. 标签/状态怎么"少而可行动"？

**原则**：**一个主状态（6 个阶段）+ 最多 2 个次要徽章 + 一个 aging 数字**；其余全部进技术详情。

- 主状态（phase，唯一来源 `task-phase.js`）：需你决定 / 返工 / 审计中 / 执行中 / 待开始 / 已完成；异常补充 阻塞 / 已取消（默认折叠或进异常区）。
- 次要徽章（最多 2）：`高风险`、`高优先级`、`需人工：<原因>`（策略/证据/驳回）、`第 N 次尝试`。
- 数字：`证据 n/m`（仅审计相关阶段显示）；aging：`等待 3h12m`（needs-you/rework 显示，超阈值变红）。
- 不显示：raw status（draft/todo/in_progress/in_review/…）、`pass/fail` 英文、runId/childId（详情技术区除外）、tag 原始列表（映射为中文分组后再显示）。
- 去重规则：同一计数全页最多 2 处（入口 + 所属行）；Lane 标题与 chips 不重复计数（当前代码 chips + lane 标题都显示计数，反例 #5）。

### Q5. 列表 vs 泳道 vs 时间线，哪种适合调度型工作任务？

| 形态 | 适合回答 | 对"老板-中央员工"的判断 | 建议 |
|---|---|---|---|
| **列表（按阶段分组）** | "有什么结果、谁在做、什么等我"；密度高、可排序、易扫读 | ✅ **默认视图** | 阶段分组 + 行式；主列见 §4.2 |
| 泳道（项目为泳道 × 阶段为列） | "多个项目并行时资源是否冲突/谁在占 WIP" | ✅ **次视图**（监控视图），非常驻默认 | Header 切换 `列表/监控`；列=阶段，泳道=项目；已完成默认隐藏 |
| 时间线（甘特/排期） | "承诺时间、等待时长、依赖先后" | ⚠️ 只做**时效条**（created→delivered，含等待/执行/审计分段），不做依赖编辑 | 第二屏"交付时间线"；用于发现"等了多久/卡在哪一段" |
| 看板（按状态列） | 团队日常拖动流转 | ❌ 当前默认形态；空列噪音大、老板不拖卡 | 不保留为默认（阶段列表替代） |

**决策**：默认列表；监控泳道是"执行资源视图"；时间线只做"时效审计"。这与飞书项目的"列表默认、看板/甘特按需"一致，也符合老板"先看结果、再看资源"的顺序。

### Q6. 任务详情：side peek / 全屏 / 抽屉怎么选？

| 形态 | 优点 | 缺点 | 用在哪 |
|---|---|---|---|
| **side peek（推荐默认）** | 保留列表上下文、可连续处理多个决定、可拖宽 | 宽内容需自适应 | 任务详情；宽度 480–560px，可拖拽并记忆（PagerDuty 同款） |
| 全屏 sheet | 空间大，适合证据对比/长链 | 丢失列表上下文 | 窄容器（<760px 面板宽）自动退化；"审计深链/原始事件"显式全屏 |
| 居中 modal | 强调、聚焦 | 阻断、不适合连续处理 | 仅用于破坏性确认（退回/作废） |

**规则**：行点击打开 side peek；`Esc` 关闭；关闭后焦点回原行；列表滚动位置不变；URL/深链不做（单面板）；抽屉内三段可折叠，默认展开"当前阶段相关段"（如 needs-you 默认展开"决定记录"）。

### Q7. 空 / 异常 / 失败 / 返工怎么展示？

| 场景 | 展示位置 | 文案/动作 |
|---|---|---|
| 空（新系统，无任务） | 主区空态 | `还没有任务。用「对话」告诉 Superbot 要做什么；它会拆成可验收任务。` + [开始对话] + 一条示例；**不显示** 6 个 0 计数 chip |
| 异步等待（无异常） | 阶段列表 | `执行中 1 · 审计中 1`；简报第二行说明；「审计中」行显示进度（证据 2/3）而非转圈 |
| 需要老板拍板 | 决策队列 + needs-you 行 | 原因、证据摘要、等待时长；动作成对（通过/退回），退回必须写原因 |
| 审计失败（verifier fail） | 返工 lane + 详情 | "第 2 次尝试 · 上次未通过：命令 `npm test` exitCode 1（查看输出）"；动作：查看失败证据 / 让经理派新 worker |
| 证据不完整/环境不可信 | 异常中心 + needs-you（若 policy 要求人） | 明确"缺哪条命令/沙箱不可信"；不提供"直接通过"捷径（策略允许时才可人工通过） |
| 阻塞 | 异常中心 + blocked lane | "阻塞：等待 X（找经理解除）"；aging 颜色 |
| 停滞/超时（有 run 但长时间无更新） | 异常中心 | "执行 47 分钟无更新（阈值 30 分钟）" + 打开线程；规则：`now - run.startedAt > threshold` 或 `updatedAt` 过期 |
| 失败/报错（接口） | 顶部 banner | `读取失败：… [重试]`；保留旧数据并标"显示的是 12:03 的数据" |
| 已取消 | 默认折叠 | 记录在技术详情，不占主视图 |

---

## 4. 推荐信息架构（可直接实现）

### 4.1 总览（5 层，一屏一个主问题）

```
L0 状态行（sticky 56px）     已交付 N · 待你决定 M · 异常 K | 更新于 x [暂停自动刷新] [对话]
L1 简报（44–64px）           过去 24h 交付…；进行中…；最久等待…
L2 决策队列（列表）          需你决定，按等待时长 desc；最多 5 条 + "还有 N 条"
L3 阶段列表（列表默认）      执行中 / 审计中 / 返工 / 待开始 / 已完成（折叠）
   监控视图（切换）          项目泳道 × 阶段列（资源占用的次视图）
L4 任务详情 side peek        执行记录 / 审计证据 / 决定记录 / 技术详情
L5 页脚                       最近交付时间线入口 · 统计（交付/返工/等待）· 原始审计导出
```

**区块优先级与首屏约束**：1280×720 内至少可见 L0+L1+L2 的前 2 条+L3 的 1 个分组；不显示 KPI 卡墙、不显示对话大卡、不显示 onboarding 详情（折叠为状态行一个点）。

### 4.2 任务列表（默认视图）

**结构**：`阶段分组 > 行`；每组标题 32px（`阶段名 · N · 一句 hint`）；空组折叠为一行 chip（`返工 0` 灰），默认不展开。

**行结构**（44–52px）：

| 列 | 内容 | 宽度（≥1000px 容器） | 说明 |
|---|---|---|---|
| 结果/任务 | 任务标题（13/500，1 行）+ 副行一句话（resultHint 或 phaseReason，11/tertiary，1 行省略） | 38% | 副行优先显示"结果"：已完成=交付摘要；返工=失败原因；needs-you=为什么等你 |
| 阶段 | 阶段 pill（6 色） | 96px | 唯一主状态 |
| 执行者 | 角色 + 人读名（`执行者 · r-24` → 显示"执行者"/"验收员"/"调度员"）；无=`未认领` | 110px | 不显示裸 runId |
| 证据 | `证据 3/3 · 通过` / `证据 1/2 · 未通过` / `—` | 120px | verdict 中文化 |
| 等待/耗时 | needs-you/rework：`等待 3h12m`（>2h 红）；其余：`更新 12 分钟前` | 100px | aging 排序键 |
| 操作 | `查看`（打开 peek）；needs-you 时 `[通过][退回]` 行内（可折叠到菜单） | 120px | 只在 needs-you 行出现决定动作 |

**排序**：默认 `阶段顺序 (needs-you→rework→auditing→executing→queued→done) → needs-you 内按等待时长 desc → 其他按 updatedAt desc`。**筛选**：`全部/需你决定/执行中/审计中/返工/异常`；**搜索**：任务标题/项目。**键盘**：`J/K` 移动、`Enter` 打开、`A` 打开"通过"确认（有默认备注）、`R` 打开"退回"（必须填原因）、`Esc` 关闭；不用单键直接通过（不可逆动作需二次确认）。

### 4.3 任务详情 side peek（480–560px，可拖宽）

```
┌ 结果标题（15/600）                                     [×] ┐
│ [阶段 pill] [高风险] [高优先级] [第2次尝试]                   │
│ 一行结果摘要（已被谁、何时交付；needs-you 时：为什么等你）      │
├ ① 执行记录（executing/worker） ──────────────────────────────┤
│ run r-24 · worker · 14:02–14:11（9m）   [打开执行会话]        │
│ 报告 rp-8：改了什么（≤5 行）· 变更文件 3 · 自测命令（claim）   │
├ ② 审计证据（verifier/policy） ───────────────────────────────┤
│ verifier r-25 · 结论：通过/未通过（中文）                     │
│ ☑ [0] node --test login   exit 0 · 12.4s · 输出预览          │
│ ☑ [1] npm test -- login    exit 0 · 48.1s · 输出预览          │
│ ☐ [2] ... exit 1 · 2.3s · 查看输出                            │
│ workspace digest ✓ · protected digest ✓（防改测试）          │
│ policy：需人工（高风险/涉及审美）→ 中文原因                   │
├ ③ 决定记录（human/policy） ──────────────────────────────────┤
│ 待你决定：原因 + 证据门槛（证据完整/策略要求）                 │
│ [通过…]（可选备注，写入 review note）  [退回返工…]（必填原因） │
│ 或：已由 policy 自动通过 · 2026-11-06 07:25                    │
├ ④ 技术详情（折叠） ──────────────────────────────────────────┤
│ taskId/projectId/runIds/childIds/reviewIds/evidenceIds/seq    │
│ 原始状态（raw status）· tags 原始值 · [导出该任务审计]         │
└──────────────────────────────────────────────────────────────┘
```

**规则**：三段顺序固定；决定按钮只在 needs-you 出现；退回写入 human review（verdict=fail）+ 任务回到返工（需后端支持，见 §4.4）；不提供"直接完成/直接改状态"；技术详情默认折叠。

### 4.4 因果链数据契约（新增只读接口）

```
GET /superbot/tasks/:taskId/audit        （authorized，同现有 connection trust；只读）
→ 200
{
  "task": {
    "taskId": "t-21", "title": "...", "projectId": "proj-fix", "projectTitle": "proj-fix",
    "status": "in_review", "phase": "needs-you", "phaseLabel": "需你决定",
    "phaseReason": "等待你处理：awaiting-human", "phaseNext": "在「待你决定」里通过/退回",
    "priority": "high", "risk": "low", "tags": [],
    "owner": "r-24", "createdAt": "...", "updatedAt": "...",
    "acceptance": ["..."], "acceptanceCommands": [{"command": "node --test", "expectExitCode": 0}]
  },
  "chain": [
    {"seq": 12, "kind": "task/created", "at": "...", "actor": {"role": "human", "id": "web"},
     "summary": "提出需求：修复登录按钮无响应", "refs": {"taskId": "t-21"}},
    {"seq": 18, "kind": "run/started", "at": "...", "actor": {"role": "manager", "id": "session-…"},
     "summary": "派工 worker · 第 1 次尝试", "refs": {"runId": "r-24", "childId": "…"}},
    {"seq": 24, "kind": "report/submitted", "at": "...", "actor": {"role": "worker", "id": "r-24"},
     "summary": "修改 src/auth/login.ts，新增回归测试；自测 node --test 通过（claim）",
     "refs": {"reportId": "rp-8"}},
    {"seq": 28, "kind": "evidence/recorded", "at": "...", "actor": {"role": "verifier", "id": "r-25"},
     "summary": "node --test test/login.test.js · exit 0 · 12.4s",
     "refs": {"evidenceId": "ev-9", "runId": "r-25", "index": 0}},
    {"seq": 30, "kind": "review/submitted", "at": "...", "actor": {"role": "verifier", "id": "r-25"},
     "summary": "结论：通过（证据覆盖 1/1）", "refs": {"reviewId": "rv-32", "verdict": "pass"}},
    {"seq": 31, "kind": "review/submitted", "at": "...", "actor": {"role": "policy", "id": "policy"},
     "summary": "策略：需人工（高风险、涉及审美）", "refs": {"reviewId": "rv-33", "decision": {"mode": "human", "reasons": ["risk-not-low"]}}},
    {"seq": null, "kind": "pending-decision", "actor": {"role": "human", "id": "you"},
     "summary": "等你通过/退回", "refs": {"since": "..."}}
  ],
  "summary": {
    "result": "修复登录按钮事件绑定并补回归测试",
    "attempts": 1, "evidence": {"passed": 1, "total": 1},
    "verdicts": ["pass"], "decision": {"by": null, "at": null, "mode": "pending", "note": null},
    "waiting": {"reason": "awaiting-human", "since": "..."}
  }
}
```

实现映射：`WorkStore` 已有 append-only `#events` 与 `exportAudit()`（`lib/work-store.js:39-52,528`），按 `taskId/runId/reportId/evidenceId/reviewId` 过滤投影即可，不需改 schema；建议新增 `WorkStore.projectTaskChain(taskId)` + `index.js` 路由 `/superbot/tasks/:taskId/audit`（与现有 `authorized`/`sendJson` 同款）。

**人工"退回返工"**（当前缺失）：新增 `POST /superbot/reject {taskId, note}`（human proof = browser trust）→ ledger 写 human review（source=human, verdict=fail, notes=note）+ `in_review → in_progress` 转移（task-engine 允许），manager 再派新 attempt。没有这个动作，"需你决定"只有"通过"一个选项，老板无法表达"不合格"。

### 4.5 状态 / 标签字典（与后端 phase 对齐）

**主状态（phase，唯一来源 `lib/task-phase.js:17-26,39-83`）**：

| phase | 中文 | 判定（账本） | 老板问题 | 主动作 | 色调 | 排序 |
|---|---|---|---|---|---|---|
| needs-you | 需你决定 | has pendingHuman（in_review + 原因） | 为什么等我？依据够吗？ | 通过 / 退回 | warn | 0 |
| rework | 返工 | 最近 verifier=fail 且无活跃 verifier | 上次为什么失败？ | 看失败证据 / 派新 worker | danger | 1 |
| auditing | 审计中 | 活跃 verifier 或 in_review 待裁决/待人工 | 在验什么？到哪了？ | 等待 / 查看证据 | business | 2 |
| executing | 执行中 | 活跃 worker | 谁在做？多久？ | 打开执行会话 | business | 3 |
| queued | 待开始 | todo/draft | 为什么没派？依赖谁？ | 催派 / 看依赖 | idle | 4 |
| done | 已完成 | status=done | 交付了什么？ | 看结果/证据 | success | 5 |
| blocked | 阻塞 | status=blocked | 卡在哪？找谁？ | 打开会话/找经理 | danger | 6 |
| canceled | 已取消 | status=canceled | —（默认折叠） | — | idle | 7 |

**次要徽章（每行最多 2 个）**：

| 徽章 | 来源 | 文案 | 出现位置 |
|---|---|---|---|
| 高风险 | `task.risk === 'high'` | 高风险 | 行 + 详情 |
| 高优先级 | `priority === 'high'` | 高 | 行 + 详情 |
| 需人工：原因 | pendingHuman.reason / policy reasons | 需人工：策略 / 证据不全 / 审计未过 | 决策队列 + 详情 |
| 第 N 次尝试 | audit.attempts > 1 | 第 2 次尝试 | 返工行 + 详情 |
| 证据 | audit.evidencePassed/Total | 证据 2/3 | 审计/返工/needs-you 行 |

**raw status 映射（只进技术详情）**：`draft/todo→queued`、`in_progress→executing（有活跃 run）或 auditing（已交付待审）`、`in_review→auditing（待裁决）或 needs-you（有 pendingHuman）`、`blocked→blocked`、`done→done`、`canceled→canceled`。**不在 UI 展示 raw status 作为主状态**。

**verdict / 角色 / 原因中文化**：

| raw | 中文 |
|---|---|
| `verdict: pass/fail/pending` | 通过 / 未通过 / 待定 |
| `review.source: verifier/policy/human` | 自动审计 / 策略裁决 / 人工决定 |
| `agentPreset: superbot-manager/worker/verifier` | 调度员 / 执行者 / 验收员 |
| `reason: awaiting-verifier/verifier-failed/evidence-incomplete/policy-human-required/sandbox-untrusted/awaiting-human` | 等待验收 / 验收未通过 / 证据不完整 / 策略要求人工 / 验收环境不可信 / 等待你验收 |
| policy reasons（risk-not-low/irreversible/external-side-effects/tag:*） | 高风险 / 不可逆变更 / 有外部副作用 / 涉及审美/设计/文案/安全/权限等 |

**字典单一来源建议**：新增 `lib/status-dictionary.js` 导出 `{ PHASES, REASONS, VERDICTS, ROLES, TAG_GROUPS }`（label/tone/order/action），`overview.js` 与 `/superbot/status` 引用；client 通过 `/superbot/status` 的 `dictionary` 字段渲染（避免前后端两套中文）。若做不到，至少保证 client 的字典与 task-phase.js 一一对应并加测试。

### 4.6 与后端 phase 的对齐建议

当前后端已经正确实现了"结果导向 phase"（`task-phase.js`）并在 `overview.js:265-300` 投影 `phase/phaseLabel/phaseReason/phaseNext/audit`。**UI 侧应该以 phase 为唯一主状态**，但当前 TaskDrawer 仍同时显示「阶段」与 raw「状态」（`client.js:944-987`），等于把两套语义又混在一起。建议：

1. `overview tasks[]` 增加 `resultSummary`（最新 report 摘要 1 行）与人读 `executor{role,label}`，让列表不需要二次请求即可显示"结果"与"谁"。
2. 新增 `chain` 接口（§4.4）；`audit` 保留为列表摘要。
3. `pendingHuman` 增加 `since`（进入 in_review 的时间）用于等待时长排序；`task.reworkCount` 便于列表排序。
4. `verdict` 等枚举在 API 层给 `label`（或 client 用 status 字典接口），避免 UI 直出英文。
5. 异常判定放后端（`overview` 增加 `attention.exceptions[]`：blocked/失败/超时/停滞），避免每个 client 各自计算阈值。

---

## 5. 低保真布局说明

### 5.1 宽度与断点（沿用实测）

- DSH 侧栏 280px；1280 视口下面板内容宽 **932px**（此前截图实测）；1440 视口约 **1092px**；页边距 28px；内容最大宽 1120px。
- 断点（容器查询 `.sb-page-inner{container-type:inline-size}`，沿用现有实现）：
  - `≥1000px`：决策队列 + 阶段列表全列；右栏可选（见下）。
  - `680–999px`：单列；阶段列表隐藏"执行者"列，证据/等待收进副行；side peek 520px 覆盖右侧。
  - `<680px`：简报折叠为 1 行；决策行纵向堆叠（动作换行）；阶段分组 accordion；side peek 全屏 sheet。

### 5.2 桌面线框（≥1000px 容器）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Superbot · 结果与审计        已交付 2 · 待你决定 1 · 异常 0    更新于 12s [暂停][对话]│ 56
├──────────────────────────────────────────────────────────────────────────────┤
│ 简报：过去 24h 交付 2 项（1 项待你验收）；执行中 1；审计中 1；异常 0             │ 44
│       最久等待：调整登录页主色 · 3h12m（需你决定）                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ 需你决定 (1)                                                    [查看全部]     │ 32
│ ┌ 调整登录页主色  需你决定 · 证据 3/3 · 等待 3h12m   [查看证据][通过][退回] ┐ 60│
├──────────────────────────────────────────────────────────────────────────────┤
│ 进行中                                                                        │ 32
│ ▾ 执行中 (1)                                                                  │ 32
│   修复 slugify     执行中 · 执行者 · 第 2 次尝试      证据 0/1    运行 12m  [查看] │ 44
│ ▾ 审计中 (1)                                                                  │ 32
│   导出 CSV        审计中 · 验收员 · 证据 2/3           审计 4m      [查看] │ 44
│ ▸ 返工 (0)   ▸ 待开始 (0)                                                     │ 28
│ ▸ 已完成 (7 天内 2)                                                           │ 28
├──────────────────────────────────────────────────────────────────────────────┤
│ 最近交付：10:42 修复 slugify（通过，policy 自动） · 09:15 导出 CSV（待你验收）…│ 36
└──────────────────────────────────────────────────────────────────────────────┘
```

**组件规格（沿用 DSH token，client.js 现有 C 对象）**：

| 组件 | 尺寸/样式 |
|---|---|
| Header | 56px sticky，`bg-base`，底边 1px `border-l2`；标题 20/600；计数 12.5；状态数字 15/600 tabular |
| 简报 | 44–64px，`bg-layer-1` 或纯文本区；12/18，最多 3 行；结果数字加粗 |
| 决策行 | 56–64px，`bg-layer-1` + 1px `border-l3`，圆角 8；左侧 3px 状态色；动作按钮 28px 高 |
| 分组标题 | 32px，12.5/600 + hint 11 tertiary + 计数 |
| 任务行 | 44px；hover `interactive-bg-hover`；点击打开 peek；首列 38% |
| 阶段 pill | 高 20，11/500，圆角 5，点+文字（颜色只做点/边） |
| 证据行 | 36px，mono 命令 11，exit 徽章，输出预览可展开 |
| side peek | 480–560px 可拖宽；header 56；三段标题 28；节点 64；技术详情折叠 |
| 时间线节点 | 左轴 2px `border-l2`；节点圆点 8px；标题 12.5/600；meta 11 |

### 5.3 窄屏线框（<680px）

```
┌ Superbot · 结果与审计                    [对话] ┐
│ 已交付2 · 待你决定1 · 异常0   [▾ 简报]            │
├───────────────────────────────────────────────┤
│ 需你决定 (1)                                    │
│ ┌ 调整登录页主色                              ┐ │
│ │ 证据3/3 · 等待3h12m                         │ │
│ │ [通过] [退回] [查看证据]                     │ │
│ └─────────────────────────────────────────────┘ │
├───────────────────────────────────────────────┤
│ ▾ 执行中 (1)                                    │
│   修复 slugify · 执行者 · 第2次 · 12m    [查看] │
│ ▸ 审计中 (1)  ▸ 返工 0  ▸ 待开始 0              │
└───────────────────────────────────────────────┘
（详情：全屏 sheet，三段纵向，底部固定决定按钮）
```

### 5.4 交互清单（可直接实现）

1. **实时**：15s 轮询（现有），顶部显示"更新于 x"；提供 `暂停/继续`（PagerDuty Live/Paused 同款），暂停时新事件累积不跳动。
2. **决策**：行内 `通过` → 行内确认条（可选备注，写 human review note）→ 成功后行移出队列、简报更新、`role=status` 提示；`退回` → 必须填原因（≥10 字）→ 任务回返工并提示"已通知经理派新 attempt"。
3. **行打开**：点击行/卡片 → side peek；`J/K` 上下移动、`Enter` 打开、`Esc` 关闭；关闭后焦点回原行。
4. **分组**：点击组头折叠；空组默认收起，chips 显示计数（**一次**，不与组头重复）。
5. **筛选/搜索**：阶段筛选 chips（不带计数，计数在标题）；搜索任务标题/项目；筛选状态持久化（现有 `VIEW_KEY` 扩展）。
6. **视图切换**：`列表 / 监控`（监控=项目泳道×阶段列）；记住选择。
7. **证据**：点击证据行展开输出预览（≤2000 字符），`打开原始输出`（若 outputPath 可读）；复制 evidenceId。
8. **技术详情**：折叠；"复制 taskId/runId"；"导出该任务审计"。
9. **空/异常**：见 Q7；接口失败 banner 保留旧数据 + 重试；首次接入未确认时折叠成状态行一个黄点（不占首屏）。
10. **a11y**：行可键盘操作；peek 焦点陷阱 + `aria-modal`/`role=dialog`；阶段颜色不是唯一信号；`prefers-reduced-motion` 关闭过渡；按钮 ≥24px。

---

## 6. 当前面板反例清单（为什么不像「老板-员工」工具）

> 以 2026-11-07 12:50 代码为准；截图：`reports/acceptance-2026-11-06/evidence/p2-compose/panel-task-board.png`（12:14）、`panel-task-drawer.png`（12:14）、`panel-result-board.png`（12:51）。

| # | 反例 | 证据（file:line / 截图） | 为什么不像老板工具 | 修复 |
|---|---|---|---|---|
| 1 | 首屏只有活动计数（项目/未完成/待处理/活跃线程） | `client.js:1315-1318` | 老板要"交付了什么/要做什么"，四个计数是**活动量**，不是**结果** | 状态行只留 `已交付/待你决定/异常` 三个结果型计数 + 简报 |
| 2 | 对话入口占首屏大卡（"对话在原生会话里进行"） | `client.js:1342-1367` | 导航控件抢走最贵的第一屏；老板要先看结果，需要时再进对话 | 降级为 header `[对话]` 按钮 + 第二屏入口 |
| 3 | 因果被 Tab 切碎：任务/调度中/待你验收/项目/高级 | `client.js:1369-1387` | 同一件事（任务→线程→证据→决定）分散在 3 个 tab，老板要跳三处才能拼出因果 | 取消这些 tab：结果/决定/执行/审计都在同一视图；阶段列表 + side peek 链 |
| 4 | **异常任务不可见**：`PHASE_LANES` 只有 6 个 phase，blocked/canceled 不在其中，TaskBoard 只遍历这 6 lane | `client.js:878-885,920-942`；`task-phase.js:17-26` | 老板最该看到的"卡住/取消"任务在板上**完全不渲染**（blocked/canceled 无 lane）；异常计数也不存在 | 增加异常区/异常 lane；`blocked` 必须出现在首屏状态行；canceled 默认折叠 |
| 5 | 阶段 chips 与 lane 标题重复展示计数 | `client.js:929-937`（chips 计数 + section 标题计数） | 同一数字出现两次，是之前被用户批评的"重复数字噪声"回潮 | 只保留一处（chips 作为筛选，不带数字；计数在组头） |
| 6 | 英文 `verdict` 直出（`结论 pass/fail`） | `client.js:908`（TaskCard）、`client.js:952`（Drawer 自动审计） | 老板看不懂/不信任英文机器值；违反中文化字典 | `pass→通过`、`fail→未通过`、`pending→待定`；字典统一 |
| 7 | 抽屉是字段表而不是因果链：没有报告摘要、证据行、review、决定记录 | `client.js:944-987` | 老板无法回答"做了什么→凭什么→谁决定"；只有"自动审计：证据 0/0 · 结论 pass"一行摘要 | 三段式 side peek（执行/审计/决定），链式节点 |
| 8 | 状态双轨：抽屉同时显示「阶段」与 raw「状态」 | `client.js:949-955`（阶段 949 / 自动审计 952 / 状态 953） | 两套状态并存，老板不知道该信哪个（且 `状态: 待验收` 与 `阶段: 需你决定` 语义重叠） | 阶段唯一主状态；raw status 只进技术详情 |
| 9 | 执行者不可读/语义错：`已分配（r-demo-w）`；已完成任务 owner=null 显示"待认领" | `client.js:955`；`task-engine` accept 后 owner=null | runId 直出；已完成的任务显示"待认领"自相矛盾 | 显示角色+人读名；done 显示"由 policy/谁通过"；无 owner 显示"未认领"只在未开始阶段 |
| 10 | 决定动作单边且两处语义不一致：待你处理队列对 risky 有「仍要通过验收…」二次确认 + 备注（`client.js:503-556`），但任务抽屉直接「通过验收」、无确认无备注（`client.js:985`）；全系统**没有「退回/返工」动作**（无 reject 路由，账本只写 human pass） | `client.js:503-556,985`；`overview.js:34-68` 只有 humanWaitReason；`work-store.js` 只有 acceptTaskByHuman | 老板只能说"行"，不能说"不行"；验收制变成橡皮图章；同一决定在队列与抽屉里行为不同，容易误点 | 新增 `POST /superbot/reject`（human review fail + in_review→in_progress + note）；统一两个入口：风险场景都需二次确认 + 备注 |
| 11 | 没有等待时长/aging：卡片只有 `相对更新时间`；needs-you 不显示等了多久 | `client.js:906-916` | 老板无法判断"最久等待"，队列无法按紧急度排序 | `pendingHuman.since` + 等待时长列（>2h 红），默认按等待 desc |
| 12 | 空态是"6 个 0 chip + 大片空白" | `panel-result-board.png`（12:51）；`client.js:921-942`（空态仅一行文字；chips 仍渲染 0 计数） | 0 值噪声 + 无下一步引导；首次打开像坏掉 | 空态：一句引导 + [开始对话] + 示例；隐藏空 lane/chips |
| 13 | 审计/原始事实不可达 | `client.js` footer 只有"账本与隔离边界"（`isolationRows`）；`tools.js:596` auditExport 只给 agent | 老板/审计员要下钻"原始事件/证据全文"时无入口；信任链不闭环 | 技术详情折叠 + "导出该任务审计"；footer 保留全局 raw 导出 |
| 14 | 「调度中」与「执行中」双入口：tab「调度中」与任务板「执行中」lane 表达同一批 run | `client.js:1374,1407-1430` | 同一事实两个入口，信息重复且口径可能不一致 | 合并到阶段列表"执行中"；线程细节进 side peek |
| 15 | 阶段卡的副行是 `phaseReason` 机器推导句（如"等待你处理：awaiting-human"） | `overview.js:143-157` 原因为 code，UI 未完全中文化（`REASON_LABEL` 存在但 detail 仍带英文 token） | 老板读代码；"为什么等我"应是业务语言 | 原因集中映射（§4.5），detail 不再直出 code |

**一句话**：当前面板已经从前一版"字段堆叠"进化到"阶段化"（方向正确），但仍像**任务管理后台的运维视图**：以活动量与状态为中心，缺少"结果简报、决定队列、因果链、异常/aging、可退回"这五个老板工具的核心件。

---

## 7. 实施建议（按收益/成本排序）

**M0（1–2 天，最小可用，只改 UI + 1 个只读接口）**
1. 首屏：状态行改 `已交付/待你决定/异常`；对话大卡降级为 header 按钮；简报 2–3 行（规则生成：最近 24h done 数、active phase 计数、最久等待）。
2. 阶段列表替代默认泳道：6 阶段分组、空组收 chip、行式（结果/阶段/执行者/证据/等待/操作）。
3. 修复异常不可见：blocked/canceled 进异常区；状态行异常计数。
4. 抽屉：阶段唯一主状态 + repurpose 为三段式（先只读，不接 reject）：执行记录（report 摘要）、审计证据（evidence 行）、决定记录（review）；技术详情折叠。
5. 字典中文化：verdict/role/reason 全部中文；raw status 只进技术详情。
6. 新接口 `GET /superbot/tasks/:taskId/audit`（基于 `#events` 投影），供抽屉链使用。

**M1（3–5 天）**
1. 决策闭环：`POST /superbot/reject`（human fail review + in_review→in_progress + note），通过/退回都写备注；等待时长排序与 aging 红。
2. 空/异常/停滞/超时状态与文案；Live/Paused；最近交付时间线（最近 10 条）。
3. 视图切换 `列表/监控`（监控=项目泳道×阶段列，已完成默认隐藏）。

**M2（可选）**
1. 交付时效条（created→delivered 分段：等待/执行/审计），发现瓶颈。
2. 统计页脚（交付数、返工率、平均等待、审计通过率）。
3. 审计导出下载 + 原始事件全屏视图。

**测试清单**：阶段映射（含 blocked/canceled）、needs-you 排序（等待时长）、reject 后 phase 变 rework、done 任务 owner 展示、verdict 中文、空态不显示 0 chip、side peek 键盘/焦点、异常计数、接口 403/404/500。

---

## 8. 参考来源（一手）

- 飞书任务 · 快速上手任务（任务中心按角色/状态/清单、负责人/关注人、任务详情、子任务）：<https://www.feishu.cn/hc/zh-CN/articles/210653614514-快速上手任务>
- 飞书任务 · Tasks updates（Dashboard tab、任务清单模板、任务视图）：<https://www.feishu.cn/hc/en-US/articles/744682473644-tasks-updates>
- 飞书任务 · 帮助中心「快速入门」分类（任务清单/看板/甘特/仪表盘相关文章入口）：<https://www.feishu.cn/hc/zh-CN/category/7225142120636678146-快速入门>
- 飞书项目 · 产品能力（多视图：列表/看板/甘特/树形/全景；节点流工作流；自动化）：<https://project.feishu.cn/home/landing-product>
- Linear · Inbox（Priority tab、J/K、snooze、就地动作）：<https://linear.app/docs/inbox>
- Linear · Triage（唯一收件队列、接受/拒绝/重复/推迟）：<https://linear.app/docs/triage>
- Linear · Initiative and project updates（健康度 On track/At risk/Off track、更新历史、staleness、Write with Agent）：<https://linear.app/docs/initiative-and-project-updates>
- Asana · Portfolio progress and reporting（组合状态、status update 三段块、dashboard）：<https://help.asana.com/hc/en-us/articles/22872284856731-Portfolio-progress-and-reporting>
- Monday · Configure your Dashboard（跨 board 汇总 widget）：<https://support.monday.com/hc/en-us/articles/26233702292114-Configure-your-Dashboard>
- Notion · Views, filters, sorts & groups（side peek、属性显隐、group/sub-group）：<https://www.notion.com/help/views-filters-and-sorts>
- Superhuman · Help（Command 快捷动作层/移动端导航，作为收件箱指挥中心模式的参考）：<https://help.superhuman.com/hc/en-us/articles/46005719737357-Mobile-Navigation>
- PagerDuty · Operations Console（实时事件台、side panel、Pin、Live/Paused、列选择/筛选、批量动作）：<https://docs.pagerduty.com/ai-automation/aiops/operations-console>
- GitHub · Using workflow run logs（run 状态与 conclusion、job 日志、失败重跑）：<https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs>

**补充说明**：
- Height 的「AI 自动 triage/状态更新」模式仅作历史参考；其官方站点在 2026-11-07 已不可访问，不作为现行标杆。
- 本报告核对的本地代码：`lib/task-phase.js`（phase/audit 派生）、`lib/overview.js:265-300`（tasks[] 投影）、`lib/client.js:878-987`（PHASE_LANES/TaskCard/TaskBoard/TaskDrawer）、`lib/client.js:1294-1468`（header/简报/tab/列表渲染）、`lib/work-store.js:39-52,528,724,743-812,888-975`（事件/审计/报告/证据/审查）、`lib/index.js:274-371`（status/概览/路由）、`tools.js:596`（auditExport）。
- 当前面板截图：`reports/acceptance-2026-11-06/evidence/p2-compose/panel-task-board.png`、`panel-task-drawer.png`、`panel-result-board.png`。
