/*
 * OHOS 兼容渲染引导（main 早期）：模拟器 GPU 直通撑不住 Chromium 的 EGL 用法
 * （上下文秒丢 → GPU 进程崩溃循环 → 窗口黑屏，见 specs/ohos-port/06），检测到
 * 模拟器时把 GL 后端切到 ANGLE + SwiftShader（纯 CPU）。appendSwitch 必须在
 * app ready 前执行，故由 index.ts 顶部 import 求值；安全极性：判据缺失一律
 * 按真机处理，绝不把真机降级到软件渲染。
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
  app.commandLine.appendSwitch("use-gl", "angle");
  app.commandLine.appendSwitch("use-angle", "swiftshader");
}
