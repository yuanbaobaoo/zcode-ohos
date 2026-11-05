# 14 Agent 自动化链路故障排查

Agent 的自动化能力是一条多层链路；任何一层断开都表现为"Agent 说做不了"，但根因完全不同。
本文按「链路 → 症状 → 取证 → 处置」组织，供下次同类问题快速定位。

## 链路全景

```text
模型
 └ mcp__node_repl__js（MCP 工具）
    └ node_repl host 进程（stdio MCP server）
       └ cua-broker（UDS + token，socket 落 ZCODE_OHOS_SOCKET_DIR）
          └ OhosComputerUseRuntime（packages/zcode-cua/ohos-computer-use.js）
             └ ArkTS 桥（computer-control/ 文件桥）→ screenshot / inputEventClient / startAbility

旁路（调试/部署，不依赖 MCP）：
  ohos_hdc（hdc-direct 直连 hdcd）/ devecocli（应用内迷你 CLT，见 11）
```

**关键结论**：CUA 的每一层都经由 `mcp__node_repl__js`。该工具缺席时，技能加载、插件开关、
权限授予全部正常也无济于事。

## 症状速查

| # | 症状 | 根因 | 状态 / 处置 |
| --- | --- | --- | --- |
| 1 | MCP 面板全红「MCP 进程启动失败」，`ps` 无 `server.mjs` | bundle 树 ELF 无执行位 → `execve` EACCES | 已修：`resolveOhosSpawnableNodeExecPath` |
| 2 | 会话工具面无 `mcp__node_repl__js`（面板可能绿） | ① 同 #1；② 15s 连接竞速、迟到不补注册 | ① 已修；② 开放问题 |
| 3 | Agent 在 Bash 里翻 socket、自造 bridge | 没拿到 #2 的工具，退化为旁路探索 | 修 #2 即消失；别按它猜的路径排查 |
| 4 | `ohos_hdc` 报 `required parameter 'action' is missing` | 多路 discriminatedUnion 让 GLM 系模型绑定失败 | 已修：schema 拍平 + 逐 action 校验 |
| 5 | `ohos_hdc` 报"无法确定设备端口" | 发现链只认 `persist.hdc.port`；hdcd 可能仍在 `0.0.0.0:46273` | 显式 `target: "127.0.0.1:46273"`；发现链增强是开放项 |
| 6 | Agent Bash 读不到 `/data/local/tmp` 的文件 | 应用沙箱的 `/data/local/tmp` 是独立空目录 | 走工作区路径或直接贴命令文本 |
| 7 | Bash 里 `rg`/`find`/`ugrep` 报 Permission denied | resfile 内工具同样无执行位 | 未修；用 `/bin/grep`、`/usr/bin/find` 或 harmonybrew 工具 |
| 8 | 截图 `unavailable` | 权限被撤销 / 截屏 API 失败 | 已改用 `@ohos.screenshot`；查 `checkScreenCapturePermission` 日志 |
| 9 | 录屏 0 帧 | 截屏失败 / 权限撤销 | 先验证单张截图；帧流复用截屏权限 |
| 10 | CUA 报 "runtime bridge is unavailable" | ① runtime 标记被 env 清洗；② broker UDS 落真实 home 被拦 | 已修：`ZCODE_OHOS_CUA_RUNTIME` + `ZCODE_OHOS_SOCKET_DIR` |
| 11 | 模型说 "no window bound"，转去 `list_windows` | 伪应用模型没有窗口绑定 | 已修：`list_apps` 真列表 + `get_app_state(appRef)` 透明拉起 |
| 12 | `devecocli device list` 报 `No active devices` | 它不读 PATH，按工具链根找 hdc；默认回退 HNP 官方 hdc（起不了 server） | 已修：应用内迷你 CLT + 环境变量注入（见 11） |
| 13 | 应用启动后开关仍 ON、权限其实已撤销 | 插件启用态持久化 | 已修：`useOhosCuaPermissionReconcile` 启动回收（见 13） |

## 取证工具箱（按可靠性）

| 工具 | 用途 | 注意 |
| --- | --- | --- |
| `ps -ef \| grep 'server.mjs'` | 最硬证据：MCP 是否真的 spawn | 比面板可信；进程活着 = spawn 修复生效 |
| `~/.zcode/cli/rollout/model-io-<sessionId>.jsonl` | 唯一能证明"模型发了什么" | 区分模型能力问题与 harness 丢参 |
| MCP 面板 | 服务器连接状态 | mcp-status 用独立进程；面板绿 ≠ 会话工具面有 |
| `devecocli log --bundle-name ai.ohpc.zcode --from 2m` | 应用 hilog（含 main/host 转发） | 需 `DEVECO_CLI_CLT_PATH`；否则报 "DevEco Studio installation not found" |
| `hdc shell hilog -x` 落盘 grep | 系统事件（MMI、ability、SELinux） | 缓冲区有限，重启即丢 |
| `devecocli ui layout/screenshot` 或 `hdc shell snapshot_display` + `file recv` | 布局与截屏 | Electron 内容只有 `rootWebArea` 壳，取不到 web 文本 |
| `aa start … --ps zcode.selftest screenshot\|record\|launch:<bundle>` | 免模型自检 | 先 `aa force-stop`，否则不触发 onCreate |
| 应用内 Bash（让 Agent 执行） | 读应用命名空间 `~/.zcode/...` | shell 域读不到应用命名空间；反之亦然 |

## 教训

1. **先分类再归因**：用 model-io 原文区分「模型没发工具 / 工具没注册 / 调用被拒」。
2. **日志分域**：hilog（系统 + main/host console）≠ 应用命名空间文件（CLI/agent 结构化日志）
   ≠ ArkTS tag `ComputerControl`。拿错工具会得出"没有日志"的错误结论。
3. **面板状态不是会话事实**：面板走独立进程，与会话 pool 不同。
4. **UI 注入的坑**：中文 IME 吞 ASCII；`uitest uiInput` 长文本易截断（分段输入）；
   组合键到不了 Electron；清空用循环 `keyEvent 2055`；`snapshot_display` 是 3120×2080，
   分析图缩放后按比例换算坐标。
5. **模型额度会中断验证**：额度耗尽时改走进程表 / 面板 / 自检命令等不依赖模型的证据。

## 开放问题

1. **15s 连接竞速**：`initializeMcp` 用 15s 快照工具表；node_repl 迟到连接不补注册。
   修法：宿主连接成功后主动递增 `toolListRevision`，或对 host MCP 用完整连接预算。
2. **resfile 内工具无执行位**（`rg`/`bfs`/`ugrep`）：需在 agent bundle staging 侧解决。
3. **打包侧根治**：让安装器给 bundle 内 ELF 加执行位（需厂商支持）。
4. **`ohos_hdc` 端口发现**：补 `/proc/net/tcp` uid-2000 监听项兜底，并让报错给出探测路径。
5. **CUA 端到端（模型级）**：自检与单测已覆盖截图/录屏/拉起；模型额度恢复后按 13 的验收表复测。

## 复现与验证命令

```bash
export DEVECO_CLI_CLT_PATH=/Users/Shared/local/ohos/command-line-tools_26.0.0_Release

# MCP 是否真的起来
hdc shell "ps -ef | grep -E 'node .*server.mjs' | grep -v grep"

# 免模型自检（先 force-stop）
hdc shell "aa force-stop ai.ohpc.zcode"
hdc shell "aa start -a EntryAbility -b ai.ohpc.zcode --ps zcode.selftest screenshot"
devecocli log --bundle-name ai.ohpc.zcode --from 1m | grep -E "screenshot ok|record stopped|launch dispatched"

# 设备通道
devecocli device list            # 应直接列出设备（迷你 CLT 已注入）
hdc shell "command -v hdc; ls -l \$HOME/.zcode/bridge/clt/sdk/default/openharmony/toolchains/hdc"

# 桥与权限
devecocli log --bundle-name ai.ohpc.zcode --from 1m | grep -E "bridge ready|permissions refreshed"
```

## 相关

- 权限与 API：[03](./03-平台权限与系统约束.md)
- 设备通道与 devecocli：[11](./11-设备通道.md)
- 电脑控制：[13](./13-本机电脑控制.md)
- 治理与不变量：[15](./15-平台适配治理与不变量.md)
