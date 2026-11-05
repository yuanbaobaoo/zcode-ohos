/*
 * OHOS「辅助操作」(CONTROL_DEVICE) 授权状态桥（main 侧，读者，spec 13/15）。
 * ArkTS ComputerControlService 是 computer-control/status.json 的唯一写入方
 * （常驻 1s 轮询、值变化才重写）；这里读取并经目录 watch 推送给 renderer。
 * 「去开启」请求落 permission.request，由 ArkTS 前台轮询消费（spec 08 同款请求文件模式）。
 * 路径与桥原语见 ohos/paths.ts、ohos/fileBridge.ts。
 */

import { isOhosRuntime, type OhosComputerControlStatus } from "@zcode/shared";
import { readJsonSync, watchJsonValue, writeTextAtomic } from "./ohos/fileBridge.js";
import { OHOS_BRIDGE_PATHS } from "./ohos/paths.js";

const UNSUPPORTED_STATUS: OhosComputerControlStatus = { supported: false, granted: false };

type PermissionState = "granted" | "needs-grant" | "unknown";

function readPermissionState(raw: unknown): PermissionState {
  const permission = (raw as { permission?: unknown } | undefined)?.permission;
  return permission === "granted" || permission === "needs-grant" ? permission : "unknown";
}

function readPermissions(
  raw: unknown,
): { controlDevice: boolean; screenCapture: boolean } | undefined {
  const permissions = (raw as { permissions?: unknown } | undefined)?.permissions;
  if (typeof permissions !== "object" || permissions === null) return undefined;
  const record = permissions as Record<string, unknown>;
  const read = (key: string): boolean => record[key] === true;
  return {
    controlDevice: read("controlDevice"),
    screenCapture: read("screenCapture"),
  };
}

// 把桥文件映射成对外状态：granted 恒等于两权限全部授予（聚合门禁，spec 15）。
// 旧版 ArkTS 只写 permission 时退化为该字段，保证升级期不误判。
function toStatus(raw: unknown): OhosComputerControlStatus {
  const permissions = readPermissions(raw);
  if (permissions !== undefined) {
    return {
      supported: true,
      granted: permissions.controlDevice && permissions.screenCapture,
      permissions,
    };
  }
  return { supported: true, granted: readPermissionState(raw) === "granted" };
}

// 解析桥文件中的权限态；缺字段/坏 JSON 返回 undefined（调用方按未授权处理，fail-closed）。
export function parseOhosComputerControlPermission(content: string): boolean | undefined {
  try {
    const state = readPermissionState(JSON.parse(content));
    if (state === "granted") return true;
    if (state === "needs-grant") return false;
    return undefined;
  } catch {
    return undefined;
  }
}

// 纯解析：把 status.json 文本映射成对外状态（导出供单测覆盖聚合规则）。
export function parseOhosComputerControlStatus(
  content: string,
): OhosComputerControlStatus | undefined {
  try {
    const raw: unknown = JSON.parse(content);
    if (readPermissions(raw) === undefined && readPermissionState(raw) === "unknown") {
      return undefined;
    }
    return toStatus(raw);
  } catch {
    return undefined;
  }
}

// 读取当前授权状态；桥文件未写或损坏时按未授权报（ArkTS 下一次写入会对齐真实状态）。
export async function readOhosComputerControlStatus(): Promise<OhosComputerControlStatus> {
  if (!isOhosRuntime()) {
    return UNSUPPORTED_STATUS;
  }
  const raw = readJsonSync<unknown>(OHOS_BRIDGE_PATHS.computerControlStatus);
  return raw === undefined ? UNSUPPORTED_STATUS : toStatus(raw);
}

/**
 * watch status.json 变更（ArkTS 1s 轮询重写）。只在值变化时回调。
 * 非 OHOS 返回空 disposer。
 */
export function watchOhosComputerControlPermission(
  onChange: (status: OhosComputerControlStatus) => void,
  logger: { warn: (...args: unknown[]) => void },
): () => void {
  if (!isOhosRuntime()) {
    return () => {};
  }
  return watchJsonValue<OhosComputerControlStatus>({
    path: OHOS_BRIDGE_PATHS.computerControlStatus,
    parse: (raw) => {
      if (readPermissions(raw) === undefined && readPermissionState(raw) === "unknown") {
        return undefined;
      }
      return toStatus(raw);
    },
    equals: (left, right) =>
      left.granted === right.granted &&
      left.permissions?.controlDevice === right.permissions?.controlDevice &&
      left.permissions?.screenCapture === right.permissions?.screenCapture,
    onChange,
    logger,
  });
}

/**
 * 写「去开启」请求文件（renderer 触发授权引导的通道）：main 落文件、
 * ArkTS ComputerControlService 1s tick 消费（spec 13）。
 */
export function writeOhosComputerControlPermissionRequest(
  logger: { warn: (...args: unknown[]) => void } = console,
): void {
  if (!isOhosRuntime()) {
    return;
  }
  try {
    writeTextAtomic(OHOS_BRIDGE_PATHS.computerControlRequest, `${Date.now()}\n`);
  } catch (error) {
    logger.warn("[ohos-computer-control] write permission request failed:", error);
  }
}
