/**
 * OHOS「辅助操作」(CONTROL_DEVICE) 授权状态的进程内共享缓存（spec 13）。
 *
 * 为什么需要它：授权状态原本只在设置页挂载时冷查询，用户进页面先看到 fail-closed 的
 * 灰显窗口再解锁，感知异常。改为 App 挂载即幂等 ensure（初始查询 + 订阅 main 的
 * watch 推送），设置页打开时读到的已是热值；ArkTS 1s 轮询 → status.json → main watch
 * 的推送链持续更新，这里只是系统授权的 renderer 投影（唯一事实仍在系统侧）。
 */
import type { IPlatformService, OhosComputerControlStatus } from "@zcode/shared";

let current: OhosComputerControlStatus | undefined = undefined;
let started = false;
const listeners = new Set<() => void>();

export function subscribeOhosComputerControlStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getOhosComputerControlStatusSnapshot(): OhosComputerControlStatus | undefined {
  return current;
}

function publish(next: OhosComputerControlStatus): void {
  if (next.supported === current?.supported && next.granted === current?.granted) return;
  current = next;
  for (const listener of listeners) listener();
}

/**
 * 幂等启动：初始查询一次 + 常驻订阅 main 推送。平台未实现该能力（非 Desktop-OHOS /
 * 旧 preload）时为空操作，状态恒为 undefined（消费方按不支持处理）。
 */
export function ensureOhosComputerControlStatusStarted(platform: IPlatformService): void {
  if (started) return;
  if (!platform.getOhosComputerControlStatus) return;
  started = true;
  void platform
    .getOhosComputerControlStatus()
    .then(publish)
    .catch(() => {
      // 初始查询失败保持 undefined；main 推送与下一次进设置页的重新 ensure 不存在——
      // 订阅已建立，状态仍会经 watch 推送回流。
    });
  platform.onOhosComputerControlChanged?.((next) => publish(next));
}

/** 测试复位：模块级缓存会跨用例存活。 */
export function resetOhosComputerControlStatusStoreForTest(): void {
  current = undefined;
  started = false;
  listeners.clear();
}
