import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { CredentialKeyStore } from "@zcode/shared/credential-security";
import { logger } from "../logger.js";

/**
 * 系统资产库（Asset Store）绑定：主密钥经 libasset_ndk.z.so 加密保存，明文不落盘。
 * 打包布局与 zcode_sqlite.node 一致（resfile app 根 + HAP libs），spec 16。
 */
interface OhosAssetKeyRing {
  get(alias: string): string | null;
  set(alias: string, secret: string): void;
}

const ASSET_KEYRING_FILE = "ohos_asset_keyring.node";
const LAYOUT_CANDIDATES = [
  `/data/storage/el1/bundle/electron/resources/resfile/resources/app/${ASSET_KEYRING_FILE}`,
  `/data/storage/el1/bundle/electron/libs/arm64-v8a/${ASSET_KEYRING_FILE}`,
  `/data/storage/el1/bundle/libs/arm64/${ASSET_KEYRING_FILE}`,
] as const;
const SYSTEM_SERVICE = "ZCode Credential Encryption";

let cached: OhosAssetKeyRing | null | undefined;
let loggedLoadFailure = false;

function loadAddon(): OhosAssetKeyRing | undefined {
  if (cached !== undefined) return cached ?? undefined;
  const candidates = [
    ...LAYOUT_CANDIDATES,
    // dev 直接加载 native 目录产物；未编译时按不可用处理。
    join(import.meta.dirname, "../../../native/ohos-asset-keyring", ASSET_KEYRING_FILE),
  ];
  const require = createRequire(import.meta.url);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      cached = require(candidate) as OhosAssetKeyRing;
      logger.info(`[credential] OHOS asset keyring loaded: ${candidate}`);
      return cached;
    } catch {
      // 单个候选加载失败（架构/依赖不符）继续试下一个，最终由调用方走回退。
    }
  }
  cached = null;
  if (!loggedLoadFailure) {
    loggedLoadFailure = true;
    logger.warn(
      "[credential] OHOS asset keyring unavailable; credentials fall back to a private file key",
      { candidates },
    );
  }
  return undefined;
}

/**
 * 每个凭据文件一条系统资产（别名取文件路径摘要），与桌面钥匙串按数据根隔离的语义一致。
 * 组件不可用时返回 undefined，由私钥文件回退兜底，登录仍可保存。
 */
export function createOhosAssetKeyStore(credentialsFilePath: string): CredentialKeyStore | undefined {
  const addon = loadAddon();
  if (!addon) return undefined;
  const alias = `${SYSTEM_SERVICE}:${createHash("sha256")
    .update(resolve(credentialsFilePath))
    .digest("hex")}`;
  return {
    async get() {
      return addon.get(alias);
    },
    async set(value) {
      addon.set(alias, value);
    },
  };
}

export function isOhosAssetKeyStoreAvailable(): boolean {
  return loadAddon() !== undefined;
}
