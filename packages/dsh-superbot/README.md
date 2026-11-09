# dsh-superbot

Superbot：DSH 的核心调度员工插件。一个 Manager 会话管理所有项目/线程，worker/verifier 通过账本汇报；自动审计、人工验收、结果面板、历史接管。

## 组成

- `lib/presets.js`：manager / worker / verifier 三个 preset。
- `lib/work-store.js`：append-only 账本 + 投影（任务/运行/证据/评审/盘点）。
- `lib/dispatch-tools.js`：派工、单写者、自动审计驱动、返工/取消。
- `lib/tools.js`：任务/验收/评审/盘点/fleet 工具。
- `lib/index.js`：HTTP 路由（config/status/overview/compose/onboarding/task/accept/reject/history）。
- `lib/client.js`：纯 `React.createElement` 面板（无构建）。
- `lib/timeline.js` / `task-phase.js` / `overview.js`：时间线、阶段与总览投影。
- `lib/task-engine.js`：vendored task-engine（打包自包含；源在 `../task-engine`）。

## 测试

```bash
node --test test/*.test.js
```

当前：149 条（v1.0.0 release candidate）。打包：`npm pack`。

## 安全默认

manager 无 shell/只读；verifier 只读+受控执行；验收命令固定白名单；一次性副本执行；人工验收默认走宿主 approval（`httpHumanActions=false`）。

## 文档

仓库根 `docs/`：上架说明、INSTALL、桌面安装步骤、审核隔离设计、维护手册。
