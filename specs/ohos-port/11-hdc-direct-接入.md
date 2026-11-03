# 11 hdc-direct 接入

在鸿蒙 HAP 内提供可用的 HDC 通道：绕开不可启动的 hdc server，直连设备端 hdcd，
让 agent 能完成「构建 → 签名 → 安装 → 启动 → 看日志」的最后一段。

上游组件：[hdc-direct](https://github.com/yuanbaobaoo/hdc-direct)（TypeScript，零运行时依赖，Apache-2.0）。

## 背景

官方 hdc 是 `client → UDS server → TCP daemon` 三段式。HAP 沙箱（SELinux 域
`develop_tools_debug_hap`）禁止绑定 AF_UNIX socket，hdc server 起不来：

```
bind uds addr fail! ret:-13
```

于是 `hdc list targets` 恒为空，devecocli 报 `No active devices`，HAP 装不上。
设备端 hdcd 本身监听 TCP 无线调试端口（`persist.hdc.port`），且不限制来源进程，
所以可以直连。

## 目标 / 非目标

目标：

- agent 在真机上能列出目标、执行设备 shell、上传文件、安装并拉起 HAP；
- 不引入新的可执行文件、HNP 包或用户侧安装步骤。

非目标：

- 接管 devecocli 内部的 hdc 解析（其 `COMMAND_LINE_TOOL_PATH` 行为属外部实现）；
- 提供 shell 命令 `hdc` / `hdc-direct`；
- USB 直连、端口转发、多设备广播发现等 hdc server 侧能力。

## 为什么是进程内调用

OHOS 上应用域 exec 二进制被 MAC 拦（`zcodeAgentProcessManager.ts` 注释：agent 改走
进程内 Worker，一并绕开 HNP execPath ENOENT）。因此：

- HAP 内没有可被 `spawn` 的 Node 可执行文件，无法做 shell 包装命令；
- HAP 内 ELF 还受 hmac 执行白名单与 HNP 代码签名管制（见 03），不能放原生二进制。

结论：hdc-direct 只能作为**纯 JS 库**随 `glm/` 打包，在 agent 进程内被 `import` 调用。

## 组件与所有权

| 关注点 | 所有者 | 说明 |
| --- | --- | --- |
| 能力边界 | `core/src/capabilities/ohos-device/` | 唯一入口 `ohosDeviceTools()`；工具、schema 引用与开关都在这一层 |
| 能力开关 | `ZCODE_OHOS_HDC_BRIDGE` | 打包与运行时读同一个变量；`0/off/false/native/disabled` 关闭 |
| 工具 schema | `contracts/src/tools/ohos-hdc.ts` | 工具 schema 统一归 contracts（zod3 与 `toToolJsonSchema` 同源） |
| 依赖声明 | `packages/desktop/package.json` 的 `dependencies.hdc-direct`（GitHub Release npm tgz URL） | 完整性由 `pnpm-lock.yaml` 的 integrity 记录，`--frozen-lockfile` 校验 |
| 资产获取 | `packages/desktop/scripts/bundled-hdc-direct-assets.mjs` | 把已安装的 `node_modules/hdc-direct` 复制到 `<glm>/node-runtime/hdc-direct/`（入口校验，幂等） |
| 资产落位 | `build-ohos.mjs` `stageRuntimeResources()` | 随 `glm` 复制到 `resfile/resources/glm/`，不额外加复制路径 |
| 打包门禁 | `bundle-ohos.mjs` 预检 | 开关启用且资产缺失时直接失败，不产出不完整 HAP |
| 运行期调用 | `core/src/capabilities/ohos-device/hdc-direct.ts` | 动态 import 资产，复用 `HdcSession` |
| 工具注册 | `core/src/tool/handlers/index.ts` | 只写 `...ohosDeviceTools()`，无平台分支 |
| 模型指引（工具层） | 工具 `description` + `modelInstructions` + `alwaysLoad` | 说明工具本身怎么用 |
| 模型指引（平台层） | `core/src/capabilities/ohos-device/context-section.ts` | 系统提示词 section：宣告「hdc/devecocli 部署在本机必败」的平台事实与 `ohos_hdc` 路线。仅有工具描述不够——用户提示词点名 `devecocli` 时模型被锚定进 CLI 路线，不会去读工具描述（2026-11-02 真机实测）。由 `context/builder.ts` 按 `envInfo.platform` 注入，读同一个 `ZCODE_OHOS_HDC_BRIDGE` 开关 |
| 设备凭据 | hdc-direct（`~/.harmony/hdckey`） | 首次连接由设备弹「允许调试」，允许后进白名单 |
| target 状态 | hdc-direct（`~/.harmony/hdc-direct-targets.json`） | 工具默认用 `127.0.0.1:<persist.hdc.port>` |

资产是只读的：运行期不下载、不改写、不重建。

## 数据流

```text
packages/desktop 依赖 URL（版本号唯一人工输入）
  └─ pnpm install ──▶ node_modules/hdc-direct（lockfile integrity 校验）
        └─ prepare:agent-bundle 复制 ──▶ <glm>/node-runtime/hdc-direct/
              └─ HAP: resfile/resources/glm/node-runtime/hdc-direct/
                    └─ 运行期 ZCODE_BUNDLED_RESOURCE_DIR 定位
                          └─ ohos_hdc 工具（agent 进程内）
                                └─ HdcSession ──TCP──▶ hdcd 127.0.0.1:<persist.hdc.port>
```

## 工具契约

工具名 `ohos_hdc`，仅 OHOS 注册。动作：

| action | 语义 | 关键参数 |
| --- | --- | --- |
| `list_targets` | 列出可用目标（状态文件 + 本机端口探测） | — |
| `shell` | 在设备执行命令并返回输出 | `command` |
| `file_send` | 上传本地文件到设备路径 | `localPath`、`remotePath` |
| `file_recv` | 下载设备文件到本机 | `remotePath`、`localPath` |
| `screenshot` | 截取设备屏幕并落盘本机，返回可 Read 的路径 | `localPath?`、`displayId?` |
| `install` | 上传 HAP 并 `bm install -r -d`，可选 `aa start` | `hapPath`、`bundleName?`、`ability?` |

`screenshot` 封装 `snapshot_display -i <display> -f <tmp>.jpeg -t jpeg`（设备侧）+
`fileRecv`（hdc-direct `CMD_FILE_INIT` 反向传输）+ 设备中转文件清理，模型只需一次调用。
此前没有该动作时，真机会话为把截图带回主机会自行探测 `nc`/`base64` 并写两个临时
Node 脚本（2026-11-02 `test` 项目实测），因此截图与 `file_recv` 属于必需的闭环能力，
不是便利封装。

target 解析顺序：`target` 参数 → `ZCODE_HDC_DIRECT_PORT` 环境变量 → `param get persist.hdc.port`。

`bundleName`/`ability` 只接受标识符字符（`A-Za-z0-9_.$`）；上传到设备的 HAP 文件名会过滤为
`A-Za-z0-9._-`，避免本地文件名改变设备侧命令语义。`ZCODE_HDC_DIRECT_MODULE` 仅开发态生效，
发布包只从 glm 资产加载 hdc-direct。

权限：`needsApproval: true`、`destructive: true`（`shell`/`install` 会改设备状态），
与 Bash 同级审批；`list_targets` 仍走同一入口，避免出现绕过审批的第二条设备通道。

## 失败模式

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 工具返回「资产缺失」 | 打包未带 hdc-direct（旧包 / `--skip-agent`） | 重新打包；`bundle-ohos` 已硬失败拦截 |
| 入口文件缺失 | 依赖未安装或版本不含 `dist/src` | `pnpm install` 后重试；staging 会硬失败 |
| tarball 校验失败 | Release 资产被覆盖/损坏 | `pnpm install --frozen-lockfile` 即失败，换版本重发 |
| 首次连接卡住/被拒 | 设备未授权新公钥 | 提示用户在设备上点「允许调试」后重试 |
| `07880109 interrupted` | 私钥带口令 | 换成无口令的 `~/.harmony/hdckey` |
| 连接超时 | 无线调试关闭或端口变化 | 重新读取 `persist.hdc.port`，确认开发者选项 |
| 非 OHOS 调用 | 工具不应存在 | 注册期已排除 |
| 开关关闭 | `ZCODE_OHOS_HDC_BRIDGE=0` 等 | 工具不注册、资产不打包；让位给系统 hdc |

## 验收场景

1. OHOS 会话中存在 `ohos_hdc` 工具；非 OHOS 或 `ZCODE_OHOS_HDC_BRIDGE=0/off/native` 时不注册。
2. `list_targets` 返回 `127.0.0.1:<port>`（无线调试已开）。
3. `shell "id"` 返回 `uid=2000(shell)`。
4. 上传 5 MB 文件后设备侧 md5 一致。
5. `install` 一个已签名 HAP，输出 `install bundle successfully`，`--launch` 时随后
   `start ability successfully`。
6. 资产缺失时调用返回结构化错误并提示重新打包，不抛未捕获异常。
7. `prepare:agent-bundle` 重复执行不重复下载（缓存命中）。
8. OHOS 会话的系统提示词含「HarmonyOS Device Debugging」段；`ZCODE_OHOS_HDC_BRIDGE`
   关闭或非 OHOS 平台时该段不出现。
9. 用户提示词为「使用 devecocli 将项目调试、安装到本地」时，模型按平台事实分治：
   `devecocli`/`hvigorw` 只用于构建与签名，部署、启动、取日志走 `ohos_hdc`，
   不去诊断 `No active devices`（2026-11-02 真机实测曾在此卡住）。
10. 用户要求「把运行截图发我」时，模型只调用一次 `ohos_hdc` `screenshot` 并 Read 返回
    路径；不得自行拼 `nc`/`base64` 传输或写临时脚本（2026-11-02 `test` 项目实测
    曾为此多花 20+ 次工具调用）。
11. `file_recv` 下载 5 MB 文件后本机与设备 md5 一致；`screenshot` 返回的 JPEG 可被
    Read 工具正常打开。

## 能力开关与移除

**停用（不删代码）**：设置 `ZCODE_OHOS_HDC_BRIDGE=native`（或 `0`/`off`/`disabled`）。
打包跳过下载与门禁，运行时不注册工具。适用于鸿蒙原生支持沙箱内 hdc 调用之后的过渡期。

**彻底移除**（按序；删除项 1-5 同前，6-8 为提示词接入的回退触点）：

1. 删除目录 `apps/zcode-cli/packages/core/src/capabilities/ohos-device/`（含工具与提示词 section）；
2. 删除 `apps/zcode-cli/packages/contracts/src/tools/ohos-hdc.ts`，并去掉 `contracts/src/tools/index.ts` 的导出行；
3. `core/src/tool/handlers/index.ts`：删 import 与 `...ohosDeviceTools()` 两行；
4. `packages/desktop/scripts/`：删 `bundled-hdc-direct-assets.mjs`，去掉 `prepare-agent-node-bundle.mjs` 的 import、调用与 `stageBundledHdcDirectRuntime`，去掉 `bundle-ohos.mjs` 的预检块与 import；
5. 删除测试 `core/tests/ohos-hdc-handler.test.ts`、`packages/desktop/test/bundledHdcDirectAssets.test.ts`，并移出 `scripts/engineering-test-files.json`；
6. 删除 `architecture-policy.yaml` 的 `ohos-hdc-direct-bridge` 例外；
7. `core/src/context/builder.ts`：删 `buildOhosDeviceContextSection` 的 import 与注入块；
8. `core/src/context/types.ts`：删 `ContextSource` 联合中的 `"ohos_device_context"`。

移除后 `core` 的上下文与 builder 无逻辑残留（`types.ts` 仅余一个字符串成员删除）。

## 版本与升级

依赖模型（与 `node_modules` 依赖同等待遇）：

- **升级只需一处**：`packages/desktop/package.json` 里 `dependencies.hdc-direct` 的 URL 版本号，
  然后 `pnpm install`。staging、测试、包内版本读取全部派生，无需其他改动。
- 完整性：`pnpm-lock.yaml` 记录 tarball 的 sha512 integrity，`pnpm install --frozen-lockfile`
  （CI 采用）在安装期校验；`pnpm audit` 等依赖工具链自然覆盖。
- 上游发布 npm 布局 tgz（顶层 `package/`，`name= hdc-direct`）；协议变化时先在上游仓库
  通过真机验收，再升版本。
- 运行期不解析 `node_modules`：打包脚本复制进 glm，进程内按
  `ZCODE_BUNDLED_RESOURCE_DIR/node-runtime/hdc-direct` 定位。
- `THIRD-PARTY-NOTICES.md` 由 lockfile 生成，下次再生成时自动收录本依赖；tarball 自带
  LICENSE 一并随包分发。
