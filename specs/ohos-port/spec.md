# ZCode 鸿蒙移植（OHOS Port）Spec

状态：v3（2026-09-27，路线定稿：**路线 B，鸿蒙版 Electron**）
范围：本仓库（ZCode 官方源码 v3.14.3）移植到 HarmonyOS PC（aarch64，HongMeng 内核），内置终端接入 zsh + harmonybrew 环境。

## 0. 方向修正（2026-09-27）

- v1 草案曾计划复用 ohos-linux-zcode 的 HAP 壳 + entry.mjs/wrapper.mjs 兼容垫片路线，**已废弃**。该项目是对官方 Linux arm64 发行包的套壳重打包（当时拿不到源码）；本仓库持有完整源码，移植必须在源码级别完成。
- ohos-linux-zcode 的价值降级为**沙箱约束参考**：应用沙箱与 HiShell 的 uid/mount 隔离、HMDFS 权限行为、exec MAC 策略、JIT/seccomp 限制等实测结论（docs/01-03、06）仍然有效，作为风险清单使用；其壳代码、垫片、elf-loader 机制一概不复用。
- 移植目标运行时：**鸿蒙原生能力**，两个候选路线见 §1，路线待定稿。

## 1. 架构（路线 B：鸿蒙版 Electron，已定稿）

```
HAP（本仓库 ohos/ 应用工程 —— 应用本体，非套壳）
  ArkTS 层: EntryAbility → Window → XComponent("adapter")
  Native 层: libadapter.so → libelectron.so（OHOS Electron 运行时，Node 20.18.1 / Chrome 132）
  资源层:   resfile = Electron 运行时资源 + resources/app
              resources/app = packages/desktop 源码构建产物（main/preload/renderer/host + 运行时依赖）
```

原则：**一切适配发生在本仓库源码内**（平台分支、兼容模块、构建管线），不修改第三方 bundle、不做运行时 monkey-patch。OHOS Electron 的 .so 作为运行时依赖引入（如同 electron npm 包之于桌面版），随构建组装进 HAP。

源码改造清单（Route B 专用）：

1. **平台分支**：`process.platform === "openharmony"` 显式处理（不伪装 linux）：
   - main：icons、window chrome、deep link（OHOS 跳过 xdg 注册）、auto-updater（OHOS 禁用）、`process.title`/`app.setName` 的 OHOS Electron 崩溃点在源码内 guard。
   - shared：平台 key 对服务端 API 报 `linux-aarch64`（服务端不认 openharmony）。
2. **node:sqlite 兼容（Node 20.18 无此 API）**：`packages/shared/src/nodeSqliteCompat.ts` 的 `loadNodeSqlite()` 统一入口——真实 API 优先；OHOS 首选**自有 NAPI 绑定 `zcode_sqlite.node`**（`ohos/native/zcode-sqlite/` 源码 + SQLite 3.53 amalgamation 经 OHOS SDK clang 交叉编译，语义与 node:sqlite 一致：裸名/前缀命名参数、真实 step、changes/lastInsertRowid、setReadBigInts；用户域签名宿主可测——完整测试 `.ohos-test/nodeSqliteCompat.test.mjs` 已全绿），仍保留 ohos_sqlite_adapter.node 兜底（其缺陷经 OhosDatabaseSync 绕过；该二进制按签名域管控，仅 el1 bundle 可加载）。调用点改造：services 三个 repo + tasksDatabase/startup、desktop chromeCookieManager（backup 用 VACUUM INTO 等价实现）、CLI sqlite-session-store 与 debug/server/sources（debug 包新增 `@zcode/shared` 依赖）。
3. **fs/promises.glob 兼容**：`packages/services/src/system/sshConfigAlias.ts` 的 glob 命名导入在 Node 20 ESM 链接期即失败；改为 `iterateGlobMatches()` 运行时检测，缺失时回退字面量路径匹配（SSH Include glob 展开能力降级，不影响其余解析）。
4. **node-pty**：OHOS 交叉编译 prebuild（`prebuilds/openharmony-arm64/pty.node`，`-DNAPI_VERSION=8`）；OHOS Electron libuv 的 `uv_tty_init` EINVAL 缺陷经 `patches/node-pty*.patch`（本仓库既有 patch-package 机制）以源码补丁方式提供 fs.read 回退。
5. **终端 zsh + harmonybrew**：`terminalService.ts` 注入 `PATH`（前置 `$HOME/.harmonybrew/bin`、`$HOME/.harmonybrew/sbin`）、SHELL 解析加 zsh 候选（随包 zsh 资产优先）、UTF-8 locale、随包 zsh 的 `LD_LIBRARY_PATH`；HOME 指向与 brew 前缀的解析在源码内明确（沙箱 HOME vs 真实用户 home 的取舍以装机实测为准）。环境注入链：main 早期引导（`desktopEarlyOhosEnvBootstrap.ts`，扫 `/storage/Users/*/.harmonybrew` 定位真实前缀 + PATH 前置 + `ZCODE_OHOS_BREW_PREFIX`）→ `buildHostProcessEnv` 下发 `ZCODE_OHOS_SHELL`（随包 zsh，`resfile resources/app/tools/zsh/`，构建期从 `ohos/app-assets/zsh/` 组装）→ host 终端服务消费。
6. **构建管线**：`scripts/build-ohos.mjs` —— 调用现有 desktop 构建（tsup target 调整为 node20 兼容）、node_modules 运行时闭包、产物重排为 resfile/resources/app（明文目录，无 asar）、组装 HAP（hvigor）。
7. **HAP 工程**：标准 ArkTS 应用（module.json5、EntryAbility、XComponent），权限声明（INTERNET、剪贴板等按 ohos-linux-zcode 风险清单）。

## 2. 状态所有者（两路线通用）

| 状态 | 所有者 | 说明 |
|---|---|---|
| OHOS 平台判定 | `packages/shared` 平台工具（新增） | `process.platform === "openharmony"` 显式分支，不伪装 |
| 终端 shell/env | 路线 A：server 终端服务；路线 B：`terminalService.ts` `resolveTerminalShell/resolveTerminalEnv` | 唯一入口注入 harmonybrew PATH，不改全局 env |
| native 模块构建 | OHOS 交叉编译脚本（新增于 scripts/） | node-pty 等产物随构建产出 |
| HAP 组装 | `scripts/build-ohos*.mjs` + ArkTS 工程 | 只消费本仓库构建产物 |

## 3. 验收场景

1. 源码构建产出 HAP，安装到本机，应用启动可用。
2. 会话链路端到端：发消息 → agent 响应 → 会话持久化。
3. 内置终端：默认 zsh，`echo $PATH` 含 `$HOME/.harmonybrew/bin`，`git`/`node` 等 brew 工具可用（若沙箱 exec 策略拦截，如实报告并回到用户对齐方案）。
4. 回归：`pnpm typecheck`、`pnpm lint` 通过；现有 Linux/macOS/Windows 行为不变。

## 4. 非目标

- 不复用 ohos-linux-zcode 的壳代码、运行时垫片、elf-loader、brewbin 垫片机制。
- 不在本仓库重编 Electron/Chromium。
- openEuler（`loh`）仅作构建辅助环境，不是运行目标。
