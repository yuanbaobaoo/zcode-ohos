import { describe, expect, it } from "vitest";
import { shouldShowOhosDesktopPrompt } from "@/OhosDesktopAccessPrompt.js";

describe("shouldShowOhosDesktopPrompt", () => {
  it("非 supported 平台不显示", () => {
    expect(shouldShowOhosDesktopPrompt(undefined)).toBe(false);
    expect(shouldShowOhosDesktopPrompt({ supported: false, granted: false })).toBe(false);
  });

  it("仅 Desktop 未授权时显示", () => {
    expect(shouldShowOhosDesktopPrompt({ supported: true, granted: false })).toBe(true);
    expect(shouldShowOhosDesktopPrompt({ supported: true, granted: true })).toBe(false);
  });
});
