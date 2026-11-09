# Superbot 面板视觉系统审计与美化规范（专家组 U2 · task-14）

- 审计人：contract-auditor（U2 独立视觉审计；本报告不参考同目录其他专家报告）
- 时间：2026-11-08 13:45 EST（America/New_York）
- 工作区：`/Users/afraxx/Documents/DeepSeekProjects/superbot-next`
- 审计快照：`packages/dsh-superbot/lib/client.js` 读取时 md5 `a5e0e2208b1fd159701b5e348167152a`（mtime 13:37，1818 行）。**审计与写报告期间该文件被并行实施持续修改**：13:44 → md5 `7607b77f…`；13:47 → md5 `9091a995…`（1851 行，`ThreadMap` 已开始接收 `model`，新增 `lib/timeline.js`，地图/时间线正在重写）。本报告 §2 行号以 **a5e0e22 快照**为准；§4/§5/§6 的规范与实现步骤与版本无关。若行号漂移，用 §2 开头给的 grep 锚点定位。
- 性质：只读审计。未改仓库源码；唯一写入本文件。
- 目标：把「普通卡片 + pill + 表格」的控制台，升级为「老板 ↔ 核心调度员工」的**安静控制室**：一眼看到该做什么、每条线程在哪、证据到哪；视觉上像产品，而不是后台模板。

---

## 0. 结论速览

1. 当前面板不是「配色不好看」，而是**没有视觉系统**：272 个内联 style、11 种字号、9 种圆角、13 种 marginTop，完全绕开 DSH 自带的 radius / type / elevation / mask token（§1、§2.1）。
2. 有 10 条「不像产品」的具体问题（§2）：信息架构双入口、首屏无焦点、排版散、强调色泛滥、抽屉/地图/空态原始、错误色 token 不存在、品牌资产缺失。
3. 方向定为 **Quiet Control Room**：单一 accent（DSH business 蓝）+ 品牌黑白主按钮 + 三层表面 + 克制的 1px 边框；标题/正文/元数据只用 DSH 的 4–5 级 type token；所有视觉值进 `sb-*` 类，只有「几何」留在内联（§3、§4）。
4. 给出**一次性 `<style>` 的完整 CSS 骨架**（§5，约 330 行，纯 CSS，无新依赖、无新字体、深浅色自动跟随 DSH token），以及从当前内联样式迁移的类名映射与步骤（§6）。
5. 选型结论：CSS + DSH token（推荐）；图标用内联 SVG；甘特用 CSS Grid；**不用 three.js / WebGL**；也不引入图表库（§7）。
6. 重点修复项：错误色 token 修复、双入口合并、首屏 Focus 区、Phase 徽章规范化、抽屉与时间线重做（§6 的 P0/P1 清单）。

---

## 1. 现状量化基线（实测统计，快照 a5e0e22）

| 指标 | 实测 | 证据 |
|---|---|---|
| 内联 `style: {` 对象 | **272 处** | `grep -c "style: {" client.js` |
| 用到 `className` 的位置 | 仅 15 处，且只有 `.sb-btn / .sb-row / .sb-page-inner / .sb-col-*` 5 个类 | 快照 a5e0e22 中：client.js:402,689,704,711,719,723,737,762,870,1396,1473,1564,1631,1633（最新 9091a99 复核为 15 处） |
| 一次性 `<style>` 规则数 | **11 条**（hover/focus/容器查询） | client.js:335-354 |
| 字号种类 | **11 种**：11px×38、12px×36、11.5×13、13×10、12.5×6、10.5×4、15×3、14×2、10×2、20×1、16×1 | `grep -o "fontSize: '[0-9.]*px'"` 统计 |
| 圆角种类 | **9 种**：6×15、8×5、10×3、5×2、50%×2、4×2、2×2、9×1、3×1 | `borderRadius` 统计 |
| 垂直间距 | `marginTop` **12 种**（2/4/6/8/10/12/14/16/18/22/26/30） | `marginTop` 统计 |
| 过渡/动效 | 2 条 transition（`.sb-row`、`.sb-btn`），**0 条 `prefers-reduced-motion`** | client.js:342,346；grep 计数 0 |
| 硬编码颜色 | 1 个 hex（`#b42318`）、2 个 rgba（遮罩、抽屉阴影） | client.js:113,963,964 |
| 引用但**不存在**的 DSH token | 2 个：`--dsw-alias-label-error`、`--dsw-alias-label-danger` | client.js:193,113；DSH 0.2.1-rc.5 token 定义见 §3.6 |
| 图标资产 | 整个面板 **1 个 SVG**（侧栏图标），其余用 Unicode 符号冒充 | client.js:1718-1727；`▸/▾` 728、`×` 967、`◻/◉/◇` 1061、`›` 918 |
| tab 数 / 对话入口数 / 侧栏面板数 | 7 tabs / **5 个对话入口** / **2 个侧栏面板（同一个图标）** | client.js:1480-1489；1407-1478、858-877、1652-1713、1735-1742 |
| 内容宽度 | maxWidth 1120px，左右 padding 28px | client.js:1396 |

> §1 统计已在最新 9091a99（1851 行，13:47）上复核：272 个内联 style、11 种字号、9 种圆角、12 种 marginTop、2 条 transition、0 条 reduced-motion、1 个 SVG、2 个侧栏入口、2 个未定义 token 均保持不变。

> 备注：`--dsw-alias-label-error` 在 DSH 0.2.1-rc.5 的 theme token 里**没有定义**（DSH theme 的 state 语义色是 `--dsw-alias-state-error-primary` 等）。当前 `C.errorText` 指向它，所以所有「读取失败 / 生成失败 / 阻断项」的红字实际上**继承普通正文色**，错误提示不红、不显眼——这是最容易被当成「不美」的隐藏 bug（已实测 token 定义缺失，见 §3.6）。

---

## 2. 10 条「看起来不像产品」的问题

> 每条给出：现象 → 证据（file:line）→ 为什么不像产品 → 修法方向（规范细节见 §4）。
>
> 行号对应读取快照 a5e0e22；并行修改后若行号漂移，用这些稳定锚点重新定位：
> `function ensurePanelCss` / `errorText: 'var(--dsw-alias-label-error)'` / `sidebar.panellist`（两处注册）/ `function TaskDrawer` + `rgba(0,0,0,0.35)` / `const MAP_ROW` / `const PHASE_LANES` / `function TaskBoard` / `function SuperbotChatLauncher` / `C.brand` / `function EmptyLine`。

### 2.1 没有视觉系统：一切靠内联值，且绕开 DSH 自己的 design token

- 现象：颜色只包了 20 个 alias 变量（client.js:179-200），但**圆角/字号/行高/阴影/遮罩/焦点环全部手写**；`ensurePanelCss` 只维护 11 条规则（335-354）；272 处内联样式里塞满 10–20px 字号、2–10px 圆角。
- 证据：字号/圆角/间距统计见 §1；对照 DSH theme 已提供 `--dsw-radius-xs/sm/md/lg/xl/panel`（4/8/12/16/20/28px）、`--dsw-font-xxxs-11 … --dsw-font-xl-24`、`--dsw-elevation-panel/prominent/soft`、`--dsw-alias-bg-mask-1`、`--dsw-focus-ring-width`（`@deepseek-ai/dsh-client-ui-theme/lib/client.js:1407,1413,1425`）。
- 为什么不像产品：产品感来自**一致性**（同一层级用同一字号/圆角/间距）。每个组件自行发明数值，视觉节奏必然碎裂；也无法统一响应深/浅色和密度。
- 修法：建一层 `sb-*` class（§5），所有静态视觉值进 CSS 并引用 DSH token；只有「几何/数据驱动」值（进度条宽度、甘特起止、表格列宽）留在内联或 CSS 变量。

### 2.2 双入口 + 对话入口堆叠，信息架构像内部调试页

- 现象：侧栏注册了**两个面板**，label 分别是「Superbot 对话」与「Superbot」，但**共用同一个图标**（client.js:1735-1742、1718-1727）；主面板里又有：顶栏「调度对话」按钮（1407-1419）→ 折叠菜单 ManagerMenu（1433-1441 / 858-877）→ 整段「对话在原生会话里进行」（1453-1478）→ 独立的 chat 启动面板（1652-1713）→ 历史 tab 里的「交给 Superbot 分析」（1524-1549）。
- 证据：5 个对话入口，其中两个侧栏入口图标完全相同；`SuperbotChatLauncher` 打开时只是一个居中的「正在打开…」splash（1706-1712），像临时页面。
- 为什么不像产品：产品只给**一个**明确主入口；同一图标两个入口、同一动作五种按钮，传达的是「功能没收敛」。
- 修法：合并为**一个侧栏入口**（唯一图标/名称「Superbot」）；主面板顶栏只保留一个 primary「进入对话」按钮；删除独立 chat 面板（`superbot-chat` slot）或改为「快捷启动」且用不同图标/不占 tab；「交给 Superbot 分析」保留在历史行内作为次级动作。

### 2.3 首屏没有焦点（Focus）：打开后不知道「我现在该干嘛」

- 现象：默认 tab 是任务（`useState('tasks')`，1098），但页面结构是「header → 对话入口整段 → 7 个 tab → 任务板」的长滚动；「待你验收」排在第 5 个 tab（1487），顶部概要只是 4 个 inline 数字（1361-1363、1424-1428），没有任何重点卡/需要动作的区块。
- 证据：client.js:1398-1428（header 与概要）、1453-1478（对话段）、1480-1501（tabs 顺序）、1502-1507（默认任务板）。
- 为什么不像产品：老板打开控制台，第一眼应该看到「需要我拍板的事」和「正在跑什么」。现在是平铺目录，注意力被平均分散。
- 修法（参考 agent-monitor PR #183 的 Focus Layout + minimap）：顶部 KPI 摘要带（4 项）+ 「需你决定」Focus 区置顶 + tabs 第二行；tabs 顺序改为 `任务 / 待你验收(n) / 调度中(n) / 地图 / 历史 / 项目 / 高级`，`待你验收` 用语义徽章突出；可选在 KPI 下加一条 16 点 minimap（每个项目/活跃线程一个点，running 跳动），实现成本低、产品感提升明显。

### 2.4 数据呈现有四套范式且密度失控

- 现象：同一个系统的数据被四种方式呈现——任务板卡片网格（941 `repeat(auto-fill,minmax(250px,1fr))`）、项目表格（1628-1645）、线程/调度表格（590-614、1556-1573）、历史卡列表（1530-1549）；控件高度也散：pill 20px（387）、按钮 24/28px（404）、tab 30px（1497）、输入 28px（558）、表格行 42px（566）、抽屉内控件混用。
- 证据：上述行号；`TABLE/TH/TD` 定义 564-566；`TaskBoard` 922-944；`TaskDrawer` 946-990。
- 为什么不像产品：控件高度/行高不成体系（24/28/30/42），页面看起来「拼」；同类信息在不同 tab 的呈现方式不一致，认知成本高。
- 修法：统一控件高度 **28px**（sm 24）、表格行 **44px**（紧凑 32）、卡片 padding 16、区块间距 24/32；任务统一用任务卡；线程/调度统一用表格；历史统一用列表行；详见 §4.4/§4.5。

### 2.5 排版没有 type scale，同一语义多处不一致

- 现象：卡片标题 13px 500（906）、抽屉标题 15px 600（966）、页面 h1 20px 600（1404）、区块标题 13px 600（428）、对话标题 14px 600（1456）——同一「标题」层级 5 种规格；行高 16/17/18/19/20/22 混用；数字列只有 2 处加 `tabular-nums`（709、714）。
- 证据：client.js:906、966、1404、428、1456；`fontVariantNumeric` 仅 709/714。
- 为什么不像产品：产品有 3–5 级稳定的 title/body/caption 体系；字号漂移=视觉噪音；数字不对齐会显得廉价。
- 修法：只用 DSH type token 的 5 级（§4.3）：`l-20`（页标题）、`m-18`（区块/抽屉标题）、`s-strong-14`（卡片标题）、`xxs-12`（元数据）、`xxxs-11-strong`（标签/徽章）；所有数字列 `.sb-num{font-variant-numeric:tabular-nums}`。

### 2.6 强调色泛滥 + 状态色叠加，蓝色到处都是

- 现象：business 蓝同时用于：active tab 下划线（1497）、primary 按钮（1408）、进度条（708）、线程状态点（713）、地图条（1059-1060）、地图 now 线（1074）、角色 pill（597/1565）、pill 圆点（393）。7 种 phase 色（879-887）又以「卡片左侧 3px 色条（899）+ pill 圆点（902）+ 地图条（1057-1060）」三种形式重复出现。
- 证据：上述行号；phase 表 `PHASE_LANES` 879-887；`TASK_STATUS` 202-210；`PROJECT_STATUS` 246-251。
- 为什么不像产品：单一 accent 的纪律是「只有交互和重点才用品牌色」（Linear DESIGN.md §7 明确：品牌色仅用于 CTA/交互）；现在 1px 蓝点、蓝条、蓝下划线到处是，视觉上「全是重点=没有重点」。
- 修法：accent 只用于 **主按钮 / active tab / 焦点环 / 关键链接**；状态一律用「语义色 + 文字 + 图形」的徽章（§4.2/§4.5），不使用色条+圆点重复编码；phase 色只在徽章出现。

### 2.7 抽屉是自绘 div：遮罩/阴影硬编码、无焦点管理，深浅色不闭环

- 现象：`TaskDrawer` 用 `position:fixed` 自绘遮罩 `rgba(0,0,0,0.35)`（963）和面板阴影 `rgba(0,0,0,0.18)`（964），没有用 DSH 的 mask/elevation token；关闭按钮是文本「×」（967，16px）；没有 Esc 关闭、焦点 trap、滚动锁定、进出动画（946-990）。
- 证据：client.js:962-990（整体）、963（遮罩）、964（阴影）、967（关闭）。
- 为什么不像产品：抽屉是最能体现「产品级交互」的组件；硬编码黑色遮罩/阴影在浅色主题显得脏、深色主题几乎不可见；无焦点管理是可用性问题。
- 修法：`.sb-drawer` + `.sb-drawer__mask`（`--dsw-alias-bg-mask-1`）+ `.sb-drawer__panel`（`--dsw-elevation-prominent` + `border-l3`），管理 Esc/focus/scroll-lock，进出用 160ms 位移（`prefers-reduced-motion` 关闭动画）；关闭用内联 SVG × 按钮（§4.5/§5）。

### 2.8 地图（甘特）实现原始：绝对定位 + 固定 220px 标签 + 10px 字 + Unicode 符号

- 现象：`ThreadMap` 用绝对定位百分比画条（992-1081）：固定 `MAP_LABEL=220`、`MAP_ROW=30`（992-993），轴刻度写死 5 个 `TICKS`（1024），标签列宽 220px 在窄面板挤压，轴/行文字 10–11px（1027、1035、1070），行首图标用 `◻/◉/◇`（1061），条色用 opacity 0.65/0.8/0.95 手调（1077）。
- 证据：client.js:992-1081 全部；尤其 992-993、1024-1032、1034-1041、1049-1080。**13:47 起地图/时间线正在被并行重写**（`ThreadMap` 新增 `model/onSelect`、新增 `lib/timeline.js`）；但最新 9091a99 快照中旧的绝对定位行、220px 标签列、`◻/◉/◇` Unicode 标签与 opacity 调色仍在，本节问题在规范收敛前依然成立。
- 为什么不像产品：时间线是这套系统最有「控制室感」的视图，但当前是「demo 级 HTML 绝对定位」；没有产品级轴/网格/直标/空态/缩放。参考 freeCodeCamp 的 CSS Grid Gantt 做法（行=grid，bar 用 `grid-column` 跨列），纯 CSS 即可做出产品级时间线，无需图表库。
- 修法：`sb-gantt` CSS Grid 骨架（§5），标签列 200–240px 响应式收窄，行高 32px，轴用 5 等分 grid 直标，条形用 CSS 变量 `--sb-start/--sb-width` 定位、`--sb-tone` 着色；文字统一 xxs-12/xxxs-11；禁止 Unicode 符号，换 SVG 图标。

### 2.9 空态/加载/错误/成功反馈是「灰字 + 裸红字」，没有反馈设计

- 现象：空态是灰色一行（`EmptyLine` 435-437；用于 923、1017、1528、1555、1623-1627）；错误是纯红文字（828、1443、1445、1448-1449），而且 `C.errorText` 指向**不存在的 token**（193，所以实际上不红）；加载只有文字（81、1194、1423、1555）；操作成功/失败是页面顶部一行小字（1444-1445），没有 toast/inline banner/图标；tab 切换没有任何加载态。
- 证据：上述行号 + §1 token 审计（`--dsw-alias-label-error` 未定义）。
- 为什么不像产品：产品的「状态设计」决定信任感：空态要告诉用户下一步，错误要显著且可恢复，加载要 skeleton 而不是闪烁文字。当前全部缺失，还叠加错误色失效。
- 修法：`.sb-empty`（图标+标题+一句下一步+动作按钮）、`.sb-skeleton`（用 `--dsw-alias-bg-skeleton` + pulse，遵守 reduced motion）、`.sb-alert`（`state-error-primary` 12% 混合背景 + 左侧 2px 语义色）、`.sb-toast`（`--dsw-alias-toast-bg`）；错误色改用 `--dsw-alias-state-error-primary`。

### 2.10 品牌与细节资产缺失，浅色主题「白糊糊」，状态无法脱离颜色理解

- 现象：整个面板只有 1 个侧栏 SVG 图标（1718-1727），没有产品级图标集/品牌标记；`Bar` 默认 tone 是未定义的 `C.brand`（419，`C` 里没有 brand）；硬编码色残留（113 的 `#b42318` fallback、963/964 的 rgba）；地图条用 opacity 手调（1077）；浅色主题下 `--dsw-alias-bg-layer-1/2/3` **全部等于 #fff**（DSH theme:1413），而面板把 layer 当卡片背景用，导致浅色模式卡片/页面无层级差（白糊糊），只能靠 1px 灰边框硬撑。
- 证据：client.js:1718-1727（唯一图标）、419（`C.brand`）、113/963/964（硬编码）、1077（opacity）；DSH theme 浅色 layer 值见 §3.6。
- 为什么不像产品：产品靠「画布→表面→浮层」的层级和统一图标系统建立品质感；浅色模式必须用**边框阶梯 + 轻阴影**补层级（因为 layer-1/2 在浅色是同一个白）。
- 修法：建 12 个内联 SVG 图标（16px、1.5px stroke、currentColor）；`Bar` 默认改 `C.business`；所有语义状态加**文字+图形**（✓ ! ✕ ●）；浅色层级用 `border-l2/l3/l4` + `--dsw-elevation-soft`；深色用 `bg-layer-1/2` + `--dsw-elevation-panel`（§4.2/§4.6）。

---

## 3. 研究与设计系统提炼

> 外部资料只作为设计输入，已按不可信数据处理；引用其公开可核验结论。

### 3.1 Focus Layout + minimap + 三层灰阶 + 语义色

参考 [agent-monitor-web PR #183（Dashboard 全面重设计）](https://github.com/cct08311github/agent-monitor-web/pull/183)：

- **Minimap**：顶部一排圆点（16 个）呈现全局状态，running 脉冲；0.3 秒掌握全局。
- **Focus 区**：只放 active/需要动作的对象，大卡片、视觉主导；idle 压到 periphery 表格行。
- **三层灰阶**：canvas → card → elevated；**语义色**只表达状态（绿/红/橙）。
- **Light theme**：不是纯白刺眼，而是暖灰象牙底 + 可见边框；浅色下背景与卡片要有明度差。

对 Superbot 的落点：首屏 = KPI 带 + 「需你决定」Focus 区 + 活跃线程；项目列表/历史走 periphery 表格；颜色只用于状态与主按钮。

### 3.2 Calm corporate / token-only / no shadows / status not by color alone

参考 [AutoBot Design System（refined-ui intro）](https://github.com/mrveiss/autobot-ai/blob/d6899a3cb30c2b573c069f7cfe65ce88fc03a30c/docs/design/mockups/refined-ui/screens/DesignSystem.dc.html) 与其 [tokens.css](https://raw.githubusercontent.com/mrveiss/autobot-ai/main/docs/design/mockups/refined-ui/tokens.css)（另见 [CSS Design System issue #704](https://github.com/mrveiss/AutoBot-AI/issues/704)、[density/token 收敛 issue #18239](https://github.com/mrveiss/AutoBot-AI/issues/18239)）：

- **Calm and corporate**：安静的中性表面 + **一个 accent** + 慷慨间距；数据和决策突出，chrome 退后。
- **Token-only colour**：组件里出现字面 hex 就是 bug（换主题会破）。
- **No shadows**：层级靠 `--bw`（1px，高对比 2px）边框和 surface 阶梯；**不用 box-shadow/渐变/发光**。
- **Status never by colour alone**：每个状态带词，重要状态加图形（✓ ! ✕）；图表用描边标记 + 直接标签。
- **Density**：表格/表单的高度、行高、字号都是 token（row 44 / compact 32、field 32/36/44、label 13、help 12.5）。
- **Focus**：永远可见的 outline（3px），不能只用颜色表达。

对 Superbot 的落点：`sb-*` 只允许 `var(--dsw-*)`；状态徽章 = 词 + 图形 + 语义色；密度按「老板控制台」取 44/32 两档；焦点环统一。

### 3.3 Linear 式 elevation 阶梯与单一 accent

参考 [Linear DESIGN.md（getdesign.md 路由）](https://getdesign.md/linear.app/design-md)，本地缓存版本（`~/.agents/skills/design-md-ui/assets/cache/linear.app/DESIGN.md`）与 [Elevation 表镜像](https://design.hagicode.com/en-US/designs/linear.app/)：

- 层级用「背景亮度阶梯 + 半透明 1px 边框 + 多层阴影」表达，而不是深色阴影；**深色下阴影几乎不可见，靠 luminance 分层**。
- 边框是「月光下的线框」：`rgba(255,255,255,0.05–0.08)`，克制。
- **单一 accent**（Linear 紫）只用于 CTA/active/交互；其余全灰阶。
- 排版有明确层级与 weight 体系（400 阅读 / 510 强调 / 590 强强调），标题大字号负字距、正文正常。
- 卡片：半透明浅白背景 + 边框 + 8–12px 圆角；**不要卡片套卡片**。

对 Superbot 的落点：DSH 的 `--dsw-elevation-stroke` 就是「border-as-shadow」，`.5px 描边 + 3px/8px 软阴影」正好对应 Linear Level 2–4；我们只对 drawer/popover 用 elevation，其余用边框阶梯。

### 3.4 shadcn 的语义 token 成对约定

参考 [shadcn/ui Theming](https://ui.shadcn.com/docs/theming)：background/foreground、card/card-foreground、popover/popover-foreground、primary/primary-foreground、muted/muted-foreground、accent/accent-foreground、destructive、border、input、ring 成对出现，dark mode 只覆盖同一组 token。

对 Superbot 的落点：`--sb-*` 映射层保持「表面/前景成对」：`--sb-surface` ↔ `--sb-text`、`--sb-primary` ↔ `--sb-on-primary`；所有组件不直接写颜色，只引用 mapping 层。

### 3.5 CSS Grid 甘特（零依赖）

参考 [freeCodeCamp: How to Create a Simple Gantt Chart Using CSS Grid](https://www.freecodecamp.org/news/create-gantt-chart-using-css-grid/)：行是 grid、时间轴是 `repeat(N,1fr)`、任务条用 `grid-column: start/end` 跨列，纯 CSS 实现，无图表库。

对 Superbot 的落点：把 `ThreadMap` 从「绝对定位百分比 + 手算」改为 `sb-gantt` grid 行；数据只提供 `--sb-start/--sb-width` 两个 CSS 变量，视觉交给 class。

### 3.6 DSH 0.2.1-rc.5 已有 token：我们应当直接用

来源：`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`（0.2.1-rc.5，`base_css_default` 1407 / `design_platform_css_default` 1413 / `gradient_shadow_text_css_default` 1425；单行压缩字符串，行号指向定义处）。

#### 颜色 alias（浅色 / 深色）

| token | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--dsw-alias-bg-base` | #ffffff | #151517 | 画布 |
| `--dsw-alias-bg-layer-1` | #ffffff | #232324 | 卡片表面 |
| `--dsw-alias-bg-layer-2` | #ffffff | #2c2c2e | 次表面/输入/表头 |
| `--dsw-alias-bg-layer-3` | #ffffff | #353638 | 浮层/选中 |
| `--dsw-alias-border-l2` | rgb(0 0 0 / 10%) | rgb(255 255 255 / 12%) | 默认分隔线 |
| `--dsw-alias-border-l3` | rgb(0 0 0 / 12%) | rgb(255 255 255 / 16%) | 卡片/控件边框 |
| `--dsw-alias-border-l4` | rgb(0 0 0 / 16%) | rgb(255 255 255 / 20%) | 强边框/输入 |
| `--dsw-alias-label-primary` | #0f1115 | #f9fafb | 主文本 |
| `--dsw-alias-label-secondary` | #61666b | #cfd3d6 | 次文本 |
| `--dsw-alias-label-tertiary` | #81858c | #adb2b8 | 弱文本 |
| `--dsw-alias-label-caption` | #adb2b8 | #81858c | 更弱/占位 |
| `--dsw-alias-label-primary-inverted` | #ffffff | #353638 | 主按钮上的字 |
| `--dsw-alias-button-primary-fill` | #0f1115 | #f9fafb | 主按钮底（品牌黑白） |
| `--dsw-alias-button-primary-hover` | #43454a | #ebeef2 | 主按钮 hover |
| `--dsw-alias-state-business-primary` | #4176e6 | #7aaaff | 唯一 accent |
| `--dsw-alias-state-business-tertiary` | #e4edfd | #34415b | accent 弱底 |
| `--dsw-alias-state-success-primary` | #22c55e | #22c55e | 成功 |
| `--dsw-alias-state-success-tertiary` | #e6faed | #233c2c | 成功弱底 |
| `--dsw-alias-state-warn-primary` | #f59e0b | #f59e0b | 警告 |
| `--dsw-alias-state-warn-label` | #dd8629 | #dd8629 | 警告文字 |
| `--dsw-alias-state-warn-tertiary` | #fef5e7 | #27241f | 警告弱底 |
| `--dsw-alias-state-error-primary` | #ec1313 | #f25a5a | 错误 |
| `--dsw-alias-state-idle-primary` | #d4d4d4 | #545557 | 空闲 |
| `--dsw-alias-bg-mask-1` | #0000003d | #00000080 | 抽屉/模态遮罩 |
| `--dsw-alias-bg-skeleton` | #0000000a | #ffffff14 | skeleton |
| `--dsw-alias-interactive-bg-hover` | #2631480f | #ffffff14 | 行/控件 hover |
| `--dsw-alias-interactive-bg-active` | #2631481a | #ffffff24 | 按下/选中 |
| `--dsw-alias-toast-bg` / `toast-label` | #353638 / #fff | #43454a / #fff | toast |
| `--dsw-alias-label-error` | **未定义** | **未定义** | 不要用（当前 bug 来源） |

> 关键事实：**浅色模式下 layer-1/2/3 都是 #fff**；所以浅色层级必须靠 border 阶梯 + `--dsw-elevation-*`，不能指望背景明度差。深色模式才有真正的 #151517→#232324→#2c2c2e→#353638 阶梯。

#### 尺寸与类型 token

| 类别 | token | 值 |
|---|---|---|
| 圆角 | `--dsw-radius-xs/sm/md/lg/xl/panel` | 4 / 8 / 12 / 16 / 20 / 28 px |
| 字体 | `--dsw-font-family` | 系统 UI 字体栈（不新增字体文件） |
| 等宽 | `--ds-font-family-code` | SF Mono/JetBrains Mono/Consolas/Menlo 栈 |
| 类型 | `--dsw-font-xxxs-11` | 11/14 400（微标签） |
| | `--dsw-font-xxs-12` / `-strong-12` | 12/18 400 / 500（元数据、按钮） |
| | `--dsw-font-xs-13` / `-strong-13` | 13/20 400 / 500（正文小） |
| | `--dsw-font-s-14` / `-strong-14` | 14/22 400 / 500（正文/卡片标题） |
| | `--dsw-font-m-18` | 16/28 500（区块标题） |
| | `--dsw-font-l-20` | 20/28 500（页面标题/KPI） |
| | `--dsw-font-xl-24` | 24/32 600（大数字，可选） |
| 抬升 | `--dsw-elevation-stroke` | 0 0 0 .5px border（border-as-shadow） |
| | `--dsw-elevation-soft` | stroke + 0 4px 16px #00000008 + 0 0 24px #00000008（卡片 hover/轻浮层） |
| | `--dsw-elevation-panel` | stroke + 0 3px 8px #00000008 + 0 0 16px #00000005（菜单/卡片） |
| | `--dsw-elevation-prominent` | stroke + 0 3px 8px #0000000a + 0 0 20px #0000000d（抽屉/弹出层） |
| 焦点 | `--dsw-focus-ring-width` | 2px |
| 过渡 | `--ds-transition-duration` / `-fast` / `-slow` | .2s / .1s / .3s |
| 缓动 | `--ds-ease-in-out` | cubic-bezier(.4,0,.2,1) |

---

## 4. Superbot 视觉规范 v1：「Quiet Control Room」

### 4.0 设计原则（5 条，落地时每条都可判定）

1. **一个 accent**：business 蓝只出现在主按钮、active tab、焦点环、关键链接。其余一律灰阶。
2. **三层表面**：canvas（bg-base）→ surface（layer-1 + border-l2）→ raised（layer-2/layer-3 + elevation）。浅色靠边框+轻阴影，深色靠明度阶梯。
3. **状态=词+图形+色**：任何徽章都必须有文字 + glyph，颜色只是辅助；禁止仅靠圆点颜色。
4. **排版 5 级**：l-20 / m-18 / s-strong-14 / xxs-12 / xxxs-strong-11；数字一律 `tabular-nums`；不使用 10px 以下文字。
5. **克制动效**：只允许颜色 120ms、位移/抽屉 160ms、running 脉冲（1.6s）；`prefers-reduced-motion` 时全部关闭。

### 4.1 布局与信息架构

```
┌──────────────────────────────────────────────────────────────────┐
│ Topbar（sticky, 56px）                                           │
│  Superbot · 工程经理控制台        [● 系统正常]  [进入对话] [刷新] │
├──────────────────────────────────────────────────────────────────┤
│ KPI 带（4 格，grid，border-l2 分隔，高 64px）                     │
│  项目 2 │ 进行中 1 │ 待你决定 1 │ 本周完成 3                      │
├──────────────────────────────────────────────────────────────────┤
│ Focus 区（默认 tab=任务 时显示）                                 │
│  ┌───────────────────────────────┬───────────────────────────┐  │
│  │ 需你决定（大卡 2/3 宽）        │ 活跃线程（1/3 宽，紧凑行） │  │
│  └───────────────────────────────┴───────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│ Tabs（36px，active 2px accent 下划线，右侧视图工具栏）            │
├──────────────────────────────────────────────────────────────────┤
│ Tab 内容（按 §4.5 组件规格）                                      │
├──────────────────────────────────────────────────────────────────┤
│ Footer：账本目录/事件数（details 折叠，xs-12 text-3）             │
└──────────────────────────────────────────────────────────────────┘
```

- 页面：`max-width: 1160px`，`padding: 24px 28px 56px`，区块间距 24px（§4.4）。
- 侧栏：**只保留 1 个入口**「Superbot」（图标见 §4.7）；关闭第二个 `superbot-chat` 面板。
- 顶栏主操作只保留：「进入对话」primary（打开最近 Manager 会话；没有则新建）＋「刷新」ghost。删除重复的 ManagerMenu/对话段/「调度对话」按钮。
- tabs 顺序与默认值：
  1. `任务`（默认；含 Focus 区）
  2. `待你验收`（badge：attention 数；有值用 warn 徽章）
  3. `调度中`（badge：activeThreads 数）
  4. `地图`
  5. `历史`
  6. `项目`
  7. `高级`（结构化发单；如仍保留此命名，至少在 tab 上加「发单」副标签，避免核心功能被藏在「高级」）
- 响应（面板被分栏收窄）：1280+ 全宽；< 900px KPI 2×2、Gantt 标签列 140px；< 640px 卡片单列、抽屉全屏；所有 tab 可横向滚动，不允许换行把 topbar 挤爆。

### 4.2 颜色系统

#### 语义映射（`sb-*` → DSH token）

| 语义 | CSS 变量 | DSH token |
|---|---|---|
| 画布 | `--sb-canvas` | `--dsw-alias-bg-base` |
| 表面/卡片 | `--sb-surface` | `--dsw-alias-bg-layer-1` |
| 次表面/表头/输入 | `--sb-surface-2` | `--dsw-alias-bg-layer-2` |
| 浮层/选中 | `--sb-raised` | `--dsw-alias-bg-layer-3` |
| 分隔线 | `--sb-line` | `--dsw-alias-border-l2` |
| 卡片/控件边框 | `--sb-line-2` | `--dsw-alias-border-l3` |
| 强边框/输入 | `--sb-line-3` | `--dsw-alias-border-l4` |
| 主文本 | `--sb-text` | `--dsw-alias-label-primary` |
| 次文本 | `--sb-text-2` | `--dsw-alias-label-secondary` |
| 弱文本 | `--sb-text-3` | `--dsw-alias-label-tertiary` |
| 占位/更弱 | `--sb-text-4` | `--dsw-alias-label-caption` |
| 唯一 accent | `--sb-accent` | `--dsw-alias-state-business-primary` |
| accent 弱底 | `--sb-accent-bg` | `--dsw-alias-state-business-tertiary` |
| 主按钮 | `--sb-primary` / `--sb-on-primary` | `--dsw-alias-button-primary-fill` / `--dsw-alias-label-primary-inverted` |
| 主按钮 hover | `--sb-primary-hover` | `--dsw-alias-button-primary-hover` |
| 成功/弱底 | `--sb-ok` / `--sb-ok-bg` | `--dsw-alias-state-success-primary` / `--dsw-alias-state-success-tertiary` |
| 警告/文字/弱底 | `--sb-warn` / `--sb-warn-text` / `--sb-warn-bg` | `--dsw-alias-state-warn-primary` / `-label` / `--dsw-alias-state-warn-tertiary` |
| 错误/弱底 | `--sb-bad` / `--sb-bad-bg` | `--dsw-alias-state-error-primary` / `color-mix(12% 到 surface)` |
| 空闲 | `--sb-idle` / `--sb-idle-bg` | `--dsw-alias-state-idle-primary` / `--sb-surface-2` |
| 遮罩 | `--sb-mask` | `--dsw-alias-bg-mask-1` |
| hover/active | `--sb-hover` / `--sb-active` | `--dsw-alias-interactive-bg-hover` / `-active` |
| 抬升 | `--sb-elev-1/2` | `--dsw-elevation-soft` / `--dsw-elevation-prominent` |

#### Phase / 状态语义（唯一来源：`task-phase.js` 的 phase + client `PHASE_LANES`，实现时合并为一处）

| phase | 徽章文字 | glyph | 语义色 | 徽章底 | 用在 |
|---|---|---|---|---|---|
| needs-you | 需你决定 | ! | `--sb-warn` | `--sb-warn-bg` | 任务卡/Focus/地图 |
| stalled | 疑似卡住 | ⏱（SVG clock） | `--sb-bad` | `--sb-bad-bg` | 任务卡/地图 |
| rework | 返工 | ↻（SVG refresh） | `--sb-bad` | `--sb-bad-bg` | 任务卡/地图 |
| auditing | 审计中 | ◐/search | `--sb-accent` | `--sb-accent-bg` | 任务卡/地图 |
| executing | 执行中 | ▶（SVG play） | `--sb-accent` | `--sb-accent-bg` | 任务卡/地图 |
| queued | 待开始 | ○ | `--sb-idle` | `--sb-idle-bg` | 任务卡/地图 |
| done | 已完成 | ✓ | `--sb-ok` | `--sb-ok-bg` | 任务卡/地图 |
| canceled | 已取消 | ✕ | `--sb-text-3` | `--sb-surface-2` | 抽屉 |
| 未确认项目 | 未确认 | ? | `--sb-warn` | `--sb-warn-bg` | 项目行 |
| 已挂起/已归档 | 已挂起/已归档 | pause/box | `--sb-text-3` | `--sb-surface-2` | 项目行 |

规则：徽章文字一律 `--sb-text`（高对比），glyph 用语义色；**禁止**用语义色做正文颜色（警告文字 `--sb-warn-label` 在浅色底上对比不足，只用于 glyph/边框）。

#### 禁止项

- 禁止 `rgba(0,0,0,0.35)` 遮罩、`rgba(0,0,0,0.18)` 硬阴影（client.js:963-964）——用 `--sb-mask` / `--sb-elev-*`。
- 禁止 `#b42318` 这类硬编码 hex（client.js:113）与 `var(--dsw-alias-label-error)`（不存在）。
- 禁止同一语义同时用「色条 + 圆点 + 色块」三重编码。
- 禁止用 opacity 调状态强弱（client.js:1077 的 0.65/0.8/0.95），用语义色/表面层级表达。

### 4.3 字体与排版（只使用 DSH type token，不引入字体文件）

| 角色 | 值（DSH token） | 用途 |
|---|---|---|
| Page title | `font: var(--dsw-font-l-20)`（20/28 500） | 「Superbot」 |
| Section / Drawer title | `font: var(--dsw-font-m-18)`（16/28 500） | 区块标题、抽屉标题 |
| Card title | `font: var(--dsw-font-s-strong-14)`（14/22 500） | 任务卡标题 |
| Body / row | `font: var(--dsw-font-s-14)`（14/22 400） | 抽屉正文、代码块外正文 |
| Small / meta | `font: var(--dsw-font-xxs-12)`（12/18 400） | 元数据、表格、按钮 |
| Micro / badge | `font: var(--dsw-font-xxxs-strong-11)`（11/14 500） | 徽章、轴标签、脚注 |
| Mono | `font: 400 12px/18px var(--ds-font-family-code)` | ID、命令、账本路径 |
| 数字 | 任意层级 + `font-variant-numeric: tabular-nums` | KPI、进度、时长 |

规则：正文最小 12px，徽章最小 11px，禁止 10/10.5px；行高只允许 14/18/20/22/28；中文与数字混排用系统默认字距，标题可 `letter-spacing: -0.01em`（≤20px 也可用），正文不用负字距。

### 4.4 间距 / 圆角 / 边框 / 阴影 / 动效

| 类别 | 值 |
|---|---|
| 间距刻度 | 4 / 8 / 12 / 16 / 24 / 32 / 48（8px 网格；只允许这些值） |
| 页面 padding | 24px 28px 56px（窄屏 16px 14px 40px） |
| 区块间距 | 24px；卡片间距 12px；卡片内 padding 16px（任务卡 14/16） |
| 控件高度 | 按钮 28（sm 24）、输入 28、tab 36、KPI 64、表格行 44（紧凑 32）、抽屉行 22 |
| 圆角 | 控件 8（`--dsw-radius-sm`）、卡片 12（`md`）、抽屉 16（`lg`）、徽章 4（`xs`）、药丸 999 |
| 边框 | 1px `--sb-line`（分隔）、1px `--sb-line-2`（卡片/控件）、1px `--sb-line-3`（输入/强调） |
| 阴影 | 卡片 hover/菜单：`--dsw-elevation-soft` / `-panel`；抽屉：`--dsw-elevation-prominent`；其余**无阴影** |
| 动效 | 颜色 120ms / 抽屉 160ms / 脉冲 1.6s；`--ds-ease-in-out`；`prefers-reduced-motion: reduce` 全部关闭 |

### 4.5 组件规格

#### Topbar
- 高 56px，sticky，`background: var(--sb-canvas)`，`border-bottom: 1px solid var(--sb-line)`；上下 padding 12/0。
- 左侧：产品名 `l-20` + 副标题 `xxs-12 text-3`（「工程经理控制台」）；如保留系统状态，用 `● 系统正常`（accent dot + xxs-12 text-2）。
- 右侧：`进入对话` primary 按钮（28px）+ `刷新` ghost 按钮（28px）+ 「更新于 x 分钟前」`xxxs-11 text-4`。
- 禁止 sticky 区内出现折叠菜单/第二行对话段。

#### KPI 摘要带
- `display:grid; grid-template-columns:repeat(4,minmax(0,1fr))`；外框 `1px --sb-line`，圆角 12，背景 `--sb-surface`，`overflow:hidden`；每格 12×16，右分隔线；高 64px。
- 数字 `l-20 tabular-nums`；标签 `xxs-12 text-3`；「待你决定 > 0」数字用 `--sb-warn-text` + 数字前加 6px 圆点（warn），其余中性。
- 点击 KPI 直接切到对应 tab（可访问性：`role=button` + `aria-label`）。

#### Tabs
- 高 36px，`display:flex; gap:2px`，底边 1px `--sb-line`；tab 内 items：文字 + 可选 count 徽章（18px 高，`xxxs-strong-11`，圆角 999，底色 `--sb-surface-2`）。
- 默认 `xxs-strong-12 text-3`；hover `text-2` + `--sb-hover` 背景（圆角 8 8 0 0）；active `text` + `2px` bottom `--sb-accent` + `aria-selected=true`。
- 键盘：←/→ 移动、Home/End；tab 面板 `role=tabpanel` + `aria-labelledby`（当前只有 role=tab/aria-selected，无 panel 关联，client.js:1481-1500 可补）。
- 右侧工具区（仅项目 tab）：筛选 chips（28px）+ 排序 select（28px）+ 搜索（28px，宽 200）+ 清除 ghost。

#### 对话入口（唯一）
- 位置：Topbar 右侧 primary「进入对话」；无历史会话时文案「开始对话」。点击打开最近 Manager 会话；无则新建（workspaceId 取首个 inInventory 项目）。
- 删除 `1453-1478` 对话段、`Mock ManagerMenu`（858-877/1433-1441）与独立 chat 面板（1652-1713/1743-1767）；历史行保留「交给 Superbot 分析」次级按钮。

#### 任务卡（TaskCard → 新样式）
- 网格：`repeat(auto-fill, minmax(280px,1fr))`，gap 12。
- 卡片：`background:--sb-surface`、`border:1px solid --sb-line`、`border-radius:12`、padding 14 16、gap 8；左侧 3px 状态条（`::before`，颜色 `--sb-tone`）；hover `border-color:--sb-line-2` + `box-shadow:var(--sb-elev-1)`；focus-visible 2px accent outline。
- 内容顺序：徽章行（phase 徽章 + 项目名 + 高优先级徽章）→ 标题（`s-strong-14`）→ 一行原因（`xxs-12 text-3`，最多 2 行 line-clamp）→ 元数据行（证据 x/y、尝试次数、更新时间，`xxxs-11 text-4`）+ 右侧「打开线程 ›」ghost 链接。
- 不使用纯色圆点表达状态；phase 徽章见 §4.2。

#### Phase 徽章
- 尺寸：高 20px，padding 0 8，圆角 4，`xxxs-strong-11`；结构：glyph（12px SVG，语义色）+ 文字（`--sb-text`）；底色语义弱底（error 用 12% mix）。
- 不带边框（除非 neutral 状态，用 `1px --sb-line`）；禁止只用圆点/色块。

#### 时间线 / 线程地图（ThreadMap → `.sb-gantt`）
- 结构：外层卡片（border 12 圆角、背景 surface）；顶部 axis 行（高 28，5 等分直标：`7d/24h/30d` 切换在右侧）；每个项目一个 lane 标题行（高 32，`--sb-surface-2`）；每行高 32，左侧标签列 220px（窄屏 140px），右侧 track。
- 轴文字 `xxxs-11 text-3`；track 网格线用 `background-image: linear-gradient(...)` 25% 间隔；「现在」线 1px accent（40% 透明）+ 顶部 6px 圆点。
- 条：thread 高 8px 圆角 999；task 高 3px 圆角 2；颜色 `--sb-tone`（phase/状态映射），运行中 1.6s 脉冲（opacity 0.7↔1，reduced-motion 关闭）；条两端不加箭头/渐变。
- 标签文字 `xxs-12 text-2`，单行省略；点击 thread 条/标签打开会话；task 行点击选中并打开抽屉。
- 空态：`.sb-empty`（图标 + 「还没有可绘制的线程」+ 一句「派工后这里会出现时间条」）。

#### 侧拉抽屉（TaskDrawer → `.sb-drawer`）
- 遮罩 `--sb-mask`（深色 50% 黑 / 浅色 24% 黑，自动）；面板宽 `min(440px,92vw)`，全高，`background:--sb-surface`，`border-left:1px --sb-line-2`，`box-shadow:--sb-elev-2`；进入 160ms 位移+淡入。
- 头部：标题 `m-18` + 关闭 icon button（28×28，ghost，aria-label「关闭」），底部 1px 分隔线。身体 padding 16 20，overflow-y auto。
- 规格信息：两列 grid `96px 1fr`，行高 22，key `xxs-12 text-3`，value `xxs-12 text-2`；分组标题 `xxxs-strong-11 text-3` 大写、`letter-spacing:.06em`、上方间距 16。
- 操作区（sticky 底部，border-top）：primary「通过验收」（in_review 且允许 http human）或「在对话中继续」（ghost）+ 取消。按钮高 32。
- 行为：Esc 关闭、点击遮罩关闭、打开时锁定背景滚动、焦点移入并循环、关闭返回触发元素。

#### 历史列表（History → `.sb-history`）
- 卡片容器：border 12 圆角 surface；每行高 56，padding 12 16，`border-bottom:1px --sb-line`（最后一行无）；hover `--sb-hover`。
- 行内容：左 6px 状态点（phase/推断状态色）+ 标题 `xs-strong-13` + 项目名 `xxs-12 text-3` + 右侧时间 `xxxs-11 text-4` + 两个 ghost 按钮（打开会话 / 交给 Superbot）。
- 组头（项目）`xxxs-strong-11 text-3` 大写；空态用 `.sb-empty`。

#### 表格（项目 / 调度中 / 高级列表）
- `.sb-table`：外框 1px line、圆角 12、`border-collapse:separate`；表头高 36、`--sb-surface-2`、`xxxs-strong-11 text-3` 大写 `letter-spacing:.05em`；行高 44（紧凑 32）、`xxs-12 text-2`、底边 1px line；hover `--sb-hover`；数字列右对齐 + tabular-nums；首列文字用 `text`。
- 项目行：名称（`xxs-strong-12 text` + 未确认/挂起徽章）+ 状态徽章 + 进度条（高 4，圆角 999，`--sb-tone`）+ `done/total` 数字 + 线程数（活跃/总）+ 最近活动 + 展开按钮（SVG chevron，28px）。
- 窄屏：不隐藏列，改为两行卡片式行（primary 列 + meta 行），避免「列消失」的信息丢失（当前 860/680 直接 display:none，client.js:350-351）。

#### 空 / 加载 / 错误 / 成功
- 空：`.sb-empty` 图标（24px，text-3）+ 标题 `s-strong-14 text-2` + 一句 `xxs-12 text-3`（≤46ch）+ 可选动作；无虚线框噪音时用 `border:1px dashed --sb-line`。
- 加载：骨架块（`.sb-skeleton` 高 12/行宽 60–100%），仅首屏和 tab 首次加载；**禁止**「正在读取…」纯文字。
- 错误：`.sb-alert--error`（bad-bg + 左侧 2px `--sb-bad` + glyph ! + 文案 + 「重试」按钮），页面级错误放在 topbar 下方；**不要**再用 `--dsw-alias-label-error`。
- 成功：`.sb-toast`（toast-bg/toast-label，底部居中，2.5s 自动消失，`role=status`）；验收成功同时在抽屉内更新徽章为「已完成」。

#### 按钮 / 输入 / 徽章
- 按钮：高 28（sm 24），padding 0 10（sm 0 8），圆角 8，`xxs-strong-12`；primary=品牌黑白（`--sb-primary`/`--sb-on-primary`），secondary=透明+`--sb-line-3` 边框，ghost=无边框 hover 背景，danger=透明+`--sb-bad` 文字/边框；focus-visible 2px accent。
- 输入：高 28，padding 0 8，圆角 8，`1px --sb-line-3`，背景 `--sb-canvas`，`xxs-12`；placeholder `--sb-text-4`；focus 2px accent outline。
- 徽章：高 20/22，圆角 4，`xxxs-strong-11`，padding 0 7，见 §4.2。

### 4.6 深浅色与无障碍

- **浅色**：canvas=#fff，卡片=#fff + `1px --sb-line-2` + hover `--sb-elevation-soft`；禁止大面积纯白无边界；正文黑 #0f1115；次要 #61666b（对白底 ≥4.5:1）。
- **深色**：canvas=#151517，卡片=#232324，浮层/抽屉=#2c2c2e，hover=#353638；边框用白 12–20% 透明；阴影在深色几乎不可见，层级以**明度阶梯**表达（Linear 的 luminance stacking）。
- 焦点：全站统一 `outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px`；键盘可达：tabs 方向键、卡片 Enter/Space、抽屉 Esc/trap、列表行可聚焦。
- 对比：正文 ≥4.5:1、大字 ≥3:1、徽章文字始终用 `--sb-text`；状态不只靠颜色（字+glyph）。
- 动效：全部 120/160ms；`@media (prefers-reduced-motion: reduce)` 关闭 transition/animation。
- 触控/命中：按钮最小 28×28（sm 24 仅用于桌面紧凑区）；图标按钮 aria-label 必须齐全。

### 4.7 图标系统（内联 SVG，不新增字体）

- 统一 16×16 viewBox、`fill:none`、`stroke:currentColor`、`stroke-width:1.5`、`stroke-linecap/linejoin:round`；尺寸 14/16/20；`aria-hidden`，语义由按钮 `aria-label` 承担。
- 需要的最小集合（12 个）：`chevron-right`、`chevron-down`、`close`、`play`、`pause`、`check`、`alert`、`refresh`、`search`、`filter`、`external`、`clock`。
- 替换点：`▸/▾`（client.js:728）、`×`（967）、`◻/◉/◇`（1061）、`›`（918）、`details/summary` 的原生三角可保留（原生控件）。
- 参考实现（React.createElement，无 JSX）：

```js
const ICON_PATHS = {
  'chevron-right': 'M6 4l4 4-4 4',
  'chevron-down': 'M4 6l4 4 4-4',
  close: 'M4 4l8 8M12 4l-8 8',
  play: 'M5 3.5v9l7-4.5z',
  pause: 'M5 3.5v9M11 3.5v9',
  check: 'M3.5 8.5l3 3 6-7',
  alert: 'M8 3.5v5M8 11.5v.5',
  refresh: 'M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 2.5v2.8H9.7',
  search: 'M7 3.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM10 10l3 3',
  filter: 'M3 4h10L9 8.5V12l-2 1V8.5z',
  external: 'M9 3.5h3.5V7M12.5 3.5L7.5 8.5M6 5H4.5v6.5H11V10',
  clock: 'M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM8 5.5V8l2 1.5',
}
function Icon({ name, size = 16 }) {
  return h('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true', focusable: 'false',
  }, h('path', { d: ICON_PATHS[name] }))
}
```

---

## 5. 一次性注入 `<style>` 的 CSS 骨架

> 用法：把 `ensurePanelCss()`（client.js:335-354）的 `textContent` 替换为下面整段；在页面根节点加 `className: 'sb-root sb-page'`，后续组件把静态视觉从 inline 移到 `className`（只保留几何值，§6）。所有 token 均来自 DSH；不新增字体文件；`color-mix` 在 DSH 自身被大量使用，Electron/Chromium 安全。

```css
/* ===== Superbot · Quiet Control Room (sb-*) ===== */
.sb-root{
  --sb-canvas:var(--dsw-alias-bg-base);
  --sb-surface:var(--dsw-alias-bg-layer-1);
  --sb-surface-2:var(--dsw-alias-bg-layer-2);
  --sb-raised:var(--dsw-alias-bg-layer-3);
  --sb-line:var(--dsw-alias-border-l2);
  --sb-line-2:var(--dsw-alias-border-l3);
  --sb-line-3:var(--dsw-alias-border-l4);
  --sb-text:var(--dsw-alias-label-primary);
  --sb-text-2:var(--dsw-alias-label-secondary);
  --sb-text-3:var(--dsw-alias-label-tertiary);
  --sb-text-4:var(--dsw-alias-label-caption);
  --sb-accent:var(--dsw-alias-state-business-primary);
  --sb-accent-bg:var(--dsw-alias-state-business-tertiary);
  --sb-primary:var(--dsw-alias-button-primary-fill);
  --sb-primary-hover:var(--dsw-alias-button-primary-hover);
  --sb-on-primary:var(--dsw-alias-label-primary-inverted);
  --sb-hover:var(--dsw-alias-interactive-bg-hover);
  --sb-active:var(--dsw-alias-interactive-bg-active);
  --sb-mask:var(--dsw-alias-bg-mask-1);
  --sb-elev-1:var(--dsw-elevation-soft);
  --sb-elev-2:var(--dsw-elevation-prominent);
  --sb-ok:var(--dsw-alias-state-success-primary);
  --sb-ok-bg:var(--dsw-alias-state-success-tertiary);
  --sb-warn:var(--dsw-alias-state-warn-primary);
  --sb-warn-text:var(--dsw-alias-state-warn-label);
  --sb-warn-bg:var(--dsw-alias-state-warn-tertiary);
  --sb-bad:var(--dsw-alias-state-error-primary);
  --sb-bad-bg:color-mix(in srgb,var(--sb-bad) 12%,var(--sb-surface));
  --sb-idle:var(--dsw-alias-state-idle-primary);
  --sb-idle-bg:var(--sb-surface-2);
  --sb-r-xs:var(--dsw-radius-xs);
  --sb-r-sm:var(--dsw-radius-sm);
  --sb-r-md:var(--dsw-radius-md);
  --sb-r-lg:var(--dsw-radius-lg);
  --sb-font:var(--dsw-font-family);
  --sb-mono:var(--ds-font-family-code);
  --sb-ease:var(--ds-ease-in-out);
  --sb-fast:var(--ds-transition-duration-fast);
  --sb-base:var(--ds-transition-duration);
  --sb-focus:2px solid var(--dsw-alias-state-business-primary);
  --sb-num:tabular-nums;
  color:var(--sb-text);
  background:var(--sb-canvas);
  font:var(--dsw-font-s-14);
  -webkit-font-smoothing:antialiased;
}
.sb-root *{box-sizing:border-box}
.sb-root :focus-visible{outline:var(--sb-focus);outline-offset:2px;border-radius:var(--sb-r-xs)}
.sb-num{font-variant-numeric:tabular-nums}
.sb-mono{font-family:var(--sb-mono)}

/* 布局 */
.sb-shell{max-width:1160px;margin:0 auto;padding:24px 28px 56px}
.sb-section{margin-top:24px}
.sb-stack{display:flex;flex-direction:column;gap:12px}
.sb-row-between{display:flex;align-items:center;gap:8px}

/* Topbar */
.sb-topbar{position:sticky;top:0;z-index:20;background:var(--sb-canvas);border-bottom:1px solid var(--sb-line);padding:12px 0 0}
.sb-topbar__row{display:flex;align-items:center;gap:12px;min-height:32px}
.sb-title{font:var(--dsw-font-l-20);letter-spacing:-.01em;color:var(--sb-text);margin:0}
.sb-subtitle{font:var(--dsw-font-xxs-12);color:var(--sb-text-3)}
.sb-grow{flex:1 1 auto}
.sb-live{display:inline-flex;align-items:center;gap:6px;font:var(--dsw-font-xxs-12);color:var(--sb-text-2)}
.sb-live__dot{width:6px;height:6px;border-radius:50%;background:var(--sb-accent);box-shadow:0 0 0 3px var(--sb-accent-bg)}

/* KPI */
.sb-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:16px;border:1px solid var(--sb-line);border-radius:var(--sb-r-md);background:var(--sb-surface);overflow:hidden}
.sb-kpi{appearance:none;border:0;background:transparent;text-align:left;padding:12px 16px;border-right:1px solid var(--sb-line);cursor:pointer;display:flex;flex-direction:column;gap:2px;min-width:0}
.sb-kpi:last-child{border-right:0}
.sb-kpi:hover{background:var(--sb-hover)}
.sb-kpi__v{font:var(--dsw-font-l-20);font-variant-numeric:tabular-nums;color:var(--sb-text)}
.sb-kpi__l{font:var(--dsw-font-xxs-12);color:var(--sb-text-3)}
.sb-kpi--attention .sb-kpi__v{color:var(--sb-warn-text)}

/* Tabs */
.sb-tabs{display:flex;align-items:center;gap:2px;margin-top:16px;border-bottom:1px solid var(--sb-line);overflow-x:auto;scrollbar-width:none}
.sb-tabs::-webkit-scrollbar{display:none}
.sb-tab{height:36px;padding:0 12px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--sb-text-3);font:var(--dsw-font-xxs-strong-12);cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;border-radius:var(--sb-r-sm) var(--sb-r-sm) 0 0;transition:color var(--sb-fast) var(--sb-ease),background var(--sb-fast) var(--sb-ease)}
.sb-tab:hover{color:var(--sb-text-2);background:var(--sb-hover)}
.sb-tab[aria-selected="true"]{color:var(--sb-text);border-bottom-color:var(--sb-accent)}
.sb-tab__count{min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--sb-surface-2);color:var(--sb-text-2);font:var(--dsw-font-xxxs-strong-11);display:inline-flex;align-items:center;justify-content:center}

/* 标题 / 提示 */
.sb-h2{font:var(--dsw-font-m-18);color:var(--sb-text);margin:0}
.sb-hint{font:var(--dsw-font-xxs-12);color:var(--sb-text-3)}
.sb-label{font:var(--dsw-font-xxxs-strong-11);color:var(--sb-text-3);text-transform:uppercase;letter-spacing:.06em}

/* 卡片 / 任务卡 */
.sb-card{background:var(--sb-surface);border:1px solid var(--sb-line);border-radius:var(--sb-r-md);padding:16px}
.sb-grid-tasks{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-top:12px}
.sb-task{position:relative;display:flex;flex-direction:column;gap:8px;padding:14px 16px 14px 18px;background:var(--sb-surface);border:1px solid var(--sb-line);border-radius:var(--sb-r-md);cursor:pointer;transition:border-color var(--sb-fast) var(--sb-ease),box-shadow var(--sb-fast) var(--sb-ease)}
.sb-task::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:0 3px 3px 0;background:var(--sb-tone,var(--sb-idle))}
.sb-task:hover{border-color:var(--sb-line-2);box-shadow:var(--sb-elev-1)}
.sb-task[data-phase="needs-you"]{--sb-tone:var(--sb-warn)}
.sb-task[data-phase="stalled"],.sb-task[data-phase="rework"]{--sb-tone:var(--sb-bad)}
.sb-task[data-phase="auditing"],.sb-task[data-phase="executing"]{--sb-tone:var(--sb-accent)}
.sb-task[data-phase="done"]{--sb-tone:var(--sb-ok)}
.sb-task__head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.sb-task__title{font:var(--dsw-font-s-strong-14);color:var(--sb-text);margin:0;line-height:20px}
.sb-task__desc{font:var(--dsw-font-xxs-12);color:var(--sb-text-3);line-height:18px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sb-task__meta{display:flex;align-items:center;gap:4px 12px;flex-wrap:wrap;font:var(--dsw-font-xxxs-11);color:var(--sb-text-4)}
.sb-glyph{display:inline-block;width:12px;height:12px;flex:0 0 auto}

/* 徽章 */
.sb-badge{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:var(--sb-r-xs);font:var(--dsw-font-xxxs-strong-11);white-space:nowrap;background:var(--sb-bg,var(--sb-surface-2));color:var(--sb-text);border:1px solid transparent}
.sb-badge svg{color:var(--sb-tone,currentColor)}
.sb-badge--warn{--sb-bg:var(--sb-warn-bg);--sb-tone:var(--sb-warn)}
.sb-badge--bad{--sb-bg:var(--sb-bad-bg);--sb-tone:var(--sb-bad)}
.sb-badge--ok{--sb-bg:var(--sb-ok-bg);--sb-tone:var(--sb-ok)}
.sb-badge--accent{--sb-bg:var(--sb-accent-bg);--sb-tone:var(--sb-accent)}
.sb-badge--idle{--sb-bg:var(--sb-idle-bg);--sb-tone:var(--sb-text-3)}
.sb-badge--neutral{--sb-bg:transparent;--sb-tone:var(--sb-text-3);border-color:var(--sb-line)}

/* 按钮 */
.sb-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 10px;border-radius:var(--sb-r-sm);border:1px solid var(--sb-line-3);background:transparent;color:var(--sb-text);font:var(--dsw-font-xxs-strong-12);cursor:pointer;white-space:nowrap;transition:background var(--sb-fast) var(--sb-ease),border-color var(--sb-fast) var(--sb-ease),color var(--sb-fast) var(--sb-ease)}
.sb-btn:hover:not(:disabled){background:var(--sb-hover);border-color:var(--sb-line-2)}
.sb-btn:disabled{opacity:.45;cursor:not-allowed}
.sb-btn--primary{background:var(--sb-primary);border-color:var(--sb-primary);color:var(--sb-on-primary)}
.sb-btn--primary:hover:not(:disabled){background:var(--sb-primary-hover);border-color:var(--sb-primary-hover);color:var(--sb-on-primary)}
.sb-btn--ghost{border-color:transparent}
.sb-btn--ghost:hover:not(:disabled){background:var(--sb-hover);border-color:transparent}
.sb-btn--danger{color:var(--sb-bad);border-color:color-mix(in srgb,var(--sb-bad) 35%,var(--sb-line))}
.sb-btn--sm{height:24px;padding:0 8px}
.sb-btn--icon{width:28px;padding:0}

/* 输入 / 表单 */
.sb-input{height:28px;padding:0 8px;border-radius:var(--sb-r-sm);border:1px solid var(--sb-line-3);background:var(--sb-canvas);color:var(--sb-text);font:var(--dsw-font-xxs-12);min-width:0}
.sb-input::placeholder{color:var(--sb-text-4)}
.sb-input:focus-visible{outline:var(--sb-focus);outline-offset:1px}
.sb-textarea{min-height:64px;padding:8px;border-radius:var(--sb-r-sm);border:1px solid var(--sb-line-3);background:var(--sb-canvas);color:var(--sb-text);font:var(--dsw-font-xxs-12);resize:vertical;width:100%}
.sb-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.sb-field__label{font:var(--dsw-font-xxxs-strong-11);color:var(--sb-text-3)}
.sb-field__hint{font:var(--dsw-font-xxxs-11);color:var(--sb-text-4)}

/* 进度 */
.sb-progress{height:4px;border-radius:999px;background:var(--sb-surface-2);overflow:hidden;min-width:56px}
.sb-progress__fill{height:100%;border-radius:999px;background:var(--sb-tone,var(--sb-accent));transition:width var(--sb-base) var(--sb-ease)}

/* 表格 */
.sb-table{width:100%;border-collapse:separate;border-spacing:0;background:var(--sb-surface);border:1px solid var(--sb-line);border-radius:var(--sb-r-md);overflow:hidden}
.sb-table th{height:36px;padding:0 12px;background:var(--sb-surface-2);color:var(--sb-text-3);font:var(--dsw-font-xxxs-strong-11);letter-spacing:.05em;text-transform:uppercase;text-align:left;border-bottom:1px solid var(--sb-line);white-space:nowrap}
.sb-table td{height:44px;padding:0 12px;border-bottom:1px solid var(--sb-line);font:var(--dsw-font-xxs-12);color:var(--sb-text-2)}
.sb-table tbody tr:last-child td{border-bottom:0}
.sb-table tbody tr:hover{background:var(--sb-hover)}
.sb-table .sb-strong{color:var(--sb-text);font:var(--dsw-font-xxs-strong-12)}
.sb-table .sb-right{text-align:right}

/* 时间线 / 甘特 */
.sb-gantt{border:1px solid var(--sb-line);border-radius:var(--sb-r-md);background:var(--sb-surface);overflow:hidden}
.sb-gantt__head{display:grid;grid-template-columns:220px minmax(0,1fr);height:28px;align-items:center;border-bottom:1px solid var(--sb-line);font:var(--dsw-font-xxxs-11);color:var(--sb-text-4)}
.sb-gantt__axis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));height:100%;align-items:center}
.sb-gantt__axis span:first-child{text-align:left}
.sb-gantt__axis span{text-align:center}
.sb-gantt__axis span:last-child{text-align:right}
.sb-gantt__lane{display:flex;align-items:center;gap:6px;height:32px;padding:0 12px;background:var(--sb-surface-2);border-top:1px solid var(--sb-line);font:var(--dsw-font-xxs-strong-12);color:var(--sb-text-2)}
.sb-gantt__row{display:grid;grid-template-columns:220px minmax(0,1fr);height:32px;align-items:center;border-top:1px solid var(--sb-line)}
.sb-gantt__label{appearance:none;border:0;background:transparent;text-align:left;padding:0 12px;height:100%;font:var(--dsw-font-xxs-12);color:var(--sb-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.sb-gantt__label:hover{color:var(--sb-text)}
.sb-gantt__track{position:relative;height:100%;background-image:linear-gradient(to right,var(--sb-line) 1px,transparent 1px);background-size:25% 100%;background-position:0 0}
.sb-gantt__bar{position:absolute;top:50%;transform:translateY(-50%);left:var(--sb-start);width:var(--sb-width);min-width:6px;height:8px;border-radius:999px;background:var(--sb-tone,var(--sb-accent))}
.sb-gantt__bar--task{height:3px;border-radius:2px;opacity:.8}
.sb-gantt__now{position:absolute;top:0;bottom:0;left:var(--sb-now,100%);width:1px;background:var(--sb-accent);opacity:.5;pointer-events:none}
.sb-gantt__now::before{content:"";position:absolute;top:-3px;left:-2.5px;width:6px;height:6px;border-radius:50%;background:var(--sb-accent)}

/* 抽屉 */
.sb-drawer{position:fixed;inset:0;z-index:80;display:flex;justify-content:flex-end;background:var(--sb-mask)}
.sb-drawer__mask{position:absolute;inset:0}
.sb-drawer__panel{position:relative;width:min(440px,92vw);height:100%;display:flex;flex-direction:column;background:var(--sb-surface);border-left:1px solid var(--sb-line-2);box-shadow:var(--sb-elev-2);animation:sb-slide-in .16s var(--sb-ease)}
.sb-drawer__head{display:flex;align-items:flex-start;gap:8px;padding:18px 20px 12px;border-bottom:1px solid var(--sb-line)}
.sb-drawer__body{flex:1 1 auto;overflow-y:auto;padding:16px 20px}
.sb-drawer__footer{display:flex;align-items:center;gap:8px;padding:14px 20px;border-top:1px solid var(--sb-line);background:var(--sb-surface)}
.sb-drawer__section{margin-top:16px}
.sb-drawer__grid{display:grid;grid-template-columns:96px minmax(0,1fr);gap:6px 12px;margin-top:8px;font:var(--dsw-font-xxs-12)}
.sb-drawer__grid dt{color:var(--sb-text-3)}
.sb-drawer__grid dd{margin:0;color:var(--sb-text-2);min-width:0;overflow-wrap:anywhere}
@keyframes sb-slide-in{from{transform:translateX(16px);opacity:.6}to{transform:none;opacity:1}}

/* 历史列表 */
.sb-history{background:var(--sb-surface);border:1px solid var(--sb-line);border-radius:var(--sb-r-md);overflow:hidden}
.sb-history__row{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--sb-line);min-height:56px}
.sb-history__row:last-child{border-bottom:0}
.sb-history__row:hover{background:var(--sb-hover)}
.sb-history__title{font:var(--dsw-font-xs-strong-13);color:var(--sb-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-history__meta{font:var(--dsw-font-xxs-12);color:var(--sb-text-3)}

/* 空态 / 骨架 / 提示 */
.sb-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:40px 16px;text-align:center;border:1px dashed var(--sb-line);border-radius:var(--sb-r-md);background:var(--sb-surface)}
.sb-empty svg{color:var(--sb-text-3)}
.sb-empty__title{font:var(--dsw-font-s-strong-14);color:var(--sb-text-2)}
.sb-empty__hint{font:var(--dsw-font-xxs-12);color:var(--sb-text-3);max-width:46ch;line-height:18px}
.sb-skeleton{border-radius:var(--sb-r-sm);background:var(--dsw-alias-bg-skeleton);animation:sb-pulse 1.2s var(--sb-ease) infinite;height:12px}
@keyframes sb-pulse{50%{opacity:.55}}
.sb-alert{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:var(--sb-r-sm);border:1px solid var(--sb-line);background:var(--sb-surface-2);font:var(--dsw-font-xxs-12);color:var(--sb-text-2)}
.sb-alert--error{border-left:2px solid var(--sb-bad);background:var(--sb-bad-bg);color:var(--sb-text)}
.sb-alert--warn{border-left:2px solid var(--sb-warn);background:var(--sb-warn-bg);color:var(--sb-text)}
.sb-alert__icon{color:var(--sb-bad);flex:0 0 auto;margin-top:1px}
.sb-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:90;padding:8px 14px;border-radius:999px;background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);font:var(--dsw-font-xxs-strong-12);box-shadow:var(--sb-elev-2)}

/* 响应式 */
@media (max-width:900px){
  .sb-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
  .sb-kpi:nth-child(2n){border-right:0}
  .sb-kpi:nth-child(-n+2){border-bottom:1px solid var(--sb-line)}
  .sb-gantt__head,.sb-gantt__row{grid-template-columns:140px minmax(0,1fr)}
}
@media (max-width:640px){
  .sb-shell{padding:16px 14px 40px}
  .sb-topbar__row{flex-wrap:wrap}
  .sb-drawer__panel{width:100%;border-left:0}
}
@media (prefers-reduced-motion:reduce){
  .sb-root *{animation:none!important;transition:none!important}
}
```

### 5.1 接入方式

1. 把上面 CSS 放进 `ensurePanelCss()` 的 `style.textContent`（client.js:335-354），保留 `id='superbot-panel-css'` 的幂等注入。
2. 在面板最外层 div 加 `className: 'sb-root'`，页面内容区用 `className='sb-shell'`；删除页面内联 `color/fontSize/background`（client.js:1357-1359、1396）。
3. 所有基础组件（`Pill/Button/SectionHeading/Bar/Time/Meta/空态`）改成 className 版本：静态视觉全部进 CSS；`C` 对象只保留用于「把语义色写进 CSS 变量」的字符串（如 `style={{ '--sb-tone': C.warn }}`）。
4. 数据驱动几何继续用内联：进度宽度、甘特 `--sb-start/--sb-width`、表格列宽；这些不是设计值，允许 inline。
5. 旧样式删除：`TABLE/TH/TD` 常量（564-566）、各组件内重复的 `fontSize/color/borderRadius/padding`；保留 `className` 作为唯一视觉入口。

---

## 6. 从现状迁移的落地步骤（按优先级）

### P0（一次性做完，收益最大，约 1 个 PR）
1. **修错误色**：`C.errorText` 从 `var(--dsw-alias-label-error)` 改为 `var(--dsw-alias-state-error-primary)`（client.js:193）；设置页 fallback `#b42318` 改为 `var(--dsw-alias-state-error-primary)`（client.js:113）。验收：`grep -n "label-error\|#b42318"` 为空。
2. **注入 §5 CSS 骨架** 并给页面根加 `sb-root/sb-shell`；把 5 个基础组件换 className。
3. **合并入口**：删除第二个侧栏面板（1735-1742 中的 `superbot-chat`）、主面板内对话段（1453-1478）与 ManagerMenu 折叠区；只保留 Topbar「进入对话」+ 历史行内次级动作。
4. **首屏 Focus**：KPI 带 + 「需你决定」大卡区（复用 attention）+ 默认任务 tab 的 phase lane 排序把 needs-you 提到最前。

### P1（视觉品质的关键）
5. **抽屉重做**：`.sb-drawer` + Esc/focus trap/滚动锁 + SVG 关闭按钮。
6. **地图重做**：`.sb-gantt` grid 版，轴/网格/直标/空态；删除 Unicode 符号。
7. **状态徽章统一**：phase/status/项目状态共用 `.sb-badge`（词+glyph+语义色），删除卡片左色条之外的重复编码。
8. **历史/项目/调度表格统一** `.sb-table`；窄屏改两行卡片式行，不再 `display:none` 丢列（client.js:350-351）。
9. **空/加载/错误/成功**组件替换 `EmptyLine` 与裸红字；`sb-skeleton` 仅首屏使用。

### P2（打磨）
10. 设置页（SuperbotSettings, 31-116）换成 `.sb-field/.sb-input/.sb-btn`，错误/成功文案分离（读取失败≠保存失败）。
11. `高级` tab 改名/前移「发单」，ComposeCard（784-856）改成两列 Field（`.sb-field`），去掉 10 个 textarea 的视觉噪音（可折叠「更多约束」）。
12. 图标集替换 Unicode（728/967/1061/918）；`Bar` 默认色修复（419）。
13. 侧栏图标与品牌：一个入口一个 icon；PanelLabel 与 chat launcher 合并后清理未使用代码。
14. 密度开关（可选）：`.sb-root[data-density="compact"]` 把表格行 44→32、卡片 padding 16→12。

### 迁移映射（现有内联 → 类名示例）

| 现状 | 替换 |
|---|---|
| `style={{ fontSize:'13px', fontWeight:600 }}` 标题 | `.sb-h2`（m-18）或 `.sb-task__title`（s-strong-14） |
| `style={{ fontSize:'11px', color:C.text3 }}` | `.sb-task__meta` / `.sb-hint` |
| `style={{ height:'28px', border:'1px solid '+C.control, borderRadius:'6px' }}` 按钮 | `.sb-btn`（8px 圆角） |
| `h(Pill, { tone })` | `.sb-badge .sb-badge--{warn,bad,ok,accent,idle}` + `<Icon>` |
| `TD/TH/TABLE` | `.sb-table` |
| `Bar`（419） | `.sb-progress` + `.sb-progress__fill`，`--sb-tone` |
| 抽屉 `rgba`/`fixed`（963-964） | `.sb-drawer`/`__mask`/`__panel` |
| 地图绝对定位（992-1081） | `.sb-gantt`（grid，`--sb-start/--sb-width`） |
| `EmptyLine`（435-437） | `.sb-empty` |
| 错误 span（828/1443/1445/1448） | `.sb-alert .sb-alert--error` |

---

## 7. 选型结论：CSS / 图表库 / three.js

| 方案 | 依赖与体积 | 深浅色 | 可访问性 | 维护成本 | 结论 |
|---|---|---|---|---|---|
| **CSS + DSH token + 内联 SVG** | 0 依赖（约 1 个 style 块 + 类名重构） | 自动跟随 DSH token，零额外适配 | DOM 语义、键盘/读屏友好 | 低（一处 token 层） | ✅ **采用** |
| 图表库（ECharts/Recharts/visx 等） | +100–400KB，或需 CDN/构建 | 需把库主题再映射到 DSH，易漂移 | 图表 a11y 普遍弱 | 中高（多一套 API/版本） | ❌ 不需要：只有甘特/进度条 |
| Canvas 2D 自绘 | 0 依赖但代码量最大 | 需手写主题重绘 | 失去 DOM/可访问性 | 高 | ⏳ 仅当 >5k 行时再评估 |
| **three.js / WebGL** | >150KB，GPU/合成开销 | 需自己实现整套 UI 材质，和 token 体系脱节 | 文本/可访问性差 | 很高 | ❌ **拒绝**：数据是 2D 调度信息，没有 3D 语义；面板是嵌入 DSH Web 的 DOM 插槽，引入 WebGL 会带来渲染/焦点/性能风险，收益为负 |

结论：**纯 CSS + DSH token**；动画只在 hover/抽屉/脉冲用 CSS transition/keyframes；图标内联 SVG；甘特 CSS Grid。性能上，272 个内联 style 的内联对象创建本身也有开销，改为类名后 React 渲染的 style diff 大幅减少；无新增网络请求/字体/依赖，深浅色零成本。

---

## 8. 验收清单（可执行）

1. **Token 审计**：`grep -n "label-error\|#b42318\|rgba(0,0,0" packages/dsh-superbot/lib/client.js` → 应为空；对 `var(--dsw-*)` 做存在性校验（下面脚本）。
```bash
node --input-type=module -e '
import { readFileSync } from "node:fs"
const client = readFileSync("packages/dsh-superbot/lib/client.js","utf8")
const theme = readFileSync("/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js","utf8")
const used = [...new Set([...client.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map(m=>m[1]))]
const defined = new Set([...theme.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)].map(m=>m[1]))
const missing = used.filter(v=>!defined.has(v))
console.log({used:used.length, missing}); process.exit(missing.length?1:0)'
```
2. **视觉值收敛**：`grep -o "fontSize: '[0-9.]*px'" client.js` 中静态字号应为 0（只允许通过 CSS 类）；`borderRadius` 同理。
3. **深浅色截图**：1120px 与 720px 各截浅色/深色；检查 KPI 带、任务卡、抽屉、甘特、空态。
4. **对比度**：正文/次要文本/徽章文字用 DevTools 检查 ≥4.5:1；accent 只出现在允许位置。
5. **键盘**：Tab 顺序从 topbar→KPI→tabs→任务卡→抽屉；tabs ←/→ 可切换；抽屉 Esc 关闭、焦点回到触发按钮；卡片 Enter/Space 打开。
6. **动效**：DevTools 模拟 `prefers-reduced-motion: reduce`，确认无动画。
7. **窄屏**：面板宽 640px 时无横向溢出；表格改两行卡片；甘特标签列 140px。
8. **视觉回归**：Playwright（若可用）对 7 个 tab × 深浅色截图，作为后续修改基线。

---

## 9. 参考资料

- [agent-monitor-web PR #183 · Dashboard 全面重设计（Focus Layout + minimap + 三层灰阶 + 语义色）](https://github.com/cct08311github/agent-monitor-web/pull/183)
- [AutoBot Design System · Introduction（calm corporate / no shadows / token-only / status not by colour alone）](https://github.com/mrveiss/autobot-ai/blob/d6899a3cb30c2b573c069f7cfe65ce88fc03a30c/docs/design/mockups/refined-ui/screens/DesignSystem.dc.html)
- [AutoBot refined-ui tokens.css（具体 token 与密度/表格/表单尺寸）](https://raw.githubusercontent.com/mrveiss/autobot-ai/main/docs/design/mockups/refined-ui/tokens.css)
- [AutoBot CSS Design System issue #704（SSOT token 收敛）](https://github.com/mrveiss/AutoBot-AI/issues/704)、[density/token 收敛 issue #18239](https://github.com/mrveiss/AutoBot-AI/issues/18239)
- [Linear DESIGN.md（getdesign.md 路由；本地缓存 ~/.agents/skills/design-md-ui/assets/cache/linear.app/DESIGN.md）：elevation 阶梯 / 单一 accent / 排版层级](https://getdesign.md/linear.app/design-md)（另有镜像 [design.hagicode.com/linear](https://design.hagicode.com/en-US/designs/linear.app/)；Lead 提到的 `robase/flowlib pkg/ui/DESIGN.md` 在 2026-11-08 抓取时 404，已用上述 Linear DESIGN.md 替代）
- [shadcn/ui Theming（语义 token 成对 + CSS variables）](https://ui.shadcn.com/docs/theming)
- [freeCodeCamp: How to Create a Simple Gantt Chart Using CSS Grid](https://www.freecodecamp.org/news/create-gantt-chart-using-css-grid/)
- 本地 DSH 0.2.1-rc.5 token 定义：`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`（1407/1413/1425）

---

## 10. 审计限制

- 本报告基于 08 日 13:37 读取的 client.js（md5 a5e0e22…，1818 行）；交稿时并行修改已推进到 md5 9091a99…（1851 行，地图/时间线重写中，新增 lib/timeline.js）。§1 的全部统计已在 9091a99 上复核一致；§2 的行号仍以 a5e0e22 为准，最新版本中部分行号（尤其 §2.8 之后）会漂移——请用 §2 开头的 grep 锚点定位，这不影响结论与规范。
- 未运行浏览器自动化截图；视觉结论来自代码结构、内联值统计与 DSH token 的实际定义。P0 的「错误色 token 不存在」为**代码可判定**（token 定义缺失 + 使用点无 fallback 或 fallback 硬编码）。
- 提供的 CSS 是骨架级规范（覆盖核心组件），落地时需按实际 DOM 结构补少数状态类（如 `.sb-task--selected`、`.sb-gantt__bar--verifier`）。
