import { existsSync, readFileSync } from "node:fs";
import {
  isOhosEmulatorProfile,
  parseOhosDeviceProfile,
  resolveOhosDeviceProfilePaths,
  type OhosDeviceProfile,
} from "@zcode/services/ohos-device-profile";
import { OHOS_SANDBOX_FILES } from "./desktopEarlyOhosEnvBootstrap.js";

/**
 * ArkTS 的 DeviceProfileWriter 每次启动把设备画像写进沙箱；这是模拟器判定的唯一事实源。
 * 文件缺失或损坏一律按真机处理（绝不误降级真机）。
 */
export function readOhosDeviceProfileFromSandbox(): OhosDeviceProfile | undefined {
  const { profileCandidates } = resolveOhosDeviceProfilePaths({
    sandboxFilesDir: OHOS_SANDBOX_FILES,
  });
  for (const candidate of profileCandidates) {
    if (!existsSync(candidate)) continue;
    return parseOhosDeviceProfile(readFileSync(candidate, "utf-8"));
  }
  return undefined;
}

/**
 * 当前是否跑在模拟器上（`@ohos.deviceInfo.productModel === "emulator"`）。
 *
 * 平台事实（specs/ohos-port/03、09 §12.6）：模拟器沙箱拒绝应用进程 fork+exec，
 * main 域 spawn 一个真实存在的可执行文件会以 SIGABRT 击杀整个应用；真机（HarmonyOS 7 PC）
 * 异步 spawn 可用。两者行为不同，需要按此判据分派。
 */
export function isOhosEmulatorRuntime(): boolean {
  const profile = readOhosDeviceProfileFromSandbox();
  return profile ? isOhosEmulatorProfile(profile) : false;
}
