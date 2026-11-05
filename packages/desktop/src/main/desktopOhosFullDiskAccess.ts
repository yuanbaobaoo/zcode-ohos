/*
 * OHOS「访问全盘文件」授权状态桥（main 侧，读者）：EntryAbility 在窗口创建与
 * onForeground 时把 checkAccessToken 结果写入 haps 沙箱桥文件（spec 08），
 * 这里读取并经目录 watch 推送变更给 renderer。路径与桥原语见 ohos/paths.ts、ohos/fileBridge.ts。
 */

import { isOhosRuntime, type OhosFullDiskAccessStatus } from "@zcode/shared";
import { readJsonSync, watchJsonValue, writeTextAtomic } from "./ohos/fileBridge.js";
import { OHOS_BRIDGE_PATHS } from "./ohos/paths.js";

const UNSUPPORTED_STATUS: OhosFullDiskAccessStatus = { supported: false, granted: false };

// 解析桥文件内容；缺字段/坏 JSON 返回 undefined（调用方按未授权处理）。
export function parseOhosFullDiskAccessState(content: string): boolean | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const granted = (parsed as { granted?: unknown }).granted;
    return typeof granted === "boolean" ? granted : undefined;
  } catch {
    return undefined;
  }
}

// 读取当前授权状态；桥文件未写或损坏时按未授权报（ArkTS 下一次写入会对齐真实状态）。
export async function readOhosFullDiskAccessStatus(): Promise<OhosFullDiskAccessStatus> {
  if (!isOhosRuntime()) {
    return UNSUPPORTED_STATUS;
  }
  const parsed = readJsonSync<{ granted?: unknown }>(OHOS_BRIDGE_PATHS.fullDiskAccessState);
  const granted = typeof parsed?.granted === "boolean" ? parsed.granted : false;
  return { supported: true, granted };
}

/**
 * watch 桥文件变更（ArkTS 在 onForeground 重写）。只在值变化时回调。
 * 非 OHOS 返回空 disposer。
 */
export function watchOhosFullDiskAccessGranted(
  onChange: (granted: boolean) => void,
  logger: { warn: (...args: unknown[]) => void },
): () => void {
  if (!isOhosRuntime()) {
    return () => {};
  }
  return watchJsonValue<boolean>({
    path: OHOS_BRIDGE_PATHS.fullDiskAccessState,
    parse: (raw) =>
      typeof (raw as { granted?: unknown } | undefined)?.granted === "boolean"
        ? (raw as { granted: boolean }).granted
        : undefined,
    equals: (left, right) => left === right,
    onChange,
    logger,
  });
}

/**
 * 写「去开启」请求文件（renderer 触发授权面板的通道）：iframe/window.open 自定义
 * scheme 在 OHOS Electron 均静默失败（真机实证，不进外部协议分发），改由 main 落
 * 请求文件、EntryAbility 前台轮询消费（spec 08）。
 */
export function writeOhosFullDiskAccessRequest(
  logger: { warn: (...args: unknown[]) => void } = console,
): void {
  if (!isOhosRuntime()) {
    return;
  }
  try {
    writeTextAtomic(OHOS_BRIDGE_PATHS.fullDiskAccessRequest, `${Date.now()}\n`);
  } catch (error) {
    logger.warn("[ohos-full-disk] write request failed:", error);
  }
}
