import { describe, expect, it } from "vitest";
import {
  isComputerUseUnavailableNonWeb,
  isOhosComputerControlPermissionGranted,
  listMissingOhosPermissions,
  resolveComputerUseAvailability,
  shouldDisableOhosCua,
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
    ).toEqual({ kind: "local-ohos", supported: true });
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
    // OHOS 由随包 ArkTS 执行端支持（spec 13），不再走不可用提示；Linux 本机才是。
    expect(
      isComputerUseUnavailableNonWeb(
        resolveComputerUseAvailability({ isDesktop: true, isOhosDesktop: true }),
      ),
    ).toBe(false);
    expect(
      isComputerUseUnavailableNonWeb(resolveComputerUseAvailability({ isDesktop: true })),
    ).toBe(true);
  });
});

describe("isOhosComputerControlPermissionGranted", () => {
  it("only a positively granted status unlocks the toggle (fail-closed, spec 13)", () => {
    expect(isOhosComputerControlPermissionGranted({ supported: true, granted: true })).toBe(true);
    // 状态缺失/不支持/未授权都视为未确认：乐观 setEnabled 下漏拦一次就会翻转滑块。
    expect(isOhosComputerControlPermissionGranted({ supported: true, granted: false })).toBe(
      false,
    );
    expect(isOhosComputerControlPermissionGranted({ supported: false, granted: false })).toBe(
      false,
    );
    expect(isOhosComputerControlPermissionGranted(undefined)).toBe(false);
  });
});

describe("OHOS 聚合门禁（辅助操作 + 截屏）", () => {
  const all = { controlDevice: true, screenCapture: true };

  it("三者全部授予才放行", () => {
    expect(
      isOhosComputerControlPermissionGranted({ supported: true, granted: true, permissions: all }),
    ).toBe(true);
    expect(
      isOhosComputerControlPermissionGranted({
        supported: true,
        granted: true,
        permissions: { ...all, screenCapture: false },
      }),
    ).toBe(false);
  });

  it("列出缺失权限，供 UI 精确提示", () => {
    expect(
      listMissingOhosPermissions({
        supported: true,
        granted: false,
        permissions: { controlDevice: true, screenCapture: false },
      }),
    ).toEqual(["screenCapture"]);
    expect(
      listMissingOhosPermissions({ supported: true, granted: true, permissions: all }),
    ).toEqual([]);
  });

  it("旧版只有 granted 时保持兼容", () => {
    expect(isOhosComputerControlPermissionGranted({ supported: true, granted: true })).toBe(true);
    expect(listMissingOhosPermissions({ supported: true, granted: false })).toEqual([
      "controlDevice",
      "screenCapture",
    ]);
  });
});

describe("shouldDisableOhosCua（权限丢失回收）", () => {
  const granted = { controlDevice: true, screenCapture: true };

  it("三缺一且插件启用时回收", () => {
    expect(
      shouldDisableOhosCua({
        status: { supported: true, granted: false, permissions: { ...granted, screenCapture: false } },
        pluginEnabled: true,
        toggling: false,
      }),
    ).toBe(true);
  });

  it("插件未启用、权限完整、正在切换、状态未回流都不动", () => {
    const missing = { supported: true, granted: false, permissions: { ...granted, screenCapture: false } } as const;
    expect(shouldDisableOhosCua({ status: missing, pluginEnabled: false, toggling: false })).toBe(false);
    expect(
      shouldDisableOhosCua({
        status: { supported: true, granted: true, permissions: granted },
        pluginEnabled: true,
        toggling: false,
      }),
    ).toBe(false);
    expect(shouldDisableOhosCua({ status: missing, pluginEnabled: true, toggling: true })).toBe(false);
    expect(
      shouldDisableOhosCua({ status: { supported: false, granted: false }, pluginEnabled: true, toggling: false }),
    ).toBe(false);
  });
});
