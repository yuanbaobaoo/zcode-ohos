import { isOhosRuntime } from "@zcode/shared";

export function resolveOhosPtyTransportMissingError(): Error | null {
  if (!isOhosRuntime()) return null;
  return new Error("当前环境不支持终端：鸿蒙模拟器禁止应用创建子进程，请在真机上使用终端");
}
