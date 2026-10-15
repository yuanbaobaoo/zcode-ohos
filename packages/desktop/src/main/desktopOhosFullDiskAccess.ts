/*
 * OHOS「访问全盘文件」授权状态桥（main 侧，读者）：EntryAbility 在窗口创建与
 * onForeground 时把 checkAccessToken 结果写入 haps 沙箱桥文件（spec 08），
 * 这里读取并经 fs.watch 推送变更给 renderer。
 */

import { mkdirSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isOhosRuntime, type OhosFullDiskAccessStatus } from "@zcode/shared";
import { OHOS_HAPS_FILES_DIR } from "./desktopOhosWindowTheme.js";

const STATE_FILENAME = "full-disk-access.json";
const REQUEST_FILENAME = "full-disk-access.request";

const UNSUPPORTED_STATUS: OhosFullDiskAccessStatus = { supported: false, granted: false };

/** 解析桥文件内容；缺字段/坏 JSON 返回 undefined（调用方按未授权处理）。 */
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

/** 读取当前授权状态；桥文件未写或损坏时按未授权报（ArkTS 下一次写入会对齐真实状态）。 */
export async function readOhosFullDiskAccessStatus(): Promise<OhosFullDiskAccessStatus> {
  if (!isOhosRuntime()) {
    return UNSUPPORTED_STATUS;
  }
  try {
    const content = await readFile(join(OHOS_HAPS_FILES_DIR, STATE_FILENAME), "utf-8");
    return { supported: true, granted: parseOhosFullDiskAccessState(content) ?? false };
  } catch {
    return { supported: true, granted: false };
  }
}

/**
 * watch 桥文件变更（ArkTS 在 onForeground 重写）。只在值变化时回调。
 * 非 OHOS 返回空 disposer。
 */
export function watchOhosFullDiskAccessGranted(
  onChange: (granted: boolean) => void,
  logger: { warn: (...args: unknown[]) => void } = console,
): () => void {
  if (!isOhosRuntime()) {
    return () => {};
  }
  let watcher: FSWatcher | undefined;
  let last: boolean | undefined;
  const emitIfChanged = async (): Promise<void> => {
    const status = await readOhosFullDiskAccessStatus();
    if (status.granted !== last) {
      last = status.granted;
      onChange(status.granted);
    }
  };
  try {
    // ArkTS 首次写入前文件可能不存在，watch 目录并过滤文件名。
    mkdirSync(OHOS_HAPS_FILES_DIR, { recursive: true });
    watcher = watch(OHOS_HAPS_FILES_DIR, (_event, filename) => {
      if (filename === STATE_FILENAME) {
        void emitIfChanged();
      }
    });
  } catch (error) {
    // watch 失败只失去自动推送：renderer 仍可在设置页打开时主动查询。
    logger.warn("[ohos-full-disk] watch failed:", error);
  }
  return () => watcher?.close();
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
    mkdirSync(OHOS_HAPS_FILES_DIR, { recursive: true });
    writeFileSync(join(OHOS_HAPS_FILES_DIR, REQUEST_FILENAME), `${Date.now()}\n`, "utf-8");
  } catch (error) {
    logger.warn("[ohos-full-disk] write request failed:", error);
  }
}
