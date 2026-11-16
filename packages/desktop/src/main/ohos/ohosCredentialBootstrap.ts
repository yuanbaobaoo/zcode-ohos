import {
  createSystemCredentialCipher,
  enablePrivateFileKeyFallback,
  type SystemCredentialCipher,
} from "@zcode/shared/credential-security";
import { isOhosRuntime } from "@zcode/shared";
import { logger } from "../logger.js";
import { createOhosAssetKeyStore } from "./ohosAssetKeyStore.js";

/**
 * 凭据主密钥的 OHOS 落点：系统资产库优先，组件缺失时回退同目录私钥文件（spec 16）。
 * 必须在首次凭据访问前调用——上游回退开关只对「尚未绑定来源」的凭据目录生效。
 */
export function bootstrapOhosCredentialStorage(): void {
  if (!isOhosRuntime()) return;
  const enabled = enablePrivateFileKeyFallback({
    onFallback: () => logger.warn("[credential] OHOS 系统资产库不可用，已改用私有文件密钥"),
  });
  if (!enabled) {
    logger.warn("[credential] 凭据已在回退开启前被访问，本次进程保持系统资产库规则");
  }
}

/** Main 侧唯一凭据后端；Host/CLI 经上游凭据桥复用同一份密钥。 */
export function createDesktopCredentialCipher(credentialsFilePath: string): SystemCredentialCipher {
  if (!isOhosRuntime()) return createSystemCredentialCipher({ filePath: credentialsFilePath });
  const keyStore = createOhosAssetKeyStore(credentialsFilePath);
  return createSystemCredentialCipher({
    filePath: credentialsFilePath,
    ...(keyStore ? { keyStore } : {}),
  });
}
