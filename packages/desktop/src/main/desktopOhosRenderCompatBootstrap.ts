/*
 * OHOS 兼容渲染引导：模拟器 GPU 直通撑不住 Chromium EGL（黑屏，specs/ohos-port/06），
 * 检测到模拟器时切 ANGLE + SwiftShader。须在 app ready 前执行（index.ts 顶部求值）；
 * 判据缺失一律按真机处理，绝不误降级真机。
 */

import { app } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isOhosRuntime } from "@zcode/shared";
import {
  parseOhosDeviceProfile,
  resolveOhosDeviceProfilePaths,
  shouldUseOhosSoftwareRendering,
  type OhosDeviceProfile,
  type OhosRenderCompatMode,
} from "@zcode/services/ohos-device-profile";
import { OHOS_SANDBOX_FILES } from "./desktopEarlyOhosEnvBootstrap.js";

function readOhosRenderCompatModeFromDisk(): OhosRenderCompatMode {
  // 须在 desktopEarlyOhosEnvBootstrap 修好 HOME 之后读（index.ts import 顺序保证）。
  const settingsFile = join(homedir(), ".zcode", "v2", "setting.json");
  try {
    const raw = JSON.parse(readFileSync(settingsFile, "utf-8")) as {
      desktopOhosRenderCompat?: unknown;
    };
    const mode = raw.desktopOhosRenderCompat;
    return mode === "software" || mode === "hardware" ? mode : "auto";
  } catch {
    return "auto";
  }
}

function readOhosDeviceProfileFromSandbox(): OhosDeviceProfile | undefined {
  const { profileCandidates } = resolveOhosDeviceProfilePaths({
    sandboxFilesDir: OHOS_SANDBOX_FILES,
  });
  for (const candidate of profileCandidates) {
    if (!existsSync(candidate)) continue;
    // 文件存在但损坏（半写/篡改）时按真机处理：解析失败不注入。
    return parseOhosDeviceProfile(readFileSync(candidate, "utf-8"));
  }
  return undefined;
}

export function applyEarlyOhosRenderCompatBootstrap(): void {
  if (!isOhosRuntime()) return;
  const mode = readOhosRenderCompatModeFromDisk();
  const profile = readOhosDeviceProfileFromSandbox();
  if (!shouldUseOhosSoftwareRendering({ mode, profile })) return;
  // v40 基线（Chromium 144）厂商默认 --use-gl=egl 在模拟器上直接可用（厂商样例
  // 装机实证渲染正常）。132 时代的 angle+swiftshader 注入在 v40 上会抢走这条路径
  // 且 ANGLE 拆分动态库未随日构建附带（初始化落空即黑屏）——v40 一律不注入。
  const electronMajor = Number(process.versions.electron?.split(".")[0] ?? 0);
  if (electronMajor >= 40) {
    return;
  }
  app.commandLine.appendSwitch("use-gl", "angle");
  app.commandLine.appendSwitch("use-angle", "swiftshader");
}
