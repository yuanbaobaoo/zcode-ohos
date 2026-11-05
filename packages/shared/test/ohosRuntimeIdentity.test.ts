// spec：specs/ohos-port/15-单控制通道与平台适配治理.md —— 平台身份显式信号
// 背景：MCP 子进程为绕开 bundle noexec 改由用户环境 node 启动后 process.platform 报
// "linux"，node_repl 内的 OHOS 分支（CUA runtime）因此全部失效。身份改由 host 注入的
// ZCODE_OHOS_RUNTIME 跨解释器继承；信号只做加法，缺省时行为与旧版逐字一致。
import { describe, expect, it } from "vitest";
import {
  isOhosRuntime,
  mapOutboundPlatformKey,
  ZCODE_OHOS_RUNTIME_ENV_KEY,
} from "../src/runtimeEnv.js";

describe("isOhosRuntime 平台身份", () => {
  it("权威信号为 1 时，linux 进程也判定为鸿蒙（MCP 子进程换解释器的场景）", () => {
    expect(isOhosRuntime("linux", { [ZCODE_OHOS_RUNTIME_ENV_KEY]: "1" })).toBe(true);
    expect(isOhosRuntime("darwin", { [ZCODE_OHOS_RUNTIME_ENV_KEY]: "1" })).toBe(true);
  });

  it("无信号时按平台名判定（旧行为逐字保留）", () => {
    expect(isOhosRuntime("ohos", {})).toBe(true);
    expect(isOhosRuntime("openharmony", {})).toBe(true);
    expect(isOhosRuntime("harmonyos", {})).toBe(true);
    expect(isOhosRuntime("linux", {})).toBe(false);
    expect(isOhosRuntime("darwin", {})).toBe(false);
    expect(isOhosRuntime("win32", {})).toBe(false);
  });

  it("信号只认 1：其它取值一律回落到平台判定，避免误把开关变成平台", () => {
    for (const value of ["0", "true", "yes", "", "  "]) {
      expect(isOhosRuntime("linux", { [ZCODE_OHOS_RUNTIME_ENV_KEY]: value })).toBe(false);
    }
    expect(isOhosRuntime("ohos", { [ZCODE_OHOS_RUNTIME_ENV_KEY]: "0" })).toBe(true);
  });

  it("出站平台标识不受权威信号影响（对外仍按 linux 上报）", () => {
    expect(mapOutboundPlatformKey("linux")).toBe("linux");
    expect(mapOutboundPlatformKey("ohos")).toBe("linux");
  });
});
