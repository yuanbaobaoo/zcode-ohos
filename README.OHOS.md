# ZCode HarmonyOS 适配说明（README.OHOS）

本仓库在保留上游全部功能的基础上，将 ZCode **源码级移植到 HarmonyOS PC**（aarch64，应用名 `ai.ohpc.zcode`，基于 OHOS Electron 运行时：Chromium 132 / Node 20.18.1）。桌面 / Web / CLI 各平台行为与上游一致，鸿蒙适配不引入运行时补丁，适配层以新增文件为主。

技术文档索引：

| 文档 | 内容 |
|---|---|
| [ohos/docs/01-构建与打包.md](ohos/docs/01-构建与打包.md) | 构建环境要求、工具链、一次性初始化、构建流水线、本地回归 |
| [ohos/docs/02-运行时架构与适配层.md](ohos/docs/02-运行时架构与适配层.md) | 进程模型、agent 进程内 Worker、环境注入、sqlite 兼容层、终端中继 |
| [ohos/docs/03-平台权限与系统约束.md](ohos/docs/03-平台权限与系统约束.md) | 系统权限、V8 Smi ABI、沙箱约束与对策、已知限制（**修改适配层代码前必读**） |
| [ohos/BRINGUP.md](ohos/BRINGUP.md) | 装机操作手册（步骤 + 冒烟清单 + 观察点） |
| [specs/ohos-port/spec.md](specs/ohos-port/spec.md) | 移植总体 spec（架构、状态所有者、验收场景） |

## 已验证能力（真机 MateBook Pro，HarmonyOS 7）

- **Agent 完整回合**：发送消息 → 模型流式回复渲染（中英文）、插件市场、任务列表（实时入库 + 历史回补 + 重启保留 + 点击恢复对话）
- **brew 工具链**：agent Bash 与内置终端可直接使用 harmonybrew 安装的工具（git 2.55 / openjdk 26 / node 26 实测）；用户 `~/.zshrc` 环境对应用四端（main / host / agent / 终端）一致生效
- **完整 V8 JIT 与 WebAssembly**（官方权限路径，无二进制绕过）

已知限制（终端全屏交互、`brew` 本体命令等）见 [ohos/docs/03-平台权限与系统约束.md](ohos/docs/03-平台权限与系统约束.md)。

## 构建与打包

### 标准打包通道（推荐）

```bash
pnpm bundle:desktop:ohos        # 等价 pnpm bundle:desktop -- --os ohos
```

产物输出到 `packages/desktop/dist/`，命名与桌面版同规则：

- `ZCode-<version>-ohos-arm64.hap`：已用本机 debug 证书签名（仅本机/同 Profile 设备可装）
- `ZCode-<version>-ohos-arm64-unsigned.hap`：未签名，供其他用户自行签名安装

该命令内部执行：源码构建 + resfile 组装（含 libelectron io_uring 补丁）→ 清 hvigor 缓存 → `assembleHap` → 产物落标准目录。

### 环境要求

详见 [ohos/docs/01-构建与打包.md](ohos/docs/01-构建与打包.md) §环境要求。要点：

| 类别 | 项 |
|---|---|
| 必需 | macOS 构建机；仓库标准 Node/pnpm；OHOS command-line-tools（hvigor，用 `OHOS_HVIGORW` 或 `OHOS_COMMAND_LINE_TOOLS` 指定位置）；npm 网络可达 |
| 必需（自动获取） | `libelectron.so`（167MB，OHOS Electron 运行时）：**缺失时构建脚本自动从 GitHub Release 镜像下载并校验 sha256**（`releases/download/v3.14.3/libelectron.so`；`ZCODE_OHOS_ELECTRON_URL` 可指向任意 http(s)/file 镜像）。无需人工取回 |
| 可选 | devecocli 签名材料（`auth login` + `signature generate`，需华为账号）——缺失时仅产出未签名版（`build-profile.json5` 不入库，缺失时自动从模板复制，已实测可正常构建） |
| 特定场景 | OHOS SDK clang + sqlite amalgamation（改 C 源重编绑定时）；hdc + 真机（装机/调试） |

### 分发与安装

- **作者设备**：直接安装签名版 `hdc install -r ZCode-<version>-ohos-arm64.hap`
- **其他用户**：HarmonyOS debug Profile 通常绑定设备 UDID，他人直接装签名版会失败。两条路：
  1. 下载未签名版，用 hap-sign-tool / DevEco Studio 自行签名后安装；
  2. **从源码构建**（推荐，见上方标准通道，签名材料自动生成、产物开箱即装）。

装机操作与冒烟清单见 [ohos/BRINGUP.md](ohos/BRINGUP.md)。

### 底层命令（开发迭代，等价于标准通道拆步）

```bash
sh ohos/native/zcode-sqlite/build.sh     # 交叉编译自有 SQLite 绑定（改 C 源后）
node scripts/build-ohos.mjs              # 桌面产物 + agent bundle + resfile 组装
rm -rf ohos/.hvigor ohos/electron/build ohos/web_engine/build   # hvigor 增量不感知 resfile，装机迭代前必清
cd ohos && hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
hdc install -r ohos/electron/build/default/outputs/default/electron-default-signed.hap
hdc shell "aa start -a EntryAbility -b ai.ohpc.zcode"
```

## 适配层结构

| 位置 | 职责 |
|---|---|
| `ohos/` | HAP 应用工程（ArkTS 入口 + Electron 运行时 + 自有原生模块） |
| `ohos/docs/` | 适配技术文档（构建、运行时架构、平台权限与系统约束） |
| `scripts/build-ohos.mjs` | 源码级 resfile 组装管线（含 libelectron io_uring 补丁） |
| `ohos/scripts/bundle-ohos.mjs` | OHOS 标准打包编排（`bundle:desktop --os ohos` 分流目标） |
| `ohos/scripts/device-cdp.mjs` | 真机 UI 自动化（CDP 通道） |
| `packages/shared/src/nodeSqliteCompat.ts` | node:sqlite 兼容层（Node 20 无内建，含 Smi 安全通道） |
| `packages/services/src/ohos/` | 用户 shell 环境（zshrc/brew）注入共享模块 |
| `packages/services/src/terminal/ohosTerminalPty.ts`、`packages/desktop/src/main/desktopTerminalPtyRelay.ts` | 终端 pty-main 中继 |
| `.ohos-test/` | 兼容层/绑定回归测试 |

**修改适配层代码前，先读 [ohos/docs/03-平台权限与系统约束.md](ohos/docs/03-平台权限与系统约束.md)**——每条平台约束都对应代码中的具体对策，破坏对策会导致崩溃或功能回退。

## 跟随上游

`main` 分支基于上游基线承载适配提交，适配以新增文件为主、上游文件内改动集中且带注释标记，可常规 `git fetch upstream && git merge` 跟随上游更新。
