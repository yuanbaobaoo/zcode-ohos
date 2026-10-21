// v40 主进程 spawn 被沙箱击杀（spec 09 §12.6），终端改走官方原生子进程通道：
// NAPI（OH_Ability_StartNativeChildProcess）拉起 libzcode_pty.so，子进程连回 unix socket。

import { app } from "electron";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeProcessBridge {
  /** 成功返回子进程 pid，失败返回负错误码。 */
  startNativeProcess(entryParams: string): number;
}

let bridge: NativeProcessBridge | null | undefined;
let bridgeError: unknown;

export function loadNativeProcessBridge(): NativeProcessBridge | null {
  if (bridge !== undefined) return bridge;
  // resfile 路径 dlopen 会被 loader 拒（同 zcode_sqlite.node），HAP libs 优先。
  const candidates = [
    "/data/storage/el1/bundle/libs/arm64/zcode_ohos_process.node",
    join(app.getAppPath(), "zcode_ohos_process.node"),
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../native/ohos-zcode-pty/zcode_ohos_process.node",
    ),
  ];
  const addonPath = candidates.find((candidate) => existsSync(candidate));
  if (!addonPath) {
    bridgeError = new Error(`zcode_ohos_process.node not found (${candidates.join(", ")})`);
    bridge = null;
    return bridge;
  }
  try {
    bridge = createRequire(import.meta.url)(addonPath) as NativeProcessBridge;
  } catch (error) {
    bridgeError = error;
    bridge = null;
  }
  return bridge;
}

export function describeNativeProcessBridgeError(): string {
  if (bridgeError instanceof Error) return bridgeError.message;
  return String(bridgeError ?? "");
}
