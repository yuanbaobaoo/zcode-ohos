// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
  afterEach(() => {
    cleanup();
    h.onLocalHostExited = undefined;
    h.emitExit = null;
  });

  it("平台不支持时不渲染", () => {
    h.onLocalHostExited = undefined;
    const { container } = render(createElement(LocalHostExitedOverlay));
    expect(container.innerHTML).toBe("");
  });

  it("收到退出事件后显示断开提示，点击重新加载触发 reload", async () => {
    const listeners: Array<(payload: { code: number | null }) => void> = [];
    h.onLocalHostExited = (cb) => {
      listeners.push(cb);
      return () => {};
    };
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    try {
      render(createElement(LocalHostExitedOverlay));
      expect(screen.queryByText("localHostExited.title")).toBeNull();
      for (const listener of listeners) listener({ code: 1 });
      await waitFor(() => {
        expect(screen.getByText("localHostExited.title")).toBeTruthy();
      });
      fireEvent.click(screen.getByText("localHostExited.reload"));
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
