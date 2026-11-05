const UNAVAILABLE_TEXT = "Computer Use is not available in this build.";

// OHOS 分支：接入仓库内 ArkTS 执行端（spec 13）；其余平台保持占位 fail-closed。
// createComputerUseRuntime 的 env 捕获门（ZCODE_CUA_PERMISSION_BROKER_SOCKET）由
// ohosUserShellEnv 引导注入，值本身无连接语义。
import { createOhosComputerUseRuntime, isOhosIdentity } from "./ohos-computer-use.js";

// 平台身份自证（spec 15）：MCP 子进程可能为绕开 bundle noexec 改由用户环境 node 启动
// （process.platform 报 "linux"），身份由 ZCODE_OHOS_RUNTIME 权威信号跨解释器继承。
// 这里留一行 stderr 证据，排查时不必再猜"没起来"还是"起来了但认错平台"。
// stderr 是 MCP stdio server 的日志通道，不污染 stdout 协议帧。
function reportRuntimeIdentity(platform, ohos) {
  try {
    process.stderr.write(
      `[zcode-cua] runtime=${ohos ? "ohos" : "placeholder"} platform=${platform} ` +
        `authority=${process.env?.ZCODE_OHOS_RUNTIME ?? "-"}\n`,
    );
  } catch {
    // stderr 不可用不影响 runtime 装配。
  }
}

export function createComputerUseRuntime(options = {}) {
  const platform = options.platform ?? process.platform;
  const ohos = isOhosIdentity(platform);
  reportRuntimeIdentity(platform, ohos);
  if (ohos) {
    return createOhosComputerUseRuntime(options);
  }
  return {
    async execute() {
      return {
        content: [{ type: "text", text: UNAVAILABLE_TEXT }],
        isError: true,
      };
    },
    async closeSession() {},
    async dispose() {},
  };
}
