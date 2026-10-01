import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOhosEmulatorProfile,
  parseOhosDeviceProfile,
  resolveOhosDeviceProfilePaths,
  shouldUseOhosSoftwareRendering,
  type OhosDeviceProfile,
} from "../src/ohos/ohosDeviceProfile.js";

function emulatorProfile(): OhosDeviceProfile {
  return {
    type: "zcode-ohos-device-profile",
    productModel: "emulator",
    hardwareModel: "emulator",
    deviceType: "2in1",
    writtenAt: 1790000000000,
  };
}

function realDeviceProfile(): OhosDeviceProfile {
  return {
    type: "zcode-ohos-device-profile",
    productModel: "HAD-W32",
    hardwareModel: "L1001",
    deviceType: "2in1",
    writtenAt: 1790000000000,
  };
}

test("resolveOhosDeviceProfilePaths 覆盖 flat 与 haps 双形态", () => {
  const flat = resolveOhosDeviceProfilePaths({ sandboxFilesDir: "/data/storage/el2/base/files" });
  assert.deepEqual(flat.profileCandidates, [
    "/data/storage/el2/base/files/device-profile.json",
    "/data/storage/el2/base/haps/electron/files/device-profile.json",
  ]);
  const haps = resolveOhosDeviceProfilePaths({
    sandboxFilesDir: "/data/storage/el2/base/haps/electron/files/",
  });
  assert.deepEqual(haps.profileCandidates, [
    "/data/storage/el2/base/haps/electron/files/device-profile.json",
    "/data/storage/el2/base/files/device-profile.json",
  ]);
});

test("parseOhosDeviceProfile 判废矩阵：非 JSON/缺字段/空串/坏时间戳", () => {
  assert.equal(parseOhosDeviceProfile("not-json"), undefined);
  assert.equal(parseOhosDeviceProfile('{"type":"other"}'), undefined);
  assert.equal(parseOhosDeviceProfile('{"type":"zcode-ohos-device-profile"}'), undefined);
  assert.equal(
    parseOhosDeviceProfile(
      JSON.stringify({ ...emulatorProfile(), productModel: "  " }),
    ),
    undefined,
  );
  assert.equal(
    parseOhosDeviceProfile(JSON.stringify({ ...emulatorProfile(), writtenAt: Number.NaN })),
    undefined,
  );
  assert.deepEqual(parseOhosDeviceProfile(JSON.stringify(realDeviceProfile())), realDeviceProfile());
});

test("isOhosEmulatorProfile：emulator 字面量命中，真机型号不命中", () => {
  assert.equal(isOhosEmulatorProfile(emulatorProfile()), true);
  // 大小写与前后空白容忍（镜像值恒为小写字面量，此处防御未来镜像变体）。
  assert.equal(
    isOhosEmulatorProfile({ ...emulatorProfile(), productModel: " Emulator " }),
    true,
  );
  assert.equal(isOhosEmulatorProfile(realDeviceProfile()), false);
  assert.equal(
    isOhosEmulatorProfile({ ...realDeviceProfile(), hardwareModel: "emulator-x" }),
    false,
  );
});

test("shouldUseOhosSoftwareRendering 三态决策表", () => {
  // auto：按判据；profile 缺失按真机（安全极性）。
  assert.equal(shouldUseOhosSoftwareRendering({ mode: "auto", profile: emulatorProfile() }), true);
  assert.equal(shouldUseOhosSoftwareRendering({ mode: "auto", profile: realDeviceProfile() }), false);
  assert.equal(shouldUseOhosSoftwareRendering({ mode: "auto", profile: undefined }), false);
  // software：真机也强制（兜底通路）；hardware：模拟器也不注入（复现黑屏排查用）。
  assert.equal(
    shouldUseOhosSoftwareRendering({ mode: "software", profile: realDeviceProfile() }),
    true,
  );
  assert.equal(
    shouldUseOhosSoftwareRendering({ mode: "hardware", profile: emulatorProfile() }),
    false,
  );
});
