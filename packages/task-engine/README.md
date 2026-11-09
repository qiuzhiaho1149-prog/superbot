# @superlegacy/task-engine

P0 任务引擎骨架（零依赖）：契约、状态机、认领、waitpoint、确定性调度、5 行 handoff。

- `validateTaskSpec` / `createTask` / `transition`
- `claim`（乐观版本）/ `release`
- `createWaitpoint` / `resolveWaitpoint`
- `planDispatch`（依赖/WIP/项目互斥）
- `buildHandoff`

**规则**：高风险/审美类 `done` 只能 `actor === 'human'`；低风险且验证通过可由 `classifyAcceptance` + `acceptByPolicy` 自动 done（审计+可重开），agent 仍不能直接 human-done。状态：`draft / todo / in_progress / in_review / blocked / done / canceled`。

测试：`node --test test/*.test.js`（12/12 PASS）。
