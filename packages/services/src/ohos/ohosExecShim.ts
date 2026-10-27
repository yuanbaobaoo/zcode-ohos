import { existsSync } from "node:fs";

// agent 命令无缝（spec 03）：LD_PRELOAD 只有 bundle 内库会被加载——用户目录路径
// 真机实测被忽略（不存在的路径也不报错）。
const OHOS_EXEC_SHIM_PATH = "/data/storage/el1/bundle/libs/arm64/libzcode_exec_shim.so";

export function applyOhosExecShimToProcessEnv(
  exists: (path: string) => boolean = existsSync,
): boolean {
  try {
    if (!exists(OHOS_EXEC_SHIM_PATH)) return false;
  } catch {
    return false;
  }
  const entries = (process.env.LD_PRELOAD ?? "").split(":").filter(Boolean);
  if (entries.includes(OHOS_EXEC_SHIM_PATH)) return true;
  process.env.LD_PRELOAD = [OHOS_EXEC_SHIM_PATH, ...entries].join(":");
  return true;
}
