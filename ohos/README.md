# ohos/ —— ZCode 鸿蒙应用工程（路线 B：鸿蒙版 Electron）

这是 ZCode 的 HarmonyOS 应用本体工程（不是对预编译包的套壳）：

- `electron/`（entry 模块）：ArkTS 入口（EntryAbility、XComponent 页面）+ `libs/arm64-v8a/` 原生库。
- `web_engine/`（har 模块）：OHOS Electron 的 ArkTS 绑定层 + Electron 运行时资源（`resfile/` 的 pak/icudtl/locales 等）。
- `resfile/resources/app/`：**ZCode 源码构建产物**，由仓库根目录 `scripts/build-ohos.mjs` 组装（main/preload/renderer/host + 运行时 node_modules + agent bundle），hvigor 构建前生成，不入库。

## 原生库来源（运行时依赖，非源码）

| 文件 | 说明 |
|---|---|
| `libadapter.so` / `libelectron.so` / `libffmpeg.so` | OHOS Electron 运行时（Chromium 132 / Node 20.18.1），来源 ohos-linux-zcode 已验证产物，等价于桌面版对 electron npm 包的依赖 |
| `ohos_sqlite_adapter.node` | OHOS sqlite NAPI 绑定（node:sqlite 兼容层后端候选） |
| `pty.node` | node-pty OHOS prebuild 占位，后续由本仓库交叉编译产物替换 |

## 构建

```
# 仓库根目录
node scripts/build-ohos.mjs        # 构建桌面产物并组装 resfile/resources/app
# 然后 hvigor assembleHap（DevEco 或命令行）
```

签名：`build-profile.json5` 的 signingConfig 留空，由 DevEco 自动签名或装机阶段配置。
