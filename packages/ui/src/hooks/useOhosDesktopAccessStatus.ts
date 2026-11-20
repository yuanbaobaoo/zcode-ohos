import { useEffect, useState } from "react";
import type { IPlatformService, OhosDesktopAccessStatus } from "@zcode/shared";

/**
 * 查询并订阅 OHOS Desktop 目录授权状态（spec 18）。
 * Desktop 不被全盘权限覆盖；非 OHOS 平台恒为 undefined。
 */
export function useOhosDesktopAccessStatus(
  platform: IPlatformService,
): OhosDesktopAccessStatus | undefined {
  const [status, setStatus] = useState<OhosDesktopAccessStatus | undefined>(undefined);
  useEffect(() => {
    if (!platform.getOhosDesktopAccessStatus) return;
    let cancelled = false;
    void platform
      .getOhosDesktopAccessStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {});
    const dispose = platform.onOhosDesktopAccessChanged?.((next) => setStatus(next));
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [platform]);
  return status;
}
