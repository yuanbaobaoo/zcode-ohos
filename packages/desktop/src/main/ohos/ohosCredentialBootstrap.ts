import { isOhosRuntime } from "@zcode/shared";
import {
  createSystemCredentialCipher,
  type SystemCredentialCipher,
} from "@zcode/shared/credential-security";
import { createOhosAssetKeyStore } from "./ohosAssetKeyStore.js";

/**
 * 凭据主密钥的 OHOS 落点：系统资产库优先，组件缺失时由上游的私有文件密钥回退兜底（spec 16）。
 * 回退与已绑定目录的自动重置由 Main 统一开启（@zcode/shared/credential-security），
 * 这里只负责选后端，不再重复 bootstrap。
 */
export function createDesktopCredentialCipher(credentialsFilePath: string): SystemCredentialCipher {
  if (!isOhosRuntime()) return createSystemCredentialCipher({ filePath: credentialsFilePath });
  const keyStore = createOhosAssetKeyStore(credentialsFilePath);
  return createSystemCredentialCipher({
    filePath: credentialsFilePath,
    ...(keyStore ? { keyStore } : {}),
  });
}
