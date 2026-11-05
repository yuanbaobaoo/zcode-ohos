// @vitest-environment jsdom
// spec：specs/ohos-port/15-单控制通道与平台适配治理.md（聚合门禁）
// 权限丢失后的状态回收：启动/运行中权限撤销时，若电脑控制仍启用 → 自动关闭并提示；
// 权限恢复不自动开启；toggling 中不抢用户操作。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import type { OhosComputerControlStatus } from "@zcode/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  status: undefined as OhosComputerControlStatus | undefined,
  cuaEnabled: true,
  togglingPluginId: null as string | null,
  setEnabledCalls: [] as Array<{ pluginId: string; enabled: boolean }>,
  toastCalls: [] as string[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return actual;
});

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ isOhos: true }),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ pluginManagementService: {} }),
}));

vi.mock("@/hooks/useOhosComputerControlStatus.js", () => ({
  useOhosComputerControlStatus: () => h.status,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: (message: string) => h.toastCalls.push(message),
}));

vi.mock("@/logger.js", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

vi.mock("@/store/pluginManagementStore.js", () => {
  const usePluginManagementStore = create(() => ({
    plugins: [] as Array<{ id: string; enabled: boolean }>,
    togglingPluginId: null as string | null,
    initialize: () => {},
    setEnabled: async (pluginId: string, enabled: boolean) => {
      h.setEnabledCalls.push({ pluginId, enabled });
      usePluginManagementStore.setState({
        plugins: usePluginManagementStore
          .getState()
          .plugins.map((plugin) => (plugin.id === pluginId ? { ...plugin, enabled } : plugin)),
      });
    },
  }));
  return { usePluginManagementStore };
});

const { usePluginManagementStore } = await import("@/store/pluginManagementStore.js");
const { useOhosCuaPermissionReconcile } = await import(
  "@/hooks/useOhosCuaPermissionReconcile.js"
);

function Harness(): null {
  useOhosCuaPermissionReconcile({ workspacePath: "/workspace", workspaceIdentity: undefined });
  return null;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function render(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Harness));
  });
  // 等 setEnabled 的 promise 落地
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  h.status = undefined;
  h.cuaEnabled = true;
  h.togglingPluginId = null;
  h.setEnabledCalls = [];
  h.toastCalls = [];
  usePluginManagementStore.setState({
    plugins: [{ id: ZCODE_CUA_OFFICIAL_PLUGIN_ID, enabled: true }],
    togglingPluginId: null,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("useOhosCuaPermissionReconcile", () => {
  it("权限三缺一且插件仍启用 → 自动关闭并提示", async () => {
    h.status = {
      supported: true,
      granted: false,
      permissions: { controlDevice: true, screenCapture: false },
    };
    await render();
    expect(h.setEnabledCalls).toEqual([
      { pluginId: ZCODE_CUA_OFFICIAL_PLUGIN_ID, enabled: false },
    ]);
    expect(h.toastCalls).toEqual(["settings.computerUse.permissionRevokedToast"]);
  });

  it("权限完整时不动作", async () => {
    h.status = {
      supported: true,
      granted: true,
      permissions: { controlDevice: true, screenCapture: true },
    };
    await render();
    expect(h.setEnabledCalls).toEqual([]);
    expect(h.toastCalls).toEqual([]);
  });

  it("插件未启用 / 正在切换 / 状态未回流 都不动作", async () => {
    usePluginManagementStore.setState({
      plugins: [{ id: ZCODE_CUA_OFFICIAL_PLUGIN_ID, enabled: false }],
    });
    h.status = { supported: true, granted: false, permissions: { controlDevice: false, screenCapture: false } };
    await render();
    expect(h.setEnabledCalls).toEqual([]);

    act(() => root?.unmount());
    container?.remove();

    usePluginManagementStore.setState({
      plugins: [{ id: ZCODE_CUA_OFFICIAL_PLUGIN_ID, enabled: true }],
      togglingPluginId: ZCODE_CUA_OFFICIAL_PLUGIN_ID,
    });
    await render();
    expect(h.setEnabledCalls).toEqual([]);

    act(() => root?.unmount());
    container?.remove();

    usePluginManagementStore.setState({ togglingPluginId: null });
    h.status = { supported: false, granted: false };
    await render();
    expect(h.setEnabledCalls).toEqual([]);
  });
});
