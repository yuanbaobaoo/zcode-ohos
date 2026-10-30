import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ ohos: true, emulator: false }));

vi.mock("@zcode/shared", () => ({
  isOhosRuntime: () => state.ohos,
}));

vi.mock("../src/main/desktopOhosDeviceProfile.js", () => ({
  isOhosEmulatorRuntime: () => state.emulator,
  readOhosDeviceProfileFromSandbox: () => undefined,
}));

const { shouldAttachTerminalPtyRelay } = await import("../src/main/desktopTerminalPtyRelay.js");

describe("terminal pty relay 挂载判据", () => {
  it("非 OHOS 平台不挂中继", () => {
    state.ohos = false;
    state.emulator = false;
    expect(shouldAttachTerminalPtyRelay()).toBe(false);
  });

  it("模拟器上不挂中继：main 域 spawn 会 SIGABRT 击杀整个应用", () => {
    state.ohos = true;
    state.emulator = true;
    expect(shouldAttachTerminalPtyRelay()).toBe(false);
  });

  it("真机继续由 main 托管系统 zsh", () => {
    state.ohos = true;
    state.emulator = false;
    expect(shouldAttachTerminalPtyRelay()).toBe(true);
  });
});
