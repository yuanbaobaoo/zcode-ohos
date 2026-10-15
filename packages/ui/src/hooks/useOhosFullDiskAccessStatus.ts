import { useEffect, useState } from "react";
import type { IPlatformService, OhosFullDiskAccessStatus } from "@zcode/shared";

/**
 * 查询并订阅 OHOS「访问全盘文件」授权状态（spec 08）；非 OHOS 平台恒为 undefined。
 * 状态回流靠 main 的桥文件 watch 推送（系统设置改动后 ≤1s 刷新）。
 */
export function useOhosFullDiskAccessStatus(
  platform: IPlatformService,
): OhosFullDiskAccessStatus | undefined {
  const [status, setStatus] = useState<OhosFullDiskAccessStatus | undefined>(undefined);
  useEffect(() => {
    if (!platform.getOhosFullDiskAccessStatus) return;
    let cancelled = false;
    void platform
      .getOhosFullDiskAccessStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {});
    const dispose = platform.onOhosFullDiskAccessChanged?.((next) => setStatus(next));
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [platform]);
  return status;
}
