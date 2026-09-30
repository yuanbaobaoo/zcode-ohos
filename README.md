# ZCode · HarmonyOS 移植版

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode" width="128" height="128" />
</div>
<p align="center">
  <a href="README.zh.md">完整说明（简体中文）</a> ·
  <a href="README.en.md">English</a>
</p>

本仓库将 ZCode（官方源码 v3.14.3）**源码级移植到 HarmonyOS PC**（aarch64，应用名 `ai.ohpc.zcode`，基于 OHOS Electron 运行时：Chromium 132 / Node 20.18.1）。桌面 / Web / CLI 上游功能保持一致，适配不引入运行时补丁。完整产品说明见 [README.zh.md](README.zh.md)，移植架构与约束文档见 [specs/ohos-port/](specs/ohos-port/)。

两条核心命令：

```bash
pnpm dev:ohos                # 开发：热更到鸿蒙 PC（实测 ~8s 生效，含应用自动重启）
pnpm bundle:desktop:ohos     # 打包：产出未签名 HAP（任何人都可直接构建）
```

## 环境准备（构建机：macOS 或 Linux）

- 仓库标准工具链：Node.js **24.14.0** + pnpm **10.33.2**（以 [mise.toml](mise.toml) 为准），`pnpm install`；
- **OHOS command-line-tools**（hvigorw/ohpm/hdc）是唯一额外必需项，三选一让它可被发现：
  1. 设置 `OHOS_COMMAND_LINE_TOOLS_ROOT=<根目录>`——推荐写入仓库根 `.env`（模板见 [.env.example](.env.example)，真实环境变量优先）；
  2. 解压到 `~/command-line-tools`（自动发现）；
  3. 把其 `bin/` 加入终端 PATH。
- **不需要** DevEco Studio、devecocli、python3；构建机暂不支持 HarmonyOS PC 本身（鸿蒙设备是部署目标，不是开发机）。
- 167MB 的 `libelectron.so`（OHOS Electron 运行时）不入库，首次构建自动从镜像下载并校验 sha256（`ZCODE_OHOS_ELECTRON_URL` 可换源，同样支持 `.env`）。

## 打包 HAP（未签名，开箱可构建）

```bash
pnpm bundle:desktop:ohos     # 等价 pnpm bundle:desktop -- --os ohos
```

- 产物：`packages/desktop/dist/ZCode-<version>-ohos-arm64-unsigned.hap`（未签名版，无签名材料也能构建——`build-profile.json5` 缺失时自动从模板复制，hvigor 自动跳过签名）；
- 本机若有 debug 签名材料（AGC 申请后按 `packages/desktop/ohos/build-profile.template.json5` 注释填写），会额外产出同名的已签名 `ZCode-<version>-ohos-arm64.hap`；
- 内部流程：desktop 生产构建（tsup/vite，产物按 node20 兼容）→ resfile 组装（含 libelectron io_uring 补丁，纯 Node）→ 清 hvigor 缓存 → `assembleHap` → 落标准 dist 目录；
- 安装到设备：`hdc install -r <hap>`（未签名版需先自行签名，debug Profile 通常绑定设备 UDID）；
- 也可以完全不开本地环境：push `v*` tag 时 GitHub Actions 自动构建并发布未签名 HAP 到 Release。

## 开发调试：热更到鸿蒙 PC

前置：鸿蒙 PC 经 USB 连接（`hdc list targets` 可见）；第一次需先完成一次全量装机（`pnpm dev:ohos` 首跑自动走全量，或用上面的 bundle + `hdc install`）。

```bash
pnpm dev:ohos                  # 改了构建产物（out/）→ 检测变更 → 热推（~8s）
pnpm dev:ohos -- --build       # 改了 TS/React 源码 → 连生产构建一起跑（实测 ~25s 全闭环）
pnpm dev:ohos -- --full        # 强制全量装机（清缓存组包 + 安装 + 启动，~50s）
pnpm dev:ohos -- --device <sn> # 多台设备时指定目标
```

原理（真机实证）：脚本对 resfile 全量 hash 与设备基线比对，小变更（≤200 文件 / ≤50MB、无删除）写入 hvigor 变更清单，`assembleDevHqf` 生成**签名 hqf 补丁**，`bm quickfix` 装进运行中的应用并自动重启——无需重装 440MB 整包。大变更 / 删除文件 / 首跑自动回退全量。

运行时观测：

```bash
hdc fport tcp:9229 tcp:9229                                # 转发 Chromium 调试端口
# 开发机 Chrome 打开 chrome://inspect → 全功能 DevTools（断点/Console/Network）
hdc shell "hilog -G 16M" && hdc shell "hilog -x -T Electron"   # 应用日志（main+host）
```

常规 UI / 业务开发与平台无关，照旧在 mac 上 `pnpm dev:desktop`（HMR）；只有适配层本身（main 进程 ohos 分支、终端中继、环境引导）需要 `dev:ohos` 上真机。

## 深入阅读

| 主题                                                                               | 文档                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 移植入口：关键决策（为什么 Electron / 为什么 zsh+brew 可行）、适配层一览、问题速查 | [specs/ohos-port/README.md](specs/ohos-port/README.md)                               |
| 环境要求、构建/热推命令、常见坑                                                    | [specs/ohos-port/01-构建与打包.md](specs/ohos-port/01-构建与打包.md)                 |
| 移植遇到的问题与解法（按适配点）                                                   | [specs/ohos-port/02-运行时架构与适配层.md](specs/ohos-port/02-运行时架构与适配层.md) |
| 平台事实清单：权限 / V8 ABI / 沙箱约束（改适配层前必读）                           | [specs/ohos-port/03-平台权限与系统约束.md](specs/ohos-port/03-平台权限与系统约束.md) |
| 完整产品说明（上游功能、配置、各平台打包）                                         | [README.zh.md](README.zh.md)                                                         |
