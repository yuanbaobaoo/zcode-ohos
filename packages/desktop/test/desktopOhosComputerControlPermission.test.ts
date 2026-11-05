// spec：specs/ohos-port/13-本机电脑控制产品化.md —— 桥文件解析容错（fail-closed 同 spec 08）
import { describe, expect, it } from "vitest";
import {
  parseOhosComputerControlPermission,
  parseOhosComputerControlStatus,
} from "../src/main/desktopOhosComputerControlPermission.js";

describe("parseOhosComputerControlPermission", () => {
  it("parses granted as true and needs-grant as false", () => {
    expect(
      parseOhosComputerControlPermission(
        '{"apiAvailable":true,"permission":"granted","bridgeAlive":true,"updatedAt":1}\n',
      ),
    ).toBe(true);
    expect(parseOhosComputerControlPermission('{"permission":"needs-grant"}')).toBe(false);
  });

  it("returns undefined for malformed JSON", () => {
    expect(parseOhosComputerControlPermission("{not json")).toBeUndefined();
  });

  it("returns undefined when permission is missing or unknown", () => {
    expect(parseOhosComputerControlPermission("{}")).toBeUndefined();
    expect(parseOhosComputerControlPermission('{"permission":"unknown"}')).toBeUndefined();
    expect(parseOhosComputerControlPermission('{"permission":true}')).toBeUndefined();
    expect(parseOhosComputerControlPermission("null")).toBeUndefined();
  });
});

// 聚合门禁（spec 15）：granted 恒等于两权限全部授予，旧版只有 permission 字段时退化兼容。
describe("parseOhosComputerControlStatus", () => {
  it("两权限全部授予才 granted", () => {
    const all = parseOhosComputerControlStatus(
      '{"permission":"granted","permissions":{"controlDevice":true,"screenCapture":true}}',
    );
    expect(all).toEqual({
      supported: true,
      granted: true,
      permissions: { controlDevice: true, screenCapture: true },
    });

    const partial = parseOhosComputerControlStatus(
      '{"permission":"needs-grant","permissions":{"controlDevice":true,"screenCapture":false}}',
    );
    expect(partial?.granted).toBe(false);
    expect(partial?.permissions).toEqual({
      controlDevice: true,
      screenCapture: false,
    });
  });

  it("旧版只有 permission 字段时按该字段兼容", () => {
    expect(parseOhosComputerControlStatus('{"permission":"granted"}')).toEqual({
      supported: true,
      granted: true,
    });
    expect(parseOhosComputerControlStatus('{"permission":"needs-grant"}')?.granted).toBe(false);
  });

  it("坏 JSON / 无有效字段返回 undefined（fail-closed）", () => {
    expect(parseOhosComputerControlStatus("{not json")).toBeUndefined();
    expect(parseOhosComputerControlStatus("{}")).toBeUndefined();
    expect(parseOhosComputerControlStatus('{"permission":"unknown"}')).toBeUndefined();
  });
});
