// 开发包数据根（spec 24）：dev 身份由 HAP 内标记决定，读不到即正式包，行为不变。
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 应用沙箱文件根：真实 home 不可写时的数据落点（spec 02）。 */
export const OHOS_SANDBOX_FILES = "/data/storage/el2/base/files";

/** build-ohos --dev-identity 写进 resfile 组装副本的标记；正式包没有该文件。 */
export const OHOS_DEV_IDENTITY_MARKER =
  "/data/storage/el1/bundle/electron/resources/resfile/resources/app/config/dev-identity.json";

export const OHOS_DEV_DATA_ROOT_NAME = ".zcode-dev";

export function hasOhosDevIdentity(markerPath: string = OHOS_DEV_IDENTITY_MARKER): boolean {
  return existsSync(markerPath);
}

/**
 * 按 dev 身份写数据根/会话库 env 并返回数据根；正式包返回 null 且不改 env。
 * main 与 host 各调一次：appspawn 隔离下 host 不继承 main env（spec 02）。
 */
export function applyOhosDevDataRootEnv(
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
  markerPath: string = OHOS_DEV_IDENTITY_MARKER,
): string | null {
  if (!hasOhosDevIdentity(markerPath)) return null;
  const root = join(baseDir, OHOS_DEV_DATA_ROOT_NAME);
  env.ZCODE_DATA_ROOT_DIR = root;
  env.ZCODE_HOME = root;
  env.ZCODE_SESSION_DB_PATH = join(root, "cli", "db", "db.sqlite");
  return root;
}
