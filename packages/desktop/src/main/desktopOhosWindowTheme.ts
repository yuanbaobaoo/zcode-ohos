/*
 * OHOS 系统栏主题文件桥（main 侧，写方唯一）：把应用主题写入沙箱文件，供 ArkTS
 * EntryAbility 在启动及文件变化时读取并 setColorMode（链路见 specs/ohos-port/07）。
 * nativeTheme.themeSource 在 libelectron.so 内空转，不触达 ArkTS，故走文件桥。
 */

import { isOhosRuntime } from "@zcode/shared";
import { writeJsonAtomic } from "./ohos/fileBridge.js";
import { OHOS_BRIDGE_PATHS } from "./ohos/paths.js";

export function writeOhosWindowThemeFile(
  theme: "dark" | "light" | "system",
  logger: { warn: (...args: unknown[]) => void } = console,
): void {
  if (!isOhosRuntime()) {
    return;
  }
  try {
    // 同步写：几十字节小文件，ArkTS 侧启动读取前必须落盘。
    writeJsonAtomic(OHOS_BRIDGE_PATHS.themeFile, { theme });
  } catch (error) {
    // 写失败只降级（系统栏不跟随），不影响主题功能本身。
    logger.warn("[ohos-window-theme] write failed:", error);
  }
}
