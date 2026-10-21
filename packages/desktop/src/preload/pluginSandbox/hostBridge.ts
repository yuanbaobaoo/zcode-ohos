import { contextBridge, ipcRenderer } from "electron";
import { InternalChannels, PlatformChannels } from "@zcode/shared";
import type { PluginSandboxCaptureRequest } from "@zcode/shared/mcp-apps";
import { enableSandboxRetainedMoves } from "./retainedMoves.js";

export function installPluginSandboxHostBridge(): void {
  // OHOS Electron 沙箱 preload 的 contextBridge 没有 executeInMainWorld（API 面偏旧），
  // 直接调用会让整段 preload 加载失败（窗口拿不到启动状态）。能力缺失按不支持
  // retained move 降级，沙箱本体（exposeInMainWorld + postMessage 端口转发）不受影响。
  const supportsRetainedMove =
    typeof contextBridge.executeInMainWorld === "function" &&
    contextBridge.executeInMainWorld({ func: enableSandboxRetainedMoves }) === true;
  /**
   * 插件 UI 沙箱：独立命名空间，不进 window.zcode。只暴露明确的沙箱操作；
   * 端口不能过 contextBridge，走下面的 window.postMessage transfer。
   */
  contextBridge.exposeInMainWorld("zcodePluginSandbox", {
    supportsRetainedMove,
    setExecutionActive: (sandboxId: string, initId: number, active: boolean) =>
      ipcRenderer.invoke(
        PlatformChannels.PluginSandboxExecutionActive,
        sandboxId,
        initId,
        active,
      ) as Promise<void>,
    copyImage: (input: PluginSandboxCaptureRequest) =>
      ipcRenderer.invoke(PlatformChannels.PluginSandboxCopyImage, input) as Promise<void>,
    getOwnerWebContentsId: () =>
      ipcRenderer.invoke(PlatformChannels.PluginSandboxOwnerWebContentsId) as Promise<number>,
    disposeSandbox: (sandboxId: string, initId?: number) =>
      ipcRenderer.invoke(PlatformChannels.PluginSandboxDispose, sandboxId, initId) as Promise<void>,
    consumeUserGesture: (sandboxId: string) =>
      ipcRenderer.invoke(
        PlatformChannels.PluginSandboxConsumeUserGesture,
        sandboxId,
      ) as Promise<boolean>,
  });

  ipcRenderer.on(
    InternalChannels.PluginSandboxPorts,
    (event, payload: { sandboxId?: unknown; initId?: unknown }) => {
      if (typeof payload?.sandboxId !== "string" || typeof payload?.initId !== "number") {
        return;
      }
      window.postMessage(
        {
          type: InternalChannels.PluginSandboxPorts,
          sandboxId: payload.sandboxId,
          initId: payload.initId,
        },
        "*",
        event.ports,
      );
    },
  );
}
