# 安装 / 升级 / 自检（Superbot for DSH）

## 支持范围
- DSH CLI **0.2.1-rc.5**：已实测（隔离 profile + 真机闭环）。
- 桌面端 DSH App **0.2.2-rc.x**：尚未验证（engines 不匹配，见根 README「已知限制」）。

## 安装（CLI profile）
```bash
# 1) 任务引擎（同仓库包）+ 插件
cd packages/task-engine && npm pack            # 或直接 link
cd packages/dsh-superbot && npm pack
# 2) 在目标 DSH_HOME 的 profile 里 link 插件
#    profile 目录：$DSH_HOME/profiles/<name>/package.json
#    dependencies 增加："dsh-superbot": "link:/path/to/packages/dsh-superbot"
#    dsh.profile.bundles 增加："dsh-superbot"
# 3) 启动
DSH_HOME=/path/to/home dsh --profile web --no-open --port 0
```

## 首次接入（已有 DSH 用户）
1. 打开面板「Superbot」→ 顶部「首次接入盘点」卡：查看扫描到的项目/线程（只读，不改历史 session）。
2. 确认「进行中 / 挂起 / 归档」→ 之后才会允许派工（`requireOnboarding` 默认 true）。
3. 「历史」tab：看旧线程意图摘要，可勾选「导入为历史工作项」或逐条「交给 Superbot 分析」。
4. 点「进入 Superbot 对话」开始派活；worker/verifier 子线程会自动出现在「调度中/地图」。

## 关键配置（`$DSH_HOME/storages/dsh-superbot/config.json`）
| 键 | 默认 | 说明 |
|---|---|---|
| requireOnboarding | true | 未确认盘点前禁止派工 |
| httpHumanActions | false | 面板直连人工验收/退回/盘点确认；默认关闭，走 approval 弹窗 |
| autoAudit | true | worker 结束自动派 verifier 并尝试 policy 裁决 |
| requireSandboxedEvidence | true | 非宿主 shell/非副本/非沙箱证据禁止自动验收 |
| acceptanceIsolation | copy | 验收在一次性工作树副本执行 |
| wipLimit | 2 | 跨项目并行上限 |

## 自检清单
```bash
curl -s -b cookies "$BASE/superbot/status" | jq '.policy,.runtime,.mode'
# 期望：httpHumanActions=false, requireSandboxedEvidence=true, autoAudit=true,
#       runtime.shell=true, sandboxPolicy=true
node --test packages/task-engine/test/*.test.js
node --test packages/dsh-superbot/test/*.test.js
```
- 面板：任务/地图/历史/验收各 tab 可打开；地图轴与条对齐；抽屉有三段因果记录。
- 首次接入：确认前派工应被拒绝（`首次接入尚未确认盘点`）。

## 升级
- 覆盖插件目录后重启 DSH；账本 append-only，投影可 `superbot_work_rebuild` 重建。
- 事件日志不自动压缩：长期使用建议定期归档 `storages/dsh-superbot/work/events.jsonl`（先停实例）。

## 安装自检记录（2026-11-09）
- 全新 `DSH_HOME`（复制自隔离环境、删除 Superbot 账本）启动：mode=preset-scoped；
  policy={httpHumanActions:false, requireSandboxedEvidence:true, requireOnboarding:true, acceptanceIsolation:copy}；
  runtime={shell:true, sandboxPolicy:true}；onboarding.confirmed=false；扫描 2 项目/9 线程。
- 证据：`reports/install-history-test-2026-11-08/evidence/fresh-status.json` / `fresh-onboarding.json`。
- 桌面端 DSH App 0.2.2-rc.x：**NOT RUN**（engines 限制，待单独验证）。

## 端到端自检（2026-11-09）
- 自动审计链（fake host 集成测试）：worker 结束 → 自动 verifier → 执行验收命令/提交 pass → 自动 policy done。
- 历史导入（旧 DSH 模拟）：onboarding 扫描 → `/superbot/history/import` → 账本新增任务（queued）。
- 版本：CLI 0.2.1-rc.5 PASS；桌面 App 0.2.2-rc.1 NOT RUN（engines `>=0.2.1-rc.5 <0.2.2-0`）。
