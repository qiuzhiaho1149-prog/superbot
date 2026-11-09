# 线程地图（ThreadMap）时间线对齐与视觉重设计 · U1

> 专家组 U1 · 只读代码诊断 + 一手资料 benchmark + 可复制实现规范
> 评估快照：2026-11-08 13:xx（`packages/dsh-superbot/lib/client.js` 1818 行；`ThreadMap` 在 `995-1090`，常量在 `992-993`）
> 结论先行：**保留纯 CSS / React.createElement，不引入 three.js**；用「外层 CSS Grid（标签列 + 时间轴列）+ 单一 `xPct` 坐标函数（轴刻度、网格线、now 线、条起点/终点、末端点全部共用）+ 固定行高 32px + 无 px 宽度」重写即可解决对齐问题。
> 本文件是唯一写入；未改仓库代码。

---

## 0. 结论先行

1. **three.js 不合适（明确否）**。问题本质是 2D 布局/坐标一致性，不是渲染性能或 3D 表达；three.js 会引入 WebGL 上下文、额外 bundle、字体/文本模糊、失去 DSH 主题 token 与可访问性、滚动/缩放/键盘全部要自建——投入远大于收益。数据量级（当前面板 ≤200 任务、每项目线程数十条）用 DOM/CSS 完全够。详见 §6。
2. **纯 CSS Grid 足够**。外层两列 `220px minmax(0,1fr)`（标签列 + 时间轴列），行高 32px；所有横向位置共用一个 `xPct(t) = (t - start) / (end - start) * 100%` 函数，**轴刻度、主网格线、now 线、条 left/width、末端点 left 全部用它**，禁止混入 px 宽度（当前 bug 的根源之一）。
3. **当前对齐缺陷是 5 类**：① 条 `minWidth:5px` 与 `width:%` 混排 → 短条真实时长被拉长、终点不在网格上；② 轴标签 `translateX(-50%)` 居中 + 0%/100% 无留白 → 首尾标签被裁/压线；③ 刻度是窗口的 25% 等分（非日历对齐）→ 没有"正方格"；④ now 线固定在 `left:100%`（因为 range 终点永远是 now）→ 被边框裁掉、无未来余量；⑤ 行内任务条（3px, top:12）与线程条（10px, top:9）硬编码 top，30px 行里中心分别 13.5/14px，差 0.5–1.5px，且两类条按开始时间混排 → 眼睛无法对齐行基线。另有标签列固定 220px 不响应、行可点击性不一致、图例与形状不符、lane header 高度破坏垂直节奏等。
4. **目标规格**：行高 32px；线程条 10px 胶囊、任务条 3px + 末端 7px 点（两种视觉层级，不混排同权）；时间轴 28px；标签列 `clamp(160px, 24cqi, 220px)`；24h/7d/30d 三档缩放各 6/7/6 个主刻度；now 线在 96–98% 处（右侧留 1 个主刻度 ~2% 余量）；主网格线通高连续、标签左对齐线、无 `translateX` 居中。
5. **可直接照抄**：§4 给完整 CSS（追加到 `ensurePanelCss()`），§5 给 `ThreadMap` 的 React.createElement 骨架（数据准备 / 坐标函数 / row 渲染 / 注入样式），Lead 可整段替换现 `995-1090`。

---

## 1. 现状诊断（逐条代码证据 → 视觉后果 → 修复规则）

当前实现：`MAP_ROW = 30`、`MAP_LABEL = 220`（`client.js:992-993`；任务描述提到的 300px 可能是早期版本，固定 px 的问题相同）。轴线 `TICKS = [0,.25,.5,.75,1]`（`1024`），轴标签 `left: ratio*100%; transform: translateX(-50%)`（`1028-1032`）；行 `grid 220px 1fr; height:30; alignItems:center`（`1065`）；条 `left:startPct%; width:width%; minWidth:5px; top:12/9; height:3/10`（`1077-1082`）。

| # | 缺陷 | 代码证据 | 视觉后果（用户感受） | 修复规则 |
|---|---|---|---|---|
| A1 | **px/% 混排**：条视觉宽度 = `max(0.8, endPct-startPct)%` 再套 `minWidth:5px` | `client.js:1077-1082` | 短线程（如 2 分钟）在 7d 窗口里真实宽度 <1px，被 5px 撑开 → 条终点不在真实时间位置，相邻短条互相重叠/看起来同长；"时长不可信" | 视觉宽度只用 `xPct(end)-xPct(start)`，**不设 px 宽度**；点击热区用独立透明层 `max(width,16px)`（不改变视觉） |
| A2 | **轴刻度与条不共享"同一套刻度语义"**：刻度是窗口 25% 等分，不是 0/6/12/18 点或 0 点/日界 | `client.js:1017-1024`（windowStart = `max(minStart, now-窗口)`，TICKS 固定 5 等分） | 标签出现 13:37、19:37… 这类"奇怪时间"；没有可按小时/按天对齐的"正方格"，老板无法把进度对到格子上 | 窗口起点 **snap 到自然边界**（24h→整点；7d/30d→本地 0 点），刻度从边界按固定 step 生成（24h→每 4h、7d→每天、30d→每 5 天） |
| A3 | **轴标签居中导致首尾漂移/裁切**：`translateX(-50%)` + 0% 无左留白、100% 无右留白 | `client.js:1028-1032`（`top:4px; background:C.bg` 遮线） | 第一个标签一半被标签列盖住、最后一个一半溢出/被滚动容器裁掉；文字中心与线看似不齐（因文字宽度不同） | 标签 **左对齐网格线**（`left:xPct(t); padding-left:6px; transform:none`），末刻度允许右溢 1 个标签宽并给轨道 2% 余量 |
| A4 | **now 线永远在 100%**：`range = now - windowStart`，所以终点就是 now；now 线写死 `left:100%` | `client.js:1017-1021,1076` | now 线贴在右边框/被裁，等于没有"现在"标记；运行中的条直接顶到右边缘，看起来像"已结束/被切掉" | `end = now + headroom`（约 2% 或 1 个主刻度的一半），now 线用 `xPct(now)`，落在 ~96–98%；运行中条终点=now，右侧留白可辨 |
| A5 | **垂直基线硬编码**：任务条 `top:12px h3`（中心 13.5）、线程条 `top:9px h10`（中心 14）、点 `top:10px h7`（中心 13.5），都没有用行高/居中变换 | `client.js:1077-1082` | 30px 行（含 1px border）中中心应在 15px，实际 13.5/14 → 条整体偏上 1–1.5px；任务条与线程条中心不一致；改行高必崩 | 行高用 CSS 变量 `--tl-row:32px`；条统一 `top:50%; transform:translateY(-50%)`；分隔线用 `box-shadow: inset 0 -1px`（不占布局，不改变中心） |
| A6 | **两类条混排、等权**：任务行和线程行都 push 进同一 `lane.rows` 再按 `start` 排序，线程 10px、任务 3px 相邻 | `client.js:1000-1022` | 同一列里粗细不一、任务行夹在线程行中间；用户"很难在正方格里对齐进度与时长" | 层级分离：项目 → 任务行（细条+末端点，表示生命周期）+ 该任务的线程子行（缩进 16px 的胶囊，表示执行 attempt）；**不再跨类型按时间混排** |
| A7 | **项目混排/无泳道边界**：lane 只有 24px 标题行（flex，跨两列，`height:24`，`marginTop:4`），不是同一套 grid 行 | `client.js:1046-1063` | 标题行高与数据行 30px 不一致，滚动时项目边界和网格节奏断裂；多个项目时上下条目无法用同一基线比较 | lane header 也是 `rowgrid` 行（高 32px = 行高），标签列放项目名，时间轴列铺 `bg-layer-1` 色带；项目之间不额外加 margin |
| A8 | **标签列固定 220px、无响应、无 sticky**：外层 `overflowX:auto`，标签列随内容一起横滚 | `client.js:992-993,1045,1065-1071` | 窄面板（1024/800）里轨道被压到 ~300px，30d 窗口条挤成一团；一旦出现横滚，标签列滚出视野，不知道每条是什么 | `--tl-label: clamp(160px, 24cqi, 220px)`（容器查询）；`.sb-tl-label{position:sticky; left:0; z-index:2; background:var(--bg-base)}`；轨道最小宽 `calc(var(--tl-label) + 560px)` 让横滚有意义 |
| A9 | **minWidth/边界条无溢出提示**：`pct()` clamp 到 [0,100]，窗口外开始/结束的条被静默裁切 | `client.js:1019,1073-1082` | 创建于窗口之前的任务看起来像"窗口开始时创建"；运行/超窗条看不出还在继续 | 起始早于窗口 → 左端 `◀` 标记（`data-clipped="start"`）；结束晚于窗口 → 右端 `▶`；tooltip/详情显示真实起止；无标记的条必须完整落在窗口内 |
| A10 | **任务条语义混淆**：任务条 = `createdAt → updatedAt`（含排队+执行+审计的"生命周期"），线程条 = `startedAt → finishedAt`（执行 attempt），两者用同一视觉编码 | `client.js:1000-1010,1052-1058` | 用户把"任务 2 天"和"线程 3 分钟"当同一维度比较；"时长"失真 | 任务条 = 生命周期（细条，label 标"生命周期"）；线程条 = 执行/审计 attempt（胶囊，label 标角色+run）；图例分开说明；若要"工作时长"只看线程 |
| A11 | **图例与形状不符**：图例 5 项都画 `12×6` 小条，但实际是 3px 任务条/10px 线程条/7px 点；颜色语义混用 phase 与 run status | `client.js:1034-1043,1052-1058` | 图例无法解释图形；"执行中/进行中·无结束"重复；看不懂细条/胶囊含义 | 图例拆两组：①形状（任务=细条+末端点 / 线程=胶囊）②状态色（执行中/成功/需你/返工·失败/阻塞）≤5 项；图例形状必须与真实形状一致 |
| A12 | **行点击不一致**：只有线程行的 label 是 button（可打开会话），任务行 `cursor:default`、条本身不可点；hint 说"点条打开会话" | `client.js:1066-1071`；地图 tab hint `1521` | 用户按提示点条没反应；任务行无法打开任务详情 | 整行可点：线程行 → 打开会话；任务行 → 打开 TaskDrawer；键盘 Enter 同理；`cursor:pointer`；hover 高亮整行 |
| A13 | **交互只有原生 title**：条的说明靠 `title` 原生 tooltip，显示延迟、不可选中、在横滚容器里会被裁 | `client.js:1067,1078` | 关键的起止时间/状态/runId 很难读到；截图/演示时看不到 | 行 hover/focus 时在工具栏下方显示 `sb-tl-inspect` 详情条（label · 起止 · 时长 · 状态 · runId/childId · [打开会话]）；`title` 仅作兜底；每行有 `aria-label` 完整句 |
| A14 | **缩放不持久/无范围说明/无日历步进**：`windowHours` 是 ThreadMap 内部 state，切 tab 卸载后重置；轴左侧只写"时间轴" | `client.js:996,1026-1032` | 每次回到地图都回到 7d；不知道当前看的是哪段时间；24h 只有 5 个标签 | zoom 状态提升到父组件或 localStorage；左侧显示 `过去 7 天 · 11/02 00:00 → 11/09 00:00`；三档刻度 6/7/6 |
| A15 | **空/极窄窗口无降级**：`lanes.length===0` 一行文字；30d 窗口在窄面板轨道 <300px 时条互相压 | `client.js:1015-1016` | 空态无引导；窄屏图不可读 | 空态：一句引导 + "切到 24h 看最近"按钮；窄面板（`<680px`）自动切 24h/隐藏次要列/表格式逐行；轨道 `min-width` 触发横滚而不是压缩 |

> 另：`task-phase.js` 的 `PHASE_META` 没有 `stalled`（`task-phase.js:17-26`），但 `deriveTaskPhase` 会返回 `stalled`（`73-80`），`phaseLabel` 缺失；`ThreadMap` 的 tone 已特判 `stalled`（`client.js:1054`）但 label/图例没有。Timeline 重做时应顺手补 `PHASE_META.stalled`（label「疑似卡住」/tone danger/order 1.5），否则详情/图例仍会漏。

---

## 2. 参考提炼（一手资料 → 可执行规则）

| 来源 | 原文关键模式 | 提炼成本次规范 |
|---|---|---|
| freeCodeCamp「How to Create a Simple Gantt Chart Using CSS Grid」（无库、纯 CSS Grid） | 表头 `grid-template-columns: 50px repeat(12,1fr)`；网格线 overlay 用同一套 12 列；任务条用 `grid-column: 1/2` 式**列跨距**表达时长 | **轴、网格线、条必须共享同一套列定义/坐标**；标签列固定第一列，时间列 `repeat(N,1fr)` 或等价单一坐标函数。不要轴一套%、条另一套 px |
| ONES「Building a Gantt Chart in JS」（工程实现教程） | `#gantt-body{display:grid;grid-template-columns:150px 1fr}`；`.task-row{display:grid;grid-template-columns:subgrid}`；滚动时间轴 header；**单一 `dayWidth` 常量**把日期映射到 px（`left=leftDays*dayWidth; width=durationDays*dayWidth`），轴标记按同一 `dayWidth` 排列 | **一个坐标常量/函数贯穿轴与条**（我们 = `xPct`）；标签列固定宽；header 与 body 同一列模板；横滚时 header 与行同步 |
| diagram-design / `type-gantt.md`（Lead 提供） | 标签列 180px；行高 40px；条高 24px、行内垂直居中（上下各 8px）；时间轴标签在 `x=200+i×pitch`；hairline 分隔；today 竖线；focal bar 用 accent、其余 muted 0.15；反模式：>12 条、>5 并行轨道、所有条等权、条内写日期 | 采用其**比例与层级原则**，但按 DSH 控制台密度调整：行 32px（面板窄、行多）、线程条 10px、任务条 3px+点；主任务/需你项用高对比，其余低饱和；日期不写进条内（放 tooltip/详情）；>12 条/项目时折叠线程子行或转表格 |
| MDN CSS Grid（line-based placement / subgrid）与 `position:sticky`（官方参考） | `grid-column` 线号定位；`subgrid` 让行共享父列；`position:sticky` 在滚动容器内固定标签列 | 外层两列 grid + 行内 grid；标签列 `sticky left:0`；若要让条吸附到"格"而非精确时间，可用 `repeat(var(--tl-units),1fr)` + `span`（但会牺牲分钟级精度，不推荐 v1） |

**共同结论**：所有成熟实现（CSS Grid 教程 / ONES / diagram-design / SVG 版）都遵循同一条：**先定一个时间→位置的映射（pitch），轴、网格、条全部用这个映射**。当前 ThreadMap 的轴与条虽然都用 `%`，但 `minWidth px` 破坏终点、标签居中破坏边界、刻度非日历、now 无余量——不属于"再调几个值"，属于坐标系没定死。

---

## 3. 目标视觉与布局规范

### 3.1 尺寸与层级

| 元素 | 规格 | 说明 |
|---|---|---|
| 卡片 | 1px `border-l3`，圆角 9px，`bg-base`，`overflow:hidden` | 沿用现有面板卡片风格 |
| 工具栏 | 高 40px，padding 0 12px：图例（左）+ 缩放 24h/7d/30d（右）+ 范围说明 | 图例与缩放不占轨道 |
| 时间轴 | 高 28px；左侧标签列显示范围 `过去 7 天 · 11/02 00:00 → 11/09 00:00` | 末刻度右溢不裁 |
| 行高 | **32px**（固定，所有行含 lane header、任务行、线程行一致） | 分隔线用 inset box-shadow，不占高度 |
| 标签列 | **220px**（宽容器）/ 200px（<1000px 容器）/ 160px（<760px）；`position:sticky` | 项目名 600/11，任务名 11.5，线程名 11 缩进 16px |
| 线程条 | 高 **10px**，圆角 5px，`opacity .85`（hover 1） | 表示执行/审计 attempt |
| 任务条 | 高 **3px**，圆角 2px，`opacity .55` + 末端 **7px** 圆点 | 表示任务生命周期（细、退后） |
| now 线 | 宽 2px，`state-business-primary`，opacity .65；顶部 "现在" 小标签 | 位置 = `xPct(now)`，落 ~96–98% |
| 主网格线 | 1px `border-l2`，通高连续（不是每行一段） | 位置 = 每主刻度 |
| 次网格线 | 可选，1px `border-l2` 透明度更低；按 `--tl-unit` 步进 | 用于"正方格"手感 |
| 字号 | 轴 10.5；标签 11–11.5；图例 10.5；详情条 11.5 | 沿用 DSH 面板字号体系 |

### 3.2 坐标模型（唯一真理）

```
windowHours ∈ {24, 168, 720}
unit        = 24h→1h,   7d→6h,  30d→1d
majorStep   = 24h→4h,   7d→1d,  30d→5d
majorCount  = 24h→6,    7d→7,   30d→6

start = snapToMajor(now - windowHours*h)     // 24h → 4h 边界（00/04/08…）；7d/30d → 本地 0 点
end   = start + windowHours*h + headroom      // headroom = 2% of window（或半个 majorStep，取小）
span  = end - start
xPct(t) = clamp(0..100, (t - start) / span * 100) + '%'
wPct(a,b) = xPct(b) - xPct(a)                 // 只做字符串计算，不引入 px
```
- **轴刻度标签、主网格线、now 线、条 `left/width`、末端点 `left` 全部调用 `xPct`**，任何地方不得再用 `minWidth`（视觉）。
- 条的真实起止记录在 `data-start/data-end`，tooltip 与详情条显示绝对时间。
- 窗口外：`start < start` → 左端 `◀`；`end > end` → 右端 `▶`（运行中的条基本都属于后者，可接受）。

### 3.3 行结构（项目泳道 → 任务 → 线程）

```
项目 A（lane header，32px，标签列=项目名，轨道列=bg-layer-1 色带）
  ◻ 修复登录按钮         [任务生命周期细条 + 末端点]       点击→任务详情抽屉
     ↳ ◉ worker r-24      [执行胶囊]                          点击→打开会话
     ↳ ◇ verifier r-25    [审计胶囊]                          点击→打开会话
     ↳ ◉ worker r-31      [第 2 次尝试胶囊]
  ◻ 导出 CSV             [细条+点]
项目 B ...
```
- 任务行排序：`createdAt` 升序；线程子行按 `startedAt` 升序；**不再把任务与线程混排**。
- 线程子行默认全部展开；若单任务线程 >3 或单项目行 >30，折叠为"展开 N 条线程"（点击展开）。
- 没有 task 的孤儿线程（task 被裁掉）挂在项目 lane 末尾，标签 `未关联任务`。

### 3.4 缩放与刻度

| 缩放 | 窗口 | 次格 | 主刻度 | 标签格式 | 主刻度数 |
|---|---|---|---|---|---|
| 24h | 24h | 1h | 4h | `HH:00` | 6（0,4,8,12,16,20 点；末端 24 点标签省略避免与 now 冲突） |
| 7d | 7d | 6h | 1d | `M/D` | 7（每天 0 点，末日在 headroom 内省略） |
| 30d | 30d | 1d | 5d | `M/D` | 6（0/5/10/15/20/25 天） |

- 窗口起点 snap：24h→向下取整点；7d/30d→本地 0 点（跨时区按浏览器本地时间，与当前 `toLocaleString` 一致）。
- 默认 7d；缩放状态存 `localStorage: superbot:map:zoom`，切 tab 不重置。
- 末刻度可能超出 `end`（headroom 内）→ 仍渲染但裁剪文字（`overflow:hidden` 在轴行内），或仅在 `<=end` 时渲染。

### 3.5 状态色（只用 token，不硬编码）

| 语义 | token | 用于 |
|---|---|---|
| 执行中 / 运行中 | `--dsw-alias-state-business-primary` | 线程胶囊（running）、now 线 |
| 已完成 / 成功 | `--dsw-alias-state-success-primary` | 线程胶囊（succeeded）、完成 |
| 失败 / 返工 / 阻塞 | `--dsw-alias-state-error-primary` | failed/canceled/rework/stalled |
| 需你决定 / 等待 | `--dsw-alias-state-warn-primary` | 任务（needs-you 阶段） |
| 待开始 / 无活动 | `--dsw-alias-state-idle-primary` | queued、未知 |
| 文本/轴线/底色 | `label-primary/secondary/tertiary`、`border-l2/l3`、`bg-base`、`bg-layer-1`、`interactive-bg-hover` | 标签、轴、网格、行 hover |
| 焦点 | `--dsw-alias-state-business-primary`（2px outline，offset -2） | 行键盘焦点 |

- 颜色只做「点/条/线」，不做小号色字（琥珀/绿色文本在浅色不达 AA，沿用面板规范）。
- 任务细条用阶段色但 opacity .55；线程胶囊用 run 状态色 opacity .85；两者不靠颜色区分层级，靠**形状/高度/位置**。

### 3.6 交互

1. 行 hover：整行 `interactive-bg-hover`；条 opacity 提升；工具栏下方出现 `sb-tl-inspect` 详情条。
2. 行点击：线程 → `onOpenSession(childId)`；任务 → `onSelectTask(taskId)`（打开现有 TaskDrawer）。
3. 键盘：行 `tabIndex=0`，`Enter` 打开；`J/K` 上下行；`Esc` 清除详情条；`aria-label` 例：`执行者 worker r-24，11/08 14:02 至 14:11，9 分钟，已完成`。
4. `title` 原生 tooltip 只作兜底；主详情走 `sb-tl-inspect`（避免横滚容器裁切）。
5. 缩放按钮：24h/7d/30d，`aria-pressed`；切换后保持滚动位置/选中行。
6. `prefers-reduced-motion`: 关闭所有 transition（条 hover/详情条淡入）。
7. 空态：`还没有可展示的线程。在对话里派工后，这里会出现任务生命周期与执行线程。` + 若有任务但无线程：`任务已创建，等待派工（切到 24h 看最新）`。

---

## 4. 可复制 CSS（追加到 `ensurePanelCss()` 的 style 文本数组）

```css
/* ── ThreadMap timeline ─────────────────────────────────────────── */
.sb-tl{
  --tl-label: 220px;
  --tl-row: 32px;
  --tl-axis: 28px;
  --tl-bar-thread: 10px;
  --tl-bar-task: 3px;
  --tl-dot: 7px;
  --tl-line: var(--dsw-alias-border-l2);
  --tl-line-strong: var(--dsw-alias-border-l3);
  --tl-bg: var(--dsw-alias-bg-base);
  --tl-band: var(--dsw-alias-bg-layer-1);
  --tl-text: var(--dsw-alias-label-secondary);
  --tl-muted: var(--dsw-alias-label-tertiary);
  --tl-hover: var(--dsw-alias-interactive-bg-hover);
  --tl-focus: var(--dsw-alias-state-business-primary);
  border: 1px solid var(--tl-line-strong);
  border-radius: 9px;
  background: var(--tl-bg);
  overflow: hidden;
}
.sb-tl-toolbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;min-height:40px;padding:6px 12px;border-bottom:1px solid var(--tl-line)}
.sb-tl-legend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:10.5px;color:var(--tl-muted)}
.sb-tl-legend .sw{display:inline-block;border-radius:999px;background:currentColor;vertical-align:middle}
.sb-tl-legend .sw--thread{width:14px;height:10px}
.sb-tl-legend .sw--task{width:14px;height:3px;border-radius:2px;opacity:.55;position:relative}
.sb-tl-legend .sw--task::after{content:"";position:absolute;right:-2px;top:-2px;width:7px;height:7px;border-radius:50%;background:currentColor}
.sb-tl-legend .sw--dot{width:8px;height:8px}
.sb-tl-zooms{margin-left:auto;display:flex;gap:4px}
.sb-tl-zooms button{height:22px;padding:0 8px;border-radius:5px;border:1px solid transparent;background:transparent;color:var(--tl-muted);font-size:11px;cursor:pointer}
.sb-tl-zooms button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--tl-line-strong);color:var(--dsw-alias-label-primary)}
.sb-tl-scroll{overflow-x:auto;overscroll-behavior-x:contain}
.sb-tl-canvas{position:relative;min-width:calc(var(--tl-label) + 560px)}
.sb-tl-rowgrid{display:grid;grid-template-columns:var(--tl-label) minmax(0,1fr);align-items:center}
.sb-tl-axis{height:var(--tl-axis);border-bottom:1px solid var(--tl-line-strong)}
.sb-tl-axis .sb-tl-label{font-size:10.5px;color:var(--tl-muted);justify-content:flex-end;padding-right:10px;white-space:nowrap}
.sb-tl-track{position:relative;height:100%;min-width:0}
.sb-tl-tick{position:absolute;top:0;height:100%;display:flex;align-items:center;font-size:10.5px;color:var(--tl-muted);padding-left:6px;white-space:nowrap;transform:none;pointer-events:none}
.sb-tl-body{position:relative}
.sb-tl-gridlines{position:absolute;top:0;bottom:0;left:var(--tl-label);right:0;pointer-events:none;z-index:0}
.sb-tl-gridlines i{position:absolute;top:0;bottom:0;width:1px;background:var(--tl-line)}
.sb-tl-gridlines i.is-major{background:var(--tl-line-strong)}
.sb-tl-nowline{position:absolute;top:0;bottom:0;width:2px;background:var(--dsw-alias-state-business-primary);opacity:.65;pointer-events:none;z-index:1}
.sb-tl-nowlabel{position:absolute;top:2px;transform:translateX(-50%);font-size:9px;line-height:12px;color:var(--dsw-alias-state-business-primary);background:var(--tl-bg);padding:0 2px;white-space:nowrap;z-index:2}
.sb-tl-lane{height:var(--tl-row);background:var(--tl-band);border-bottom:1px solid var(--tl-line)}
.sb-tl-lane .sb-tl-label{font-weight:600;color:var(--dsw-alias-label-primary);font-size:11px}
.sb-tl-row{height:var(--tl-row);box-shadow:inset 0 -1px 0 var(--tl-line);cursor:pointer}
.sb-tl-row:hover,.sb-tl-row:focus-visible{background:var(--tl-hover);outline:none}
.sb-tl-row:focus-visible{box-shadow:inset 0 -1px 0 var(--tl-line),inset 2px 0 0 var(--tl-focus)}
.sb-tl-label{position:sticky;left:0;z-index:2;height:100%;display:flex;align-items:center;gap:6px;padding:0 8px;background:var(--tl-bg);font-size:11.5px;color:var(--tl-text);overflow:hidden;box-sizing:border-box}
.sb-tl-lane .sb-tl-label,.sb-tl-row:hover .sb-tl-label{background:inherit}
.sb-tl-row--thread .sb-tl-label{padding-left:24px;font-size:11px}
.sb-tl-label .tx{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.sb-tl-label .glyph{flex:0 0 auto;color:var(--tl-muted);font-size:10px}
.sb-tl-label .sub{flex:0 0 auto;color:var(--tl-muted);font-size:10px}
.sb-tl-bar{position:absolute;top:50%;transform:translateY(-50%);height:var(--tl-bar-thread);border-radius:5px;background:var(--tone);opacity:.85;pointer-events:none}
.sb-tl-row--thread:hover .sb-tl-bar,.sb-tl-row--thread:focus-visible .sb-tl-bar{opacity:1}
.sb-tl-bar--task{height:var(--tl-bar-task);border-radius:2px;opacity:.55}
.sb-tl-row:hover .sb-tl-bar--task{opacity:.8}
.sb-tl-dot{position:absolute;top:50%;transform:translate(-50%,-50%);width:var(--tl-dot);height:var(--tl-dot);border-radius:50%;background:var(--tone);pointer-events:none}
.sb-tl-clip{position:absolute;top:50%;transform:translateY(-50%);font-size:9px;line-height:1;color:var(--tl-muted);pointer-events:none}
.sb-tl-inspect{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:32px;padding:4px 12px;border-bottom:1px solid var(--tl-line);background:var(--tl-band);font-size:11.5px;color:var(--tl-text)}
.sb-tl-inspect .k{color:var(--tl-muted);font-size:10.5px}
.sb-tl-empty{padding:20px 12px;font-size:12px;color:var(--tl-muted)}
.sb-tl-empty button{margin-left:8px;height:24px;padding:0 8px;border-radius:5px;border:1px solid var(--tl-line-strong);background:transparent;color:var(--dsw-alias-label-primary);font-size:11px;cursor:pointer}
.sb-tl-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@container (max-width:1000px){ .sb-tl{--tl-label:200px} }
@container (max-width:760px){ .sb-tl{--tl-label:160px;--tl-row:30px} }
@media (prefers-reduced-motion:reduce){ .sb-tl *{transition:none!important} }
```

**关键约束（写进 review checklist）**：
- 轨道容器 `.sb-tl-track` **不得有左右 padding/border**（否则 `%` 基准偏移）；标签列的 padding 只加在 `.sb-tl-label`。
- 条宽度只用 `width:%`，**不得出现 px 宽度**（视觉）；hit 区域用行点击实现，不需要加宽。
- 网格线用**整块 overlay**（`.sb-tl-gridlines`）而不是每行画，保证竖线连续、无接缝。
- now 线位置由 `xPct(now)` 计算（headroom 保证不在 100%）。

---

## 5. React.createElement 组件骨架（可直接替换 `client.js:995-1090`）

> 依赖现有 `C` 颜色 token、`relativeTime`/`absoluteTime`/`shortId`/`presetLabel`、`ensurePanelCss()`；用 `h = React.createElement`。CSS 用 §4 追加。

```js
// ── ThreadMap v2 ───────────────────────────────────────────────────
const MAP_ZOOM = {
  '24h': { hours: 24, unitMs: 3_600_000, majorMs: 4 * 3_600_000, snapMs: 4 * 3_600_000, fmt: (d) => `${String(d.getHours()).padStart(2, '0')}:00` },
  '7d':  { hours: 168, unitMs: 6 * 3_600_000, majorMs: 86_400_000, snapMs: 86_400_000, fmt: (d) => `${d.getMonth() + 1}/${d.getDate()}` },
  '30d': { hours: 720, unitMs: 86_400_000, majorMs: 5 * 86_400_000, snapMs: 86_400_000, fmt: (d) => `${d.getMonth() + 1}/${d.getDate()}` },
}
const MAP_ZOOM_KEY = 'superbot:map:zoom'
const MAP_HEADROOM = 0.02 // 2% 余量放 now 线

function snapToStep(ms, stepMs) {
  const d = new Date(ms)
  if (stepMs >= 86_400_000) { d.setHours(0, 0, 0, 0); return d.getTime() }          // 日级：本地 0 点
  d.setMinutes(0, 0, 0)
  d.setHours(Math.floor(d.getHours() / (stepMs / 3_600_000)) * (stepMs / 3_600_000)) // 小时级：本地 4h 边界
  return d.getTime()
}

function loadMapZoom() {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(MAP_ZOOM_KEY)
    return raw !== null && MAP_ZOOM[raw] !== undefined ? raw : '7d'
  } catch { return '7d' }
}

function ThreadMap({ projects, tasks, onOpenSession, onSelectTask }) {
  const [zoom, setZoom] = useState(loadMapZoom)
  const [inspect, setInspect] = useState(null)   // {kind,row,label,start,end,tone,title}
  const view = MAP_ZOOM[zoom]
  useEffect(() => { try { localStorage.setItem(MAP_ZOOM_KEY, zoom) } catch { /* best effort */ } }, [zoom])

  const model = useMemo(() => {
    const taskById = new Map((Array.isArray(tasks) ? tasks : []).map((t) => [t.taskId, t]))
    const now = Date.now()
    const windowMs = view.hours * 3_600_000
    const start = snapToStep(now - windowMs, view.snapMs)
    const end = start + windowMs + Math.round(windowMs * MAP_HEADROOM)
    const span = Math.max(1, end - start)
    const pct = (t) => `${Math.max(0, Math.min(100, ((t - start) / span) * 100)).toFixed(3)}%`
    const ticks = []
    for (let t = start; t < start + windowMs; t += view.majorMs) ticks.push({ t, label: view.fmt(new Date(t)) })
    const lanes = []
    const orphan = []
    for (const project of Array.isArray(projects) ? projects : []) {
      const rows = []
      const projectTasks = new Map()
      for (const task of Array.isArray(tasks) ? tasks : []) {
        if (task.projectId !== project.projectId) continue
        projectTasks.set(task.taskId, task)
      }
      for (const task of projectTasks.values()) {
        rows.push({ kind: 'task', task, start: Date.parse(String(task.createdAt ?? task.updatedAt ?? '')) })
      }
      rows.sort((a, b) => a.start - b.start)
      const threadRows = new Map() // taskId -> rows
      for (const thread of Array.isArray(project.threads) ? project.threads : []) {
        const started = Date.parse(String(thread.startedAt ?? ''))
        if (!Number.isFinite(started)) continue
        const finished = Date.parse(String(thread.finishedAt ?? ''))
        const row = { kind: 'thread', thread, task: taskById.get(thread.taskId), start: started, end: Number.isFinite(finished) ? finished : null }
        if (thread.taskId === undefined || !projectTasks.has(thread.taskId)) { orphan.push({ ...row, lane: project }); continue }
        const list = threadRows.get(thread.taskId) ?? []
        list.push(row); threadRows.set(thread.taskId, list)
      }
      const laneOrphans = orphan.filter((r) => r.lane.projectId === project.projectId)
      if (rows.length === 0 && threadRows.size === 0 && laneOrphans.length === 0) continue
      lanes.push({ projectId: project.projectId, title: project.title || project.projectId, tasks: rows, threadsByTask: threadRows, orphans: laneOrphans })
    }
    return { lanes, now, start, end, span, pct, ticks, windowMs }
  }, [projects, tasks, view])

  const toneOf = (kind, task, thread) => kind === 'task'
    ? (task?.phase === 'needs-you' ? C.warn : task?.phase === 'done' ? C.success : (task?.phase === 'rework' || task?.phase === 'stalled' || task?.phase === 'blocked') ? C.danger : task?.phase === 'queued' ? C.idle : C.business)
    : (thread?.active === true || thread?.status === 'running') ? C.business : thread?.status === 'succeeded' ? C.success : (thread?.status === 'failed' || thread?.status === 'canceled') ? C.danger : C.idle
  const labelOf = (kind, task, thread) => kind === 'task'
    ? `${task?.phaseLabel || task?.phase || '任务'} · ${task?.title || task?.taskId}`
    : `${presetLabel(thread?.agentPreset)} · ${thread?.label || task?.title || thread?.taskId || thread?.runId || '线程'}`
  const timeText = (a, b) => `${absoluteTime(new Date(a).toISOString())} → ${b === null ? '进行中' : absoluteTime(new Date(b).toISOString())}`

  const bar = (row, kind) => {
    const task = row.task
    const thread = row.thread
    const end = row.end === null ? model.now : row.end
    const a = Math.max(row.start, model.start)
    const b = Math.min(end, model.end)
    const tone = toneOf(kind, task, thread)
    const left = model.pct(a)
    const width = `${Math.max(0, parseFloat(model.pct(b)) - parseFloat(left))}%`
    const clippedStart = row.start < model.start
    const clippedEnd = row.end !== null && row.end > model.end
    const label = labelOf(kind, task, thread)
    const title = `${label} · ${timeText(row.start, row.end)}`
    const common = { className: kind === 'task' ? 'sb-tl-bar sb-tl-bar--task' : 'sb-tl-bar', style: { left, width, '--tone': tone }, 'aria-hidden': 'true' }
    return h(React.Fragment, null,
      h('span', common),
      kind === 'task' ? h('span', { className: 'sb-tl-dot', style: { left: model.pct(end), '--tone': tone }, 'aria-hidden': 'true' }) : null,
      clippedStart ? h('span', { className: 'sb-tl-clip', style: { left: '2px' }, 'aria-hidden': 'true' }, '◀') : null,
      clippedEnd ? h('span', { className: 'sb-tl-clip', style: { right: '2px' }, 'aria-hidden': 'true' }, '▶') : null,
      h('span', { className: 'sb-tl-sr' }, title))
  }

  const row = (rowModel, kind, key) => {
    const task = rowModel.task
    const thread = rowModel.thread
    const label = labelOf(kind, task, thread)
    const glyph = kind === 'task' ? '◻' : thread?.agentPreset === 'superbot-verifier' ? '◇' : '◉'
    const open = () => {
      if (kind === 'thread') { if (typeof onOpenSession === 'function' && typeof thread?.childId === 'string') onOpenSession(thread.childId); return }
      if (typeof onSelectTask === 'function') onSelectTask(task?.taskId)
    }
    return h('div', {
      key, role: 'button', tabIndex: 0, className: `sb-tl-row sb-tl-rowgrid ${kind === 'thread' ? 'sb-tl-row--thread' : ''}`,
      'aria-label': `${label}，${timeText(rowModel.start, rowModel.end)}`,
      onClick: open,
      onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } },
      onMouseEnter: () => setInspect({ kind, rowModel, label }),
      onFocus: () => setInspect({ kind, rowModel, label }),
      onMouseLeave: () => setInspect(null),
      onBlur: () => setInspect(null),
    },
      h('div', { className: 'sb-tl-label' },
        h('span', { className: 'glyph' }, glyph),
        h('span', { className: 'tx' }, label),
        h('span', { className: 'sub' }, kind === 'thread' ? shortId(thread?.runId ?? '') : relativeTime(task?.updatedAt).text)),
      h('div', { className: 'sb-tl-track' }, bar(rowModel, kind)))
  }

  if (model.lanes.length === 0) {
    return h('div', { className: 'sb-tl' },
      h('div', { className: 'sb-tl-empty' }, '还没有可展示的线程。在对话里让 Superbot 派工后，这里会出现任务生命周期与执行线程。'))
  }
  return h('section', { className: 'sb-tl', 'aria-label': '线程时间线' },
    h('div', { className: 'sb-tl-toolbar' },
      h('div', { className: 'sb-tl-legend' },
        h('span', null, h('span', { className: 'sw sw--task', style: { color: C.text3 } }), ' 任务生命周期'),
        h('span', null, h('span', { className: 'sw sw--thread', style: { color: C.business } }), ' 执行/审计线程'),
        h('span', null, h('span', { className: 'sw sw--dot', style: { color: C.success } }), ' 完成'),
        h('span', null, h('span', { className: 'sw sw--dot', style: { color: C.danger } }), ' 失败/返工'),
        h('span', null, h('span', { className: 'sw sw--dot', style: { color: C.warn } }), ' 需你决定')),
      h('div', { className: 'sb-tl-zooms', role: 'group', 'aria-label': '时间范围' },
        ['24h', '7d', '30d'].map((key) => h('button', { key, type: 'button', 'aria-pressed': zoom === key, onClick: () => setZoom(key) }, key)))),
    inspect ? h('div', { className: 'sb-tl-inspect', role: 'status' },
      h('span', { className: 'k' }, '时间'), h('span', null, timeText(inspect.rowModel.start, inspect.rowModel.end)),
      h('span', { className: 'k' }, '时长'), h('span', null, inspect.rowModel.end === null ? '进行中' : `${Math.max(1, Math.round((inspect.rowModel.end - inspect.rowModel.start) / 60000))} 分钟`),
      h('span', { className: 'k' }, '对象'), h('span', null, inspect.label),
      inspect.kind === 'thread' && typeof inspect.rowModel.thread?.childId === 'string'
        ? h(Button, { size: 'sm', onClick: () => onOpenSession(inspect.rowModel.thread.childId) }, '打开会话')
        : null)
      : null,
    h('div', { className: 'sb-tl-scroll' },
      h('div', { className: 'sb-tl-canvas' },
        h('div', { className: 'sb-tl-rowgrid sb-tl-axis' },
          h('div', { className: 'sb-tl-label' }, `过去 ${zoom} · ${view.fmt(new Date(model.start))} → ${view.fmt(new Date(model.end))}`),
          h('div', { className: 'sb-tl-track' },
            model.ticks.map(({ t, label }) => h('span', { key: t, className: 'sb-tl-tick', style: { left: model.pct(t) } }, label)),
            h('span', { className: 'sb-tl-nowlabel', style: { left: model.pct(model.now) } }, '现在'))),
        h('div', { className: 'sb-tl-body' },
          (() => {
            const lines = []
            for (let t = model.start; t <= model.end; t += view.unitMs) {
              const major = Math.abs((t - model.start) % view.majorMs) < 1
              lines.push(h('i', { key: `g${t}`, className: major ? 'is-major' : '', style: { left: model.pct(t) } }))
            }
            lines.push(h('i', { key: 'now', className: 'sb-tl-nowline', style: { left: model.pct(model.now) } }))
            return h('div', { className: 'sb-tl-gridlines', 'aria-hidden': 'true' }, lines)
          })(),
          model.lanes.map((lane) => h(React.Fragment, { key: lane.projectId },
            h('div', { className: 'sb-tl-rowgrid sb-tl-lane' },
              h('div', { className: 'sb-tl-label' }, lane.title, h('span', { className: 'sub' }, `${lane.tasks.length} 任务`)),
              h('div', { className: 'sb-tl-track' })),
            lane.tasks.flatMap((taskRow) => {
              const task = taskRow.task
              if (taskRow.start === undefined || !Number.isFinite(taskRow.start)) return []
              const threads = lane.threadsByTask.get(task.taskId) ?? []
              return [
                row({ ...taskRow, end: Date.parse(String(task.acceptedAt ?? task.updatedAt ?? '')) || null }, 'task', `task:${task.taskId}`),
                ...threads.map((threadRow) => row(threadRow, 'thread', `thread:${threadRow.thread.runId}`)),
              ]
            })),
            lane.orphans.map((r) => row(r, 'thread', `orphan:${r.thread.runId}`)))),
      )))
}
```

**数据前提**：`overview.tasks[]` 已含 `createdAt/updatedAt/phase/phaseLabel/priority/taskId/title/projectId`（`overview.js:265-300`），`projects[].threads[]` 含 `runId/childId/agentPreset/label/status/active/startedAt/finishedAt/taskId`（`overview.js:138-151`）。v1 不需要改后端；若要显示"验收通过时间"作为任务条终点，需在 tasks[] 增加 `acceptedAt`（可选）。

**集成点**：
| 文件/位置 | 改动 |
|---|---|
| `client.js:995-1090` | 用 §5 替换 `ThreadMap` |
| `client.js:992-993` | 删除 `MAP_ROW/MAP_LABEL` 常量（改用 CSS 变量） |
| `client.js:335-354` `ensurePanelCss()` | 追加 §4 CSS |
| `client.js:1519-1522` 地图 tab | 传 `onSelectTask` props；SectionHeading hint 改为"任务生命周期与线程胶囊；点行查看详情/打开会话" |
| `task-phase.js:17-26` | 补 `stalled: { label: '疑似卡住', tone: 'danger', order: 1.5 }`（否则 `phaseLabel` 缺失，图例/详情显示 `stalled`） |

---

## 6. three.js 是否合适？纯 CSS Grid 够不够？

### 6.1 结论：**不合适（否）**

| 维度 | three.js（WebGL） | 纯 DOM/CSS |
|---|---|---|
| 问题性质 | 对齐问题来自**坐标系与布局**，不是渲染吞吐；换 3D 不解决 `minWidth/居中/刻度/now` 这些 bug | 单一 `xPct` + CSS Grid 直接消除 |
| 依赖/构建 | 需额外依赖与构建（当前插件无构建、client 是纯 `React.createElement` + 一次性 `<style>`）；three 体积 ~150KB+ | 0 依赖，CSS 追加 ~2KB |
| 文本/标签 | 文本需 DOM overlay 或 TextGeometry/纹理：前者等于不用 three，后者模糊、无字体回退/中文排版差 | DOM 文本清晰、可选中、可 i18n |
| 主题 token | 需把 `--dsw-alias-*` 手动转成 material color，深浅色/对比度要自己维护 | 直接 `var(--dsw-alias-*)`，自动深浅色 |
| 可访问性 | canvas 无读屏/键盘/`aria-label`，需另做影子 DOM | 原生 role/tabIndex/aria |
| 交互 | 滚动/缩放/点击命中/hover 全部自建（射线拾取） | 原生滚动、CSS hover、DOM 事件 |
| 性能 | 200 任务 × 数十线程不构成性能问题；DOM 总节点 ~1k | 无压力；超过 1–2 万行再考虑虚拟化/Canvas |

**适用边界**：只有未来需要 3D 透视、地理/空间映射、粒子动画/GPU 特效才考虑 three.js；即便如此，时间线也不是它的场景。数据量增长路径应是：DOM（现在）→ 行虚拟化 → 超出 5k 条用**Canvas 2D 自绘**（或 SVG，若需保留 DOM a11y），不做 three.js。

### 6.2 纯 CSS Grid 够不够？够

- 外层两列 grid 解决"标签列 + 时间轴列"结构；行高固定解决垂直节奏；`xPct` 单一函数解决水平对齐；`sticky` 解决横滚标签；`container query` 解决响应式；`background/overlay` 解决连续网格线。
- 唯一需要 JS 的是：窗口计算（start/end/ticks）、`xPct`、数据分组。这些都是纯函数，不涉渲染库。
- 不支持 CSS Grid 的环境不存在（DSH 是 Chromium/Electron）；`subgrid` 不需要（只有两列 + 绝对定位条），避免兼容性顾虑。

---

## 7. 验收清单（像素级可测）

| # | 检查 | 通过标准 |
|---|---|---|
| 1 | 轴刻度与网格线对齐 | DevTools 取任一主刻度 label 左边缘 x 与 gridline x，差 ≤1px |
| 2 | 条起点/终点与时间一致 | 取 1h 窗口内任一条：`(bar.left - track.left)/track.width` 与 `(start-windowStart)/span` 误差 ≤0.2% |
| 3 | 条垂直居中 | 每条 bar 的 `top + height/2` == 行 `top + rowHeight/2`，误差 ≤0.5px（含 1px 分隔线时用 box-shadow 不占位） |
| 4 | 无 px 宽度 | 源码搜索 `minWidth` 不再出现在 ThreadMap；条宽度只来自 `xPct` 差值 |
| 5 | now 线可见 | now 线 x 位于轨道 94–99% 区间；未被边框/滚动容器裁切 |
| 6 | 三档刻度 | 24h=6 主刻度、7d=7、30d=6；24h 标签均为整点，7d/30d 均从 0 点开始 |
| 7 | 行高一致 | lane header/任务/线程行高度全部 32px（窄容器 30）；无 margin 造成的错位 |
| 8 | 标签列 | 横向滚动时标签列固定；宽容器 220、<1000 为 200、<760 为 160 |
| 9 | 层级 | 任务条 3px+7px 点；线程条 10px 胶囊；两者形状/高度可区分，图例与真实形状一致 |
| 10 | 点击/键盘 | 任务行点击打开 TaskDrawer；线程行打开会话；Tab 可聚焦、Enter 生效、focus ring 可见 |
| 11 | hover/focus 详情 | 工具栏下方显示起止/时长/对象；无原生 title 依赖也可读 |
| 12 | 空/窄/极端 | 无数据显示引导；30d 在 800px 面板下出现横滚而非挤压；创建于窗口外的条有 ◀/▶ |
| 13 | 深浅色 | 只使用 token；深浅两主题截图无不可见元素 |
| 14 | reduced motion | 开启后无过渡动画 |
| 15 | 截图证据 | 验收产物包含：1440/1280/1024 宽度 × 24h/7d/30d × 深浅色截图（当前仓库没有 map tab 截图，需补） |

---

## 8. 引用与本地证据

**一手/教程资料（2026-11-08 核对）**

1. freeCodeCamp — How to Create a Simple Gantt Chart Using CSS Grid（纯 CSS Grid，无库；表头/网格线/条共享列定义，条用 `grid-column` 表达时长）：<https://www.freecodecamp.org/news/create-gantt-chart-using-css-grid/>
2. ONES — Building a Gantt Chart in JS: A Step-by-Step Tutorial（`grid-template-columns: 150px 1fr` + `subgrid` 行；滚动时间轴 header；单 `dayWidth` 常量让 header 与 bar 共享坐标）：<https://ones.com/blog/building-a-gantt-chart-in-js-a-step-by-step-tutorial>
3. cathrynlavery/diagram-design — `skills/diagram-design/references/type-gantt.md`（label 列 180px、行高 40px、条 24px 垂直居中、pitch 定位时间轴、hairline、today 竖线、focal bar、反模式）：<https://github.com/cathrynlavery/diagram-design/blob/main/skills/diagram-design/references/type-gantt.md>（raw：<https://raw.githubusercontent.com/cathrynlavery/diagram-design/main/skills/diagram-design/references/type-gantt.md>）
4. MDN — CSS Grid layout / line-based placement（网格线定位与列模板）：<https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout/Grid_layout_using_line-based_placement>；`position: sticky`（横滚时固定标签列）：<https://developer.mozilla.org/en-US/docs/Web/CSS/position>
5. Lead 提供的 nicelydone Linear timeline 示例（`https://nicelydone.club/examples/components/96ff4f7a`）在 2026-11-08 核对为 **404**，未作为事实依据；如需 Linear 时间线的官方模式，可参考其 Docs 中的 timeline 视图说明。

**本地证据（只读）**
- `packages/dsh-superbot/lib/client.js:992-1090`（ThreadMap 当前实现/常量）、`335-354`（`ensurePanelCss`）、`1519-1522`（地图 tab 渲染）
- `packages/dsh-superbot/lib/overview.js:138-151`（project.threads 字段）、`265-300`（tasks[] phase/thread 投影）
- `packages/dsh-superbot/lib/task-phase.js:17-26`（PHASE_META，缺 stalled）、`73-80`（stalled 派生）
- 插件为纯 `React.createElement` + 内联样式 + 一次性注入 `<style>`，无构建、无 Tailwind（`client.js:335-354` 与文件结构）。

**限制**：仓库内没有地图 tab 的现有截图（`（历史验收证据已归档，不在本仓库）` 中无 map 视图），本报告的对齐诊断基于代码行级推导；建议实现后按 §7 补 1440/1280/1024 × 24h/7d/30d × 深浅色截图作为验收证据。任务描述提到的 label 300px 与当前代码 220px 不一致（可能为早期版本），修复方案对两者都适用（固定 px → 响应式 clamp + sticky）。
