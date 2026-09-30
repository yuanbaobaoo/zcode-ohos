# ZCode HarmonyOS 移植

将 ZCode（官方源码 v3.14.3）**源码级移植**到 HarmonyOS PC（aarch64，应用 `ai.ohpc.zcode`，基于 OHOS Electron 运行时：Chromium 132 / Node 20.18.1）。上游桌面 / Web / CLI 功能保持一致，不引入运行时补丁。

| 文档                                                   | 内容                                   |
| ------------------------------------------------------ | -------------------------------------- |
| [01-构建与打包.md](./01-构建与打包.md)                 | 环境要求、构建/热推命令、常见坑        |
| [02-运行时架构与适配层.md](./02-运行时架构与适配层.md) | 移植过程中遇到的问题与解法（按适配点） |
| [03-平台权限与系统约束.md](./03-平台权限与系统约束.md) | 平台事实清单：权限 / V8 ABI / 沙箱约束 |

## 三个关键决策

**为什么选 Electron（而不是 ArkTS 重写或套壳重打包）？**
Electron 路线让 UI、业务逻辑、RPC 协议、Agent CLI **100% 复用上游源码**——本次移植没有改一行 renderer/组件代码，只适配「运行时层 + main 进程平台分支」。ArkTS 重写等于双份维护；套壳重打包（ohos-linux-zcode 路线）是拿不到源码时代的产物，已废弃（其沙箱实测结论仍被用作风险参考）。

**为什么 zsh + harmonybrew 环境可用？**
三个平台事实叠加：①用户目录下的 ELF **可以 exec**（需 `CUSTOM_SANDBOX` 动态沙箱权限）——harmonybrew 安装的 git/java/node 对应用可执行；②应用经用户授权可读真实 home（`READ_WRITE_USER_FILE`），因此能解析 `~/.zshenv/.zprofile/.zshrc` 并把 export 的环境**重放**给应用四端（main / host / agent / 终端）；③系统 rootfs 的 `/bin/sh`（toybox）始终可 exec，作终端兜底。用户装完 brew 工具，应用内开箱即用。

**为什么不重编 Electron 就能跑起来？**
所有平台约束在适配层解决：二进制级只做一处 4 字节×2 的 io_uring 禁用补丁（构建期、幂等），其余全部是源码分支、兼容层与构建管线。

## 做了什么（适配层一览）

| 位置                                                            | 作用                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| `packages/desktop/ohos/`                                        | HAP 应用工程（ArkTS 壳 + Electron 运行时 + hvigor 配置） |
| `packages/desktop/native/ohos-*`                                | OHOS 专属 C 源码（sqlite 绑定、HMDFS link 垫层）         |
| `packages/desktop/scripts/{build,bundle,dev}-ohos*.mjs`         | 构建 / 打包 / 设备热推管线                               |
| `packages/shared/src/nodeSqliteCompat.ts`                       | node:sqlite 兼容层（Node 20 无此 API）                   |
| `packages/services/src/ohos/`                                   | 用户 shell 环境注入共享模块                              |
| `packages/services/src/terminal/ohosTerminalPty.ts` + main 中继 | 终端伪终端方案                                           |
| main 进程若干 `desktopOhos*.ts` / host 早期引导                 | 平台分支与环境引导                                       |

## HAP 工程内部（packages/desktop/ohos/）

- `electron/`（entry 模块）：ArkTS 入口（EntryAbility、XComponent 页面）+ `libs/arm64-v8a/` 原生库；
- `web_engine/`（har 模块）：OHOS Electron 的 ArkTS 绑定层 + 运行时资源（resfile 的 pak/icudtl/locales 等）；
- `resfile/resources/app/`：ZCode 源码构建产物（main/preload/renderer/host + 运行时 node_modules + agent bundle），由 build-ohos.mjs 组装，不入库；
- 原生库（`libadapter.so` / `libelectron.so` / `libffmpeg.so`）= OHOS Electron 运行时，等价于桌面版对 electron npm 包的依赖；`ohos_sqlite_adapter.node` 为 sqlite 兼容层后端候选，`pty.node` 为 node-pty OHOS prebuild。

## 怎么用

```bash
pnpm bundle:desktop:ohos   # 打包（未签名 HAP，零门槛可构建；详见 01）
pnpm dev:ohos              # 开发热更到真机（hqf 补丁 ~8s；详见 01）
```

## 问题 → 对策速查（详情见 02/03）

| 问题                                                    | 对策                                                    |
| ------------------------------------------------------- | ------------------------------------------------------- |
| seccomp 拒 io_uring → SIGSYS 击杀进程                   | 构建期二进制补丁禁用（`ohos-patch-libelectron.mjs`）    |
| 沙箱默认禁 RWX → V8 无 JIT/WASM                         | 早期加载 sqlite 绑定触发 `prctl(SET_JITFORT)`           |
| `app.isPackaged` 恒 false、`process.title` 赋值 SIGSEGV | 显式平台守卫 + `assignProcessTitle()` 收口              |
| Node 20 无 `node:sqlite`                                | 自有 NAPI 绑定 + 兼容层（详见 02）                      |
| V8 Smi ABI：数字经 napi 对象/数组路径即 SEGV            | 包装层把参数展开到 cb_info 位置通道（铁律，详见 03）    |
| `/dev/ptmx` 被拒 → 无伪终端                             | pty 由 main 进程创建经 MessagePort 中继；降级管道哑终端 |
| HAP 安装区（el1）noexec，随包 zsh 起不来                | 终端回退 `/bin/sh`；zsh 走用户目录（可 exec）           |
| host 由 appspawn 拉起、不继承 main env                  | 用户 shell env 在 main/host 双入口重放（同一共享模块）  |
| HOME 对应用常无写权                                     | 早期写权探测 → 回退沙箱 + 一次目录授权后迁回            |
| hvigor 增量不感知 resfile 变化                          | 全量前清缓存（脚本已自动处理）                          |
