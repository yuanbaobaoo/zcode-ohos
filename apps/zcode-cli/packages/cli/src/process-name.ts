import { assignProcessTitle } from "@zcode/shared";

export const CLI_COMMAND_NAME = "zcode";
export const CLI_PROCESS_NAME = "zcode-cli";
const MCP_PROCESS_NAME = "zcode-mcp";
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

interface ProcessTitleTarget {
  title: string;
}

export const setCliProcessTitle = (target: ProcessTitleTarget = process): void => {
  // OHOS Electron 的 process.title setter 会触发 uv_set_process_title memset
  // 下溢并 SIGSEGV 整进程（装机实测：agent Worker 内 app-server 启动即崩，
  // storage Worker 因跳过本调用而幸存）；统一走共享 guard。
  if (target === process) {
    assignProcessTitle(CLI_PROCESS_NAME);
    return;
  }
  target.title = CLI_PROCESS_NAME;
};

export const setPluginHostProcessTitle = (
  pluginId: string | undefined,
  target: ProcessTitleTarget = process,
): void => {
  const pluginName = pluginId?.split("@", 1)[0]?.trim().toLowerCase();
  target.title =
    pluginName && PLUGIN_NAME_PATTERN.test(pluginName)
      ? `${MCP_PROCESS_NAME}-${pluginName}`
      : MCP_PROCESS_NAME;
};
