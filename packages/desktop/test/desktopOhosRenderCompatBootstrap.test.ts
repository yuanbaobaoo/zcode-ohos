import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { appendSwitch, disableHardwareAcceleration, softwareRendering } = vi.hoisted(() => ({
  appendSwitch: vi.fn(),
  disableHardwareAcceleration: vi.fn(),
  softwareRendering: { value: true },
}));

vi.mock("electron", () => ({
  app: { commandLine: { appendSwitch }, disableHardwareAcceleration },
}));
vi.mock("@zcode/shared", () => ({ isOhosRuntime: () => true }));
vi.mock("@zcode/services/ohos-device-profile", () => ({
  parseOhosDeviceProfile: vi.fn(),
  resolveOhosDeviceProfilePaths: () => ({ profileCandidates: [] }),
  shouldUseOhosSoftwareRendering: () => softwareRendering.value,
}));
vi.mock("../src/main/desktopEarlyOhosEnvBootstrap.js", () => ({
  OHOS_SANDBOX_FILES: "/tmp/zcode-render-compat-test",
}));

import { applyEarlyOhosRenderCompatBootstrap } from "../src/main/desktopOhosRenderCompatBootstrap.js";

const originalElectronVersion = Object.getOwnPropertyDescriptor(process.versions, "electron");

function setElectronVersion(version: string | undefined): void {
  if (version === undefined) {
    delete (process.versions as Record<string, string | undefined>).electron;
    return;
  }
  Object.defineProperty(process.versions, "electron", {
    configurable: true,
    value: version,
  });
}

beforeEach(() => {
  appendSwitch.mockClear();
  disableHardwareAcceleration.mockClear();
  softwareRendering.value = true;
});

afterEach(() => {
  if (originalElectronVersion) {
    Object.defineProperty(process.versions, "electron", originalElectronVersion);
  } else {
    delete (process.versions as Record<string, string | undefined>).electron;
  }
});

describe("applyEarlyOhosRenderCompatBootstrap", () => {
  it.each(["v40.0.1-release", "40.0.1"])(
    "uses software compositing instead of legacy switches on Electron %s",
    (version) => {
      setElectronVersion(version);

      applyEarlyOhosRenderCompatBootstrap();

      expect(disableHardwareAcceleration).toHaveBeenCalledOnce();
      expect(appendSwitch).not.toHaveBeenCalled();
    },
  );

  it("leaves hardware rendering untouched when the user forces hardware mode", () => {
    setElectronVersion("v40.0.1-release");
    softwareRendering.value = false;

    applyEarlyOhosRenderCompatBootstrap();

    expect(disableHardwareAcceleration).not.toHaveBeenCalled();
    expect(appendSwitch).not.toHaveBeenCalled();
  });

  it("injects ANGLE + SwiftShader on pre-v40 Electron", () => {
    setElectronVersion("39.2.0");

    applyEarlyOhosRenderCompatBootstrap();

    expect(disableHardwareAcceleration).not.toHaveBeenCalled();
    expect(appendSwitch.mock.calls).toEqual([
      ["use-gl", "angle"],
      ["use-angle", "swiftshader"],
    ]);
  });
});
