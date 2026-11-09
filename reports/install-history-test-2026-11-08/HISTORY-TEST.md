# 已有 DSH 历史安装测试（2026-11-08）

## 场景设置
- 用现有 `DSH_HOME` 复制为 `/tmp/sb-history-home`（2 个 workspace、9 个顶层 session、12 个子 session）。
- 删除 `storages/dsh-superbot`，模拟用户第一次安装 Superbot（账本为空）。
- 全部 session 文件 mtime 设为 2026-08-15（约 2–3 个月前）。
- 启动隔离 DSH 0.2.1-rc.5 + 当前插件（http://127.0.0.1:56429/）。

## 实测结果

| 检查 | 结果 |
|---|---|
| 插件启动 | PASS（新 stateDir 自建账本、单实例锁生效） |
| 首次接入扫描 | PASS：识别 2 个 workspace、9 条顶层线程、12 条子线程、0 条账本任务；`confirmationRequired=true` |
| 线程标题 | 部分缺失：session 没有 title 事件时为 `null`（proj-fix 前 3 条中 2 条无标题） |
| 历史会话内容 | 未读取（扫描只读 session 头部：title/agentPreset/origin/lock/mtime），拿不到任务正文、目标、结果 |
| 历史「任务」 | **没有**：`/superbot/overview` 中 `tasks=0`、`projects[].counts.tasks.total=0` |
| 盘点确认 | PASS（显式开启 `httpHumanActions` 后确认；默认关闭仍是 approval-only） |
| 确认后能否管理历史工作 | **不能**：无 `superbot_history_*` / `import` 工具或路由；Manager 的 `project_list/project_overview` 只读账本，看不到旧 session 的正文 |
| 「分析完所有旧任务交给主线程」 | **当前不成立**：只能看到项目/线程清单和标题，不能把历史工作导入账本，也不能把历史任务转成可管理的 Superbot 任务 |

## 结论
1. **已有 DSH 用户的安装流程是通的**：插件只读扫描，不改历史 session；首次接入会要求确认项目状态。
2. **历史工作导入是缺口**：旧会话不是 Superbot 任务（没有 requirement/plan/task/run），插件也没有 session 正文读取和导入工具；确认盘点只是解锁后续新派工，不等于接管旧任务。
3. **完整度判定**：核心闭环（需求→计划→派工→执行→证据→审计→人工验收→返工）已实现并有 166 测试；但「历史任务接管」与专家审计的 P0/P1（自动审计驱动、取消/停滞、驳回、因果时间线、phase V2）未收口，**尚未收敛为可交付 v1**。

## 建议的补齐方案（下一版）
1. onboarding 增加有界 **session digest**：首条用户意图 + 最后一条 assistant 结论 + 标题（最多 N 字节/帧，失败降级为 null）。
2. 面板「历史工作」列表：按项目展示 digest、最后活动、建议状态（进行中/挂起/归档），支持勾选。
3. 新增 manager 工具 `superbot_history_import`：用户确认后把选中的历史工作落成 requirement + task（context=digest，acceptance=人工确认历史状态），默认 paused/待确认，不进派工队列。
4. 真机验收：在 2–3 个月的 history 上完成「扫描→展示→勾选导入→主线程可见→用户确认后派工」全链。

## 证据
- `evidence/onboarding.json`、`overview.json`、`status.json`

## 追加实现（同日）：历史摘要 + 交给 Superbot 接管

- `onboarding.js` 的 `readSessionMeta` 增加有界 **digest**：从 session 头部帧提取首条 `user/message` 文本（≤600 字符），线程输出新增 `digest.intent`。
- 实测（fresh stateDir，2–3 个月旧会话）：proj-fix 3 条、proj-fix-2 1 条线程成功提取意图摘要，例如「这是 Superbot 的真实闭环验收演练…」「这次先做一次首次接入盘点确认流程…」；证据见 `evidence/onboarding-digest.json`。
- 面板新增 **历史** tab：按项目列出旧线程（标题/摘要/建议状态/最后活动），每条支持「交给 Superbot 分析」（打开 Manager 原生会话并预填该历史工作的摘要与接管问题）和「打开原会话」。
- 新增 **INIT_PROMPT**：用户没有任何历史时，点「新建对话/进入对话」会让 Manager 先 `superbot_onboarding_scan`，给出「现状快照 + 进行中/挂起/没结果」的接管建议并建立最小工作流，不自动派工。
- 仍未做：把历史工作自动落成账本 requirement/task（即 `superbot_history_import`）；当前是「摘要 + 人工确认 + Manager 对话接管」，不是静默自动导入。

验证：dsh-superbot 148 + task-engine 18 = 166 PASS。
