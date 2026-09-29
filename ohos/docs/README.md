# ZCode HarmonyOS 适配文档（ohos/docs）

本目录是 ZCode（官方源码 v3.14.3）到 HarmonyOS PC（aarch64）**源码级移植**的技术文档。

| 文档 | 内容 |
|---|---|
| [01-构建与打包.md](./01-构建与打包.md) | macOS 主构建环境、工具链、一次性初始化、构建流水线、本地回归 |
| [02-运行时架构与适配层.md](./02-运行时架构与适配层.md) | 进程模型（agent 进程内 Worker）、早期引导、用户 shell 环境四端注入、sqlite 后端、终端中继、JIT 矩阵 |
| [03-平台权限与系统约束.md](./03-平台权限与系统约束.md) | 系统权限清单、V8 Smi ABI 铁律、内核/沙箱约束与对策、工具链行为、已知限制 |

其他工程入口：

| 路径 | 说明 |
|---|---|
| `ohos/` | HAP 应用工程（electron entry 模块 + web_engine har + 原生模块 + 脚本） |
| `ohos/BRINGUP.md` | 装机操作手册（步骤 + 冒烟清单 + 观察点） |
| `specs/ohos-port/spec.md` | 移植总体 spec（架构、状态所有者、验收场景） |
| `scripts/build-ohos.mjs` | 源码级 resfile 组装管线 |
| `ohos/native/zcode-sqlite/` | 自有 SQLite NAPI 绑定（C 源 + 交叉编译） |
| `ohos/scripts/device-cdp.mjs` | 真机 UI 自动化（CDP 通道） |
| `.ohos-test/` | 兼容层/绑定回归测试 |

**修改适配层代码前，先读 03 的约束清单**——每条约束对应代码中的具体对策，
破坏对策会导致崩溃或功能回退。
