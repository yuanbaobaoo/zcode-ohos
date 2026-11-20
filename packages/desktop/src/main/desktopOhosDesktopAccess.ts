/*
 * OHOS Desktop 目录授权桥（spec 18）。
 *
 * Desktop 不被 ACCESS_USER_FULL_DISK 覆盖：必须单独声明 READ_WRITE_DESKTOP_DIRECTORY，
 * 由系统弹窗授权。Documents/Download 等其它目录由全盘权限覆盖，不在此建模。
 * ArkTS 在窗口创建/前台写 desktop-access.json；main 读取并 watch 推给 renderer。
 */
import { isOhosRuntime, type OhosDesktopAccessStatus } from "@zcode/shared";
import { readJsonSync, watchJsonValue, writeTextAtomic } from "./ohos/fileBridge.js";
import { OHOS_BRIDGE_PATHS } from "./ohos/paths.js";

const UNSUPPORTED_STATUS: OhosDesktopAccessStatus = { supported: false, granted: false };

export function parseOhosDesktopAccessState(content: string): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const granted = (parsed as { granted?: unknown }).granted;
    return typeof granted === "boolean" ? granted : undefined;
  } catch {
    return undefined;
  }
}

export function readOhosDesktopAccessGrantedSync(): boolean {
  if (!isOhosRuntime()) return false;
  const parsed = readJsonSync<{ granted?: unknown }>(OHOS_BRIDGE_PATHS.desktopAccessState);
  return parsed?.granted === true;
}

export async function readOhosDesktopAccessStatus(): Promise<OhosDesktopAccessStatus> {
  if (!isOhosRuntime()) return UNSUPPORTED_STATUS;
  return { supported: true, granted: readOhosDesktopAccessGrantedSync() };
}

export function watchOhosDesktopAccessChanged(
  onChange: (status: OhosDesktopAccessStatus) => void,
  logger: { warn: (...args: unknown[]) => void },
): () => void {
  if (!isOhosRuntime()) return () => {};
  return watchJsonValue<boolean>({
    path: OHOS_BRIDGE_PATHS.desktopAccessState,
    parse: (raw) => {
      const granted = (raw as { granted?: unknown } | undefined)?.granted;
      return typeof granted === "boolean" ? granted : undefined;
    },
    equals: (left, right) => left === right,
    onChange: (granted) => onChange({ supported: true, granted }),
    logger,
  });
}

/** 写「去授权」请求：ArkTS 前台轮询消费后调用 requestPermissionsFromUser（系统弹窗）。 */
export function writeOhosDesktopAccessRequest(
  logger: { warn: (...args: unknown[]) => void } = console,
): void {
  if (!isOhosRuntime()) return;
  try {
    writeTextAtomic(OHOS_BRIDGE_PATHS.desktopAccessRequest, `${Date.now()}\n`);
  } catch (error) {
    logger.warn("[ohos-desktop] write request failed:", error);
  }
}
