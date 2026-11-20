---
name: ohos-dev
description: "在本机开发、构建、签名、安装、调试鸿蒙应用时使用：从用户 PATH 或 hdc/hvigorw 所在位置自动发现 OHOS SDK，创建 ArkTS 工程，用 devecocli 或 hvigorw 构建，处理签名，用应用自带的 hdc-direct 驱动设备（安装、shell、bm、aa、文件收发），读 hilog，以及沙箱里的坑（home 路径、可执行位、可写目录、hdc-direct 与用户自有 hdc 的区别）。"
when_to_use: "仅用于在本机做鸿蒙应用开发闭环；通用桌面操作交给电脑控制（Computer Use）。"
---

# 在本机开发鸿蒙应用

你运行在鸿蒙 PC 上的 ZCode 应用里。硬性依赖只有 `node` 与应用自带的 `hdc-direct`；
OHOS SDK、`devecocli`、`hvigorw`、`python` 都可以由用户以任意方式提供（命令行工具、
DevEco Studio、brew、npm、手工解包）。**要做的是发现它们，而不是假定某一种安装布局。**

## 0. 环境门禁（写任何代码之前）

```sh
command -v node || echo 缺少:node
command -v hdc-direct || command -v hdc || echo 缺少:设备客户端
command -v devecocli || echo 可选缺失:devecocli
```

- `node` 必须有：应用自带的设备客户端就是一个 Node 程序。
- 设备客户端必须有：优先用应用自带的 `hdc-direct`；如果用户自己有 `hdc`（任何来源），
  那是用户的，应用不会覆盖它。
- `devecocli` 是**可选项**：用户的包源里有时，可以用 node/npm 安装（安装前先问用户）；
  没有就改用 `hvigorw` 构建。
- `node` 和两种设备客户端都没有时：**停下**，说清缺什么、怎么补，然后问用户；
  不要开始写工程代码，不要猜 CLT 绝对路径，也不要把 token 花在跑不起来的构建上。

## 1. 查找 OHOS SDK（三级降级，命中即停）

目标：把 `OHOS_SDK` 设为一个包含 `sdk/default/openharmony` 的根目录。按顺序尝试，
三级都失败才问用户。

**第 1 级 — 扫 `PATH`**（用户的 SDK 可能来自命令行工具、DevEco、brew 等）：

```sh
find_sdk_from_path() {
  for d in $(printf '%s' "$PATH" | tr ':' ' '); do
    [ -n "$d" ] || continue
    for cand in "$d" "$d/.." "$d/../.." "$d/../../.."; do
      [ -d "$cand/sdk/default/openharmony" ] && { printf '%s\n' "$cand"; return 0; }
    done
  done
  return 1
}
```

**第 2 级 — 从可执行文件位置反推**（`hdc` / `hvigorw` / `ohpm`）：

```sh
find_sdk_from_tool() {
  for tool in hdc hvigorw ohpm; do
    p="$(command -v "$tool" 2>/dev/null)" || continue
    rp="$(readlink -f "$p" 2>/dev/null || printf '%s' "$p")"
    case "$rp" in
      */sdk/default/openharmony/*) printf '%s\n' "${rp%%/sdk/default/openharmony/*}"; return 0 ;;
    esac
    dir="$(dirname "$rp")"; i=0
    while [ "$i" -lt 6 ]; do
      [ -d "$dir/sdk/default/openharmony" ] && { printf '%s\n' "$dir"; return 0; }
      dir="$(dirname "$dir")"; i=$((i + 1))
    done
  done
  return 1
}
```

**第 3 级 — 问用户**要 SDK 路径，然后用 `OHOS_SDK=<路径>` 重新构建（hvigor 还需要
`DEVECO_SDK_HOME=$OHOS_SDK/sdk`）。**绝不自己编一个路径。**

开始查之前，先看环境里已有的提示：`DEVECO_CLI_CLT_PATH`、`COMMAND_LINE_TOOL_PATH`、
`DEVECO_SDK_HOME`——它们可能已经指向 SDK 根。

## 2. `hdc-direct`（应用提供）与 `hdc`（用户自有）

- **`hdc-direct` 是应用自带的命令**：`~/.zcode/bridge/bin/hdc-direct`。它是纯 Node 客户端，
  直接按 hdc 线协议连设备端 `hdcd` 的 TCP 端口（`$ZCODE_HDC_TARGET`），**不需要本地
  hdc server，也不需要 CLT**。
- **`hdc` 是用户自己的二进制**：应用不覆盖、不改写。用户用 HiShell PATH、`.zshrc`、
  命令行工具、brew、npm 提供都行；只要它能用，就照常属于用户。
- 当前沙箱里官方 `hdc` 是 client/server 架构，起不了本地 server；所以设备操作**优先用
  `hdc-direct`**。只有用户确认 `hdc` 可用时（在宿主上，或平台开放 hdc server 之后）才用它。
- 两者命令形状一致，目标要显式传：

  ```sh
  hdc-direct -t "$ZCODE_HDC_TARGET" shell id
  ```

  环境变量缺失时用：`hdc-direct tconn 127.0.0.1:$(param get persist.hdc.port)`。

- `hdc-direct` 支持：`list targets`、`shell "<命令>"`、`file send|recv`、
  `install [-r] <hap> [--launch <bundle> <ability>]`、`root`、`tconn`。
- 首次运行会在 `~/.harmony/hdckey(.pub)` 生成密钥，设备弹一次「允许调试」——
  让用户点允许。密钥丢了或重装会再弹一次。
- `bm` / `aa` 是设备侧命令，统一这样走：
  `hdc-direct -t "$ZCODE_HDC_TARGET" shell "bm …"`。

### 关于 `devecocli` 的设备命令

应用在桥目录提供了一个 `devecocli` 分发启动器：`devecocli device|log|ui …` 会自动把
`DEVECO_CLI_CLT_PATH` 指向应用生成的兼容 CLT 根（其 `hdc` 转发到随包 `hdc-direct`），
所以这些纯设备命令不需要官方 hdc server；`build/create/signature/auth` 等其它子命令
保持用户原环境不变（构建仍用用户自己的 SDK/CLT）。`command -v devecocli` 失败时启动器
报 127，此时用 node/npm 安装，或直接用 `hvigorw` 构建。

## 3. 创建 → 构建 → 签名 → 安装 → 调试

1. **创建工程**（有 `devecocli` 时优先）：

   ```sh
   devecocli create --project-path ~/Documents/Demo --app-name Demo --bundle-name com.example.demo
   ```

   工程写到用户指定的可写工作区；`Desktop` 及其子目录在真机上不可读写（EPERM），
   权限 `drwxrws--x`，应用 uid 没有写位 → EPERM）。
2. **构建**：`cd <工程> && devecocli build --build-mode debug`。
   没有 `devecocli` 时，用第 1 步找到的 SDK：

   ```sh
   DEVECO_SDK_HOME=$OHOS_SDK/sdk HVIGOR_USER_HOME=$HOME/.hvigor \
     "$OHOS_SDK/node/bin/node" "$OHOS_SDK/hvigor/bin/hvigorw.js" --no-daemon assembleHap \
     --mode module -p module=entry@default -p product=default -p buildMode=debug \
     --analyze=off --parallel --incremental
   ```

   遇到 "permission denied" 就 `chmod +x` 一次（CLT 里有二进制默认没可执行位）。
3. **签名是唯一真正的门槛**：鸿蒙真机只安装华为调试材料签的 HAP。应用内
   `devecocli auth status` 常常是 `Not logged in`，此时签名会退回 OpenHarmony 默认证书，
   `hdc-direct install` 会被设备拒绝。遇到这种情况：把 `install` 的原始报错告诉用户，
   请他提供 DevEco 签名材料或已登录的 `devecocli`；**不要循环重试**。
4. **安装 + 启动**：

   ```sh
   hdc-direct -t "$ZCODE_HDC_TARGET" install -r <hap> --launch <bundle> EntryAbility
   hdc-direct -t "$ZCODE_HDC_TARGET" shell "bm dump -n <bundle>"
   hdc-direct -t "$ZCODE_HDC_TARGET" shell "aa start -a EntryAbility -b <bundle>"
   hdc-direct -t "$ZCODE_HDC_TARGET" shell "aa force-stop <bundle>"
   ```
5. **日志**：`hdc-direct -t "$ZCODE_HDC_TARGET" shell "hilog -x | grep <bundle>"`；
   看冷启动日志前先 `aa force-stop`（onCreate 只在冷启动打印）。
6. **UI 调试（仅限本工作区构建的应用）**：
   `uitest dumpLayout -p /data/local/tmp/layout.json` 后 `file recv` 取回；
   `snapshot_display` 取像素截图（3120×2080，换算成你的点击坐标）。
   驱动无关应用或系统 UI 不是你的职责，交给 Computer Use。

## 4. 环境事实（先读）

- `~` 有歧义：`echo $HOME`——`/storage/Users/...` 是真实用户 home，`/data/storage/...`
  是应用沙箱。用户文件在 `/storage/Users/currentUser/...`，路径一律写全。
- `env | grep ZCODE_OHOS_FULL_DISK_ACCESS` 是进程启动时的全盘权限快照（`1`/`0`）；
  系统设置改了之后，新会话才会看到变化。
- `Desktop` 是系统受管目录：真机实测即使 `ZCODE_OHOS_FULL_DISK_ACCESS=1`，应用对它
  的 `readdir`/`mkdir`/写入仍是 `EPERM`（`Desktop` 及其子目录同样），而 `Documents`
  可读写。工作区若指向 `Desktop` 下的目录，先 `ls` 探测：不可读就**立即**报告路径与
  `EPERM`，请用户换到 `Documents` 或其它可写目录，不要在不可读目录里继续建工程。
- 你 shell 里的 `/data/local/tmp` 是应用私有视图，不是设备全局目录。
- 随包的 `rg`/`find`/`ugrep` 没有可执行位：用 `/bin/grep` 和 `/usr/bin/find`。
- 有的工具链 `node` 没可执行位：首次构建前 `chmod +x` 一次。

## 5. 常见失败模式

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `缺少:node` / `缺少:设备客户端` | 工具链不可用 | 停下，告诉用户；不要写代码 |
| `hdc-direct: not found`（127） | 桥目录启动器或随包资产缺失 | 检查 `~/.zcode/bridge/bin/hdc-direct`；报告 |
| `hdc-direct list targets` 为空 | 没传目标 / hdcd 没监听 | `echo $ZCODE_HDC_TARGET`；带 `-t` 重试 |
| 首次 `hdc-direct` 弹「允许调试」 | 新密钥待授权 | 让用户点允许；密钥在 `~/.harmony/hdckey` |
| `[Fail]` 连接超时 | 端口漂移 / 无线调试关闭 | 重读 `persist.hdc.port`；`tconn` 重连 |
| `install` 报证书错误 | HAP 是 OpenHarmony 默认证书签的 | 向用户要华为签名材料；不要循环 |
| `devecocli` 不存在 | 可选项缺失 | 用 node/npm 安装（先问用户），或改用 hvigorw |
| node/hvigorw "permission denied" | 缺可执行位 | `chmod +x` 一次 |
| ArkTS 报 `any`/对象字面量错误 | ArkTS 严格模式 | 显式类型；未使用 `catch {}` |
| 安装成功但应用立刻退出 | HAP 未签名或构建模式不对 | 用 `*-signed.hap` 与 `--build-mode debug` |

## 6. 升级与求助

如果循环卡在环境问题上（工具缺失、`Documents` 之外的 EPERM、证书被拒、hdcd 拒绝连接），
**停下并报告原始命令与报错**，不要自己发明绕行方案——这些墙大多是刻意的沙箱策略，
用户提供缺失条件比你猜路径快得多。
