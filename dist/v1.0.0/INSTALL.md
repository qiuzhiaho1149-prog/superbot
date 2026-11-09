# Superbot v1.0.0 · 安装包

产物：`dsh-superbot-1.0.0.tgz`（自包含：已内置 task-engine，无第三方依赖）。

## 安装（CLI / core 0.2.1-rc.5 或 0.2.2-rc.1）
```bash
# 1) 目标 DSH profile（$DSH_HOME/profiles/<name>）里安装 tarball
cd "$DSH_HOME/profiles/web"
npm install /abs/path/dsh-superbot-1.0.0.tgz
# 2) profile package.json 的 dsh.profile.bundles 加入 "dsh-superbot"
# 3) 启动
DSH_HOME=$DSH_HOME dsh --profile web --no-open --port 0
```
自检：`/superbot/status` 应返回 `mode=preset-scoped`、manager/worker/verifier registered、runtime.shell=true。
首次接入会要求盘点确认；「历史」tab 可看旧 DSH 线程摘要并导入。

## 已验证
- 从本 tarball 在干净 profile 安装：插件加载、presets registered、onboarding 2 项目/9 线程、面板 UI 渲染 PASS。
- 测试 158 + 18 = 176 PASS。
- 桌面 App 安装流程未执行（需用户授权改桌面 profile）。
