import { isOhosRuntime } from "@zcode/shared";
import { resolveOhosRealHome } from "./ohosUserShellEnv.js";

// OHOS 进程 cwd 可能是沙箱根 `/`，brew 等工具要求 cwd 对 uid 可读（spec 02/03）。
export function resolveDefaultSpawnCwd(platform: string = process.platform): string {
  if (!isOhosRuntime(platform)) return process.cwd();
  return resolveOhosRealHome() ?? process.cwd();
}
