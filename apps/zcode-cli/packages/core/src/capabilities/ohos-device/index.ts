// ============================================================
// OHOS device capability - 唯一对外入口
// ============================================================
// 鸿蒙设备通道的完整边界：停用设 ZCODE_OHOS_HDC_BRIDGE（spec 11），
// 移除整目录删除即可，外部只经 ohosDeviceTools()。

import { isOhosRuntime } from "@zcode/shared";

import type { ToolEntry } from "../../tool/types.js";
import { ohosHdcToolEntry } from "./hdc-direct.js";

// 能力开关，打包与运行时读同一变量；关闭值含 native（让位给系统实现，spec 11）
export const OHOS_DEVICE_BRIDGE_ENV = "ZCODE_OHOS_HDC_BRIDGE";

const DISABLED_VALUES = new Set(["0", "off", "false", "native", "disabled"]);

// 能力是否启用；未显式关闭时按平台判定
export function isOhosDeviceBridgeEnabled(
    env: NodeJS.ProcessEnv = process.env,
    platform: string = process.platform,
): boolean {
    const raw = env[OHOS_DEVICE_BRIDGE_ENV]?.trim().toLowerCase();
    if (raw && DISABLED_VALUES.has(raw)) return false;
    return isOhosRuntime(platform);
}

// 返回该能力贡献的工具；未启用时为空，注册处不出现平台判断
export function ohosDeviceTools(
    env: NodeJS.ProcessEnv = process.env,
    platform: string = process.platform,
): ToolEntry[] {
    return isOhosDeviceBridgeEnabled(env, platform) ? [ohosHdcToolEntry] : [];
}
