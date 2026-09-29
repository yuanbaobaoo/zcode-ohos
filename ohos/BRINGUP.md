# ZCode OHOS 装机手册（macOS headless 组装 + 冒烟验证）

> 面向第一次把本仓库的 ZCode 装到鸿蒙 PC 的操作者。
> 前置知识：`specs/ohos-port/spec.md`（架构与验收场景）、`ohos/docs/`（技术文档）。
> 主构建环境为 macOS（真机经 hdc 连接），全流程 headless。

## 1. 组装 resfile 产物

resfile 产物（`ohos/web_engine/src/main/resources/resfile/resources/`）由构建管线生成且不入库（gitignore）。

首次环境初始化（新 checkout / 新机器）见 `ohos/docs/01-构建与打包.md` §新环境一次性初始化：
libelectron.so 取回（旧仓 LFS）、zcode_sqlite.node 交叉编译、devecocli 登录与签名。

```sh
pnpm install                                # 依赖原生可用
sh ohos/native/zcode-sqlite/build.sh        # 交叉编译 sqlite 绑定（改 C 源后必须）
ZCODE_TARGET_OS=linux ZCODE_TARGET_ARCH=arm64 pnpm --dir packages/desktop prepare:runtime-assets  # bundled-tools/glm 资产（build-ohos 已默认注入该 env）

node scripts/build-ohos.mjs                 # 全量（workspace 构建 + agent bundle + 组装）
node scripts/build-ohos.mjs --skip-agent    # 迭代 main/renderer（跳过 agent bundle 重打）
node scripts/build-ohos.mjs --skip-build --skip-agent   # 只重新组装 resfile（如仅换 .node）
```

## 2. headless 组装与签名（macOS）

标准打包通道（推荐，产物落 `packages/desktop/dist/`，含未签名版）：

```sh
pnpm bundle:desktop:ohos       # = pnpm bundle:desktop -- --os ohos
```

底层手动组装（等价拆步；hvigorw 路径见 docs/01 §环境要求——`OHOS_HVIGORW` 或 `OHOS_COMMAND_LINE_TOOLS` 指定，下方为作者机器示例路径）：

```sh
cd ohos
/Users/Shared/local/ohos/command-line-tools_26.0.0_Beta1/bin/hvigorw \
  assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
# 产物：ohos/electron/build/default/outputs/default/electron-default-signed.hap
```

hvigor 增量构建不感知 resfile/libs 变化，装机迭代前必须清理缓存：

```sh
rm -rf ohos/.hvigor ohos/electron/build ohos/web_engine/build
```

签名材料首次由 `devecocli auth login`（浏览器华为账号）+ `devecocli signature generate`
生成并写入 build-profile.json5（材料在 `~/.ohos/config`，机器相关、不入库）。

安装与启动（hdc = command-line-tools `sdk/default/openharmony/toolchains/hdc`）：

```sh
hdc install -r ohos/electron/build/default/outputs/default/electron-default-signed.hap
hdc shell "aa start -a EntryAbility -b ai.ohpc.zcode"
hdc shell "aa force-stop ai.ohpc.zcode"    # 停应用
```

注意：设备锁屏时 `aa start` 报 10106102（developer mode 不能自动解锁），需手动解锁后重试。

首次启动需在应用内完成授权：全盘文件访问弹窗（先说明后跳设置）与用户目录授权，
详见 `ohos/docs/03-平台权限与系统约束.md`。

## 3. 冒烟清单（按序）

| # | 场景 | 通过标准 | 失败时看什么 |
|---|---|---|---|
| 1 | 启动 | 主界面出现，无黑屏 | hilog 过滤 `A00001/ai.ohpc.zcode/Electron`；`database startup phase=` 逐条应为 ready |
| 2 | 数据库启动 | hilog：`database startup phase=ready` 且 `local services ready, all channels registered` | `[zcode-host] local database startup failed`（错误对象含 workerExitCode/workerStderrTail/systemCode 诊断字段） |
| 3 | 会话 | 登录 provider → 发消息有模型响应；任务列表出现会话；重启后仍在 | agent 侧 jsonl 日志、hilog `zcode-agent-service` 与 task-index 诊断行 |
| 4 | 终端 | shell 为 `/bin/sh`（回退形态，随包 zsh 见约束文档）；`echo $PATH` 前缀含 `$HOME/.harmonybrew/bin`；`git --version` 可执行 | PATH 缺注入 → `ohos-host-env` / `ohos-bootstrap` 日志；Permission denied → CUSTOM_SANDBOX 权限未生效 |
| 5 | agent 工具 | 对话里让 agent 跑 `git status` 等命令 | agent 的 Bash 输出与 hilog |

## 3.5 真机 UI 自动化（双通道）

| 通道 | 工具 | 覆盖面 | 说明 |
|---|---|---|---|
| **CDP（web 内容层）** | `node ohos/scripts/device-cdp.mjs <cmd>` | 应用全部 UI（Electron 页面） | 前置 `hdc fport tcp:9229 tcp:9229`；子命令：elements/eval/click/clicksel/type/key/shot/info。点击走 Chromium Input 事件管线（React 正常响应）；CJK 文本用 `execCommand("insertText")`（key 事件无法组合中文） |
| **系统层** | `devecocli ui <cmd>`（click/swipe/screenshot/layout/window） | 系统弹窗、锁屏、原生 ArkUI 组件 | CDP 看不到的原生弹窗用这条；`uitest dumpLayout`（hdc）给原生组件精确 bounds。web 内容点击需换算 CSS→物理坐标（含系统缩放），web 内容优先走 CDP |

典型自动化冒烟（无人工）：

```sh
hdc fport tcp:9229 tcp:9229
node ohos/scripts/device-cdp.mjs info                          # 页面就绪
node ohos/scripts/device-cdp.mjs clicksel "button"             # 点击
node ohos/scripts/device-cdp.mjs type "..."                    # 键入
node ohos/scripts/device-cdp.mjs eval "document.querySelector('input')?.value"  # 断言
devecocli ui screenshot --path /tmp/screen.png                 # 物理屏幕取证
```

## 4. 平台约束速查（装机相关）

完整清单见 `ohos/docs/03-平台权限与系统约束.md`。与装机直接相关的三项：

- **brew 工具 exec 依赖 `CUSTOM_SANDBOX`（动态沙箱）**：缺失时终端/agent 执行
  brew 工具报 EPERM（toybox 文案与"未安装"相同）
- **终端当前为管道哑终端**（ptmx 被拒）：无 vim/top 全屏交互；PATH/回显/命令执行正常
- **数字参数不可经 napi 数组/对象路径进 native**（V8 Smi ABI）：适配层已收口，
  新增 NAPI 取值路径时遵守"数字只走 cb_info 通道"

## 5. 沙箱身份与路径备忘

- 应用 uid 由 appspawn 分配（本机实测 20020221）；`/storage/Users/currentUser` 在应用沙箱内为可写视图（真实用户目录形态待确认）
- 应用可写区：`/data/storage/el2/base/files`（HOME 回退目标）
- `.node` 的 require 有 loader 重定向行为（bundle libs），zcode_sqlite.node 双份投放（app 根 + HAP libs）
- 网络：`ohos.permission.INTERNET` 已声明，loopback 跨沙箱互通
- hdc shell（uid 2000，file_manager 组）可读应用 el2 目录；HMDFS 用户区与 el1 bundle 对 shell 不可见
