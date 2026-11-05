# ZCode HarmonyOS 移植

把 ZCode 桌面端**源码级移植**到 HarmonyOS PC（aarch64，应用 `ai.ohpc.zcode`）。上游基线 **v3.17.1**，运行时为华为 OHOS Electron v40.0.1（Chromium 144）；真机基准 HUAWEI MateBook Pro HAD-W32 / HarmonyOS 7.0.0.111 / API 26 / 3120×2080。

桌面端功能跟随上游；`apps/zcode-cli` 仅作为 HAP 内置 Agent 运行时复用上游源码。独立 CLI、TUI、SEA、Web / Server 不是鸿蒙交付面。

## 文档

| 文档 | 内容 |
| --- | --- |
| [01-构建与打包.md](./01-构建与打包.md) | 环境、签名、构建/热推、常见坑 |
| [02-运行时架构与适配层.md](./02-运行时架构与适配层.md) | 进程模型、问题→解法、已知限制 |
| [03-平台权限与系统约束.md](./03-平台权限与系统约束.md) | 权限矩阵、授权 API 语义、沙箱与 V8 约束、截屏/录屏授权模型 |
| [04-版本与更新.md](./04-版本与更新.md) | 版本号、HAP 版本同步、更新检查 |
| [05-碰一碰投送接收.md](./05-碰一碰投送接收.md) | 华为分享 → 输入框附件 |
| [06-模拟器检测与软件渲染降级.md](./06-模拟器检测与软件渲染降级.md) | 模拟器判据与渲染降级 |
| [07-系统栏主题跟随.md](./07-系统栏主题跟随.md) | 最大化时系统栏深浅跟随 |
| [08-全盘文件权限引导.md](./08-全盘文件权限引导.md) | 全盘文件权限的引导与状态回流 |
| [09-上游合并与版本演进.md](./09-上游合并与版本演进.md) | 合并边界、冲突分类、版本历史、未来合并清单 |
| [11-设备通道.md](./11-设备通道.md) | `ohos_hdc`（hdc-direct 直连 hdcd）与 devecocli 的 hdc 入口 |
| [13-本机电脑控制.md](./13-本机电脑控制.md) | 电脑控制终态：权限门禁、截图、录屏、工具映射、验收 |
| [14-Agent自动化链路故障排查.md](./14-Agent自动化链路故障排查.md) | 链路全景、症状速查、取证工具箱、开放问题 |
| [15-平台适配治理与不变量.md](./15-平台适配治理与不变量.md) | 单控制通道、平台身份、文件桥契约、门禁与移除清单 |

> 旧编号 10（v3.17.1 合并方案）已并入 09；旧编号 12（原型/dev 档电脑控制）已随 dev 通道删除，有效结论并入 13/15。

## 交付范围与非目标

- **支持**：HarmonyOS 桌面 HAP，以及随包的 Agent bundle、终端、权限与环境引导等平台适配。
- **非目标**：独立 `zcode` 命令、CLI TUI、SEA / npm / 包管理器分发、Web / Server 独立部署。
- `apps/zcode-cli` 不可裁剪：它是桌面 Agent 的源码来源，`pnpm dev:ohos -- --build --agent` 与 HAP 打包都会重建 `zcode.cjs`。

## 关键决策

1. **选 Electron，不重写也不套壳**：复用上游 UI/业务/Agent 源码，只在运行时适配层解决平台差异。
2. **单一控制通道**：电脑控制只保留产品化的 ArkTS 桥（`computer-control/` 文件桥 + 系统能力），原型期的 dev 档 `ohos_hdc` 控制动作已全部删除。
3. **两权限门禁**：电脑控制要求「辅助操作 + 截屏」两个系统权限；录屏走截屏 API 帧流，不再依赖 `CUSTOM_SCREEN_RECORDING`。
4. **hdc 直连**：沙箱起不了 hdc server，设备通道统一走 `hdc-direct`（TCP 直连 hdcd）；devecocli 通过应用内迷你 CLT 复用同一条通道。
5. **用户 zsh 环境可直接用**：main 采集登录 shell 快照并注入 main/host；终端由 main 域托管系统 zsh。
6. **无需重编 Electron**：平台约束在适配层解决，二进制只做一处 io_uring 禁用补丁。

## 适配层一览

| 位置 | 作用 |
| --- | --- |
| `packages/desktop/ohos/` | HAP 工程（ArkTS 壳 + Electron 运行时 + hvigor 配置） |
| `packages/desktop/ohos/entry/src/main/ets/computerControl/` | 电脑控制 ArkTS 服务（权限、截图、录屏、输入、拉起） |
| `packages/desktop/native/ohos-*` | OHOS 专属 C 源码（sqlite 绑定、HMDFS link 垫层） |
| `packages/desktop/scripts/{build,bundle,dev}-ohos*.mjs` | 构建 / 打包 / 设备热推 |
| `packages/shared/src/nodeSqliteCompat.ts` | `node:sqlite` 兼容层 |
| `packages/services/src/ohos/` | 用户 shell 环境、hdc shim、TMPDIR/socket 目录 |
| `packages/desktop/src/main/desktopOhos*.ts` + `ohos/` | 平台分支、文件桥、权限状态与窗口主题 |
| `packages/zcode-cua/ohos-computer-use.js` | CUA 的 OHOS runtime（工具编排，经文件桥调用 ArkTS） |
| `apps/zcode-cli/packages/core/src/capabilities/ohos-device/` | `ohos_hdc` 工具（hdc-direct 直连） |

## 常用命令

```bash
pnpm bundle:desktop:ohos   # 打包（未签名 HAP）
pnpm dev:ohos              # 部署到设备（全量 ~30s；--hqf 增量 ~8s）
pnpm dev:ohos -- --build   # 全量重建（desktop + agent bundle）后部署
pnpm typecheck && pnpm lint && pnpm architecture:check -- --changed
```

## 问题 → 对策速查

| 问题 | 对策 | 文档 |
| --- | --- | --- |
| seccomp 拒 io_uring → SIGSYS | 构建期补丁禁用 | 02/03 |
| 沙箱禁 RWX → V8 无 JIT/WASM | 早期加载 sqlite 绑定触发 `prctl(SET_JITFORT)` | 02 |
| `app.isPackaged` 恒 false、`process.title` 赋值 SIGSEGV | 显式平台守卫 + `assignProcessTitle()` | 02 |
| 无 `node:sqlite` | 自有 NAPI 绑定 + 兼容层 | 02 |
| V8 Smi：数字经 napi 对象/数组路径即 SEGV | 参数展开到 cb_info 位置通道 | 03 |
| `/dev/ptmx` 被拒 → 无伪终端 | main 托管 shell + MessagePort 中继 | 02 |
| host 不继承 main env | 登录 shell 快照双入口注入 | 02 |
| agent 缺 `/usr/bin/env`，shebang 失败 | LD_PRELOAD exec shim 改写为 `/bin/env` | 03 |
| 起不了 hdc server（UDS bind 被拒） | `hdc-direct` 直连 hdcd；devecocli 用迷你 CLT | 11 |
| devecocli `No active devices` | `DEVECO_CLI_CLT_PATH` 指向应用内迷你 CLT（host 自动注入） | 11 |
| 截图/录屏失败 | `@ohos.screenshot` + 两权限门禁；帧流录屏 | 03/13 |
| 权限撤销后开关仍 ON | 启动 `useOhosCuaPermissionReconcile` 回收 | 13/15 |

## HAP 工程内部

- `entry/`（hvigor 模块名保留 `electron`）：ArkTS 入口（EntryAbility、XComponent 页面）+ `libs/arm64-v8a/` 原生库；
- `web_engine/`（har）：OHOS Electron 的 ArkTS 绑定层 + 运行时资源（pak/icudtl/locales 等）；
- `resfile/resources/app/`：ZCode 源码构建产物，由 `build-ohos.mjs` 组装，不入库；
- 原生库（`libadapter.so` / `libelectron.so` / `libffmpeg.so`）= OHOS Electron 运行时；终端走 main 中继管道，不随包分发 `pty.node`。
