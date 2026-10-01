import type { ExternalFilesReceivedPayload } from "@zcode/shared";

/**
 * 平台外部文件（鸿蒙碰一碰投送等）→ 输入框附件的 renderer 内路由。
 *
 * 与白板 ADD_TO_CHAT（lib/whiteboard.ts）同款机制：root 订阅平台事件后在 window 上
 * 派发 CustomEvent，只有聚焦 composer（listenAddToChatEvents）消费并 preventDefault
 * 认领，避免常驻的多个 SessionPane 同时注入附件。
 */
export const EXTERNAL_FILES_ADD_TO_CHAT_EVENT = "zcode:add-external-files-to-chat";

/** renderer 进程级批次幂等：main 崩溃补投窗口内可能重发同一 batchId。 */
const consumedBatchIds = new Map<string, number>();
const CONSUMED_BATCH_TTL_MS = 10 * 60 * 1000;

export function shouldConsumeExternalFilesBatch(batchId: string): boolean {
  const now = Date.now();
  for (const [id, at] of consumedBatchIds) {
    if (now - at > CONSUMED_BATCH_TTL_MS) consumedBatchIds.delete(id);
  }
  if (consumedBatchIds.has(batchId)) return false;
  consumedBatchIds.set(batchId, now);
  return true;
}

/** 派发给聚焦 composer；返回是否被认领，未认领时调用方负责用户提示。 */
export function dispatchExternalFilesAddToChat(payload: ExternalFilesReceivedPayload): boolean {
  const event = new CustomEvent<ExternalFilesReceivedPayload>(EXTERNAL_FILES_ADD_TO_CHAT_EVENT, {
    detail: payload,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

export function isExternalFilesAddToChatEvent(
  event: Event,
): event is CustomEvent<ExternalFilesReceivedPayload> {
  return event.type === EXTERNAL_FILES_ADD_TO_CHAT_EVENT;
}
