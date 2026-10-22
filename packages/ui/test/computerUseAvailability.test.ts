import { describe, expect, it } from "vitest";
import {
  isComputerUseUnavailableNonWeb,
  resolveComputerUseAvailability,
} from "@/settings/computerUseAvailability.js";

describe("resolveComputerUseAvailability", () => {
  it("supports local macOS and Windows desktops", () => {
    expect(resolveComputerUseAvailability({ isDesktop: true, isMacDesktop: true })).toEqual({
      kind: "local-macos",
      supported: true,
    });
    expect(resolveComputerUseAvailability({ isDesktop: true, isWindowsDesktop: true })).toEqual({
      kind: "local-windows",
      supported: true,
    });
  });

  it("reports HarmonyOS separately from Linux (UA 在 OHOS 上仍报 Linux)", () => {
    expect(
      resolveComputerUseAvailability({
        isDesktop: true,
        isOhosDesktop: true,
        remoteSessionId: null,
      }),
    ).toEqual({ kind: "local-ohos", supported: false });
    expect(resolveComputerUseAvailability({ isDesktop: true })).toEqual({
      kind: "local-linux",
      supported: false,
    });
  });

  it("keeps remote targets ahead of the local platform", () => {
    expect(
      resolveComputerUseAvailability({
        isDesktop: true,
        isOhosDesktop: true,
        remoteTarget: { kind: "docker", container: "dev" },
      }),
    ).toEqual({ kind: "remote-docker", supported: false });
  });

  it("marks web and unsupported non-web environments for the unavailable hint", () => {
    const web = resolveComputerUseAvailability({});
    expect(web).toEqual({ kind: "web", supported: false });
    expect(isComputerUseUnavailableNonWeb(web)).toBe(false);
    expect(
      isComputerUseUnavailableNonWeb(
        resolveComputerUseAvailability({ isDesktop: true, isOhosDesktop: true }),
      ),
    ).toBe(true);
  });
});
