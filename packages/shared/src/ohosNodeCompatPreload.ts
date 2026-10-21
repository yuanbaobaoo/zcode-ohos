import { installOhosNodeRuntimeCompat } from "./ohosNodeRuntimeCompat.js";
import { installOhosSpawnCompat } from "./ohosSpawnCompat.js";

/**
 * Agent Worker（zcode.cjs）的 `--require` preload 入口（specs/ohos-port/09 §4.1.1）。
 *
 * OHOS 上 Agent 以进程内 Worker 运行 CLI bundle（CJS）。bundle 入口第一行就静态
 * import `@zcode/shared/sqlite-migrations`，其内部 `require("node:sqlite")` 会在
 * 任何业务代码执行前取值——钩子必须在 bundle 解析前装好。构建链把本入口编译成
 * `ohos-node-compat.cjs` 暂存到 zcode.cjs 同目录，spawnZCodeAgentInProcessWorker
 * 以 execArgv --require 挂载。非 OHOS 平台 install 内部 no-op。
 */
installOhosNodeRuntimeCompat();
installOhosSpawnCompat();
