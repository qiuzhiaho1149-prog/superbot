# 安装 / 升级 / 自检（Superbot for DSH）

## 支持范围
- DSH CLI **0.2.1-rc.5**：已实测（隔离 profile + 真机闭环）。
- DSH core **0.2.2-rc.1**：已实测 smoke（preset 注册、status、onboarding、overview、面板）。
- 桌面 App（0.2.2-rc.1）：自带 CLI 安装到 `desktop` profile 已验证到插件加载层；App 重启后的 UI 验收未在本机执行。桌面安装见 `docs/桌面安装步骤.md`。

## 一键安装（推荐）

1. 确认 DSH Home 与 profile：
```bash
echo "${DSH_HOME:-$HOME/.dsh}"
dsh --version
```
2. 下载并校验：
```bash
curl -L -o /tmp/dsh-superbot-1.3.0.tgz \
  https://github.com/qiuzhiaho1149-prog/superbot/releases/download/v1.3.0/dsh-superbot-1.3.0.tgz
shasum -a 256 /tmp/dsh-superbot-1.3.0.tgz
# 应为 dsh-superbot-1.3.0.tgz 的 SHA256（见 release 的 SHA256SUMS）
```
3. 安装到 profile 并登记 bundle：
```bash
dsh plugin --profile web add /tmp/dsh-superbot-1.3.0.tgz
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/web/package.json"
cp "$PROFILE" "$PROFILE.bak"
node - "$PROFILE" <<'NODE'
const fs=require('fs'); const file=process.argv[2];
const p=JSON.parse(fs.readFileSync(file,'utf8'));
p.dsh ??= {}; p.dsh.profile ??= {}; p.dsh.profile.bundles ??= [];
if (!p.dsh.profile.bundles.includes('dsh-superbot')) p.dsh.profile.bundles.push('dsh-superbot');
fs.writeFileSync(file, JSON.stringify(p,null,2)+'\n');
NODE
```
4. 重启 DSH：
```bash
dsh --profile web --no-open --port 0
```
打开输出的 URL → 侧栏「Superbot」→ 首次接入盘点。

## 首次接入（已有 DSH 用户）
1. 面板「首次接入盘点」：只读扫描项目/线程，确认「进行中/挂起/归档」。
2. 「历史」tab：旧线程摘要；可勾选导入或交给 Superbot 分析。
3. 「进入 Superbot 对话」开始派活。

## 关键配置（`$DSH_HOME/storages/dsh-superbot/config.json`）
| 键 | 默认 | 说明 |
|---|---|---|
| requireOnboarding | true | 未确认盘点前禁止派工 |
| httpHumanActions | false | 面板直连验收/退回/盘点；默认关，走宿主 approval |
| autoAudit | true | worker 结束自动 verifier + policy 裁决 |
| requireSandboxedEvidence | true | 非宿主 shell/非副本/非沙箱证据禁止自动验收 |
| acceptanceIsolation | copy | 验收在一次性副本执行 |
| wipLimit | 2 | 跨项目并行上限 |

## 自检
```bash
BASE=http://127.0.0.1:<port>   # 启动日志里的地址
curl -s -b cookies "$BASE/superbot/status" | jq '.mode,.policy,.runtime'
# 期望：preset-scoped；requireSandboxedEvidence=true/autoAudit=true；shell=true/sandboxPolicy=true
```
面板：任务/地图/历史/验收可打开；地图轴与条对齐；抽屉有三段因果记录；确认盘点前派工应被拒绝。

## 升级
- 重新下载新 tarball → 重复第 3 步（`dsh plugin add` 会更新依赖）→ 重启。
- 账本 append-only；投影可 `superbot_work_rebuild` 重建。
- 事件日志长期使用建议归档 `storages/dsh-superbot/work/events.jsonl`（先停实例）。

## 已知限制
- 桌面 App 安装流程 NOT RUN；核心兼容已验证。
- 视觉系统仍有少量内联样式未完全收敛，不影响功能。
