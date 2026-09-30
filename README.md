<div align="center">

<img src="public/logo/icons/1024x1024.png" alt="ZCode" width="120" />

# ZCode · HarmonyOS

**将 ZCode 源码级移植到 HarmonyOS PC**（aarch64 · `ai.ohpc.zcode` · OHOS Electron：Chromium 132 / Node 20.18.1）

[![OHOS HAP CI](https://github.com/yuanbaobaoo/ZCode-ohos/actions/workflows/ohos-hap.yml/badge.svg)](https://github.com/yuanbaobaoo/ZCode-ohos/actions/workflows/ohos-hap.yml)
[![Release](https://img.shields.io/github/v/release/yuanbaobaoo/ZCode-ohos?style=flat-square)](https://github.com/yuanbaobaoo/ZCode-ohos/releases)
[![Platform](https://img.shields.io/badge/platform-HarmonyOS%20PC%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square)](#环境准备)
[![License](https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square)](LICENSE)

上游桌面 / Web / CLI 功能保持一致 · 适配不引入运行时补丁

[完整说明](README.zh.md) · [移植文档](specs/ohos-port/) · [English](README.en.md)

</div>

## ⬇️ 下载

|                        |                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 📱 **最新未签名 HAP**  | [**ZCode-latest-ohos-arm64-unsigned.hap**](https://github.com/yuanbaobaoo/ZCode-ohos/releases/latest/download/ZCode-latest-ohos-arm64-unsigned.hap) |
| 🗂 历史版本 / 校验文件 | [Releases](https://github.com/yuanbaobaoo/ZCode-ohos/releases)（每次打 `v*` tag 由 CI 自动构建发布，附 sha256）                                     |

> 未签名版需自行签名后安装（HarmonyOS debug Profile 绑定设备 UDID）；从源码构建可自动生成签名材料，见下方 [📦 打包](#-打包-hap未签名开箱可构建)。

## 🚀 快速开始

```bash
pnpm dev:ohos                # 开发：热更到鸿蒙 PC（实测 ~8s 生效，含应用自动重启）
pnpm bundle:desktop:ohos     # 打包：产出未签名 HAP（任何人都可直接构建）
```

## 🧰 环境准备

构建机：**macOS 或 Linux**（鸿蒙 PC 是部署目标，不是开发机）。

- 仓库标准工具链：Node.js **24.14.0** + pnpm **10.33.2**（以 [mise.toml](mise.toml) 为准），`pnpm install`；
- **OHOS command-line-tools**（hvigorw/ohpm/hdc，[华为开发者下载页](https://developer.huawei.com/consumer/cn/download/)）——唯一额外必需，三选一让它可被发现：
  1. 设置 `OHOS_COMMAND_LINE_TOOLS_ROOT=<根目录>`，推荐写入仓库根 `.env`（模板见 [.env.example](.env.example)，真实环境变量优先）；
  2. 解压到 `~/command-line-tools`（自动发现）；
  3. 把其 `bin/` 加入终端 PATH。
- ❌ **不需要** DevEco Studio、devecocli、python3；
- 🔄 167MB 的 `libelectron.so` 不入库，首次构建自动从本仓库 [ohos-tools Release](https://github.com/yuanbaobaoo/ZCode-ohos/releases/tag/ohos-tools) 下载并校验 sha256（`ZCODE_OHOS_ELECTRON_URL` 可换源，同样支持 `.env`）。

## 📦 打包 HAP（未签名，开箱可构建）

```bash
pnpm bundle:desktop:ohos     # 等价 pnpm bundle:desktop -- --os ohos
```

- 产物：`packages/desktop/dist/ZCode-<version>-ohos-arm64-unsigned.hap`——无签名材料也能构建（`build-profile.json5` 缺失时自动从模板复制，hvigor 自动跳过签名）；
- 本机有 debug 签名材料时（AGC 申请后按 [`build-profile.template.json5`](packages/desktop/ohos/build-profile.template.json5) 注释填写），额外产出同名已签名版；
- 内部流程：desktop 生产构建（tsup/vite，node20 兼容）→ resfile 组装（含 io_uring 补丁，纯 Node）→ 清 hvigor 缓存 → `assembleHap` → 落标准 dist；
- 安装：`hdc install -r <hap>`；或推送 `v*` tag 由 CI 自动出包发 Release。

## 🔥 开发热更到鸿蒙 PC

前置：设备经 USB 连接（`hdc list targets` 可见）；首次需全量装机（`pnpm dev:ohos` 首跑自动完成）。

```bash
pnpm dev:ohos                  # 改了构建产物（out/）→ 变更热推（~8s）
pnpm dev:ohos -- --build       # 改了 TS/React 源码 → 连生产构建（~25s 全闭环）
pnpm dev:ohos -- --full        # 强制全量装机（~50s）
pnpm dev:ohos -- --device <sn> # 多台设备时指定目标
```

原理：resfile 全量 hash 与设备基线比对，小变更（≤200 文件 / ≤50MB、无删除）生成**签名 hqf 补丁**，`bm quickfix` 装入运行中的应用并自动重启——无需重装 440MB 整包；大变更 / 删除 / 首跑自动回退全量。

> 💡 UI / 业务开发与平台无关，照旧 `pnpm dev:desktop`（HMR）；只有适配层（main 进程 ohos 分支、终端中继、环境引导）需要上真机。

## 🩺 运行时观测

```bash
hdc fport tcp:9229 tcp:9229                                  # 转发调试端口 → chrome://inspect 全功能 DevTools
hdc shell "hilog -G 16M" && hdc shell "hilog -x -T Electron" # 应用日志（main+host）
```

## 📚 深入阅读

| 主题                                                                      | 文档                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 🧭 移植入口：关键决策（为什么 Electron / 为什么 zsh+brew 可行）、问题速查 | [specs/ohos-port/README.md](specs/ohos-port/README.md)                               |
| 🔧 环境要求、构建/热推命令、常见坑                                        | [specs/ohos-port/01-构建与打包.md](specs/ohos-port/01-构建与打包.md)                 |
| 🧩 移植遇到的问题与解法（按适配点）                                       | [specs/ohos-port/02-运行时架构与适配层.md](specs/ohos-port/02-运行时架构与适配层.md) |
| ⚠️ 平台事实清单：权限 / V8 ABI / 沙箱约束（改适配层前必读）               | [specs/ohos-port/03-平台权限与系统约束.md](specs/ohos-port/03-平台权限与系统约束.md) |
| 📖 完整产品说明（上游功能、配置、各平台打包）                             | [README.zh.md](README.zh.md)                                                         |
