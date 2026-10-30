// @vitest-environment jsdom
// 上游 v3.17.1 随 App 单测退役移除了 @testing-library/react；本用例改用
// react-dom/client + act 驱动同一 DOM 断言，交互用原生事件派发。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  onLocalHostExited: undefined as
    | undefined
    | ((cb: (payload: { code: number | null }) => void) => () => void),
  emitExit: null as null | ((payload: { code: number | null }) => void),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    onLocalHostExited: h.onLocalHostExited,
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { LocalHostExitedOverlay } from "../src/LocalHostExitedOverlay.js";

describe("LocalHostExitedOverlay", () => {
  let container: HTMLElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = undefined;
    root = undefined;
    h.onLocalHostExited = undefined;
    h.emitExit = null;
    vi.unstubAllGlobals();
  });

  function mount(): void {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(createElement(LocalHostExitedOverlay)));
  }

  it("平台不支持时不渲染", () => {
    h.onLocalHostExited = undefined;
    mount();
    expect(container?.innerHTML).toBe("");
  });

  it("收到退出事件后显示断开提示，点击重新加载触发 reload", () => {
    const listeners: Array<(payload: { code: number | null }) => void> = [];
    h.onLocalHostExited = (cb) => {
      listeners.push(cb);
      return () => {};
    };
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    mount();
    expect(container?.textContent).not.toContain("localHostExited.title");

    act(() => {
      for (const listener of listeners) listener({ code: 1 });
    });
    // AlertDialog 经 Radix Portal 渲染到 document.body，不在挂载容器内。
    expect(document.body.textContent).toContain("localHostExited.title");
    expect(document.body.textContent).toContain("code: 1");

    const reloadButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "localHostExited.reload",
    );
    expect(reloadButton).toBeTruthy();
    act(() => {
      reloadButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(reload).toHaveBeenCalledOnce();
  });
});
