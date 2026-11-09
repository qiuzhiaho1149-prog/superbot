# Superbot 维护手册（上线后）

## 1. 上线后节奏

| 频率 | 动作 |
|---|---|
| 每天 | 看 GitHub Issues/PR：新 issue 24h 内 `needs-triage`；复现并分类 |
| 每周 | 发一次 release（有改动才发）；汇总"用户理解问题 vs 产品问题"；更新 FAQ |
| 每月 | 回顾指标：issue 关闭率、首次响应、回归数、安装失败率、活跃用户反馈；清理 stale |
| 每季度 | 兼容新 DSH 版本；评估 breaking change；roadmap 更新 |

## 2. Issue 分流：先判断是「理解问题」还是「产品问题」

```
新 issue
 ├─ 缺信息（版本/status/步骤） → needs-info（模板中的 checklist）
 ├─ 安装/兼容失败
 │   ├─ DSH 版本不在支持范围 → docs/install（引导升级/降级）
 │   ├─ 按 INSTALL 步骤可解决 → user-understanding（补 FAQ + 文档）
 │   └─ 按步骤仍失败 → product-bug (install)
 ├─ 期望与设计不一致
 │   ├─ 文档已说明（如 httpHumanActions 默认关） → user-understanding（引用文档，考虑改 UI 文案）
 │   └─ 文档未说明/反直觉 → product-bug (ux/docs)
 ├─ 能稳定复现的错误 → product-bug（附最小账本/截图）
 └─ 新需求 → enhancement（进 roadmap，不承诺时间）
```

标签：
`needs-triage` `needs-info` `user-understanding` `product-bug` `install` `panel` `dispatch` `audit` `docs` `enhancement` `good-first-issue` `duplicate` `wontfix`.

关键原则：**先证明"用户按文档操作仍失败"再开 bug**；纯使用问题也要回，但把答案写回文档/FAQ，减少重复。

## 3. 反馈监控命令

```bash
gh issue list --repo qiuzhiaho1149-prog/superbot --state open --limit 50
gh issue list --repo qiuzhiaho1149-prog/superbot --label needs-triage
gh pr list --repo qiuzhiaho1149-prog/superbot --state open
gh api repos/qiuzhiaho1149-prog/superbot/issues?state=all\&per_page=10 --jq '.[] | [.number,.title,.labels[].name] | @tsv'
```
（需要本机 `gh auth login`；也可用 GitHub 网页通知。）

## 4. 发布流程

1. `node --test` 两个包全绿；`npm pack --dry-run` 包含 `lib/task-engine.js`。
2. 版本号：bugfix `1.0.x`，feature `1.x.0`，breaking `2.0.0`。
3. `git tag vX.Y.Z` → push → GitHub Release 附 `dist/...tgz` + `SHA256SUMS`。
4. Release notes：新增/修复/已知限制/升级注意。
5. 如需跑桌面 App：按 `docs/桌面安装步骤.md`，需用户授权。

## 5. 100k stars 的现实路径

星标来自**分发 + 可信演示 + 持续维护**，不是刷量：

- **可发现**：README 首屏截图/一段 60s 演示；在 DSH 插件清单、awesome-agent 列表、HN/Reddit/X 发布；中文社区（即刻/V2EX/公众号）同步。
- **可信**：安全默认 + 真机证据 + 失败案例公开；至少 3 个真实项目案例（截图/账本导出）。
- **低门槛**：一键安装 tarball；首次接入 3 步内完成；FAQ 覆盖安装/权限/审计。
- **留存**：每两周一个可见改进（面板/审计/兼容），issue 24h 响应；good-first-issue 吸引贡献。
- **社区**：贡献指南、设计讨论、模板任务；不承诺未实现功能。

指标：周新增 star、issue 首次响应、安装成功反馈、真实使用案例数；每月复盘，不把 star 当唯一 KPI。
