# 视频台本：在鸿蒙电脑上，ZCode 自己就是开发环境

**时长** ~8:30 ｜ **形式** 口播 + 屏幕操作 ｜ **基调** 先给结论、再拆难点、每段一个演示

**一句话立意**：这台鸿蒙 PC 不是"只能跑 App 的终端机"。ZCode 在本机就能起终端、能连设备、
能装包、能看日志——因为平台差异全部收在适配层里，而不是把 Linux 那一套硬塞进来。

---

## 0. 开场（0:00–0:40）

**画面**：ZCode 主界面，右侧打开终端，光标在提示符上闪。背景是鸿蒙桌面。

**口播**：
> 很多人第一次看到鸿蒙 PC，会觉得它是个"大号平板"：能跑 App，但写代码、调试，还得回 Mac。
> 今天我用这台机器上的 ZCode 演示两件事：
> 第一，它的终端是真的在跑，不是远程连回某台 Linux；
> 第二，它能在鸿蒙上直接调试鸿蒙 App——列设备、装 HAP、拉日志、看界面。
> 而且我没有重编 Electron，也没有改你机器上的开发环境。

**字幕**：本机终端 ｜ 本机设备调试 ｜ 零改环境

---

## 1. 终端为什么能跑（0:40–3:10）

### 1.1 先说难点：鸿蒙没有给你 pty（0:40–1:20）

**画面**：切到一张对比图（左：桌面版 forkpty；右：鸿蒙沙箱拒绝 /dev/ptmx）。

**口播**：
> 桌面版终端很直接：开一个伪终端，把 shell 挂上去，键盘输入写进去，屏幕输出读出来。
> 但在鸿蒙的应用沙箱里，`/dev/ptmx` 是打不开的——没有 pty，这一套直接作废。
> 所以不能照搬，得换一种"托管"方式。

### 1.2 解法：shell 由 main 进程托管，走中继（1:20–2:20）

**画面**：终端里执行 `echo $SHELL`、`echo $0`；切到架构图（main → MessagePort → Host → 终端 UI）。

**口播**：
> 关键事实是：`/usr/bin` 只在 main 进程和它拉起的进程里是完整的；host、agent 那些由
> nativespawn 拉起的进程，`/usr/bin` 是一个空挂载，连 `zsh` 都看不到。
> 所以 shell 必须由 main 托管：main 起系统自带的 `/usr/bin/zsh -il`，用管道接 stdin/stdout，
> 再通过一条专用的 MessagePort 把数据中继给终端界面。
> 没有 tty 就没有内核帮你做换行，输出里的 `\n` 要自己补成 `\r\n`——这就是为什么终端里
> 换行、回显都正常。

**字幕**：main 托管 zsh ｜ 管道 + MessagePort ｜ 无 tty，行级回显

### 1.3 用户环境从哪来（2:20–3:10）

**画面**：终端跑 `pnpm -v`、`node -v`；再让右侧 Agent 的 Bash 跑同一条，两个输出并排。

**口播**：
> 第二个问题是环境。你机器上的 PATH、node、pnpm，都是登录 shell 里那套 rc 算出来的。
> main 会在启动时跑一次 `zsh -ilc 'env -0'`，把这份环境快照落盘；main 和 host 两个入口
> 各自注入。所以终端、Agent 的 Bash、MCP 子进程，看到的是同一套 PATH。
> 你在这里 `pnpm -v` 是多少，Agent 里跑出来就是多少。
> 还有一个坑：agent 视图里没有 `/usr/bin/env`，带 shebang 的脚本会直接失败。我们用一个小
> 的 exec shim 把它改写成 `/bin/env`，脚本就能正常跑。

**演示命令**：
```bash
echo $SHELL
pnpm -v
node -v
```
（Agent 侧：让 Agent 执行 `pnpm -v`，对比输出。）

---

## 2. 为什么能直接调试鸿蒙 App（3:10–6:50）

### 2.1 坎一：hdc server 起不来（3:10–4:10）

**画面**：终端跑 `hdc list targets`（空、exit 0），再跑 `ohos_hdc` 的 list，出 `127.0.0.1:46273`。

**口播**：
> 官方 hdc 是"客户端 + 服务端"：`hdc` 命令先连本机的 hdc server，再由 server 去连设备。
> 但 server 要在本机 bind 一个 Unix socket，沙箱不允许——所以 server 起不来，
> `hdc list targets` 永远是空的，还不报错。
> 我们的做法是绕开 server：写了一个纯 JS 的 hdc-direct，直接 TCP 连设备上的 hdcd，
> 端口就是无线调试端口 `persist.hdc.port`，这台机器上是 46273。
> 它说的是官方 hdc 的线协议：`HW` 帧头、`OHOS HDC` 握手、公钥挑战签名——所以设备把它
> 当成一个正常的 hdc 客户端。

**演示命令**：
```bash
# 官方 hdc：空
hdc list targets
# hdc-direct：出设备
# （Agent 里）ohos_hdc action=list_targets
# （Agent 里）ohos_hdc action=shell command="param get const.ohos.apiversion"   → 26
```

### 2.2 坎二：devecocli 不认路（4:10–5:30）

**画面**：终端跑 `devecocli device list`，直接出 `HUAWEI MateBook Pro 127.0.0.1:46273 2in1`；
再跑 `devecocli log --bundle-name ai.ohpc.zcode --from 1m | head`。

**口播**：
> 第二个坎是 devecocli。它不读 PATH，而是按"工具链根目录"去找
> `sdk/default/openharmony/toolchains/hdc`；找不到就退回 HNP 里的官方 hdc——又回到起不了
> server 的死路，所以报"没有设备"。
> 解法不是改你安装的 CLT，而是在应用自己的目录里生成一个"迷你 CLT"：一个 version.txt、
> 一个 375 字节的 hdc 包装脚本（指向 hdc-direct）、再加上 node/ohpm/hvigor 的占位入口，
> 骗过它的工具链校验；启动时把 `DEVECO_CLI_CLT_PATH` 和 `COMMAND_LINE_TOOL_PATH` 指向它。
> 你机器上的 CLT 一个字没动。做了个 A/B：官方 hdc 加同样的环境变量，还是"No active devices"；
> 换成这个包装脚本，设备立刻出来。

**演示命令**：
```bash
devecocli device list
devecocli log --bundle-name ai.ohpc.zcode --from 1m | head -20
devecocli ui screenshot --path /tmp/ohos.png   # 或 ui layout
```

### 2.3 开发闭环：写 → 构建 → 装 → 看日志（5:30–6:50）

**画面**：编辑器里改一行 ArkTS/前端代码 → 终端跑构建（用户 CLT 的 hvigor/ohpm）→
`ohos_hdc install` 装 HAP → `aa start` 拉起 → 截屏/日志确认。

**口播**：
> 把上面两块拼起来，就是完整的开发闭环：
> 在 ZCode 里改代码；终端里用你自己装的 CLT 构建、签名；然后用 `ohos_hdc` 的 install
> 把 HAP 推到设备、`bm install` 装上；再用 `shell` 拉起、抓 hilog。
> 这台机器既是开发机，也是被测设备——不用第二台电脑。
> 需要看界面时，`snapshot_display` 截图拉回来，或者直接用 devecocli 的 ui 子命令。

**演示命令**：
```bash
# 构建（用用户自己的 CLT；按项目实际命令替换）
# hvigorw assembleHap --mode module -p product=default
# 安装（Agent 里）
# ohos_hdc action=install hapPath=<signed.hap> bundleName=<bundle>
# 或终端
hdc shell "aa start -a EntryAbility -b <bundle>"
hdc shell "hilog -x | grep <bundle>" | tail -20
```

**诚实边界（口播一句带过）**：
> 说明一下边界：终端没有 pty，vim 这类全屏交互会受限；devecocli 的 run/build 需要真实 CLT，
> 迷你 CLT 只承诺设备侧的 list/install/log/ui；截图和电脑控制需要用户在设置里授权。

---

## 3. 收尾（6:50–8:00）

**画面**：三层架构图（应用层 / 适配层 / 系统能力），三个数字依次打出：`46273`、`26`、`2`。

**口播**：
> 最后用一张图总结：
> 上面是 ZCode 的应用层，和上游同一套代码；
> 中间是适配层——main 托管的 zsh、登录环境快照、hdc-direct、迷你 CLT、文件桥；
> 下面是鸿蒙的系统能力：hdcd、设置页、截屏 API。
> 三个数字：46273 是设备调试端口，26 是这台机器的 API 版本，2 是电脑控制需要的权限个数。
> 所以"鸿蒙能不能当开发机"这个问题，答案不在于平台有没有现成的 pty 或 hdc server，
> 而在于平台差异有没有被收进一层薄薄的适配里。
> 这层做对了，终端、Agent、设备调试就都是自然结果。
> 下一期讲电脑控制：怎么让 Agent 真的在这台机器上点、打、截屏、录屏。

---

## 附 A：演示前检查清单

- [ ] ZCode 已安装最新 dev 构建；`bridge ready: api=true permission=granted`
- [ ] 终端能跑 `pnpm -v` / `node -v` / `devecocli --version`
- [ ] `devecocli device list` 能出设备（迷你 CLT 已注入）
- [ ] 准备好一个可安装的示例 HAP（已签名）与 bundle 名
- [ ] 关闭无关窗口，避免通知弹窗入镜
- [ ] 分辨率 3120×2080，录屏前把字体调大（终端 ≥16pt）

## 附 B：备用话术（翻车时）

| 情况 | 话术 |
| --- | --- |
| `devecocli device list` 空 | "这台机器刚重启，host 还没注入环境变量，我们重启一下应用再试"（重启后仍空则改跑 `ohos_hdc` 演示，后续补录） |
| 官方 hdc 那条命令报错而不是空 | "沙箱里它连 server 都起不来，报错/空都属于同一类失败——重点看下一条" |
| 安装 HAP 失败 | "签名或 bundle 不匹配，我们换一个已签名的包"（提前准备备用包） |
| 截图黑屏 | 先 `aa force-stop` 目标应用再拉起，避免截到启动瞬间 |

## 附 C：可直接复制的演示序列

```bash
# 1) 终端真实运行
echo $SHELL; pnpm -v; node -v

# 2) 官方 hdc 的死路
hdc list targets || true

# 3) hdc-direct 的活路（Agent 工具）
# ohos_hdc action=list_targets
# ohos_hdc action=shell command="param get const.ohos.apiversion"

# 4) devecocli 直连
devecocli device list
devecocli log --bundle-name ai.ohpc.zcode --from 1m | head -20

# 5) 装机与拉起（按实际包名替换）
# ohos_hdc action=install hapPath=/path/to/app.hap bundleName=<bundle>
hdc shell "aa start -a EntryAbility -b <bundle>"
```
