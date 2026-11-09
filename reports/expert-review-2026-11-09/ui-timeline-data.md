# 时间线数据契约与交互缺陷复核 · U3

> 专家组 U3 · 只读代码诊断 + 真实账本探针复现 + 可落地契约/骨架
> 评估快照：2026-11-08 13:37（`packages/dsh-superbot/lib/client.js` **1818 行**；`ThreadMap` 在 `995-1081`，常量 `992-993`；`overview.js` **354 行**）。行号已按该快照复核；仓库代码未改，本文件是唯一写入。
> 与 U1 的分工：`ui-timeline-redesign.md`（同目录）负责**几何/视觉重设计**（网格、xPct、now 线位置、行高、裁剪标记样式）；本文负责**数据契约根因、交互缺陷、纯函数测试、组件 props 骨架**。两份结论互相引用，不重复实现细节。
> 复现脚本：`/tmp/u3-timeline-probe.mjs`、`/tmp/u3-timeline-probe2.mjs`、`/tmp/u3-timeline-probe3.mjs`（临时 `stateDir` + 真实 `WorkStore`/`buildOverview` + ThreadMap 精确映射逻辑；只写 `/tmp`）。

---

## 0. 结论先行（TL;DR）

**面板时间线"对不齐"的主因不在 CSS，而在数据契约缺三类事实**：

| # | 缺失的事实 | 当前替代物（错误来源） | 直接后果 |
|---|---|---|---|
| 1 | **单一时间基准**（服务端 `now`） | 客户端 `Date.now()`（`client.js:1018`）+ 服务端 `Date.now()`（`task-phase.js:77`）+ `generatedAt` ISO 字符串（`overview.js:339`）三套时钟 | 条的位置/进行中判定/相对时间各算各的；客户端时钟偏移时"已完成"的条被 clamp 成 100% 或"进行中"；phase 说"疑似卡住"、图上条还在跑 |
| 2 | **数值时间戳 + 时长**（`t0/t1` epoch ms、`durationMs`） | ISO 字符串 + 客户端 `Date.parse`（`client.js:1002/1004/1009/1011`）+ 由 bar 宽度隐式表达时长 | 解析失败静默丢行（`1003/1010` `continue`）；空串被 `??` 漏过（`1009`）；时长要靠比例尺猜；跨设备/跨时区显示漂移 |
| 3 | **按项目分组 + 截断语义**（`lanes[]`、`truncated`） | 全局 `tasks` 按 `updatedAt` 排序后 **slice(0,200)**（`overview.js:310-311`）+ `project.threads` 不设上限（`167-181`）+ 前端"可见项目 × 全局任务"拼装（`client.js:1286/1522`） | 跨项目饥饿：探针中 alpha 项目 6 个任务只进来 2 个；被挤掉的项目只剩线程条、没有任务条；`filter=attention` 时可见项目 1 个但 tasks 载荷仍是 200 条 |

**当前实现的 30 行数据准备（`client.js:995-1022`）同时承担了**：ISO 解析、空值回退、跨项目 join、窗口求解、比例尺。任何一条数据事实缺失都会直接变成视觉错觉：

- **进行中条顶着右边界**：`finishedAt=null → end=null → end=now`（`1050-1051`），而窗口终点就是 `now`（`1020-1021`），所以 open 条终点恒为 100%；同一条"now 线"也写死 `left:100%`（`1074`），两者重合 → 无法区分"在跑""被窗口裁掉""已结束"。
- **任务条长度不代表工时**：任务条是 `createdAt → updatedAt`（`1009-1012`），`updatedAt` 是"最后一次状态变更"，不是工作时长。探针里一个 11-03 创建、11-08 被 blocked 的任务条宽 **99.19%**（看着像干了 5 天，真实 worker 工时 0）。
- **同一毫秒多条 + 短条变圆点**：`createPlan` 把**同一个 `at`** 传给每个任务（`work-store.js:1118-1119`；`createTask` 把 `at` 同时写进 `createdAt/updatedAt`，`task-engine/lib/index.js:153-161`）。探针 211 个任务里 **208 个 `createdAt === updatedAt`**（0 时长）；三个 plan 任务在 7 天窗口上都是 `startPct=0.00 → endPct=0.00`，再被 `Math.max(0.8,…)` + CSS `minWidth:5px`（`client.js:1054/1077`）拉成 5px 圆点。即便**真实的 25 分钟 worker run**，在默认 7d 轴（147h 实测跨度）上也只有 **0.28%** 宽 → 仍是圆点。**"只有跑了几个小时/跨天的条才可见"是比例尺+时长语义的双重问题。**
- **缩放档位无效**：`windowStart = max(最老数据, now - windowHours)`（`1020`），即轴永远"贴合数据"（探针请求 168h，实际跨度 147h），而 `70/24h` 又被夹到 `now-24h` 后只剩 24h、所有更早行 `startPct` 被 clamp 到 0（探针：24h 档全部 `clippedStart=true`、全部 0.00）——**切档只改变裁切，不改变刻度语义**，而且没有"左端被裁"标记（`1022` clamp，无 flag）。
- **跨项目排序/身份混淆**：lane 只保留 `title`、丢掉 `projectId`（`client.js:1000`），React key 用 `lane.title`（`1046`）→ 同名项目（不同路径）会合并/错配；lane 顺序 = 项目列表排序（`overview.js:247-256`），行顺序 = 仅按 `start`（`1014`），任务/线程两类混排（细条 3px 与胶囊 10px 交错）→ 看不出"哪个任务的哪次执行"。

**交互层 P1 结论**：只有左侧标签按钮可点（`1066-1071`），**条本身不可点**（`1075-1079`）；任务行没有打开任务抽屉的通道（`995` 只有 `onOpenSession`，`1522` 未传 `onSelect`）；hover 只有原生 `title`（`1069/1076`）；标签列不 sticky、随横滚丢失（`1043/1065`）；空态/裁剪/丢弃无任何提示（`1003/1010/1015/1017`）；`childId` 尚未绑定时指针可点但无响应（`1068`）。

**建议**（详见 §3-§7）：服务端新增纯函数 `buildTimeline()`（新文件 `lib/timeline.js`）并在 `GET /superbot/overview` 增量返回 `now`、`timeline.lanes[]`、`truncated`，线程/任务条目统一 `t0/t1`（epoch ms）、`durationMs`、`state`、`openReason`；一个请求内把同一个 `now` 注入 `buildOverview`/`deriveTaskPhase`；客户端 `ThreadMap` 降级为**纯投影组件**（无 `Date.parse`、无 `Date.now`、无跨项目 join），几何只保留一个 `xPct`（与 U1 规范对齐）；固定窗口 = `[now - windowHours, now + headroom]`，open 条终点=now、now 线不被边框裁；补 12 条服务端纯函数测试 + 客户端 geometry 测试（`node --test`，不引入构建）。

---

## 1. 复核范围与方法

| 项 | 内容 |
|---|---|
| 代码范围 | `client.js`（ThreadMap 995-1081、数据装配 1284-1354、map tab 1519-1523、`relativeTime/absoluteTime` 257-280、`POLL_MS` 138/1154-1161）、`overview.js` 全量、`work-store.js`（`startRun` 647-668、`finishRun` 682-694、`createPlan` 1079-1129、`#clock` 432）、`task-engine/lib/index.js`（`createTask` 153-161、`transition` 185-193）、`task-phase.js`（stalled 判定 73-80）、`index.js:285-296/381`（路由） |
| 方法 | ① 逐行读；② 用真实 `WorkStore`（临时 stateDir）构造"生产形状"账本：plan 任务（同一 `at`）、完成 run、active run（无 `finishedAt`）、跨天等待任务、空串时间戳任务、跨项目饥饿（205 vs 3）；③ 把 `ThreadMap` 的映射逻辑**逐行照抄**到探针里跑同一份 payload，量化每一项错觉；④ 对照 `reports/project-review-2026-11-09/panel-gantt.png`（旧构建截图，见 §4.9） |
| 只读约束 | 未修改仓库任何源码；探针只写 `/tmp` 临时 `stateDir`，运行后删除 |
| 未验证 | 真机浏览器渲染/交互（NOT RUN）；未运行现有测试套件（本次为只读数据复核，测试基线引用 `reports/project-review-2026-11-09/PROJECT-REVIEW.md`：168 PASS） |

---

## 2. 复现结果（关键数字）

探针 2（跨项目 + 生产形状，serverNow=2026-11-08T12:00:00Z，`/tmp/u3-timeline-probe2.mjs`）：

```text
ledger tasks = 211 | overview.tasks = 200 | cap = 200 (overview.js:310-311)
- proj-alpha: ledger=6 overview.tasks=2     ← 跨项目饥饿：4/6 任务被全局 cap 挤掉
- proj-beta : ledger=205 overview.tasks=198
- tasks with createdAt === updatedAt: 208    ← plan 任务同一 at（零时长）
- tasks 起始不可解析（被客户端静默丢弃）: 1（createdAt="" 的任务）
- windowStart = 2026-11-03T08:00:00.000Z | range(h) = 124.00  ← 请求 168h，轴贴合数据
- active run bar: startPct=87.10 endPct=100.00              ← 进行中条贴右边界
- alpha-waiting 任务条: startPct=0.00 endPct=99.19 width=99.19% ← 真实工时≈0
- task rows with width < 0.1%（渲染成 5px 点）: 198
- 已完成线程 2 条 | 客户端临时算的 duration = 1500000ms / 900000ms | payload 无 durationMs、无 now
- client 时钟慢 1h：已完成 run 的 endPct = 60.50（位置随客户端时钟漂移）
- filter=attention: projects = 1/2 | tasks payload = 200（可见项目与任务载荷脱钩）
```

探针 3（单项目、可解析，`now=2026-11-08T12:00:00Z`，`/tmp/u3-timeline-probe3.mjs`）：

```text
windowHours=168 windowStart=2026-11-02T09:00:00Z rangeH=147.00
  task t-2 startPct=0.00 endPct=0.00 width=0.80   ← plan 任务（createdAt===updatedAt）三点重叠
  task t-4 startPct=0.00 endPct=0.00 width=0.80
  task t-6 startPct=0.00 endPct=0.00 width=0.80
  thread r-9 startPct=65.99 endPct=66.27 width=0.80 ← 25 分钟真实 run 也是"点"（0.28% 真实宽）
windowHours=24  windowStart=2026-11-07T12:00:00Z rangeH=24.00
  全部行 startPct=0.00 endPct=0.00 clippedStart=true ← 切 24h 后所有更早数据被左裁且无标记
```

探针 1 补充：数据跨度 < 60s 时，`range = Math.max(now-windowStart, 60_000)`（`1021`）的 60s 下限生效——全部数据被压到轴的最左 **0.25%**，右 99.75% 空白，且"now 线"（固定在 100%）落在未来的 60s 处。新装/短账本用户的图直接不可读。

---

## 3. 数据根因逐项（对齐失败）

> 级别：P0=会直接导致错误结论/错误决策；P1=明显误导/可用性差；P2=打磨项。

| # | 级别 | 根因 | 代码证据 | 机制与现象 | 修复归属 |
|---|---|---|---|---|---|
| R1 | **P0** | **没有单一服务端时间基准** | `client.js:1018` `const now = Date.now()`；`overview.js:339` 只给 ISO `generatedAt`；`task-phase.js:77` 服务端再算一次 `Date.now()`；`client.js:257/1354` 相对时间又用客户端时钟 | 同一屏上三套时钟：phase 的 stalled 判定用服务端 now、条/now 线用客户端 now、`更新于 x 分钟前` 用客户端 now。客户端时钟偏移 → 已完成 run 被画到 100%（clamp）或位置整体漂移；客户端时钟落后时 open 条仍贴右边界（因为右边界=客户端 now） | 服务端契约：每个响应带 `now`（epoch ms）；一个请求内只取一次 now，注入 `buildOverview`/`buildTimeline`/`deriveTaskPhase` |
| R2 | P0 | **只有 ISO 字符串、无数值时间戳** | `overview.js:21/178-179`（`timeOf` 只回字符串或 null）；`client.js:1002/1004/1009/1011` 全用 `Date.parse(String(...))` | 每次渲染重新解析；格式/时区不一致时（未来导入、外部 `at`、工具传本地时间串）解析结果随引擎/机器变化；数字时间戳（epoch）没有歧义，ISO 只在兼容字段保留 | 契约：新增 `t0/t1` 数值；客户端不再 `Date.parse` |
| R3 | P0 | **解析失败静默丢行** | `client.js:1003` `if (!Number.isFinite(start)) continue`；`1010` 同 | 一条时间坏的任务/线程整行消失，无计数、无提示；用户以为"没有这条工作" | 契约：条目带 `missingTime:true`/`invalidTime`，UI 显示"时间未知"徽章；`truncated/dropped` 计数上报 |
| R3b | P1 | **`??` 不回退空串** | `client.js:1009` `String(task.createdAt ?? task.updatedAt ?? '')` | `createdAt === ''`（store 的 `at` 允许空串：`work-store.js:563` `at ?? this.#clock()`，空串不是 nullish）→ `'' ?? updatedAt` 仍是 `''` → 解析 NaN → 任务被丢；探针已复现 1 例 | `toEpoch()` 统一处理（空串→null→明确标记），不要用 `??` 链 |
| R4 | **P0** | **`finishedAt` 缺失时用 `now`，且 now 线与右边界重合** | `client.js:1004`（end 可能 null）→ `1050-1051` `running ? now : end`；`1020-1021` 窗口终点=now；`1074` now 线固定 `left:100%` | open 条终点恒 100%、now 线与右边框重叠、被窗口裁掉的完成条也用 clamp 到 100%；"进行中/被截断/窗口末端"三种语义在像素上不可区分；`status` 永远 `running` 的 abandoned run（进程重启后无 finish 事件）也画成"在跑" | `t1:null` 显式表示开放端 + `openReason`；窗口 = `[now-windowHours, now+headroom]`，now 线在 ~96-98%；`t0/t1` 在窗口外的行标 `clippedStart/clippedEnd` |
| R5 | **P0** | **同一毫秒多条**（plan 任务共享一个 `at`） | `work-store.js:1079-1129`（`createPlan` 把同一 `at` 传给每个 `submitTask`/`planTask`：`1118-1119`）；`task-engine/lib/index.js:153-161`（`createTask` 用 `at` 同时写 createdAt/updatedAt） | 一次 plan 的所有任务 createdAt===updatedAt（探针 208/211）→ 0 时长；同一 x 位置完全重叠、排序不稳定、点标记互相覆盖；"一条 plan 的 5 个任务"在图上看起来"没有任务" | 契约：每行给 `t0/t1`（数值）+ `stackIndex/laneRow`（或客户端按同 t0 分组加 2px 偏移）；UI 对 0 时长用"点+计数堆叠"而不是一条细线 |
| R6 | **P0** | **任务条用 `createdAt → updatedAt`，长度≠时长** | `client.js:1009-1012`；`updatedAt` 语义见 `task-engine/lib/index.js:190`（每次 transition 刷新） | 等待/阻塞/审计时间都被算进条长（探针 99.19% ≈ 5 天，实际工时 0）；plan 任务 0 时长；完成任务的条长=贯穿其生命周期的总等待 | 任务条语义拆成 `spanMs`（生命周期）与 `workMs`（worker run 时长之和）；默认视觉用"生命周期细条 + 执行子行"（U1 §3），tooltip 同时显示两个时长 |
| R7 | P1 | **无 `durationMs` 字段** | `overview.js:167-181`（threads 无 duration）；`271-311`（tasks 无 duration/span/work）；探针 payload keys 实测无 `duration*` | 客户端只能靠条宽猜时长；hover 无法给出"跑了 25 分钟"；验证"卡了多久"没有事实来源 | 契约：thread 给 `durationMs`（closed）/null（open）；task 给 `spanMs`+`workMs`；再加 `marks[]`（claim/in_review/done/review 的 epoch）供因果时间线复用 |
| R8 | **P0** | **跨项目全局排序 + 200 上限** | `overview.js:310-311`（全局按 `updatedAt` desc → slice 200）；`167-181` threads 不设限；`client.js:1007-1013` 每个 lane 再从同一全局数组过滤；`1522` 传 `overview.tasks` | 活跃项目把 cap 吃满 → 其它项目任务全部消失（探针 alpha 6→2）；被挤掉项目的线程条还在（thread 来自 project.threads）→ "有线程没任务"；`taskById` join 失败导致标签退化为 runId | 契约：服务端按项目分组产出 `timeline.lanes`（每项目独立 cap + `truncated`），UI 直接消费；`overview.tasks` 保持列表用途不变 |
| R9 | P1 | **可见项目 ≠ 任务载荷（filter/视图脱钩）** | `client.js:1286`（`projects = overview.projects`，服务端已过滤：`overview.js:246/341`）+ `1522`（tasks 未过滤：`overview.js:343`）；`client.js:1520-1522` map tab 没有自己的过滤控件 | 用户在"待你验收"过滤下切到地图：只看到 1 个项目，但任务数组 200 条、大部分属于不可见项目；切回其它 tab 过滤仍在 | map tab 用独立数据（`timeline.lanes` 全量项目；过滤仅高亮/折叠），或地图 tab 隐藏全局过滤 |
| R10 | P1 | **lane 身份丢失 + key 冲突** | `client.js:1000`（lane 只存 title，不含 projectId）；`1046` `key: lane.title` | 同名项目（不同路径）在 React 复用中错配；不同项目无法区分；跨项目比较不可靠；排序按项目列表顺序而非时间 | lane 带 `laneId/projectId/order`；key 用 projectId |
| R11 | P1 | **行排序/类别混排** | `client.js:1014` 仅按 start 排序；`1049` 同一数组渲染 thread 10px 胶囊与 task 3px 细条 | 同一 lane 内任务与线程按时间交错；看不出"哪个线程属于哪个任务"；数据刷新后行序会跳 | 分层：项目 → 任务行（生命周期）→ 该任务的线程子行（U1 §3 层级规范）；行序由服务端 `laneOrder/rowOrder` 固定 |
| R12 | P1 | **窗口/缩放语义错误** | `client.js:1020-1022`；`1038-1041` 三档按钮；`996` `windowHours` 内部 state | 轴自动贴合数据（168h→147h），24h 档把更早数据静默左裁；切 tab 卸载后重置 7d；没有"当前窗口起止"文字说明 | 固定窗口 `[now-windowHours, now+headroom]`；窗口状态提升到父组件 + localStorage；轴头显示窗口起止 |
| R13 | P2 | **短时长视觉尺度失真** | `client.js:1054` `Math.max(0.8, endPct-startPct)`；`1077` `minWidth:'5px'` | 真实 25 分钟 run 在 7d 轴上是 0.28% → 被 5px 撑开；短条终点不在真实时间位置，相邻短条重叠/等长；"时长不可信" | 视觉宽度只用 `xPct` 差值，不设 px 宽；点击热区单独扩展（U1 A1 规则） |
| R14 | P2 | **phase 派生没有共享同一个 `now`** | `overview.js:274-280` 调 `deriveTaskPhase`；`task-phase.js:74-80` 内部 `Date.now()`（stalled 判定） | 同一响应里 phase 的 stalled 与 timeline 的"进行中"会各用各的时钟，可矛盾（客户端时钟/轮询时差）；`PHASE_META` 已含 stalled（`task-phase.js:19`），无需补 label | `deriveTaskPhase({..., now})`，与 timeline 共用路由注入的 `now` |

---

## 4. 数据契约修正建议（核心）

### 4.1 原则

1. **服务端是事实源**：项目分组、`now`、时长、开放端原因、截断计数都由服务端算；客户端只做像素映射与格式化（避免三套时钟/两套 join）。
2. **数值时间优先**：所有机器消费的时间字段用 **epoch 毫秒整数**（`t0/t1`），ISO 字符串仅保留在兼容字段（`startedAt/finishedAt/createdAt/updatedAt`）。
3. **开放端显式化**：`t1:null` + `openReason:'active'|'no-finish'`，不允许"null 一律当 now"。
4. **截断显式化**：`truncated.{tasks,runs,projects}` + 每行 `clippedStart/clippedEnd`；禁止静默丢弃。
5. **一个请求一个 `now`**：路由取一次 `Date.now()`，注入 overview/timeline/phase；测试可传固定 `now`（纯函数）。
6. **向后兼容**：所有新增字段是增量；旧客户端忽略；旧字段保留。

### 4.2 `GET /superbot/overview` 增量契约（JSON）

```jsonc
{
  // ── 新增：单一时间基准 ───────────────────────────────────────────
  "now": 1794139200000,                    // epoch ms，服务端本次响应唯一时钟
  "generatedAt": "2026-11-08T12:00:00.000Z", // 保留：人类可读/兼容
  "serverTimeZone": "America/New_York",    // 可选：绝对时间标签用

  // ── 新增：地图专用分组（与 tasks 解耦，按项目各自 cap）──────────
  "timeline": {
    "window": { "defaultHours": 168 },      // 客户端可自行 zoom，不必回服务端
    "lanes": [
      {
        "laneId": "proj-alpha",            // React key / 稳定身份
        "projectId": "proj-alpha",
        "title": "alpha-project",
        "order": 0,                        // 服务端显式排序（避免客户端按 title 猜）
        "counts": { "tasks": 6, "threads": 2, "openThreads": 0 },
        "truncated": { "tasks": { "shown": 6, "total": 6, "cap": 120 }, "runs": { "shown": 2, "total": 2, "cap": 200 } },
        "items": [
          {
            "key": "task:t-12", "kind": "task", "taskId": "t-12",
            "title": "alpha-waiting", "status": "blocked", "phase": "blocked", "phaseLabel": "阻塞",
            "t0": 1793740800000,           // createdAt epoch ms
            "t1": 1794106800000,           // updatedAt epoch ms（生命周期末端）
            "spanMs": 366000000,           // = t1 - t0（生命周期；不是工时）
            "workMs": 0,                   // worker runs 时长之和（真实工时；无 run 为 0）
            "missingTime": false,
            "marks": [ { "at": 1793740800000, "kind": "created" }, { "at": 1794106800000, "kind": "blocked" } ]
          },
          {
            "key": "thread:r-17", "kind": "thread", "runId": "r-17", "taskId": "t-12",
            "agentPreset": "superbot-worker", "label": "worker:alpha-active",
            "status": "running", "active": true,
            "t0": 1794067200000,
            "t1": null,                    // 开放端（不伪造 now）
            "durationMs": null,            // closed 时 = t1-t0；open=null
            "openReason": "active",        // active | no-finish；closed=null
            "missingTime": false,
            "childId": "session-a-active"
          }
        ]
      }
    ],
    "truncated": { "projects": { "shown": 2, "total": 2 } }
  },

  // ── 兼容增强：现有数组补数值字段与开放端语义 ────────────────────
  "projects": [{
    "threads": [{
      "runId": "r-17", "startedAt": "…ISO…", "finishedAt": null,
      "t0": 1794067200000, "t1": null, "durationMs": null, "openReason": "active"
    }]
  }],
  "tasks": [{
    "taskId": "t-12", "createdAt": "…ISO…", "updatedAt": "…ISO…",
    "t0": 1793740800000, "t1": 1794106800000, "spanMs": 366000000, "workMs": 0
  }]
}
```

### 4.3 字段语义（写进契约注释，避免再次误解）

| 字段 | 类型 | 语义 | 空值规则 |
|---|---|---|---|
| `now` | number | 服务端单次响应的当前时刻（epoch ms）；同响应内所有派生共用 | 必填 |
| `t0` | number | 区间起点：线程=`startedAt`，任务=`createdAt` | 不可解析时 `missingTime:true` 且该行不参与像素映射（但仍在 `items` 出现） |
| `t1` | number\|null | 区间终点：线程=`finishedAt`，任务=`updatedAt`；`null`=开放端 | open 时必须配 `openReason` |
| `durationMs` | number\|null | 线程真实执行时长；closed=`t1-t0`，open=`null` | 不用 `now-t0` 伪造 |
| `spanMs` | number\|null | 任务生命周期（created→updated），**不是工时** | 与 `workMs` 并列展示 |
| `workMs` | number\|null | 该任务所有 worker run 的 closed 时长之和；无 run=0 | 与 `spanMs` 区分，UI 标"等待 X / 执行 Y" |
| `state` | enum | `open-running`/`open-no-finish`/`closed-succeeded`/`closed-failed`/`closed-canceled`（由 `active/status/finishedAt` 归一） | 客户端只用此枚举决定视觉，不再各自 if |
| `openReason` | `'active'\|'no-finish'\|null` | 开放端原因：active=仍在跑；no-finish=有 run 无 finish 事件（进程重启/丢失） | 显式区分，`no-finish` 用虚线/问号 |
| `clippedStart/clippedEnd` | boolean | 由客户端按窗口计算后回写（服务端不裁） | 有裁剪标记，禁止静默 |
| `laneId/projectId/order` | string/number | 稳定身份与显式排序 | React key 必须用 `laneId` |
| `truncated` | object | 每项目 tasks/runs 的 shown/total/cap | UI 显示"显示 120/811（截断）" |

### 4.4 服务端实现位置（建议）

- 新文件 `packages/dsh-superbot/lib/timeline.js`（ESM、零依赖、纯函数，可独立单测）：
  ```js
  export function toEpoch(value) { /* number | ISO-Z/offset | '' | null | 非法 → number|null */ }
  export function buildTimeline({ store, projects = [], now = Date.now(), perProjectTaskCap = 120, perProjectRunCap = 200 } = {}) { /* → { now, lanes, truncated } */ }
  ```
  内部：`store.listTasks()`/`store.listRuns()` 各取一次 → 按 `projectId`（run 的 `workspaceId` 回退 taskId→project）分组 → 每组独立 cap → 每项 `t0/t1/durationMs/spanMs/workMs/state/openReason/missingTime` → 组按项目顺序（沿用 `buildOverview` 的 visible 排序传入 `order`）。
- `overview.js`：`buildOverview({ …, now })` 内部 `const timeline = buildTimeline({ store, projects: inventoryRows, now })`，把 `now`/`timeline`/数值字段加入返回值；`deriveTaskPhase({ …, now })` 传入同一 `now`；`task-phase.js` 增加 `now` 参数（默认值保持 `Date.now()` 兼容现有测试）。
- `index.js:285-296`：handler 顶部 `const now = Date.now()`，传给 `buildOverview`；路由签名/鉴权不变。
- `package.json` 增加 `"./timeline": "./lib/timeline.js"` 导出（便于测试/工具复用）。

### 4.5 客户端消费与回退

- `ThreadMap` 改为接收 `timeline`（新字段）：`h(ThreadMap, { timeline: overview.timeline, now: overview.now, … })`；旧响应（无 `timeline`）时回退现有计算，保证插件/宿主版本错配时不白屏。
- 客户端**不再** `Date.parse`/`Date.now` 参与条的位置：`t0/t1` 直接用；`now` 用 `overview.now`（轮询每次更新）；相对时间文案可以用 `Date.now()-fetchedAt` 的偏移（只影响文案，不影响位置），或统一用 `overview.now` 保守处理。
- 窗口：客户端算 `windowStart = now - windowHours*3600e3`、`windowEnd = now + Math.max(0.02*(windowHours*3600e3), 5*60e3)`（headroom，避免 now 贴边）；`xPct(t)` clamp + `clippedStart/End` 标记（与 U1 §3 的 xPct/now 位置规范一致）。

### 4.6 为什么不能只在前端修（3 个不可修事实）

1. **`now` 不是前端事实**：客户端时钟≠服务端；phase/审计/相对时间都以服务端为准，前端自造 now 永远可能与之矛盾。
2. **每项目分组/截断不是前端事实**：`overview.tasks` 已被全局 cap 200 破坏（`overview.js:310-311`），前端拿不到被挤掉的任务；只有服务端按项目分组才能保证每个项目可见。
3. **时长/开放端原因不是前端事实**：`finishedAt:null` 既可能是"在跑"也可能是"finish 事件丢失"，`createPlan` 的同一 `at` 使任务跨度无信息；这些都需要服务端在折叠投影时归一（`work-store` 已有 `run` 状态与事件 `seq`，是唯一能判定的地方）。

---

## 5. 纯函数测试建议（`node --test`，不引入构建）

### 5.1 服务端 `lib/timeline.js` 测试（新 `test/timeline.test.js`）

| # | 用例 | 断言 |
|---|---|---|
| T1 | 两个项目，各 3 任务 + 若干 run | 每个 projectId 都有 lane；`laneId` 唯一；`order` 稳定；同名项目不合并 |
| T2 | plan 任务（同一 `at`） | `t0===t1`、`spanMs===0`、`workMs===0`、`state:'closed-...'` 或 queued；不产出负值 |
| T3 | 已结束 run | `t1===finishedAt` 的 epoch、`durationMs===t1-t0`、`openReason:null` |
| T4 | 进行中 run（无 finishedAt） | `t1:null`、`durationMs:null`、`openReason:'active'` |
| T5 | 有 run 无 finish 事件（进程重启模拟） | `openReason:'no-finish'`（不是 `active`） |
| T6 | 时间字段：epoch number / ISO-Z / ISO+偏移 / `''` / `null` / 非法串 | `toEpoch` 行为固定：合法→数字；`''/null`→null + `missingTime:true`；数字不被当字符串 |
| T7 | 跨项目 cap：项目 A 205 任务、项目 B 3 任务 | B 的 3 条必须全部出现；A 出现 cap 条；`truncated.tasks` 准确 |
| T8 | `now` 注入 | 固定 `now` 时输出完全确定（无 `Date.now()` 泄漏）；两次调用结果相同 |
| T9 | `marks[]` 顺序 | 按 epoch 升序、无重复、事件种类正确（created/claim/in_review/done/review） |
| T10 | `workMs` 聚合 | 多 worker run（经历 rework）时求和；verifier run 不计入 `workMs`（或计入 `verifyMs`，契约里写清） |
| T11 | 空 store / 无项目 | `lanes:[]`、`truncated` 全 0、不抛错 |
| T12 | 分组键回退 | run 无 `workspaceId` 时按 `taskId → task.projectId` 归属；无法归属的 run 进 `orphanRuns` 计数而不是丢弃 |

参考骨架：

```js
// test/timeline.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkStore } from '../lib/work-store.js'
import { buildTimeline, toEpoch } from '../lib/timeline.js'

const NOW = Date.parse('2026-11-08T12:00:00.000Z')

test('open run keeps t1 null (never fabricates now)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-'))
  try {
    const store = new WorkStore({ stateDir: dir })
    // seed: requirement → plan → claim → startRun(no finish)
    const model = buildTimeline({ store, projects: [{ workspaceId: 'p', title: 'P' }], now: NOW })
    const run = model.lanes[0].items.find((item) => item.kind === 'thread')
    assert.equal(run.t1, null)
    assert.equal(run.durationMs, null)
    assert.equal(run.openReason, 'active')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('same-`at` plan tasks are zero span but still listed', () => {
  // assert t0 === t1, spanMs === 0, workMs === 0, items.length === plan.tasks.length
})
```

### 5.2 客户端 geometry 测试（`test/client-threadmap.test.js`，无需构建/无需 DOM）

思路：把纯几何函数抽成 `buildTimelineGeometry({ now, lanes, windowHours, headroomRatio })`（不依赖 React/DOM），并在 `client.js` 末尾加 **测试缝**：

```js
exports.__internals = { buildTimelineGeometry, formatDuration, xPctOf }
```

测试通过"读文件 + 假 window + 假 react"在 Node 里实例化浏览器模块（与现有 `test/fake-context.js` 的 fake 思路一致）：

```js
// test/client-threadmap.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const text = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const captured = []
new Function('window', text)({ __ModuleLoader__: { load: (r) => captured.push(r) } })
const reactStub = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useCallback: (fn) => fn }
const mod = captured[0].factory((name) => { if (name === 'react') return reactStub; throw new Error(name) })
const { buildTimelineGeometry } = mod.__internals

test('window is fixed, not data-fitted; now line sits inside', () => {
  const g = buildTimelineGeometry({ now: 1000 * 3600e3, windowHours: 24, headroomRatio: 0.02, lanes: [] })
  assert.equal(g.windowStart, 1000 * 3600e3 - 24 * 3600e3)
  assert.ok(g.windowEnd > g.now)
  assert.ok(g.xPct(g.now) < 100)
})
```

| # | 用例 | 断言 |
|---|---|---|
| C1 | 固定窗口（数据只有 5 分钟） | 不触 60s 下限；`now` 不贴边（headroom）；空轴不是 0.25% 数据挤左 |
| C2 | open 条 | 终点=`xPct(now)` 且 `<100`；`openEnd:true`；now 线为独立图层 |
| C3 | 早于窗口的 closed 条 | `clippedStart:true`、起点 0；不产生负宽；宽度=真实 `xPct(t1)-xPct(窗口起点)` |
| C4 | 晚于窗口终点 | `clippedEnd:true`、终点 100 |
| C5 | 零时长（t0===t1） | `zeroDuration:true`，宽度=0，渲染点标记（不拉伸） |
| C6 | 同一 `t0` 的 3 条任务 | 排序确定（taskId 次序）、`stackIndex` 0/1/2、偏移后不重叠 |
| C7 | 24h/168h/720h 三档 | 窗口起止严格等于 `now-hours`；同一条 closed 行的 `xPct` 随档位单调变化 |
| C8 | 时钟偏移：`now` 用服务端、`fetchedAt` 用客户端 | closed 行位置完全不受客户端时钟影响；只有 open 条终点用 `now` |
| C9 | 重复 project title | `laneId` 不同 → React key 唯一；不合并 |
| C10 | `formatDuration` | `0→"0s"`、`25m→"25 分钟"`、`>24h→"1 天 2 小时"`；`null→"—"` |
| C11 | 转义/超长 label | 截断但不抛错；`aria-label` 含完整标题 |
| C12 | 空 lanes / 空 items | 返回空模型 + `empty:true`；不抛错 |

（几何断言与 U1 §7 的像素级验收清单对齐：U1 管渲染后的视觉，本文管输入模型的确定性。）

---

## 6. 交互缺陷清单（P1/P2）

| # | 级别 | 缺陷 | 代码证据 | 现象/用户感受 | 最小修法 |
|---|---|---|---|---|---|
| I1 | **P1** | **条本身不可点**；只有左侧标签是 button | `client.js:1066-1071`（label button onClick）vs `1075-1079`（bar 是 `<span>`，无 onClick，仅 `title`） | hint 写"点条打开会话"（`1521`），按提示点条没反应；只有点 220px 标签区才有用 | 整行（label+track）包 `role="button"`/`onClick`；线程→`onOpenSession(childId)`，任务→`onSelect(item)` |
| I2 | **P1** | 任务条无打开任务详情通道 | `ThreadMap` props 仅 `{projects,tasks,onOpenSession}`（`995`）；`TaskDrawer` 由 `client.js:1509` 的 `selectedTaskId` 控制，地图没有设置它的入口（`1522` 未传 `onSelect`） | 地图上看到异常任务，无法点开看原因/验收/线程；必须切回任务 tab 找 | props 加 `onSelectTask(taskId)`（父组件 `setTab('tasks'); setSelectedTaskId(...)` 或直接开 Drawer） |
| I3 | **P1** | 进行中 vs 窗口截断 vs no-finish 不可区分 | `1050-1051`（end=now）、`1074`（now 线=100%）、`1022`（clamp 无标记） | 所有"到右边"的条看起来一样；被裁的旧条看起来像"从窗口开始就在跑" | `state/openReason` 区分 + clip 标记（U1 A9）+ now 线内移 |
| I4 | **P1** | 缩放三档无效、不持久、无窗口说明 | `1020-1022`（轴贴合数据）、`996`（内部 state）、`1038-1041`（按钮）、`1519-1523`（tab 切换即卸载） | 切 24h/30d 多数时候看不出差别，或旧数据突然消失；切走再回来回到 7d；不知道当前看的是哪段时间 | 固定窗口 + 父组件持久化 `windowHours`（localStorage `superbot:panel:map:v1`）+ 轴头显示 `now-24h → now` |
| I5 | P1 | 短条被 `minWidth` 拉长，终点不在时间位置 | `1054`（0.8% 下限）、`1077`（CSS `minWidth:5px`） | 25 分钟 run 和 0 时长任务都画成 5px 点；相邻短条重叠；看不出真实结束点 | 视觉宽度只由 `xPct` 决定；热点区单独扩展；零时长用点+计数 |
| I6 | **P1** | hover 信息不足：只有原生 `title` | `1069`（label title）、`1076`（bar title）；内容 `1063-1064` 仅 phase+相对更新/线程起止 | 浏览器 tooltip 延迟 1s+、不可选中、横滚时被裁；看不到"时长/绝对时间/时区/runId 可复制" | 行 hover/focus 显示固定 inspect 条（U1 A13）：标题·项目·起止·时长(`durationMs`)·state·runId/childId·[打开]；`title` 仅兜底 |
| I7 | P1 | 标签列不 sticky、横滚丢上下文；无虚拟化 | `1043`（容器 `overflowX:auto`）、`1065`（label 与 track 同一 grid 行） | 横向滚动后左侧 220px 标签滑出视野，只剩一排条；200 任务=6000px 无虚拟化，滚动卡 | `.sb-tl-label{position:sticky;left:0;z-index;background}`；tickRow `position:sticky;top:0`；行数 >60 时窗口化 |
| I8 | P1 | 空态/丢弃/裁剪无提示 | `1003`、`1010`（静默 `continue`）；`1015`（无行项目整体隐藏）；`1017`（仅全局空态一句） | 项目"消失"（探针里 proj-fix-2 在截图中不存在）；时间坏掉的条目没有解释；空账本没有下一步引导 | 全局空态加 CTA（"在对话里派工/切 24h"）；每个隐藏项目显示占位行；`missingTime` 行显示"时间未知"；`truncated` 计数展示 |
| I9 | P2 | 图例与实际形状/颜色不符 | `1034-1041`（5 项都画 12×6 小条）vs `1052-1058`（任务 3px 细条、线程 10px 胶囊、点 7px；task 颜色按 phase 有 4 种） | 图例解释不了图；"进行中·无结束"与"执行中"同色重复 | 图例分两组：形状（生命周期细条/线程胶囊/点）+ 状态色（running/success/fail/needs-you/blocked）≤5 项，且用真实形状 |
| I10 | P2 | 同一瞬时多条重叠、无堆叠 | 同 R5；`1075-1079` 无 stack 偏移 | 一次 plan 的 5 个任务在同一 x 完全重合，只看到 1 个点 | `stackIndex` + `translateY` 2px 或"点+计数 N"聚合 |
| I11 | P2 | `childId=null` 时行可点但无反应 | `1068`（`typeof row.thread.childId === 'string'` 才执行）；`1070` cursor 仍为 pointer | 点击无反馈（子会话尚未 bind） | disabled 态 + tooltip "子会话尚未绑定"；或点击重试/打开任务详情 |
| I12 | P2 | 键盘/读屏不可用 | `1075` bar 是 span 无 role/aria；label button 无完整 `aria-label`；网格线是装饰但未 `aria-hidden` | 键盘无法遍历地图；读屏只读到标签文本 | 行 `role="button" tabIndex={0}` + Enter/Space；`aria-label="任务 X，阻塞，创建…更新…时长…"`；装饰层 `aria-hidden` |
| I13 | P2 | 时间标签本地时区未标注；locale 混排 | `1023` `toLocaleString([])`；`257-280` 本地时间；无时区文字 | 截图出现 `11/6, 06:19 AM` 混中文；跨时区协作时"到底几点"歧义 | 轴头写"本地时间（America/New_York）"；组件接受 `serverTimeZone` 时标注；固定 `hour12:false` |
| I14 | P2 | 任务/线程混排无层级、行序漂移 | `1014` 仅按 start；`1049` 混渲染；`1046` title key | 同一任务多次执行/返工的行不聚类；刷新后顺序跳动 | 任务行做父行、线程行缩进子行（U1 §3）；`rowOrder` 由模型给 |

---

## 7. 组件 props 骨架（供 Lead 实现）

### 7.1 组件边界

```
SuperbotOverview（数据容器：fetch / 轮询 / accept / 抽屉状态）
  └─ map tab
       └─ ThreadMapView（纯展示：几何 + 行渲染 + 交互回调；无 fetch/无时钟/无解析）
            ├─ TimelineLegend（形状+状态色，U1 §3）
            ├─ TimelineAxis（tickRow，sticky）
            └─ TimelineLane → TimelineRow × N
```

### 7.2 props 契约（JS 注释形式，可直接落到组件签名）

```js
/**
 * @typedef {Object} TimelineItem
 * @property {string} key                 // `${kind}:${id}`，稳定 React key
 * @property {'task'|'thread'} kind
 * @property {string} id                  // taskId 或 runId
 * @property {string} [taskId]
 * @property {string} label               // 已由服务端/模型准备好的短标签
 * @property {number} t0                  // epoch ms（必填；缺失→ missingTime 行）
 * @property {number|null} t1             // null=开放端
 * @property {'open-running'|'open-no-finish'|'closed-succeeded'|'closed-failed'|'closed-canceled'|'queued'} state
 * @property {number|null} durationMs     // thread：真实时长；task：null（用 spanMs/workMs）
 * @property {number|null} [spanMs]       // task：生命周期
 * @property {number|null} [workMs]       // task：真实工时
 * @property {string|null} [childId]      // thread：打开会话用
 * @property {string} [tone]              // 语义色 token 名（由模型映射，不在组件里 if-else）
 * @property {Array<{at:number, kind:string}>} [marks]
 * @property {boolean} [missingTime]
 */

/**
 * @typedef {Object} TimelineLane
 * @property {string} laneId              // React key（禁止用 title）
 * @property {string} projectId
 * @property {string} title
 * @property {number} order
 * @property {TimelineItem[]} items
 * @property {{tasks?:{shown:number,total:number,cap:number}, runs?:{shown:number,total:number,cap:number}}} [truncated]
 */

/**
 * ThreadMapView props（纯展示；所有数据来自服务端 timeline 契约）
 * @param {Object} props
 * @param {{ now:number, lanes: TimelineLane[], truncated?: object }} props.model
 * @param {24|168|720} props.windowHours
 * @param {(hours:number)=>void} props.onWindowChange
 * @param {string|null} props.selectedKey
 * @param {(item:TimelineItem)=>void} props.onSelect        // 任务→抽屉；线程→会话
 * @param {(childId:string)=>void} [props.onOpenSession]    // 兼容独立"打开会话"按钮
 * @param {()=>void} [props.onRetry]
 * @param {boolean} [props.compact]                         // settings 变体/窄面板
 * @param {string} [props.timeZone]                         // 轴头时区标注
 * @returns {React.ReactNode}
 */
```

**行为契约**：

| 交互 | 行为 |
|---|---|
| 点击行（label 或 bar 任一区域） | 任务行 → `onSelect(item)`（父组件开 TaskDrawer）；线程行 → `onSelect`，若 `childId` 非空同时提示"打开执行会话"或直接 `onOpenSession` |
| hover / focus 行 | 显示 inspect 条：标题 · 项目 · 状态 · `开始→结束`（绝对时间）· `持续 durationMs` · 任务显示"生命周期 spanMs / 执行 workMs" · runId/childId（可复制）；bar 原生 `title` 保留兜底 |
| 键盘 | 行 `role="button"`、`tabIndex=0`；`Enter/Space`=点击；`ArrowUp/Down` 行间移动；`Esc` 清空选中 |
| 缩放 | 24h/7d/30d 按钮 → `onWindowChange`；窗口固定 `[now-hours, now+headroom]`；轴头显示起止 + 时区 |
| 空态 | 无 lanes → 引导（"还没有工作：在对话里派工" + "切 24h"）；lane 内无 items → 占位一行"（无记录）"；`missingTime` 行 → "时间未知"徽章 |
| 截断 | 行外显示 `显示 {shown}/{total}`（服务端 `truncated`）；`clippedStart/End` 用 ◀/▶ 标记（U1 A9） |
| loading/error | 不在地图内单独 loading（父级已有）；`onRetry` 只在 model 缺失时显示 |

### 7.3 纯展示骨架（React.createElement，可直接粘）

```js
/** 唯一坐标函数：轴刻度、网格线、now 线、条 left/width、endpoint 全部共用。 */
function xPctOf(t, start, end) {
  if (end <= start) return 0
  return Math.max(0, Math.min(100, ((t - start) / (end - start)) * 100))
}

function buildTimelineGeometry({ now, lanes = [], windowHours = 168, headroomRatio = 0.02 }) {
  const span = windowHours * 3_600_000
  const start = now - span
  const end = now + Math.max(span * headroomRatio, 5 * 60_000) // now 线不再贴边
  const rows = []
  for (const lane of lanes) {
    lane.items.forEach((item, index) => {
      const t0 = Number.isFinite(item.t0) ? item.t0 : null
      const t1 = Number.isFinite(item.t1) ? item.t1 : null
      const open = t1 === null
      const clippedStart = t0 !== null && t0 < start
      const clippedEnd = t1 !== null && t1 > end
      const x0 = t0 === null ? null : xPctOf(t0, start, end)
      const x1 = t0 === null ? null : xPctOf(open ? now : t1, start, end)
      rows.push({
        ...item, laneId: lane.laneId, rowIndex: index,
        x0, x1, width: x0 === null ? 0 : Math.max(0, x1 - x0),
        zeroDuration: t0 !== null && t1 !== null && t1 === t0,
        openEnd: open, clippedStart, clippedEnd, missingTime: t0 === null,
      })
    })
  }
  return { now, start, end, xPct: (t) => xPctOf(t, start, end), rows }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${m % 60} 分`
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`
}

function ThreadMapView({ model, windowHours, onWindowChange, onSelect, onOpenSession, compact }) {
  const geometry = buildTimelineGeometry({ now: model.now, lanes: model.lanes, windowHours })
  if (geometry.rows.length === 0) {
    return h('div', { 'aria-label': '线程地图', style: { padding: '16px 0', fontSize: '12px', color: C.text3 } },
      '还没有可展示的工作。去对话里让 Superbot 派工，或切到 24h 看最近活动。')
  }
  const nowX = geometry.xPct(model.now)
  return h('div', { 'aria-label': '线程地图', style: { border: `1px solid ${C.line}`, borderRadius: '9px', background: C.surface } },
    h(TimelineToolbar, { windowHours, onWindowChange, now: model.now, start: geometry.start, end: geometry.end, truncated: model.truncated }),
    h('div', { style: { position: 'relative', display: 'grid', gridTemplateColumns: `${compact ? 160 : 220}px minmax(0,1fr)` } },
      // sticky now 线（唯一 now 图层；不再复制到每行）
      h('span', { 'aria-hidden': 'true', style: { position: 'absolute', left: `${nowX}%`, top: 0, bottom: 0, width: '1px', background: C.business, opacity: 0.7, zIndex: 1 } }),
      model.lanes.flatMap((lane) => [
        h(TimelineLaneHeader, { key: `h:${lane.laneId}`, lane, compact }),
        ...geometry.rows.filter((row) => row.laneId === lane.laneId).map((row) =>
          h(TimelineRow, { key: row.key, row, compact, onSelect, onOpenSession })),
      ])))
}
```

`TimelineRow` 契约（实现细节交给 U1 的 CSS/形状规范）：
- label 列：`role="button" tabIndex={0}`，`cursor:'pointer'`，`aria-label` 完整句；truncate + `title` 兜底。
- track 列：**无 px 宽度**、只用 `left:${row.x0}%`、`width:${row.width}%`；`clippedStart/End` 加 ◀/▶；`openEnd` 用右端箭头/虚线；`zeroDuration` 用 7px 点；点击热区 `minWidth` 独立透明层。
- 行 hover/focus → 父级 `setInspect(row.key)`，inspect 条显示 `formatDuration` 与绝对起止。

### 7.4 与 U1 几何规范的对接点

| 契约项 | 本文（数据/交互） | U1（视觉/几何） |
|---|---|---|
| 坐标函数 | `xPctOf(t, start, end)`（§7.3） | `xPct` 单一函数，轴/网格/条共用 |
| 窗口 | 固定 `[now-hours, now+headroom]`（§4.5） | now 线在 96–98%、右侧留余量 |
| 裁剪 | `clippedStart/End` 布尔（服务端 t0/t1 不裁） | ◀/▶ 标记样式 |
| 零时长/短条 | `zeroDuration`、宽度只用 xPct（不 minWidth） | 点标记 + 点击热区独立扩展 |
| 行层级 | 任务行/线程子行 `kind` + `taskId` 关联（§4.3） | 32px 行高、缩进 16px、行基线 `translateY(-50%)` |
| now 线 | 只画一条（父层），open 条终点=`xPct(now)` | 单层 now 线，不被边框裁 |
| 截断计数 | `truncated`（服务端） | 工具栏 `显示 x/y` |

---

## 8. 落地顺序与验收

### 8.1 实施顺序（建议 5 步，每步独立可验）

1. **`lib/timeline.js` + `test/timeline.test.js`**（纯服务端、零依赖）：`toEpoch`/`buildTimeline`；先让 T1-T12 全 PASS，不改任何现有行为。
2. **`overview.js` 增量**：`buildOverview({…, now})` 注入 timeline + 数值字段；`task-phase.js` 加 `now` 参数（默认兼容现有测试）；`index.js` 路由传 `now`。现有 overview 测试补断言（`now`/`timeline.lanes`/old fields 不变）。
3. **`client.js` ThreadMap 数据源切换**：优先读 `overview.timeline`/`overview.now`，旧响应回退；`buildTimelineGeometry`/`formatDuration` 抽纯函数 + `exports.__internals` 测试缝；`test/client-threadmap.test.js`（C1-C12）。
4. **交互补齐**：整行点击（I1/I2）、inspect 条（I6）、sticky 标签列 + 轴头（I7）、空态/截断/missingTime（I8/I3）、缩放持久化 + 固定窗口（I4）、键盘/aria（I12）——按 U1 的视觉规范落地。
5. **验收**：截图（24h/7d/30d × 深浅色 × 1440/1024）+ 数据断言（`now` 单调、open 条 `<100%`、25min run 可见且终点准确、每项目 cap 不串、同名项目 lane 独立、时钟偏移模拟下 closed 行不动）。

### 8.2 验收用例（可直接写成测试/人工检查单）

| # | 场景 | 期望 |
|---|---|---|
| A1 | 一条进行中 run、窗口 7d | 条终点 = `xPct(now)` < 100%，右端有"开放"标记；now 线可辨 |
| A2 | 一条 25 分钟已完成 run | 条宽足够可见（按 U1 的最小可见规则），终点落在正确 `xPct(finishedAt)`，tooltip 显示"25 分钟" |
| A3 | 一条 5 天前创建、今天 blocked 的任务 | 细条准确（生命周期），inspect 同时显示"生命周期 5 天 / 执行 0 分钟" |
| A4 | 一次 plan 的 5 个任务（同 `at`） | 5 个点/行都可见、不合并；tooltip 显示"未开始（0 分钟）" |
| A5 | 两个项目同名 | lane 独立、key 无冲突、顺序按 `order` |
| A6 | 项目 A 有 205 任务、B 有 3 任务 | B 的 3 个任务全部可见；A 显示 `x/120 截断`；B lane 不消失 |
| A7 | 切 24h | 窗口严格 `now-24h → now+headroom`；更早行标 ◀ 且 tooltip 显示真实起止；不出现"全部 0%" |
| A8 | 客户端时钟 +2h（devtools 覆盖 Date） | closed 行位置完全不变；open 条终点仍=服务端 now；相对时间文案不出现"未来时间" |
| A9 | `filter=attention` 时打开地图 | 地图显示全部项目的 lanes（或明确"地图不受过滤"），不出现"只有 1 个项目但有 200 条任务" |
| A10 | 空账本 | 引导语 + 切 24h 按钮；不空白 |
| A11 | 任务行点击 | 打开 TaskDrawer（保留地图上下文）或切到任务 tab 并选中该任务 |
| A12 | 键盘 Tab/Enter/Arrow/Esc | 行可聚焦、Enter 打开、上下移动、Esc 取消高亮 |

### 8.3 风险与未验证

| 项 | 级别 | 说明 |
|---|---|---|
| 服务端 payload 增量 | 低 | 新增 `timeline` 会增大响应（200 tasks + runs ~ 50-150KB）；建议每项目 cap 120 任务/200 run，并保持 `tasks` 旧字段不变 |
| 客户端旧响应兼容 | 低 | 保留 fallback 分支；宿主 0.2.1-rc.5 桌面/网页均支持同一 HTTP 契约 |
| 契约语义歧义 | 中 | 必须把 `spanMs`/`workMs`/`durationMs` 的差异写进 README/注释，并在 UI 文案区分（U1 §A10 同结论） |
| 与"不要做甘特"的历史结论冲突 | 产品决策 | `reports/project-review-2026-11-09/PROJECT-REVIEW.md:81` 建议不要为任务板再做甘特；若保留地图，应按本文把它明确为"线程时效/异常视图"（任务生命周期细条 + 执行胶囊），不再宣称"工时甘特"；否则删除任务条、只保留线程条 |
| 历史结论已过时 | 低 | U1 早期快照认为 `PHASE_META` 缺 `stalled`；当前 `task-phase.js:19` 已有 `stalled`（label「疑似卡住」）。落地时以最新代码为准，不要重复补 |
| 真机浏览器 | **NOT RUN** | 本轮只读代码 + 纯数据探针；交互修复后需在真实面板截图/点击验收（含 settings 变体窄宽 800px） |
| 并发修改 | 中 | 复核期间 `client.js` 正被其他专家/Lead 修改（快照 13:37 为 1818 行）；落地时以当时行号为准，本文引用行号仅对应 13:37 快照 |

---

## 9. 证据索引（file:line，按 13:37 快照）

| 主题 | 证据 |
|---|---|
| ThreadMap 数据准备 | `client.js:995-1022`（995 签名、996 缩放 state、1002-1005 线程解析、1007-1013 任务解析、1014 排序、1018 now、1020-1022 窗口/比例尺） |
| 渲染/交互 | `client.js:1026-1032` tickRow、`1034-1041` 图例+缩放按钮、`1043` 容器、`1046` lane key、`1049-1064` running/tone/label/title、`1065-1071` 行+label button、`1072-1074` 网格/now 线、`1075-1079` bar/end dot |
| map tab 调用 | `client.js:1519-1523`（hint 写"点条打开会话"，实际 bar 不可点） |
| 项目/任务载荷 | `client.js:1284-1286`（projects=服务端过滤后）、`1522`（tasks=全局未过滤） |
| 时间 helper | `client.js:257-280`（`relativeTime`/`absoluteTime`，客户端时钟+本地时区）、`439-442`（`Time`） |
| overview 输出 | `overview.js:167-181`（threads：ISO 字符串、无 duration）、`271-311`（tasks：全局 updatedAt 排序+slice 200、`298-307` thread 子集只有 startedAt）、`338-353`（返回形状、`339` generatedAt、`343/344` tasks/taskCount）、`246-256`（项目排序） |
| overview 时间字段 | `overview.js:21` `timeOf`、`178-179`、`183-189` `lastActivityAt` |
| 派工/运行时 | `work-store.js:432` 默认 clock、`564` submitTask at、`647-668` startRun、`682-694` finishRun、`1079-1129` createPlan（`1118-1119` 同一 at） |
| 任务时间语义 | `task-engine/lib/index.js:153-161`（createdAt=updatedAt=at）、`185-193`（transition 只改 updatedAt） |
| stalled/now | `task-phase.js:74-80`（stalled 判定内 `Date.now()`）、`task-phase.js:17-27`（PHASE_META 含 stalled） |
| 路由 | `index.js:285-296`（overview handler，可加 now 注入）、`381` 注册 |
| 截图 | `reports/project-review-2026-11-09/panel-gantt.png`（旧构建：active worker 条贴右边界、两条完成 run 只有点、第二个项目 lane 缺失、轴 11/6 06:19→11/8 07:55 为数据贴合；该截图早于当前代码，缩放按钮在当前代码 `1038-1041` 已存在） |

## 10. 附录：探针脚本与运行方式

```bash
node /tmp/u3-timeline-probe.mjs   # cap 饥饿 + 零时长 + active 右边界（v1）
node /tmp/u3-timeline-probe2.mjs  # 生产形状：211 任务/208 同 at/跨项目 cap/时钟偏移/空串时间（v2）
node /tmp/u3-timeline-probe3.mjs  # 零时长 0.80%、25min run 0.28%、24h 档全裁剪（v3）
```

三个脚本都在 `/tmp` 下自建 `mkdtemp` stateDir，`finally` 删除；不 import 客户端 React 代码（只复刻 ThreadMap 的 30 行映射逻辑），因此结论可独立于浏览器复现。若要把它们固化成仓库测试，建议按 §5.1/§5.2 拆成 `test/timeline.test.js` + `test/client-threadmap.test.js`（后者用 `new Function('window', text)` 加载 `lib/client.js`，与探针同样的 fake loader 思路）。
