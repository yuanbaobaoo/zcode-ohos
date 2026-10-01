// 模拟器检测与软件渲染降级的纯逻辑（profile 解析/判据/路径候选），fs 与
// appendSwitch 在 desktop main 的 desktopOhosRenderCompatBootstrap.ts
//（specs/ohos-port/06）。ArkTS DeviceProfileWriter 是 profile 的唯一写者。

/** ArkTS DeviceProfileWriter 在每次启动写入沙箱的设备画像（模拟器判定的唯一事实）。 */
export interface OhosDeviceProfile {
  type: "zcode-ohos-device-profile";
  /** @ohos.deviceInfo.productModel：模拟器镜像恒为 "emulator"，真机为型号（HAD-W32）。 */
  productModel: string;
  /** @ohos.deviceInfo.hardwareModel：与 productModel 同源的辅判据。 */
  hardwareModel: string;
  deviceType: string;
  /** 毫秒时间戳（ArkTS 写入时刻）。 */
  writtenAt: number;
}

export const OHOS_DEVICE_PROFILE_FILENAME = "device-profile.json";

/**
 * 三态兼容渲染设置（setting.json 的 desktopOhosRenderCompat）：
 * auto 按模拟器判据；software 强制 SwiftShader；hardware 强制硬件 GL。
 */
export type OhosRenderCompatMode = "auto" | "software" | "hardware";

export interface OhosDeviceProfilePaths {
  /**
   * main 读 profile 的候选：ArkTS filesDir 为 haps 形态
   * （/data/storage/el2/base/haps/electron/files），main 的 HOME 为扁平形态
   * （/data/storage/el2/base/files），两个都覆盖（同 share-inbox 候选推导）。
   */
  profileCandidates: string[];
}

export function resolveOhosDeviceProfilePaths(params: {
  sandboxFilesDir: string;
}): OhosDeviceProfilePaths {
  const base = params.sandboxFilesDir.replace(/\/+$/, "");
  const candidates = [`${base}/${OHOS_DEVICE_PROFILE_FILENAME}`];
  const otherCandidate = base.includes("/haps/")
    ? `${base.replace(/\/haps\/[^/]+\/files$/, "")}/files/${OHOS_DEVICE_PROFILE_FILENAME}`
    : `${base.replace(/\/files$/, "")}/haps/electron/files/${OHOS_DEVICE_PROFILE_FILENAME}`;
  if (!candidates.includes(otherCandidate)) candidates.push(otherCandidate);
  return { profileCandidates: candidates };
}

/** 解析并校验 profile：结构不符一律判废（调用方按真机处理，绝不降级）。 */
export function parseOhosDeviceProfile(raw: string): OhosDeviceProfile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "zcode-ohos-device-profile") return undefined;
  if (typeof record.productModel !== "string" || !record.productModel.trim()) return undefined;
  if (typeof record.hardwareModel !== "string" || !record.hardwareModel.trim()) return undefined;
  if (typeof record.deviceType !== "string" || !record.deviceType.trim()) return undefined;
  if (typeof record.writtenAt !== "number" || !Number.isFinite(record.writtenAt))
    return undefined;
  return {
    type: "zcode-ohos-device-profile",
    productModel: record.productModel,
    hardwareModel: record.hardwareModel,
    deviceType: record.deviceType,
    writtenAt: record.writtenAt,
  };
}

/** 模拟器判据："emulator" 字面量由模拟器镜像写死，真机型号不可能命中。 */
export function isOhosEmulatorProfile(profile: OhosDeviceProfile): boolean {
  const marker = "emulator";
  return (
    profile.productModel.trim().toLowerCase() === marker ||
    profile.hardwareModel.trim().toLowerCase() === marker
  );
}

/**
 * 决策是否注入 SwiftShader 开关：hardware 恒否；software 恒是（真机兜底通路）；
 * auto 按判据。profile 缺失时 auto 视为真机（安全极性：宁黑屏不降级真机）。
 */
export function shouldUseOhosSoftwareRendering(params: {
  mode: OhosRenderCompatMode;
  profile: OhosDeviceProfile | undefined;
}): boolean {
  if (params.mode === "software") return true;
  if (params.mode === "hardware") return false;
  return params.profile !== undefined && isOhosEmulatorProfile(params.profile);
}
