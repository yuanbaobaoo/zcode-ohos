import { describe, expect, it } from "vitest";
import { resolveVoiceInputAvailability } from "@/voice-input/domain/voiceInputAvailability.js";

const desktop = {
  enabled: true,
  hasEntry: true,
  hasMicrophone: true,
  hasService: true,
  isLoggedIn: true,
};

describe("resolveVoiceInputAvailability", () => {
  it("桌面本机有麦克风后端时可录音", () => {
    expect(resolveVoiceInputAvailability(desktop)).toEqual({
      visible: true,
      available: true,
      unsupported: false,
    });
  });

  it("缺麦克风后端时入口仍显示但禁用", () => {
    expect(resolveVoiceInputAvailability({ ...desktop, hasMicrophone: false })).toEqual({
      visible: true,
      available: false,
      unsupported: true,
    });
  });

  it("手机远控、未登录或无 Host 服务时不显示入口", () => {
    expect(resolveVoiceInputAvailability({ ...desktop, enabled: false })).toEqual({
      visible: false,
      available: false,
      unsupported: false,
    });
    expect(resolveVoiceInputAvailability({ ...desktop, isLoggedIn: false }).visible).toBe(false);
    expect(resolveVoiceInputAvailability({ ...desktop, hasService: false }).visible).toBe(false);
    expect(resolveVoiceInputAvailability({ ...desktop, hasEntry: false }).visible).toBe(false);
  });
});
