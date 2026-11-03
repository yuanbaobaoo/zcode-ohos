import { isOhosRuntime } from "@zcode/shared";

// OHOS 主进程 exec 外部命令会终止整个应用（spec 02），跳过 `ssh -G` 探测。
export function shouldSkipSshExecutableProbe(): boolean {
  return isOhosRuntime();
}
