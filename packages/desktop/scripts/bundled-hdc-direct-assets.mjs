// 随包 hdc-direct：沙箱内 hdc server 起不来，设备操作由该库在 agent 进程内
// 直连 hdcd（spec 11）。依赖完整性由 pnpm-lock 记录，这里只把已安装的
// node_modules/hdc-direct 复制进 glm；升级改 desktop 依赖 URL 的版本号。
import { access, cp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// 相对 glm 目录（zcode.cjs 所在目录）的位置；与 core 的 ohos-hdc handler 同一约定
export const BUNDLED_HDC_DIRECT_STAGED_SEGMENTS = ["node-runtime", "hdc-direct"];
// 资产必须包含的入口文件
const REQUIRED_ENTRIES = ["package.json", "dist/src/cli.js", "dist/src/index.js"];

// 能力开关：与 core 的 ohos-device 能力读同一变量；关闭时不复制、不门禁
export const HDC_DIRECT_BRIDGE_ENV = "ZCODE_OHOS_HDC_BRIDGE";
const DISABLED_VALUES = new Set(["0", "off", "false", "native", "disabled"]);

export function isHdcDirectBridgeEnabled(env = process.env) {
  const raw = env[HDC_DIRECT_BRIDGE_ENV]?.trim().toLowerCase();
  return !(raw && DISABLED_VALUES.has(raw));
}

export function resolveHdcDirectPackageRoot(fromModule = import.meta.url) {
  const require = createRequire(fromModule);
  return dirname(require.resolve("hdc-direct/package.json"));
}

// 唯一事实是 desktop 依赖 URL；此处仅读包内 package.json 用于日志
export async function installedHdcDirectVersion(packageRoot) {
  return JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version;
}

export async function stageBundledHdcDirect({
  glmDir,
  packageRoot = resolveHdcDirectPackageRoot(),
}) {
  await assertRequiredEntries(packageRoot);
  const targetRoot = join(glmDir, ...BUNDLED_HDC_DIRECT_STAGED_SEGMENTS);
  await rm(targetRoot, { force: true, recursive: true });
  await cp(packageRoot, targetRoot, { recursive: true });
  return targetRoot;
}

async function assertRequiredEntries(packageRoot) {
  for (const entry of REQUIRED_ENTRIES) {
    try {
      await access(join(packageRoot, ...entry.split("/")));
    } catch (error) {
      throw new Error(
        `[bundled-hdc-direct] installed package missing ${entry} in ${packageRoot}; run pnpm install`,
        { cause: error },
      );
    }
  }
}
