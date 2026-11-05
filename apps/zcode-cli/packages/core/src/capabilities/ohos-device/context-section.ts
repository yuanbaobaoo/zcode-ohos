// ============================================================
// OHOS device capability - 系统提示词 section
// ============================================================
// 用户提示词点名 devecocli/hdc 时模型被锚定进 CLI 路线，不会去读工具描述；
// 平台事实（hdc server 在本机必败）必须占一个系统提示词段（spec 11）。

import type { ContextSection } from "../../context/types.js";
import { estimateTokens } from "../../context/utils.js";
import { isOhosDeviceBridgeEnabled } from "./index.js";

const SECTION_NAME = "OHOS Device Context";
const SECTION_SOURCE = "ohos_device_context" as const;

const SECTION_LINES = [
  "# HarmonyOS Device Debugging",
  "",
  "This session runs on a HarmonyOS device. Platform facts that change how apps are deployed and debugged:",
  "",
  "- The `hdc` CLI cannot work here: the hdc server needs to bind a Unix socket and this app sandbox denies it,",
  "  so `hdc list targets` stays empty and any tool that shells out to `hdc` (including `devecocli run`)",
  "  reports no devices. This is a sandbox limitation — do not spend turns investigating or trying to fix it.",
  "- Build and sign HAPs normally with `hvigorw` / `devecocli`; only the deploy, launch and device-log steps",
  "  must go through the `ohos_hdc` tool, which talks to hdcd directly over TCP.",
  "- Recommended loop: build and sign the HAP, then `ohos_hdc` action `install` (uploads, `bm install -r -d`,",
  "  optionally launches the ability), then `ohos_hdc` action `shell` for `hilog` and verification.",
  "- `ohos_hdc` is a **debug/deploy channel only** (`list_targets` / `shell` / `file_send` / `file_recv` /",
  "  `install`). Use `shell` for hilog and diagnostics, and `file_recv` to pull a file back.",
  "- Any UI interaction — clicking, typing, taking a screenshot, launching an app — belongs to Computer Use",
  "  (the computer-use skill / `agent.computerUse`), which is the single control channel on this platform.",
  "  Do not rebuild that capability with `uitest` / `snapshot_display` inside `shell`; that path is only an",
  "  operator escape hatch and double-implements the product surface.",
  '- The first `ohos_hdc` connection may need the user to accept the "allow debugging" prompt on the device.',
];

// 与 ohosDeviceTools() 同开关：停用能力时这段指引同时消失，让位给系统实现（spec 11）
export function buildOhosDeviceContextSection(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): ContextSection | null {
  if (!isOhosDeviceBridgeEnabled(env, platform)) return null;
  const content = SECTION_LINES.join("\n");
  return {
    name: SECTION_NAME,
    source: SECTION_SOURCE,
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
