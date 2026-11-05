import { installOhosNodeRuntimeCompat } from "./ohosNodeRuntimeCompat.js";
import { installOhosSpawnCompat } from "./ohosSpawnCompat.js";

// Agent Worker 的 --require preload（spec 02）：node:sqlite/withResolvers 钩子
// 必须在 zcode.cjs 解析前装好，由 spawnOhosAgentWorker 挂载。
installOhosNodeRuntimeCompat();
installOhosSpawnCompat();
