// spec：specs/ohos-port/08-全盘文件权限引导.md —— 一次性 toast 的展示门槛
import { describe, expect, it } from "vitest";
import { shouldShowOhosFullDiskPrompt } from "../src/OhosFullDiskAccessPrompt.js";

describe("shouldShowOhosFullDiskPrompt", () => {
  it("shows only when supported, not granted, and not shown before", () => {
    expect(
      shouldShowOhosFullDiskPrompt({ supported: true, granted: false, alreadyShown: false }),
    ).toBe(true);
  });

  it("does not show on platforms without the entry", () => {
    expect(
      shouldShowOhosFullDiskPrompt({ supported: false, granted: false, alreadyShown: false }),
    ).toBe(false);
  });

  it("does not show when already granted", () => {
    expect(
      shouldShowOhosFullDiskPrompt({ supported: true, granted: true, alreadyShown: false }),
    ).toBe(false);
  });

  it("never shows again once the marker is persisted", () => {
    expect(
      shouldShowOhosFullDiskPrompt({ supported: true, granted: false, alreadyShown: true }),
    ).toBe(false);
  });
});
