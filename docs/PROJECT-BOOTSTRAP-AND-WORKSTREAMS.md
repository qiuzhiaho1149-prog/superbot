# 首次接入 / 新项目：项目地图、Harness、Handoff 与多 Session 规划

这篇说明 Superbot 在「刚接入、项目很多、一个目标要多个 session」时到底怎么从零规划，以及为什么不会乱派。

## 1. 首次接入的顺序（不直接开干）

```
只读盘点项目/线程
   → 用户确认 inventory
   → 每个项目自动生成 SUPERBOT-PROJECT.md（项目地图） + SUPERBOT-HANDOFF.md（交接）
   → Manager 读地图，评估 harness 缺口
   → 若缺口影响执行：先拆“小步基础任务”（补 test 命令/CI/handoff），再做大改
   → 目标 → 需求 → 规格 → 任务 DAG → 派工
```

- 盘点：只读，不创建任务、不改项目。
- 确认后：每个确认项目根生成两份**生成文件**（可删、可重新生成）：
  - `SUPERBOT-PROJECT.md`：技术栈、构建/测试命令、顶层结构、harness 现状与缺口；
  - `SUPERBOT-HANDOFF.md`：目标/进行中/待决策/返工/验收命令/约束/下一步。
- 这两个文件在插件关闭后仍然可读，普通 DSH 会话可据此接手。

## 2. 项目地图（SUPERBOT-PROJECT.md）是什么

只读扫描（不执行项目代码、不运行 git）：

- `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / `Makefile` / lockfile；
- scripts（test/lint/build/typecheck）、推断出的测试命令；
- 顶层目录/文件、是否 monorepo；
- harness 现状：`AGENTS.md`、`README.md`、`.cursor/rules`、`.github/workflows`、handoff；
- 缺口：没有可执行 test、没有 CI、没有 AGENTS、没有 handoff。

Manager 必须在**第一次在该项目规划实现任务前**调用 `superbot_project_profile`；项目地图是后续 spec/任务拆分的输入，不是装饰。

## 3. Harness 优化原则（不静默改项目规则）

- 自动生成的只有 `SUPERBOT-PROJECT.md` / `SUPERBOT-HANDOFF.md`；
- **不自动改写** `AGENTS.md`、CI、测试配置、package.json；这些属于项目规则，必须人类确认；
- 缺口可作为独立的“小步基础任务”派工（补 test 命令 / 补 CI / 补 handoff），验收命令必须真实可跑；
- 每个项目保持自己的边界、工具链和验收方式，不把 Superbot 的偏好强加给项目。

## 4. 一个目标 → 多个 session：用任务 DAG，不用“多开聊天”

Session 是执行资源，不是进度本体：

| 层 | 含义 |
|---|---|
| 目标 / requirement | 用户想达成什么（原话 + 改写后的 spec） |
| plan | 任务 DAG：依赖、并行、验收 |
| task | 一个自包含 session 合约：brief + 验收 + 证据要求 |
| session | 由 dispatch 新建的 worker/verifier 子会话，只拿 brief/handoff/文件引用 |

规则：
1. **一个 task = 一个 session**；不要在同一个 task 上并发多个 writer；
2. 高目标需要多个 session 时，拆成多个 task（recon / implement A / implement B / verify），用 `deps` 表达顺序；
3. 同一项目同时只允许一个写者；只读 recon/verifier 可以并行；
4. 跨项目并行受 `wipLimit`；一个 task 只能属于一个项目；
5. session 之间只通过任务报告、证据、handoff 交接，不共享聊天历史。

示例（一个“重构认证模块”目标）：

```
recon（只读：读地图/代码，产出方案）  ← 只读 session
  → impl-core（写）                ← 写者
  → impl-api（写，依赖 core）      ← 同项目串行
  → verify（verifier，独立 session）← 只读+受控执行
```

如果 recon 发现项目缺 test 命令，先插入 `harness-test` 小任务；不要在没有验收的情况下直接重构。

## 5. 上下文经济

- Manager：读 `SUPERBOT-PROJECT.md` + `SUPERBOT-HANDOFF.md` + `project_overview`，不回放聊天/账本历史；
- Worker：自包含 brief + 项目手交接文件指针 + 必要文件引用；
- Verifier：任务 + 报告背景 + 账本验收命令；
- 不新增第二套“记忆/向量库/哈希校验”；项目文件与账本就是事实源。

## 6. 验收清单（首次接入 / 多 session）

- [ ] 盘点只读，确认前不派工、不写项目（确认后只生成两个 `SUPERBOT-*` 文件）。
- [ ] 每个确认项目有 `SUPERBOT-PROJECT.md` 与 `SUPERBOT-HANDOFF.md`。
- [ ] 项目地图里的 test 命令可真实执行；缺失时先有 harness 任务。
- [ ] 一个目标拆成 DAG；每个 task 一个 session；同项目没有并发写者。
- [ ] 关闭 Superbot 后，普通会话能读这两个文件继续；重新开启后账本恢复。
