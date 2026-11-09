# Superbot v1 · Release Candidate（2026-11-09）

## 交付内容
- DSH 插件：manager/worker/verifier 三 preset；任务/运行/证据/评审账本；派工/审核隔离/返工/取消/卡住检测；首次接入盘点；历史摘要+导入；结果导向任务板 + 线程甘特地图 + 因果时间线抽屉；自动审计驱动 + 自动 policy 裁决；历史多选导入；结构化发单（高级）。
- 文档：`docs/上架说明-v1.md`、`docs/INSTALL.md`、`docs/桌面安装步骤.md`、`docs/上架检查表.md`。
- 商店素材：`reports/store-v1/`（深/浅色任务板、地图、历史、真实模型会话）。
- 专家审计：`reports/expert-review-2026-11-07/`、`reports/expert-review-2026-11-09/`、`reports/project-review-2026-11-09/`。

## 验证（PASS）
- 测试：dsh-superbot 157 + task-engine 18 = **175 PASS**。
- 自动审计链：fake-host 集成测试（worker→verifier→policy done）PASS。
- 真实模型：Manager preset 成功调用 `superbot_fleet_status` 并账本汇报 PASS。
- 历史导入：旧 DSH 模拟环境 E2E（扫描→导入→task queued）PASS。
- 安装：全新 DSH_HOME CLI 0.2.1-rc.5 PASS；DSH core 0.2.2-rc.1 smoke PASS。
- 浏览器实测：面板 + 地图 + 抽屉 + 深浅色截图 PASS。

## 上架包（2026-11-09）
- `dist/v1.0.0/dsh-superbot-1.0.0.tgz`（自包含，内置 task-engine，无第三方依赖）+ `SHA256SUMS` + `INSTALL.md`。
- 干净 profile 从 tarball 安装实测：插件加载、三 preset registered、onboarding 扫描 2 项目/9 线程、面板 UI 渲染 PASS。
- 打包修复：把 task-engine vendor 进插件（否则 tarball 的 `../../task-engine` 相对导入会失效）；新增 vendored 一致性测试。

## 已知限制（上架文案需注明）
1. **桌面 App 安装流程 NOT RUN**：需用户授权改桌面 profile；手动步骤见 `docs/桌面安装步骤.md`。
2. 视觉系统 U2 迁移 PARTIAL：时间线/字号/圆角/关键卡片已落地，仍有内联样式与图标未完全收敛。
3. 真实模型全链路（含自动派工执行）未跑：真实验证到 Manager 工具读取层；worker/verifier 全链是 fake-host 集成证据。
4. 验收执行隔离为「宿主 shell + 一次性副本」；同用户读权限/网络未隔离（安全边界文档已注明）。
5. 桌面/窄屏/浅色只有有限截图验收。
