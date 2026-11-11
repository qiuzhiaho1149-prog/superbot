# 安装 / 升级 / 排错（Superbot for DSH）

## 支持范围

| 环境 | 状态 |
|---|---|
| macOS 桌面 App（DeepSeek Harness 0.2.x） | ✅ 推荐，一键安装器 |
| DSH CLI 0.2.1-rc.5（web profile） | ✅ 已实测 |
| DSH core 0.2.2-rc.1 | ✅ 已实测 smoke |
| Windows / Linux 桌面 | ❌ 暂无安装器 |

插件包**自包含、零 npm 依赖**（task-engine 已内置）。安装器不运行 npm/pnpm，因此不会改动其他插件的依赖。

## 一、桌面 App 一键安装（大多数用户）

1. 完全退出 DeepSeek Harness（Cmd+Q）。
2. 终端执行：
   ```bash
   curl -fL -o /tmp/superbot-install.sh \
     "https://github.com/qiuzhiaho1149-prog/superbot/releases/download/v1.4.0/install-desktop.sh"
   sh /tmp/superbot-install.sh
   ```
3. 重新打开 App → 左侧「Superbot」→「首次接入盘点」→ 由你确认项目状态。

安装器做的事：下载 v1.4.0 tarball → SHA256 校验 → 备份 profile → 解压到 `~/.dsh/profiles/desktop/node_modules/dsh-superbot` → 写依赖与 `dsh.profile.bundles`。安装包保留在 `~/.dsh/storages/dsh-superbot/install/`，**不要删除**（profile 记录了这个路径）。

卸载：
```bash
sh /tmp/superbot-install.sh --uninstall
```
保留账本、项目里的 `SUPERBOT-HANDOFF.md` / `SUPERBOT-PROJECT.md`。

## 二、首次接入（已有 DSH 用户）

1. 面板「首次接入盘点」：只读扫描项目/线程，你确认「进行中/挂起/归档」。
2. 每个项目会生成 `SUPERBOT-PROJECT.md`（项目地图）和 `SUPERBOT-HANDOFF.md`（交接）。
3. 「历史」tab：旧线程摘要；可勾选导入，或逐条「交给 Superbot 分析」。
4. 「进入 Superbot 对话」：一个窗口开始派活/验收。

## 三、常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 提示找不到 `/Applications/DeepSeek Harness.app` | 未安装桌面 App，或装在别的路径；先安装 App 再重试 |
| 提示 `Quit DeepSeek Harness completely` | App 还在运行：Cmd+Q 完全退出，或菜单栏 Quit |
| 提示 `profile not found` | 先打开一次 App 再退出，让 App 创建 desktop profile |
| 安装阶段出现 `pnpm` / `ERR_PNPM` / `ELIFECYCLE` | 你在用旧安装方式；用上面的新脚本（它不跑 pnpm） |
| 启动后报 `Cannot find module '@deepseek-ai/...'` | 不是 Superbot 依赖；是 DSH App 版本不完整/过旧，升级 App 后重试 |
| 侧栏没有 Superbot | 确认安装脚本成功、完全退出后重开 App；仍无则把 `~/.dsh/profiles/desktop/package.json` 和 App 版本发给维护者（可脱敏） |
| 想回到普通模式 | 卸载脚本即可；账本与项目文件保留，原有会话/项目不受影响 |

## 四、CLI profile（高级）

没有桌面 App、或要在 server/headless 环境用：

1. 确认 CLI 版本：
   ```bash
   dsh --version   # 需要 0.2.1-rc.5 ~ 0.2.x
   echo "${DSH_HOME:-$HOME/.dsh}"
   ```
2. 下载并校验：
   ```bash
   curl -L -o /tmp/dsh-superbot-1.4.0.tgz \
     "https://github.com/qiuzhiaho1149-prog/superbot/releases/download/v1.4.0/dsh-superbot-1.4.0.tgz"
   curl -L -o /tmp/SHA256SUMS \
     "https://github.com/qiuzhiaho1149-prog/superbot/releases/download/v1.4.0/SHA256SUMS"
   cd /tmp && shasum -a 256 -c SHA256SUMS
   ```
3. 解压到 web profile（不跑包管理器）：
   ```bash
   PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/web"
   mkdir -p "$PROFILE/node_modules/dsh-superbot"
   tar -xzf /tmp/dsh-superbot-1.4.0.tgz -C "$PROFILE/node_modules/dsh-superbot" --strip-components=1
   ```
4. 写依赖与 bundle（可用系统 Node 或 Python；下面用 Node）：
   ```bash
   node - "$PROFILE/package.json" /tmp/dsh-superbot-1.4.0.tgz <<'NODE'
   const fs=require('fs');const [file,tgz]=process.argv.slice(2);
   const p=JSON.parse(fs.readFileSync(file,'utf8'));
   p.dependencies??={};p.dependencies['dsh-superbot']='file:'+tgz;
   p.dsh??={};p.dsh.profile??={};p.dsh.profile.bundles??=[];
   if(!p.dsh.profile.bundles.includes('dsh-superbot'))p.dsh.profile.bundles.push('dsh-superbot');
   fs.writeFileSync(file,JSON.stringify(p,null,2)+'\n');
   NODE
   ```
5. 启动：
   ```bash
   dsh --profile web --no-open --port 0
   ```
   打开日志里的 URL → 侧栏 Superbot。

## 五、配置（`$DSH_HOME/storages/dsh-superbot/config.json`）

| 键 | 默认 | 说明 |
|---|---|---|
| requireOnboarding | true | 未确认盘点前禁止派工 |
| httpHumanActions | false | 面板直连验收/退回/盘点；默认关，走宿主 approval |
| autoAudit | true | worker 结束自动 verifier + policy 裁决 |
| requireSandboxedEvidence | true | 非宿主 shell/非副本/非沙箱证据禁止自动验收 |
| acceptanceIsolation | copy | 验收在一次性副本执行 |
| wipLimit | 2 | 跨项目并行上限 |
| projectHandoff | true | 每个项目生成 `SUPERBOT-HANDOFF.md` |
| handoffFile | SUPERBOT-HANDOFF.md | 交接文件名 |

## 六、升级

重新运行最新 `install-desktop.sh` 即可；脚本会覆盖旧版插件并保留账本。卸载旧版不是必须的。

## 七、已知限制

- 桌面 App 重启后的 UI 未在本机执行最终验收（安装/加载层已实测）；失败可用 `--uninstall` 回滚。
- Windows/Linux 桌面暂无安装器。
- 视觉系统仍有少量内联样式未完全收敛，不影响功能。
