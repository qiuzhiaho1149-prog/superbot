## 专家修复记录（Lead，2026-11-07）

- P0-1 rework 断链：transitionTask 支持 clearOwner；task_rework requeue 时清 owner；新增回归：rework 后新 worker 可 claim。
- P0-3 fire-and-forget run 永 running：dispatch 对 wait=false 也挂 result observer，子会话结束后自动 finishRun（failed/succeeded）。
- P0-2 单写者：dispatcher.dispatch 内部增加项目活跃 writer 检查（task-bound worker），不再只靠 plan_dispatch。
- P1 phase：deriveTaskPhase 改为 attempt-scoped 最新 verifier 结论；active worker/verifier 优先于 rework；新增 test/task-phase.test.js 6 用例。
- overview ?projectId= 时 tasks 同步过滤。
- 测试：dsh-superbot 148 + task-engine 18 = 166 PASS。
