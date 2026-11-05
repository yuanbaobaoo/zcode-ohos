import { useEffect, useSyncExternalStore } from "react";
import type { IPlatformService, OhosComputerControlStatus } from "@zcode/shared";
import {
  ensureOhosComputerControlStatusStarted,
  getOhosComputerControlStatusSnapshot,
  subscribeOhosComputerControlStatus,
} from "@/lib/ohosComputerControlStatusStore.js";

/**
 * 读取 OHOS「辅助操作」(CONTROL_DEVICE) 授权状态（spec 13）；非 OHOS 平台恒为 undefined。
 * 状态存进程内共享 store：App 挂载即预热（初始查询 + 订阅 main watch 推送），设置页
 * 打开时读到的已是热值——不再有进页面冷查询的灰显窗口。
 */
export function useOhosComputerControlStatus(
  platform: IPlatformService,
): OhosComputerControlStatus | undefined {
  useEffect(() => {
    ensureOhosComputerControlStatusStarted(platform);
  }, [platform]);
  return useSyncExternalStore(
    subscribeOhosComputerControlStatus,
    getOhosComputerControlStatusSnapshot,
  );
}
