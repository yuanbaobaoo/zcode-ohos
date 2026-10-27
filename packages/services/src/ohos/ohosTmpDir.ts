import { mkdirSync } from "node:fs";
import { join } from "node:path";

// 平台 /tmp 对应用 uid 不可写（spec 03）；与 /storage/Users 同文件系统，临时文件 move 到工作区不跨设备。
export function ohosTmpDirPath(realHome: string): string {
  return join(realHome, ".zcode", "tmp");
}

export function ensureOhosTmpDir(realHome: string): string | undefined {
  const dir = ohosTmpDirPath(realHome);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return undefined;
  }
}

// AF_UNIX 路径型 bind 在 /storage/Users 被虚拟化层拦截（EPERM，真机实证 znr-*.sock），
// socket 必须落在应用 el2 区；TMPDIR 可以指向真实 home，socket 目录不能跟随。
export function ohosSocketDirPath(): string {
  return "/data/storage/el2/base/files/tmp";
}

export function ensureOhosSocketDir(): string | undefined {
  const dir = ohosSocketDirPath();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return undefined;
  }
}
