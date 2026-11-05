# 视频台本（原理版）：终端与鸿蒙 App 调试

**时长** ~3 分钟 ｜ 只讲原理：现状 → 原因 → 为什么这样

---

## 一、终端（约 90 秒）

**现状**
ZCode 在这台鸿蒙 PC 上能起真实终端：`pnpm`、`node`、`git` 都能跑，而且和 Agent 的 Bash
共享同一套环境。

**原因：平台给了三个限制**
1. **没有 pty**：沙箱打不开 `/dev/ptmx`，桌面版"开伪终端 + 挂 shell"的做法直接不可用。
2. **`/usr/bin` 视图分裂**：只有 main 进程（appspawn 域）能看到完整的 `/usr/bin/zsh`；
   host、agent 这些 nativespawn 域里，`/usr/bin` 是空挂载。
3. **用户环境不在进程里**：PATH、node、pnpm 都来自登录 shell 的 rc，不会自动继承给应用。

**为什么这样解**
- **shell 交给 main 托管**：只有 main 能看到 zsh，所以由它 `spawn /usr/bin/zsh -il`，
  管道接 stdio，再用一条专用 MessagePort 把数据中继给终端界面。
  没有 tty，就没有内核做换行，输出里的 `\n` 自己补成 `\r\n`。
- **环境用登录 shell 快照**：main 跑一次 `zsh -ilc 'env -0'`（cwd 设为用户 home），
  把结果落盘；main 和 host 两个入口各自注入。于是终端、Agent Bash、MCP 子进程
  拿到的是同一套 PATH。
- **shebang 兜底**：agent 视图里没有 `/usr/bin/env`，用 LD_PRELOAD 的 exec shim
  把它改写成 `/bin/env`，脚本才能跑。
- **不重编 Electron**：以上全部在运行时适配层完成，业务代码与上游同源。

一句话：**不是把 Linux 终端塞进 Electron，而是让 main 当"终端服务器"。**

---

## 二、直接调试鸿蒙 App（约 90 秒）

**现状**
在这台机器上，ZCode 能列出本机设备、装 HAP、拉起应用、拉日志、截图；Agent 也能直接跑
设备命令。开发和调试在同一台机器上闭环。

**原因：官方链路断在两处**
1. **hdc server 起不来**：官方 hdc 是 client/server——`hdc` 命令先连本机 server（Unix socket），
   再由 server 连设备。沙箱禁止 bind Unix socket，server 起不来；于是 `hdc list targets`
   永远是空的，而且不报错。
2. **devecocli 不读 PATH**：它按"工具链根目录"去找 `sdk/default/openharmony/toolchains/hdc`；
   找不到就退回 HNP 里的官方 hdc——又回到上一条死路，所以报 `No active devices`。

**为什么这样解**
- **hdc-direct**：设备端的 hdcd 本身监听 TCP（`persist.hdc.port`，这台机器是 `46273`）。
  我们用一个纯 JS 客户端直接实现官方 hdc 的线协议（`HW` 帧、`OHOS HDC` 握手、
  公钥挑战签名），TCP 直连 hdcd，**绕过 server**。
  选纯 JS 而不是塞原生 hdc：HAP 里的 ELF 受代码签名/白名单管制，放不进去。
- **迷你 CLT**：devecocli 只认工具链根，那就在应用自己的目录里造一个最小 CLT——
  `version.txt` + 一个指向 hdc-direct 的 `hdc` 包装脚本 + `node/ohpm/hvigor` 占位入口，
  再把 `DEVECO_CLI_CLT_PATH` / `COMMAND_LINE_TOOL_PATH` 指过去。
  **不改用户安装的 CLT**；A/B 验证过：官方 hdc 加同样的环境变量仍然找不到设备。
- **单控制通道**：设备**调试**走 hdc-direct（`ohos_hdc` 的 list/shell/file/install，
  devecocli 复用同一条通道）；**控制**走 CUA 的 ArkTS 桥。两者不混用。
- **边界**：终端没有 pty，全屏交互类工具受限；devecocli 的构建命令需要真实 CLT，
  迷你 CLT 只承诺设备侧命令（list/install/log/ui）。

一句话：**官方 hdc 的两段链路，我们把"server ↔ daemon"这一段用 JS 重写了。**

---

## 三、收尾（约 20 秒）

```text
终端：  UI ⇄ MessagePort ⇄ main(zsh -il) ⇄ 管道
设备：  ohos_hdc / devecocli ⇄ hdc-direct ⇄ TCP:46273 ⇄ hdcd
```

> 两个能力看起来是"鸿蒙居然能……"，其实都是同一件事：
> 把平台差异（没有 pty、没有 hdc server、环境不继承）收进一层薄适配，
> 上层应用与业务代码不动。适配做对了，终端和设备调试就是自然结果。
