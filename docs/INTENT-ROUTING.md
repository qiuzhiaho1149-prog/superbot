# Superbot：口语需求 → 项目路由 → 高质量任务

用户在唯一的主 Manager 会话里跨项目说话。本文说明 Superbot 如何**自己判断该在哪个项目执行**，以及如何把口语需求改写成可验收任务，同时避免猜错和冗余校验。

## 1. 路由目标：项目是目标，session 是资源

| 概念 | 含义 | 是否路由目标 |
|---|---|---|
| **project / workspace** | 一个 DSH 工作区（仓库/目录），任务有唯一 `projectId` | ✅ 是 |
| **session / 线程** | 一次对话上下文；worker/verifier 是执行资源 | ❌ 不是 |
| **任务** | 一个可验收工作单元，属于恰好一个项目 | 执行单位 |

因此：
- 用户说“优化一下”时，Superbot 先判断**哪个项目**，再决定是否派工；
- 它不会把任务塞进某个历史 session 里执行；派工时由 dispatch 新建 worker 子会话（verifier 另建），子会话只拿任务 brief；
- 历史 session 只用于只读摘要/导入，不是执行容器。

## 2. 路由决策（确定性匹配 + 人类确认阈值）

Manager 在写 requirement 之前调用 `superbot_project_match({text})`（内部 `matchRequirement`）：

- 对每个项目按标题、标题 token、路径、活跃度打分；
- 返回 `candidates`（含 score/reasons）和 `needsConfirmation`；
- `needsConfirmation = top 不存在 || top.score < 4 || (第二 - 第一) 差距 < 2`。

执行规则：
1. 用户**明确**说项目名/路径/仓库 → 直接使用，不重复问；
2. 不明确 → 调 match：
   - `needsConfirmation=false` → 自动选 top1，回复第一行写「目标项目：X」；
   - `needsConfirmation=true` → 只问 **一个**阻塞问题，列 2–3 个候选；不先派工、不猜多个；
3. **跨项目目标** → 拆成每项目一个 requirement/spec/plan；一个 task 只允许一个 `projectId`，不建“跨项目 task”；
4. 用户纠正项目 → 改 `projectId` 重新提交，不重复创建需求；
5. 不新增哈希/二次验证层：路由靠现有 workspace registry + 文本匹配，任务事实仍由账本与验收证据保证。

## 3. 口语需求改写（核心职责）

用户原话是 L0 素材，不是任务工单。Manager 必须先做理解对齐：

```
requirement.text  = 用户原话（逐字保留，不覆盖）
spec.content      = 改写后的 L0 目标/现状/为什么
spec.acceptance   = L1 可观察验收（至少一条行为验收）
spec.constraints  = L2 范围/非目标/项目边界
plan.tasks        = L3 任务拆分（每 task 自带 acceptanceCommands）
verifier evidence = L4 机器证据（账本命令 + 工作区指纹）
```

规则：
- 模糊词（优化/好看/尽快/差不多）必须变成可观察结果或阈值；不能量化时给 2–3 个选项让用户选，不替用户做审美/范围决定；
- 只问**阻塞**问题（最多 3 个）；能合理默认的写「假设：…」并继续；
- 改写后给用户 3 行确认：目标项目 / 要做什么 / 验收方式；用户说“直接做”则跳过确认，但不跳过内部拆解；
- 不把原话直接当 task title 派工，也不把 manager 的长篇解释塞进 worker brief；
- 不新增“提示词评分器/校验器”一类冗余层：改写质量靠 spec 结构 + 验收命令 + verifier 证据闭环。

## 4. 例子

| 用户口语 | Superbot 行为 |
|---|---|
| “帮我把登录页改好看点，就那个 fix 项目” | 明确项目 → 直接路由；把“好看”转成可观察验收（布局/颜色/截图对比或具体 token），给 2 个风格选项让用户选。 |
| “优化一下” | 无项目信号 → match 无法确认 → 只问：“你说的是 A / B / C 哪个项目？” |
| “把 A 项目的前端和 B 项目的 API 都改一下” | 拆成两个 requirement/plan（A、B 各一个），分别派工；不建跨项目 task。 |
| “这个 bug 修一下，测试跑不过” | 若“这个”无上下文 → 问项目；确认后要求用户/代码给出失败命令，转成 acceptanceCommands。 |

## 5. 与上下文经济的关系

- 路由只传用户原话 + 项目列表摘要，不传所有项目历史；
- 每个项目有 `SUPERBOT-HANDOFF.md`，Manager 恢复上下文先读它 + `project_overview`，不重放聊天；
- worker/verifier 只拿自包含 brief，不拿主会话历史。
