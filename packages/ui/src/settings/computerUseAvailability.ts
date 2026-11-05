import type { OhosComputerControlStatus, RemoteTarget } from "@zcode/shared";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";

export type ComputerUseAvailabilityKind =
  | "local-macos"
  | "local-windows"
  | "local-linux"
  | "local-ohos"
  | "remote-ssh"
  | "remote-wsl"
  | "remote-docker"
  | "remote-server"
  | "web";

export interface ComputerUseAvailability {
  kind: ComputerUseAvailabilityKind;
  supported: boolean;
}

export interface ComputerUseAvailabilityInput {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  /** OHOS 的 process.platform 不是 linux，但 renderer UA 报 Linux；必须显式传入。 */
  isOhosDesktop?: boolean;
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
  workspaceIdentity?: string | null;
}

export function resolveComputerUseAvailability({
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
  isOhosDesktop = false,
  remoteSessionId,
  remoteTarget,
  workspaceIdentity,
}: ComputerUseAvailabilityInput = {}): ComputerUseAvailability {
  const isRemote = Boolean(
    remoteSessionId ||
    remoteTarget ||
    (workspaceIdentity?.trim() && isRemoteWorkspaceIdentity(workspaceIdentity.trim())),
  );
  if (isRemote) {
    const remoteKind: ComputerUseAvailabilityKind =
      remoteTarget?.kind === "ssh"
        ? "remote-ssh"
        : remoteTarget?.kind === "wsl"
          ? "remote-wsl"
          : remoteTarget?.kind === "docker"
            ? "remote-docker"
            : "remote-server";
    return {
      kind: remoteKind,
      supported: false,
    };
  }
  if (!isDesktop) return { kind: "web", supported: false };
  if (isMacDesktop) return { kind: "local-macos", supported: true };
  if (isWindowsDesktop) return { kind: "local-windows", supported: true };
  // OHOS 本机由 ArkTS 执行端提供（CONTROL_DEVICE + inputEventClient，spec 13）。
  if (isOhosDesktop) return { kind: "local-ohos", supported: true };
  return { kind: "local-linux", supported: false };
}

const COMPUTER_USE_SEARCH_TERMS = ["电脑控制", "computer use", "zcode-cua", "cua"];

export function matchesComputerUseSearch(query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return COMPUTER_USE_SEARCH_TERMS.some((term) => term.includes(normalized));
}

/** 远端或 Linux 本机：需要展示不可用提示（Web/OHOS 另有分支）。 */
export function isComputerUseUnavailableNonWeb(availability: ComputerUseAvailability): boolean {
  return !availability.supported && availability.kind !== "web";
}

/**
 * OHOS「辅助操作」(CONTROL_DEVICE) 是否已确认授权（spec 13）。status 缺失/不支持均视为
 * 未确认（fail-closed）：设置页门控据此锁「启用」方向，授权回流后解锁——锁错的代价只是
 * 多点一次授权引导，漏锁的代价是绕过授权直接启用插件。
 */
// 聚合门禁：辅助操作 / 截屏两个权限全部授予才放行（spec 15）。
// 旧版 ArkTS 只回传 granted 时按该字段判断（升级期兼容），新版本以 permissions 为准。
export function isOhosComputerControlPermissionGranted(
  status: OhosComputerControlStatus | undefined,
): boolean {
  if (status?.supported !== true) return false;
  const permissions = status.permissions;
  if (permissions) {
    return permissions.controlDevice && permissions.screenCapture;
  }
  return status.granted === true;
}

export type OhosMissingPermission = "controlDevice" | "screenCapture";

/**
 * 权限丢失后是否需要把「电脑控制」插件关掉（spec 15 聚合门禁）：
 * 两权限缺一 且 插件仍启用 且 没有正在切换 —— 才回收；toggling 中不抢用户的操作。
 * 未支持/未回流（supported=false）不判断，避免桥异常时误关。
 */
export function shouldDisableOhosCua(input: {
  status: OhosComputerControlStatus | undefined;
  pluginEnabled: boolean;
  toggling: boolean;
}): boolean {
  if (input.toggling) return false;
  if (!input.pluginEnabled) return false;
  if (input.status?.supported !== true) return false;
  return !isOhosComputerControlPermissionGranted(input.status);
}

// 列出尚缺的权限，供设置页提示"还差哪一个"，避免用户逐个试。
export function listMissingOhosPermissions(
  status: OhosComputerControlStatus | undefined,
): OhosMissingPermission[] {
  if (status?.supported !== true) {
    return ["controlDevice", "screenCapture"];
  }
  const permissions = status.permissions;
  if (!permissions) {
    return status.granted === true
      ? []
      : ["controlDevice", "screenCapture"];
  }
  const missing: OhosMissingPermission[] = [];
  if (!permissions.controlDevice) missing.push("controlDevice");
  if (!permissions.screenCapture) missing.push("screenCapture");
  return missing;
}
