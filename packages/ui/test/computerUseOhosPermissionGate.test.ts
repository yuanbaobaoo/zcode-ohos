// @vitest-environment jsdom
// spec：specs/ohos-port/13-本机电脑控制产品化.md —— 设置页「辅助操作」门控。
// 产品裁定：未授权时滑块真 disabled（不响应点击），其上透明遮罩承接点击（弹授权引导）
// 与 hover 提示；fail-closed——状态未回流同样锁。onTogglePlugin 内的 ref 门控是写入点
// 兜底（合成事件/滞后闭包/其它调用路径）。
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { resetOhosComputerControlStatusStoreForTest } from "@/lib/ohosComputerControlStatusStore.js";
import type { OhosComputerControlStatus } from "@zcode/shared";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  // 可变测试状态：platform 查询返回值 / store 快照 / 请求调用记录。
  status: undefined as OhosComputerControlStatus | undefined,
  statusReady: false,
  cuaEnabled: false,
  setEnabledCalls: [] as Array<boolean>,
  requestCalls: 0,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    isOhos: true,
    getOhosComputerControlStatus: () =>
      h.statusReady ? Promise.resolve(h.status) : new Promise<OhosComputerControlStatus>(() => {}),
    onOhosComputerControlChanged: () => () => {},
    requestOhosComputerControlPermission: () => {
      h.requestCalls += 1;
    },
  }),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ pluginManagementService: {} }),
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: null, update: async () => {} }),
}));

vi.mock("@/hooks/useCuaPermissionStatus.js", () => ({
  useCuaPermissionStatus: () => ({ status: null, settled: true, refresh: () => {} }),
}));

// 最小插件 store：setEnabled 记录调用即可——滑块是受控 + 乐观更新，「写入点未被调用」
// 即等价于「滑块不可能翻转」。
vi.mock("@/store/pluginManagementStore.js", () => {
  const usePluginManagementStore = create(() => ({
    plugins: [{ id: ZCODE_CUA_OFFICIAL_PLUGIN_ID, enabled: false }],
    togglingPluginId: null,
    error: null,
    initialize: () => {},
    setEnabled: (_pluginId: string, enabled: boolean) => {
      h.setEnabledCalls.push(enabled);
      h.cuaEnabled = enabled;
    },
  }));
  return { usePluginManagementStore };
});

vi.mock("@/settings/pluginEnabledChange.js", () => ({
  runAfterSuccessfulPluginEnabledChange: async (options: {
    submit: () => Promise<unknown>;
    onSuccess?: () => void;
  }) => {
    await options.submit();
    options.onSuccess?.();
    return true;
  },
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: () => {} }));
vi.mock("@/lib/cuaPermissionAction.js", () => ({
  claimCuaPermissionReturnRecovery: () => undefined,
  completeCuaPermissionReturnRecovery: () => {},
  captureCuaPermissionReturnRecovery: () => undefined,
  createCuaPermissionReturnRecoveryState: () => ({}),
  isCuaPermissionReturnRecoveryCurrent: () => false,
  markCuaPermissionOnboardingOpened: () => {},
  shouldRestartHelperAfterCuaPermissionReturn: () => false,
}));
vi.mock("@/lib/cuaPermissionOnboardingOperation.js", () => ({
  createCuaPermissionOnboardingOperationId: () => "op-1",
}));
vi.mock("@/settings/cuaPermissionRestartVerify.js", () => ({
  waitForAccessibilityNotStale: async () => false,
}));
vi.mock("@/settings/cuaPermissionPreparation.js", () => ({
  requiredCuaPermissionsForFreshStatus: () => [],
}));
vi.mock("@/lib/cuaPlatform.js", () => ({
  supportsLocalMacCuaPermissionOnboarding: () => false,
}));
vi.mock("@zcode/services", () => ({ isCuaPermissionStatusAvailable: () => false }));

const { ComputerUseSection } = await import("@/settings/ComputerUseSection.js");

let container: HTMLElement | undefined;
let root: Root | undefined;

// 渲染后冲一次微任务：platform 状态查询 resolve → 门控状态就位后再驱动点击。
async function renderSection(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(ComputerUseSection, {
        isDesktop: true,
        workspacePath: "/tmp/ws",
        workspaceIdentity: "/tmp/ws",
      }) as ReactElement,
    );
  });
  await act(async () => {});
}

function switchElement(): HTMLElement {
  const el = container!.querySelector('[role="switch"]');
  if (!el) throw new Error("switch not found");
  return el as HTMLElement;
}

function overlayButton(): HTMLElement {
  // 未授权时盖在滑块上的透明遮罩按钮（aria-label = hover 提示文案，无可见文本）。
  const el = Array.from(container!.querySelectorAll("button")).find(
    (button) => button.getAttribute("aria-label") === "settings.computerUse.ohosPermission.hint",
  );
  if (!el) throw new Error("permission overlay button not found");
  return el as HTMLElement;
}

function clickSwitch(): void {
  act(() => {
    switchElement().dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function dialogOpen(): boolean {
  return document.querySelector('[role="alertdialog"]') !== null;
}

beforeEach(() => {
  // 共享 store 模块级缓存跨用例存活：每个用例重置后由组件挂载重新 ensure 当前场景值。
  resetOhosComputerControlStatusStoreForTest();
  h.status = { supported: true, granted: false };
  h.statusReady = false;
  h.cuaEnabled = false;
  h.setEnabledCalls = [];
  h.requestCalls = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
});

describe("OHOS 辅助操作门控（ComputerUseSection）", () => {
  it("确认未授权：滑块真 disabled 且有遮罩承接点击；合成点击也到不了写入点", async () => {
    h.statusReady = true;
    await renderSection();
    expect(switchElement().hasAttribute("disabled")).toBe(true);
    clickSwitch();
    expect(h.setEnabledCalls).toEqual([]);
  });

  it("状态未回流（查询在途）：fail-closed 同样锁死（真机缺陷的时序回归）", async () => {
    await renderSection();
    expect(switchElement().hasAttribute("disabled")).toBe(true);
    clickSwitch();
    expect(h.setEnabledCalls).toEqual([]);
  });

  it("未授权时遮罩点击弹窗，去开启触发请求链路；描述保持纯文本", async () => {
    h.statusReady = true;
    await renderSection();
    // 描述恢复原文（纯文本，不可点）：不出现以提示文案为可见文本的按钮。
    const descriptionAsButton = Array.from(container!.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("settings.computerUse.ohosPermission.hint"),
    );
    expect(descriptionAsButton).toBeUndefined();
    act(() => {
      overlayButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialogOpen()).toBe(true);
    const action = Array.from(document.querySelectorAll('[role="alertdialog"] button')).find(
      (button) => button.textContent?.includes("settings.computerUse.ohosPermission.dialogAction"),
    );
    expect(action).toBeTruthy();
    act(() => {
      action!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(h.requestCalls).toBe(1);
    expect(h.setEnabledCalls).toEqual([]);
  });

  it("已确认授权：遮罩隐藏、滑块可点，正常走启用（门控不过度）", async () => {
    h.status = { supported: true, granted: true };
    h.statusReady = true;
    await renderSection();
    const overlay = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "settings.computerUse.ohosPermission.hint",
    );
    expect(overlay).toBeUndefined();
    expect(switchElement().hasAttribute("disabled")).toBe(false);
    clickSwitch();
    expect(h.setEnabledCalls).toEqual([true]);
    expect(dialogOpen()).toBe(false);
  });

  it("聚合门禁：只缺截屏也保持锁定，并提示缺的是哪一项", async () => {
    h.status = {
      supported: true,
      granted: false,
      permissions: { controlDevice: true, screenCapture: false },
    };
    h.statusReady = true;
    await renderSection();

    expect(switchElement().hasAttribute("disabled")).toBe(true);
    clickSwitch();
    expect(h.setEnabledCalls).toEqual([]);

    // 遮罩点击 → 聚合授权对话框；缺项以 i18n key 逐条列出（测试环境 formatMessage 原样返回 key）。
    act(() => {
      overlayButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(dialogOpen()).toBe(true);
    expect(document.body.textContent).toContain(
      "settings.computerUse.ohosPermission.screenCapture",
    );
    expect(document.body.textContent).not.toContain(
      "settings.computerUse.ohosPermission.controlDevice",
    );
  });
});
