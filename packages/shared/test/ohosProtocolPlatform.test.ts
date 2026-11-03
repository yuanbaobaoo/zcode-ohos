import { describe, expect, it } from "vitest";
import { mapOutboundPlatformKey } from "../src/runtimeEnv.js";
import { zcodeMcpResourceSampleSchema } from "../src/zcode-protocol/index.js";

const sample = {
  mcpId: "builtin:ohos-device",
  instanceToken: "ohos-device-1",
  sampledAt: 0,
  intervalMs: 300_000,
  processCount: 1,
  rssKbTotal: 0,
  rssKbMaxProcess: 0,
  cpuTimeMsDelta: 0,
  uptimeMinutes: 0,
  platform: "linux",
  arch: "arm64",
  logicalCpuCount: 8,
  totalMemoryGb: 16,
};

describe("遥测出站平台标识", () => {
  it.each(["ohos", "openharmony", "harmonyos"])("%s 统一按 linux 上报", (platform) => {
    expect(mapOutboundPlatformKey(platform)).toBe("linux");
  });

  it("保留已知平台标识", () => {
    expect(mapOutboundPlatformKey("darwin")).toBe("darwin");
  });

  it("协议不接收未映射的鸿蒙平台串", () => {
    expect(zcodeMcpResourceSampleSchema.safeParse({ ...sample, platform: "ohos" }).success).toBe(
      false,
    );
  });
});
