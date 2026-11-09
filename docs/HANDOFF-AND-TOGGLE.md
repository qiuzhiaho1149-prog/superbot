# Superbot：开关、交接与上下文经济

本文回答三个问题：
1. Superbot 怎么**开/关**，关闭后如何回到正常模式；
2. 每个项目怎么有一份**完整 handoff**，关闭后别人/普通会话能接手；
3. 如何在**不降低工作质量**的前提下节省上下文。

## 1. 高度：开关是控制面开关，不是项目开关

| 状态 | 发生什么 |
|---|---|
| **ON** | Manager/worker/verifier 三个 preset + 面板 + 工具 + 账本投影存在。一个 Manager 会话调度所有项目。 |
| **OFF** | 从 profile 移除 bundle 并重启。插件代码不再加载：面板/工具/preset 消失；你的原有会话、项目文件、Git、终端完全回到正常 DSH。 |
| **数据** | 账本在 `$DSH_HOME/storages/dsh-superbot/`，**不在项目里**；关闭不删除、不迁移。项目里的 `SUPERBOT-HANDOFF.md` 是唯一有意留下的交接文件。 |

要点：
- 关闭**不会回滚** worker 已经改过的代码（那是正常 Git 工作，应由你 review/commit）。
- 关闭前必须确认没有活跃 worker/verifier；否则子会话可能在工具消失后失败。
- Superbot 自己的 Manager 会话是 preset 绑定的：关闭后这些会话保留但不能打开，重新开启即可继续；原有普通会话从未被改写。

### 关闭步骤（桌面 App）

```bash
# 1) 先完全退出 App
# 2) 用 App 自带 CLI 移除（会自动从 dependencies 和 bundles 移除）
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
DSH_HOME="$HOME/.dsh" "$CLI" plugin --profile desktop remove dsh-superbot
# 3) 重新打开 App：侧栏不再有 Superbot，正常模式
```

关闭前自检：
```bash
# 在 Superbot 面板确认 调度中/地图 没有活跃线程；或让 Manager 调 superbot_fleet_status
# 有活跃 run 时先 wait 或 cancel，再移除插件
```

### 重新开启

```bash
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
DSH_HOME="$HOME/.dsh" "$CLI" plugin --profile desktop add "$HOME/Downloads/dsh-superbot-1.0.0.tgz"
# 重开 App；账本原样恢复，Manager 先读各项目 handoff
```

## 2. 深度：每个项目一份 handoff（账本的事实投影）

### 文件

项目根：`SUPERBOT-HANDOFF.md`（默认；可用 `handoffFile` 改名，`projectHandoff=false` 可关）。

### 生成时机

- 用户确认首次接入盘点后：为每个确认项目生成基线；
- 任务创建/状态迁移/验收/评审/运行结束等事件后：自动刷新（400ms 防抖）；
- Manager 可随时调用 `superbot_project_handoff` 强制生成或只读预览；
- 文件只允许 Superbot 自己覆盖：如果同名文件不是 Superbot 生成的，会拒绝写入。

### 内容（有界，目标 <4.5KB）

```
# Superbot handoff — <项目>
Project / Updated / 计数
## Goal                 最新 requirement
## Needs your decision  in_review 任务（人类验收点）
## Rework               verifier fail 的任务
## Executing / Queued   进行中、待开始
## Machine acceptance commands（项目根执行，不可放宽）
## Constraints / non-goals
## How to continue without Superbot
```

**它不是聊天记录**：不写对话、不写 reasoning、不贴工具输出；只写任务 ID、验收命令、约束、下一步。账本仍为事实源，handoff 可安全删除并重新生成。

### 关闭后怎么接手

1. 普通 DSH 会话/人打开项目，先读 `SUPERBOT-HANDOFF.md`；
2. 按文件里的验收命令自己跑，worker 自报不算证据；
3. 继续用 Git 正常提交；需要 Superbot 时重新开启，Manager 读 handoff + 账本继续。

## 3. 广度：项目之间不互相污染

- 每个任务属于恰好一个项目；一个项目同时只允许一个写者 worker，跨项目并行受 `wipLimit`。
- 证据/评审按 taskId + attempt 隔离；不跨项目复用。
- handoff 只写自己的项目根；不会写到别的项目。
- 关闭插件时，所有项目同时回到普通模式；不存在“半接管”状态。

## 4. 上下文经济：省 token 但不降标准

| 角色 | 上下文 |
|---|---|
| Manager | 系统提示 + 当前用户消息；恢复项目用 `SUPERBOT-HANDOFF.md` / `superbot_project_overview`；不重放账本历史/聊天全文。 |
| Worker | 自包含 brief（任务/验收/命令/约束/依赖/风险）+ 项目 handoff 文件指针 + 必要文件引用；不拿 manager 会话。 |
| Verifier | 任务 + 报告/运行背景 + 账本验收命令；不拿角色文本、不拿 manager 闲聊。 |

三条纪律：
1. **事实进账本，上下文可丢**：会话轮换/压缩不影响任务状态；
2. **brief 自包含**：不依赖“上一轮说过什么”；
3. **按需读文件**：handoff/代码/命令都在项目里，不把全文塞进 prompt。

## 5. 验收清单（开关 + handoff）

- [ ] ON：面板三页可用；首次接入盘点由人确认；任务能派工。
- [ ] 每个已确认项目根出现 `SUPERBOT-HANDOFF.md`，内容与面板一致。
- [ ] 关闭前无活跃 run；移除 bundle 后重启，面板/preset 消失，原有会话正常。
- [ ] 关闭后 handoff/账本仍在；普通会话按 handoff 可继续。
- [ ] 重新开启后账本恢复、Manager 能读 handoff 继续未完成任务。
