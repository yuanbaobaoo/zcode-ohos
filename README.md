<div align="center">

<img src="public/logo/icons/1024x1024.png" alt="ZCode" width="120" />

# ZCode · HarmonyOS

**将 ZCode 源码级移植到 HarmonyOS PC**（aarch64 · `ai.ohpc.zcode` · OHOS Electron v40.1：Chromium 144 / Node 24.11.1）

[![OHOS HAP CI](https://github.com/yuanbaobaoo/zcode-ohos/actions/workflows/ohos-hap.yml/badge.svg)](https://github.com/yuanbaobaoo/zcode-ohos/actions/workflows/ohos-hap.yml)
[![Release](https://img.shields.io/github/v/release/yuanbaobaoo/zcode-ohos?style=flat-square)](https://github.com/yuanbaobaoo/zcode-ohos/releases)
[![Platform](https://img.shields.io/badge/platform-HarmonyOS%20PC%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square)](#环境准备)
[![License](https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square)](LICENSE)

桌面端功能跟随上游 · `apps/zcode-cli` 仅作为内置 Agent 运行时 · 适配不引入运行时补丁

[移植文档](specs/ohos-port/)

</div>

## 更新

- **2026-10-30**：合并上游 ZCode v3.17.1（Electron 44 线、Data Sync 设备配置同步、手机远控输入预测/事件推送、conversation telemetry、会话任务重启、Sites 面板、App 单测退役为 engineering 工程测试）。
- **2026-10-21**：合并上游 ZCode v3.16.2（Bash 直执行/输出隔离、Side Pane 完整视图、项目存储 0007 迁移、动态工作流并发、远程/Web 配对修复）。
- **2026-10-16**：合并上游 ZCode v3.16.1（Project-first 项目模型、R3 Source Server 远程、Relay V2、Office viewer、ToolSearch、存储迁移与架构治理）。
- 2026-10-10：合并上游 ZCode v3.15.1。
- 2026-9-23：基于上游 ZCode v3.14.3 开始源码级移植。

## 下载

| 内容 | 链接 |
| --- | --- |
| 最新未签名 HAP | [ZCode-latest-ohos-arm64-unsigned.hap](https://github.com/yuanbaobaoo/zcode-ohos/releases/latest/download/ZCode-latest-ohos-arm64-unsigned.hap) |
| 历史版本 / 校验文件 | [Releases](https://github.com/yuanbaobaoo/zcode-ohos/releases)（每次打 `v*` tag 由 CI 自动构建发布，附 sha256） |

> 未签名版需自行签名后安装（HarmonyOS debug Profile 绑定设备 UDID）；从源码构建可自动生成签名材料，见下方[打包](#打包-hap未签名开箱可构建)一节。

## 交付范围

| 交付面 | 状态 | 说明 |
| --- | --- | --- |
| HarmonyOS 桌面 HAP | 支持 | 本仓库构建、发布，并在鸿蒙 PC / 模拟器验收 |
| 内置 Agent CLI | 随 HAP 分发 | `apps/zcode-cli` 构建为 `zcode.cjs`，由桌面 Host / Agent 调用；不安装独立 `zcode` 命令 |
| 独立 CLI / TUI / SEA | 非目标 | 不移植独立命令行运行时，不发布 `zcode` 的 npm / SEA / Harmonybrew 包 |
| Web / Server | 非目标 | 源码随上游保留，不作为鸿蒙上的独立部署面 |

> 开发命令里的 `--agent` 指重建桌面内置 Agent bundle，不是发布或运行独立 zcode CLI。

## 快速开始

```bash
pnpm dev:ohos                # 开发：dev HAP 覆盖装机到所有已连接设备并启动（实测 ~30s）
pnpm bundle:desktop:ohos     # 打包：产出未签名 HAP（任何人都可直接构建）
```

## 环境准备

构建机：**macOS 或 Linux**（鸿蒙 PC 是部署目标，不是开发机）。

- 仓库标准工具链：Node.js **24.14.0** + pnpm **10.33.2**（以 [mise.toml](mise.toml) 为准），`pnpm install`；
- **OHOS command-line-tools**（hvigorw/ohpm/hdc，[华为开发者下载页](https://developer.huawei.com/consumer/cn/download/)，本仓库镜像见 [GitCode ohos-tools Release](https://gitcode.com/yuanbaobaoo/zcode-ohos/releases/ohos-tools)）——唯一额外必需，三选一让它可被发现：
  1. 设置 `OHOS_COMMAND_LINE_TOOLS_ROOT=<根目录>`，推荐写入仓库根 `.env`（模板见 [.env.example](.env.example)，真实环境变量优先）；
  2. 解压到 `~/command-line-tools`（自动发现）；
  3. 把其 `bin/` 加入终端 PATH。
- Electron v40 运行时（三件 `.so`、启动器与 resfile 资源）不入库，首次构建自动从 [GitCode ohos-tools Release](https://gitcode.com/yuanbaobaoo/zcode-ohos/releases/ohos-tools) 的 `electron-ohos-v40.0.1.20260928.2-release.zip` 下载并校验 sha256（`ZCODE_OHOS_ELECTRON_URL` 可换源，同样支持 `.env`）。

## 打包 HAP（未签名，开箱可构建）

```bash
pnpm bundle:desktop:ohos     # 等价 pnpm bundle:desktop -- --os ohos
```

- 产物：`packages/desktop/dist/ZCode-<version>-ohos-arm64-unsigned.hap`——无签名材料也能构建（`build-profile.json5` 缺失时自动从模板复制，hvigor 自动跳过签名）；
- 本机有 debug 签名材料时（AGC 申请后按 [`build-profile.template.json5`](packages/desktop/ohos/build-profile.template.json5) 注释填写），额外产出同名已签名版；
- 内部流程：desktop 生产构建（tsup/vite，node20 兼容）→ resfile 组装（含 io_uring 补丁，纯 Node）→ 清 hvigor 缓存 → `assembleHap` → 落标准 dist；
- 安装：`hdc install -r <hap>`；或推送 `v*` tag 由 CI 自动出包发 Release。

## 开发部署到鸿蒙 PC

前置：设备经 USB/网络连接（`hdc list targets` 可见）。

**默认全量覆盖**（确定性强，推荐日常使用）：无论目标设备上是否已安装、resfile 是否有变更，
一律用本次 dev 构建重新打 HAP 并 `hdc install -r` 覆盖 **所有** `hdc list targets` 可见的
设备，装完自动启动（实测 ~30s）。单台设备失败不阻断其余设备，最后汇总报错。

```bash
pnpm dev:ohos                    # 全量 HAP 覆盖所有设备（改了 ArkTS/.ets 时够用）
pnpm dev:ohos -- --build         # 改了 TS/React 源码 → 连 JS 生产构建（~60s 全闭环）
pnpm dev:ohos -- --build --agent # 连 Agent bundle（apps/zcode-cli）一起重建
pnpm dev:ohos -- --device <sn>   # 只部署到指定设备
pnpm dev:ohos -- --hqf --device <sn> # 增量热推（见下）
```

**增量热推**（可选，~8s）：`--hqf` 走 resfile hash 与设备基线比对，小变更
（≤200 文件 / ≤50MB、无删除）生成**签名 hqf 补丁**，`bm quickfix` 装入运行中的应用并
自动重启——无需重装整包。仅支持单设备（须 `--device` 指定）；无基线 / 应用已被卸载 /
有删除 / 变更超阈值时自动回退全量。

```bash
pnpm dev:ohos -- --hqf --device 127.0.0.1:5555   # 改了构建产物（out/）后的快速迭代
```

> 注意：`dev:ohos` 默认不重建 JS 产物（`out/`）与 Agent bundle
> （`bundled-agents/linux-arm64/glm/zcode.cjs`）——改了 `packages/*` 的 TS/React 必须
> 带 `--build`，改了 `apps/zcode-cli` 必须带 `--agent`，否则设备上跑的是旧代码，
> host 与 agent 的协议/配置格式错位会导致 agent 启动即崩（实测报
> "Bundled 与 Active ZCode Built-in Release 均不可用"）。

> UI / 业务开发与平台无关，照旧 `pnpm dev:desktop`（HMR）；只有适配层（main 进程 ohos 分支、终端中继、环境引导）需要上真机。

## 运行时观测

```bash
hdc fport tcp:9229 tcp:9229                                  # 转发调试端口 → chrome://inspect 全功能 DevTools
hdc shell "hilog -G 16M" && hdc shell "hilog -x -T Electron" # 应用日志（main+host）
```

## 深入阅读

| 主题 | 文档 |
| --- | --- |
| 移植入口：关键决策（为什么 Electron / 为什么 zsh+brew 可行）、问题速查 | [specs/ohos-port/README.md](specs/ohos-port/README.md) |
| 环境要求、构建/热推命令、常见坑 | [specs/ohos-port/01-构建与打包.md](specs/ohos-port/01-构建与打包.md) |
| 移植遇到的问题与解法（按适配点） | [specs/ohos-port/02-运行时架构与适配层.md](specs/ohos-port/02-运行时架构与适配层.md) |
| 平台事实清单：权限 / V8 ABI / 沙箱约束（改适配层前必读） | [specs/ohos-port/03-平台权限与系统约束.md](specs/ohos-port/03-平台权限与系统约束.md) |
