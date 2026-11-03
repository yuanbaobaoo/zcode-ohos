import { isOhosRuntime } from "@zcode/shared";

// OHOS 系统 monospace 在 canvas 度量里会退化成比例字体，必须用随包字体兜底。
const TERMINAL_BUNDLED_FONT_FAMILY = "ZCode Terminal Mono";
const OHOS_TERMINAL_FONT_SIZE = 14;

export function resolveOhosFontFamilies(
  fallback: readonly string[],
): readonly string[] | undefined {
  return isOhosRuntime() ? [`"${TERMINAL_BUNDLED_FONT_FAMILY}"`, ...fallback] : undefined;
}

export function resolveOhosTerminalFontSize(): number | undefined {
  return isOhosRuntime() ? OHOS_TERMINAL_FONT_SIZE : undefined;
}
