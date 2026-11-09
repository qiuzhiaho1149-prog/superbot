# Superbot 商店素材 v1

截图（1440×1000，深色/浅色）：
- `01-tasks-dark.png` / `04-tasks-light.png`：结果导向任务板（Focus KPI + 需你决定/返工/审计中/执行中/疑似卡住/已完成）。
- `02-map-dark.png` / `05-map-light.png`：线程地图（任务条 + worker/verifier 时间条，24h/7d/30d，点击开会话）。
- `03-history-dark.png`：历史工作（旧 DSH 线程摘要 + 勾选导入 + 交给 Superbot 分析）。

卖点（对应实现）：
1. 一个对话窗口调度所有项目/线程（Manager + worker/verifier 子会话 + 账本）。
2. 自动审计：worker 结束自动派 verifier、执行验收命令、写证据，policy 自动裁决/转人工。
3. 结果导向：需你决定/返工/审计中/执行中/卡住/已完成，任务详情有执行记录/审计证据/决定记录。
4. 历史接管：装到已用几个月的 DSH，只读扫描项目/线程摘要，可批量导入为历史工作项。
5. 安全默认：manager 无 shell、验收命令固定白名单、验收在一次性副本执行、人工验收走 approval（面板直连默认关）。

兼容：DSH CLI 0.2.1-rc.5 已实测；DSH core 0.2.2-rc.1 smoke PASS；桌面 App 安装流程待最终验证。
