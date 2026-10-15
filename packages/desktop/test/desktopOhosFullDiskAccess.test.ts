// spec：specs/ohos-port/08-全盘文件权限引导.md —— 桥文件解析容错
import { describe, expect, it } from "vitest";
import { parseOhosFullDiskAccessState } from "../src/main/desktopOhosFullDiskAccess.js";

describe("parseOhosFullDiskAccessState", () => {
  it("parses granted=true", () => {
    expect(parseOhosFullDiskAccessState('{"granted":true,"updatedAt":1}\n')).toBe(true);
  });

  it("parses granted=false", () => {
    expect(parseOhosFullDiskAccessState('{"granted":false}')).toBe(false);
  });

  it("returns undefined for malformed JSON", () => {
    expect(parseOhosFullDiskAccessState("{not json")).toBeUndefined();
  });

  it("returns undefined when granted is missing or not boolean", () => {
    expect(parseOhosFullDiskAccessState("{}")).toBeUndefined();
    expect(parseOhosFullDiskAccessState('{"granted":"yes"}')).toBeUndefined();
    expect(parseOhosFullDiskAccessState("[true]")).toBeUndefined();
    expect(parseOhosFullDiskAccessState("null")).toBeUndefined();
  });
});
