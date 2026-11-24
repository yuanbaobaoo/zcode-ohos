<div align="center">

<img src="public/logo/icons/1024x1024.png" alt="ZCode" width="120" />

# ZCode · HarmonyOS

[![OHOS HAP CI](https://github.com/yuanbaobaoo/zcode-ohos/actions/workflows/ohos-hap.yml/badge.svg)](https://github.com/yuanbaobaoo/zcode-ohos/actions/workflows/ohos-hap.yml)
[![Release](https://img.shields.io/github/v/release/yuanbaobaoo/zcode-ohos?style=flat-square)](https://github.com/yuanbaobaoo/zcode-ohos/releases)
[![Platform](https://img.shields.io/badge/platform-HarmonyOS%20PC%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square)](#环境准备)
[![License](https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square)](LICENSE)

桌面端功能跟随上游 · `apps/zcode-cli` 仅作为内置 Agent 运行时 · 适配不引入运行时补丁

[移植文档](specs/ohos-port/)

</div>

## 更新

| 日期       | 上游版本 | 主要内容                                                                                                                                                  |
| ---------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-23 | v4.0.0   | 预装工具链与文档转换、MCP 热重载与远程恢复、崩溃重启与会话活动关闭确认、草稿预热退役、Agent 回复语言                                                      |
| 2026-11-16 | v3.18.2  | 扩展宿主、会话控制、受管 worktree、系统凭据安全存储、语音输入、设计插件                                                                                   |
| 2026-11-05 | v3.17.2  | 子代理权限模式、自定义命令 shell handoff、MCP 失败指引与官方鉴权路由、浏览器本地 HTML 预览、会话远程草稿预热、打包平台依赖裁剪                            |
| 2026-10-30 | v3.17.1  | Electron 44 线、Data Sync 设备配置同步、手机远控输入预测与事件推送、conversation telemetry、会话任务重启、Sites 面板、App 单测退役为 engineering 工程测试 |
| 2026-10-21 | v3.16.2  | Bash 直执行与输出隔离、Side Pane 完整视图、项目存储 0007 迁移、动态工作流并发、远程 / Web 配对修复                                                        |
| 2026-10-16 | v3.16.1  | Project-first 项目模型、R3 Source Server 远程、Relay V2、Office viewer、ToolSearch、存储迁移与架构治理                                                    |
| 2026-10-10 | v3.15.1  | —                                                                                                                                                         |
| 2026-09-23 | v3.14.3  | 开始源码级移植                                                                                                                                            |

## 快速开始

两条命令覆盖绝大多数场景，构建机是 macOS 或 Linux（鸿蒙 PC 是部署目标，不是开发机）：

```bash
pnpm dev:ohos                # 开发：dev HAP 装到所有已连接设备并启动（约 30s，独立包名 ZCode-dev，与正式包共存）
pnpm bundle:desktop:ohos     # 打包：产出未签名 HAP（不需要任何签名材料）
```

## 交付范围

| 交付面               | 状态        | 说明                                                                                     |
| -------------------- | ----------- | ---------------------------------------------------------------------------------------- |
| HarmonyOS 桌面 HAP   | 支持        | 本仓库构建、发布，在鸿蒙 PC 与模拟器上验收                                               |
| 内置 Agent CLI       | 随 HAP 分发 | `apps/zcode-cli` 构建成 `zcode.cjs`，由桌面 Host / Agent 调用；不安装独立的 `zcode` 命令 |
| 独立 CLI / TUI / SEA | 非目标      | 不移植独立命令行运行时，不发 `zcode` 的 npm / SEA / Harmonybrew 包                       |
| Web / Server         | 非目标      | 源码随上游保留，不作为鸿蒙上的独立部署面                                                 |

开发命令里的 `--agent` 指重建桌面内置的 Agent bundle，不是发布或运行独立 CLI。

## 下载

| 内容                | 链接                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 最新未签名 HAP      | [ZCode-latest-ohos-arm64-unsigned.hap](https://github.com/yuanbaobaoo/zcode-ohos/releases/latest/download/ZCode-latest-ohos-arm64-unsigned.hap) |
| 历史版本 / 校验文件 | [Releases](https://github.com/yuanbaobaoo/zcode-ohos/releases)（每次打 `v*` tag 由 CI 自动构建发布，附 sha256）                                 |

装之前要先自己签名：Profile 必须带上面那 6 个受限权限的 ACL，否则装机报 9568289，见
[自行签名安装](#自行签名安装权限提示)。

## 环境准备

| 依赖                    | 要求                                                                 | 怎么准备                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js + pnpm          | Node **24.14.0**、pnpm **10.33.2**（以 [mise.toml](mise.toml) 为准） | 装好后跑 `pnpm install`                                                                                                                                   |
| OHOS command-line-tools | 提供 hvigorw / ohpm / hdc，**唯一额外必需**                          | 见下，[华为开发者下载页](https://developer.huawei.com/consumer/cn/download/) 或 [GitCode 镜像](https://gitcode.com/yuanbaobaoo/ohos-tools/releases/v26.0) |
| Electron v40 运行时     | 三件 `.so`、启动器与 resfile 资源，**不入库**                        | 首次构建自动下载（368MB 华为官方原包），校验 sha256                                                                                                       |

command-line-tools 只要能被发现，二选一：

1. 设 `DEVECO_CLI_CLT_PATH=<根目录>`。这是 devecocli 的标准变量，可与其他项目共用，推荐
   写进仓库根的 `.env`（模板见 [.env.example](.env.example)，真实环境变量优先）。
2. 把它的 `bin/`（或 `sdk/default/openharmony/toolchains`）加进终端 PATH，脚本会从 hvigorw 或
   hdc 反推根目录。

Electron 运行时从 [GitHub Release tools](https://github.com/yuanbaobaoo/zcode-ohos/releases/tag/tools)
的 `electron-ohos-v40.0.1.20260928.2.zip` 取（华为官方原包内容）。要换源设
`ZCODE_OHOS_ELECTRON_URL`，同样可以写进 `.env`。

## 打包 HAP（未签名，开箱可构建）

```bash
pnpm bundle:desktop:ohos     # 等价于 pnpm bundle:desktop -- --os ohos
```

- 产物：`packages/desktop/dist/ZCode-<version>-ohos-arm64-unsigned.hap`。没有签名材料也能构建：
  `build-profile.json5` 缺失时会自动从模板复制，hvigor 自己跳过签名。
- 本机有 debug 签名材料时，额外产出同名已签名版（材料怎么填见
  [`build-profile.template.json5`](packages/desktop/ohos/build-profile.template.json5) 里的注释，
  权限要求见[自行签名安装](#自行签名安装权限提示)）。
- 内部流程：desktop 生产构建（tsup / vite，node20 兼容）→ 组装 resfile（含 io_uring 补丁，纯 Node）
  → 清 hvigor 缓存 → `assembleHap` → 落到 dist。
- 安装：`hdc install -r <hap>`；或者推 `v*` tag 交给 CI 出包发 Release。

## 开发部署到鸿蒙 PC

前置：设备连上（USB 或网络），`hdc list targets` 能看到。

默认是**全量覆盖**：不管设备上装没装、resfile 有没有变，都用这次的 dev 构建重打 HAP，再
`hdc install -r` 覆盖**所有**可见设备，装完自动启动（实测约 30s）。单台失败不影响其余设备，
最后汇总报错。

| 命令                                   | 作用                                                      |
| -------------------------------------- | --------------------------------------------------------- |
| `pnpm dev:ohos`                        | 全量 HAP 覆盖所有设备（只改 ArkTS / .ets 时够用）         |
| `pnpm dev:ohos -- --build`             | 连 JS 生产构建一起（改了 TS / React 源码，约 60s 全闭环） |
| `pnpm dev:ohos -- --build --agent`     | 再把 Agent bundle（`apps/zcode-cli`）一起重建             |
| `pnpm dev:ohos -- --device <sn>`       | 只部署到指定设备                                          |
| `pnpm dev:ohos -- --hqf --device <sn>` | 增量热推，见下                                            |

**增量热推**（可选，约 8s）：`--hqf` 拿 resfile 的 hash 与设备上的基线比对，小改动（≤200 个文件、
≤50MB、没有删除）会生成签名 hqf 补丁，用 `bm quickfix` 装进运行中的应用并自动重启，不用重装整包。
只支持单设备，必须用 `--device` 指定；没有基线、应用已被卸载、有删除、改动超阈值时自动回退全量。

```bash
pnpm dev:ohos -- --hqf --device 127.0.0.1:5555   # 改了构建产物（out/）后的快速迭代
```

三条容易忘的：

- `dev:ohos` 默认**不重建** JS 产物（`out/`）和 Agent bundle
  （`bundled-agents/linux-arm64/glm/zcode.cjs`）。改了 `packages/*` 的 TS / React 要带 `--build`，
  改了 `apps/zcode-cli` 要带 `--agent`，否则设备上跑的仍是旧代码；host 与 agent 的协议或配置
  格式一旦错位，agent 会启动即崩（实测报 "Bundled 与 Active ZCode Built-in Release 均不可用"）。
- UI 与业务开发和平台无关，照旧 `pnpm dev:desktop`（带 HMR）。只有适配层（main 的 ohos 分支、
  终端中继、环境引导）需要上真机。
- 中文路径别用在鸿蒙工程里：`devecocli create` 与 hvigor 都只接受 ASCII 工程路径。工作区可以带
  中文，工程建在纯 ASCII 目录即可（详见 [specs/ohos-port/03](specs/ohos-port/03-平台权限与系统约束.md)）。

## 自行签名安装（权限提示）

Release 里的 HAP 是未签名的，得自己签名才能装。包内申请了 6 个 `system_basic` 受限权限，
**签名用的 Profile 必须在 `allowed-acls` 里逐条写上**，否则装机直接报 9568289。

| 受限权限                                            | 用途                                 | 备注                                                       |
| --------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------- |
| `ohos.permission.kernel.ALLOW_WRITABLE_CODE_MEMORY` | 允许 V8 JIT / WASM                   | 运行刚需，缺了全程 jitless                                 |
| `ohos.permission.CUSTOM_SANDBOX`                    | 动态沙箱，可 exec 用户目录里的工具链 | 运行刚需，缺了终端 / agent 无法执行用户装好的工具          |
| `ohos.permission.ACCESS_USER_FULL_DISK`             | 全盘文件访问                         | 对应系统设置里的「访问全盘文件」，应用内有引导页与主页提示 |
| `ohos.permission.CONTROL_DEVICE`                    | 电脑控制（输入注入）                 | 缺了电脑控制不可用                                         |
| `ohos.permission.READ_WRITE_USER_FILE`              | 读写真实用户 home                    | 缺了用户 shell 环境注入失效                                |
| `ohos.permission.READ_PASTEBOARD`                   | 读取剪贴板                           |                                                            |

前两项是应用能跑起来的底线，**不要为了绕过安装限制删掉它们**——删了也照样卡在其余受限权限上。

### dev 装机签名（正式 HAP 不签名）

正式 HAP 一律按未签名产出，签名由使用者自己处理；本仓库只保证 `pnpm dev:ohos` 装出来的 dev 包
能装上。两种做法：

| 方式              | 步骤                                                                                                                                                            | 说明                                                                                                                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| devecocli（推荐） | 在 `packages/desktop/ohos/` 下执行 `devecocli auth login`（浏览器登录华为账号，一次性），再执行 `devecocli signature generate --product dev`                    | 自动申请带上述 ACL 的调试 Profile，并写好 `build-profile.json5` 的 `dev` 条目。`dev:ohos` 用的就是独立的 `dev` product（包名 `…zcode.dev`、桌面名 `ZCode-dev`，见 [19](specs/ohos-port/19-开发包身份.md)），发现签名缺失会自动调它生成 |
| AGC 手动          | 申请调试证书与 Profile 时勾上受限权限（ACL），再按 [`build-profile.template.json5`](packages/desktop/ohos/build-profile.template.json5) 的注释填 `dev` 条目材料 | 正式 HAP 若要自己签名，同样按模板填，不在本仓库维护范围                                                                                                                                                                                |

### 报错对照

| 设备报错                                          | 原因与处理                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `9568320 no signature file`                       | 直接装了未签名包，先签名                                                                                    |
| `代码签名验证失败，请确保签名时 signCode 为 true` | 用第三方一键工具重签时没写原生库的代码签名。本包带 7 个原生库（含 `libelectron.so`），纯 ArkTS 应用不会踩到 |
| `9568289 ... grant request permissions failed`    | Profile 的 `allowed-acls` 少了包内受限权限，用上面两种方式重新生成签名材料                                  |
| `9568393 verify code signature failed`            | 手工解压重打包把原生库签名弄坏了。**别手工改包**，直接对原始 HAP 签名                                       |

小白调试助手、hotkit 这类一键安装工具目前装不了本包：它们的重签实现不写原生库代码签名，自动
申请的 Profile 也不带 ACL。用上面两种签名方式，或者等一键安装脚本。

## 运行时观测

| 端口 | 是什么                        | 怎么用                                                     |
| ---- | ----------------------------- | ---------------------------------------------------------- |
| 9229 | renderer 的 Chromium DevTools | `hdc fport tcp:9229 tcp:9229`，取 DOM 与 Performance trace |
| 9330 | main 进程的 Node inspector    | `hdc fport tcp:9330 tcp:9330` 后接调试器                   |

```bash
hdc fport tcp:9229 tcp:9229                                  # renderer DevTools
hdc fport tcp:9330 tcp:9330                                  # main 进程 Node inspector
hdc shell "hilog -G 16M" && hdc shell "hilog -x -T Electron" # 应用日志（main + host）
```

## 深入阅读

| 主题                                                                   | 文档                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 移植入口：关键决策（为什么 Electron / 为什么 zsh+brew 可行）、问题速查 | [specs/ohos-port/README.md](specs/ohos-port/README.md)                               |
| 环境要求、构建 / 热推命令、常见坑                                      | [specs/ohos-port/01-构建与打包.md](specs/ohos-port/01-构建与打包.md)                 |
| 移植遇到的问题与解法（按适配点）                                       | [specs/ohos-port/02-运行时架构与适配层.md](specs/ohos-port/02-运行时架构与适配层.md) |
| 平台事实清单：权限 / V8 ABI / 沙箱约束（改适配层前必读）               | [specs/ohos-port/03-平台权限与系统约束.md](specs/ohos-port/03-平台权限与系统约束.md) |
| 功能可用性清单：上游合入后哪些用不了、有入口点不动、能用但换了做法     | [specs/ohos-port/21-上游能力可用性清单.md](specs/ohos-port/21-上游能力可用性清单.md) |
| 鸿蒙新增能力：上游没有、为鸿蒙新加的功能                               | [specs/ohos-port/22-鸿蒙新增能力.md](specs/ohos-port/22-鸿蒙新增能力.md)             |
