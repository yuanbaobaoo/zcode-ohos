/*
 * OHOS 系统栏主题文件桥（main 侧，写方唯一）：把应用主题写入沙箱文件，供 ArkTS
 * AppWindowAdapter 在窗口最大化时读取并 setColorMode（链路见 specs/ohos-port/07）。
 * nativeTheme.themeSource 在 libelectron.so 内空转，不触达 ArkTS，故走文件桥。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isOhosRuntime } from "@zcode/shared";

// el2/base/files 沙箱视图映射到扁平目录，ArkTS 的 context.filesDir 则在 haps 模块
// 目录下（两者不同文件，见 share-inbox 的双候选先例）——桥必须落 haps 形态。
const OHOS_SANDBOX_HAPS_FILES = "/data/storage/el2/base/haps/electron/files";

const WINDOW_THEME_FILENAME = "window-theme.json";

export function writeOhosWindowThemeFile(
  theme: "dark" | "light" | "system",
  logger: { warn: (...args: unknown[]) => void } = console,
): void {
  if (!isOhosRuntime()) {
    return;
  }
  try {
    // 同步写：12 字节小文件，ArkTS 侧启动读取前必须落盘。
    mkdirSync(OHOS_SANDBOX_HAPS_FILES, { recursive: true });
    writeFileSync(
      join(OHOS_SANDBOX_HAPS_FILES, WINDOW_THEME_FILENAME),
      `${JSON.stringify({ theme })}\n`,
      "utf-8",
    );
  } catch (error) {
    // 写失败只降级（系统栏不跟随），不影响主题功能本身。
    logger.warn("[ohos-window-theme] write failed:", error);
  }
}
