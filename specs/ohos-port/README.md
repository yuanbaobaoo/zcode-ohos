# ZCode HarmonyOS 移植

将 ZCode（上游 v3.16.2）**源码级移植**到 HarmonyOS PC（aarch64，应用 `ai.ohpc.zcode`，基于 OHOS Electron v40.1：Chromium 144 / Node 24.11.1）。桌面端功能跟随上游，`apps/zcode-cli` 仅作为 HAP 内置 Agent 运行时复用上游源码；独立 CLI / TUI / SEA、Web / Server 不作为鸿蒙交付面。

| 文档                                                               | 内容                                    |
| ------------------------------------------------------------------ | --------------------------------------- |
| [01-构建与打包.md](./01-构建与打包.md)                             | 环境要求、构建/热推命令、常见坑         |
| [02-运行时架构与适配层.md](./02-运行时架构与适配层.md)             | 移植过程中遇到的问题与解法（按适配点）  |
| [03-平台权限与系统约束.md](./03-平台权限与系统约束.md)             | 平台事实清单：权限 / V8 ABI / 沙箱约束  |
| [04-版本与更新.md](./04-版本与更新.md)                             | tag 排序、HAP 版本同步、GitHub 更新检查 |
| [05-碰一碰投送接收.md](./05-碰一碰投送接收.md)                     | 碰一碰接收适配                          |
| [06-模拟器检测与软件渲染降级.md](./06-模拟器检测与软件渲染降级.md) | 模拟器检测与渲染降级                    |
| [07-系统栏主题跟随.md](./07-系统栏主题跟随.md)                     | 最大化时系统栏深浅跟随应用主题          |
| [08-全盘文件权限引导.md](./08-全盘文件权限引导.md)                 | 一次性 toast + 设置页开关的授权引导     |
| [09-上游-v3.16.2-合并方案.md](./09-上游-v3.16.2-合并方案.md)       | v3.16.1 → v3.16.2 合并的边界、兼容层与执行计划 |

## 交付范围与非目标

- **支持**：HarmonyOS 桌面 HAP，以及随包的 Agent bundle、终端、权限与环境引导等平台适配。
- **非目标**：独立 `zcode` 命令、CLI TUI、SEA / npm / 包管理器分发、Web / Server 独立部署。
- `apps/zcode-cli` 不可裁剪：它是桌面 Agent 的源码来源，`pnpm dev:ohos -- --build --agent` 和 HAP 打包都会重建 `zcode.cjs`。

## 三个关键决策

- **选 Electron，不重写也不套壳**：完整复用上游 UI、业务与 Agent 源码，只适配运行时层，避免双份维护。
- **用户 zsh 环境可直接用**：main 采集登录 shell 快照并注入 main/host，终端由 main 域托管系统 zsh；HiShell/HarmonyBrew 只是该环境的常见来源。
- **无需重编 Electron**：平台约束都在运行时适配层解决，二进制只做一处 io_uring 禁用补丁。

## 做了什么（适配层一览）

| 位置                                                            | 作用                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| `packages/desktop/ohos/`                                        | HAP 应用工程（ArkTS 壳 + Electron 运行时 + hvigor 配置） |
| `packages/desktop/native/ohos-*`                                | OHOS 专属 C 源码（sqlite 绑定、HMDFS link 垫层）         |
| `packages/desktop/scripts/{build,bundle,dev}-ohos*.mjs`         | 构建 / 打包 / 设备热推管线                               |
| `packages/shared/src/nodeSqliteCompat.ts`                       | node:sqlite 兼容层（Node 20 无此 API）                   |
| `packages/services/src/ohos/`                                   | 用户 shell 环境注入共享模块                              |
| `packages/services/src/terminal/ohosTerminalPty.ts` + main 中继 | 终端 shell 托管与中继                                    |
| main 进程若干 `desktopOhos*.ts` / host 早期引导                 | 平台分支与环境引导                                       |

## HAP 工程内部（packages/desktop/ohos/）

- `entry/`（entry 模块，hvigor 模块名保留 `electron`——设备端 `bundle/electron`、`haps/electron/files` 路径的组成部分）：ArkTS 入口（EntryAbility、XComponent 页面）+ `libs/arm64-v8a/` 原生库；
- `web_engine/`（har 模块）：OHOS Electron 的 ArkTS 绑定层 + 运行时资源（resfile 的 pak/icudtl/locales 等）；
- `resfile/resources/app/`：ZCode 源码构建产物（main/preload/renderer/host + 运行时 node_modules + agent bundle），由 build-ohos.mjs 组装，不入库；
- 原生库（`libadapter.so` / `libelectron.so` / `libffmpeg.so`）= OHOS Electron 运行时，等价于桌面版对 electron npm 包的依赖；`ohos_sqlite_adapter.node` 为 sqlite 兼容层后端候选，`pty.node` 为 node-pty OHOS prebuild。

## 怎么用

```bash
pnpm bundle:desktop:ohos   # 打包（未签名 HAP，零门槛可构建；详见 01）
pnpm dev:ohos              # 开发部署（默认全量覆盖所有设备 ~30s；--hqf 增量 ~8s；详见 01）
```

## 问题 → 对策速查（详情见 02/03）

| 问题                                                    | 对策                                                    |
| ------------------------------------------------------- | ------------------------------------------------------- |
| seccomp 拒 io_uring → SIGSYS 击杀进程                   | 构建期二进制补丁禁用（`ohos-patch-libelectron.mjs`）    |
| 沙箱默认禁 RWX → V8 无 JIT/WASM                         | 早期加载 sqlite 绑定触发 `prctl(SET_JITFORT)`           |
| `app.isPackaged` 恒 false、`process.title` 赋值 SIGSEGV | 显式平台守卫 + `assignProcessTitle()` 收口              |
| Node 20 无 `node:sqlite`                                | 自有 NAPI 绑定 + 兼容层（详见 02）                      |
| V8 Smi ABI：数字经 napi 对象/数组路径即 SEGV            | 包装层把参数展开到 cb_info 位置通道（铁律，详见 03）    |
| `/dev/ptmx` 被拒 → 无伪终端                             | shell 由 main 托管经 MessagePort 中继；管道哑终端       |
| host/native child 域没有 `/usr/bin`，系统 zsh 仅 main 可见 | 终端 shell 固定在 main 域 spawn `/usr/bin/zsh -il`      |
| host 由 appspawn 拉起、不继承 main env                  | 登录 shell 快照在 main/host 双入口应用（同一共享模块）  |
| agent 视图缺 `/usr/bin/env`，shebang 脚本失败           | LD_PRELOAD exec shim 改写为 `/bin/env` 交 PATH 解析     |
| HOME 对应用常无写权                                     | 早期写权探测 → 回退沙箱 + 一次目录授权后迁回            |
| hvigor 增量不感知 resfile 变化                          | 全量前清缓存（脚本已自动处理）                          |
