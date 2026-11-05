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
  "- `~` may point into the app sandbox, not the user's real home. Access user files by full path under",
  "  `/storage/Users/currentUser/...` instead of `~`. `Documents` accepts new folders; creating folders",
  "  directly under `Desktop` fails with EPERM (system policy — pick another location, do not fight it).",
  "- Build and sign HAPs with `devecocli` (`create` / `build` / `signature`) or `hvigorw`; CLT locations come",
  "  from `DEVECO_CLI_CLT_PATH` / `COMMAND_LINE_TOOL_PATH`. If a CLT `node` binary lacks the exec bit,",
  "  `chmod +x` it once before building. Deploy, launch and device logs go through the `ohos_hdc` tool.",
  "- Recommended loop: build and sign the HAP, then `ohos_hdc` action `install` (uploads, `bm install -r -d`,",
  "  optionally launches the ability), then `ohos_hdc` action `shell` for `hilog` and verification.",
  "- `ohos_hdc` is a **debug/deploy channel only** (`list_targets` / `shell` / `file_send` / `file_recv` /",
  "  `install`). Use `shell` for hilog and diagnostics, and `file_recv` to pull a file back.",
  "- Debugging the UI of an app you built and installed from this workspace: use `ohos_hdc` `shell` with the",
  "  system `uitest` (`uitest dumpLayout` for the view tree, `uitest uiInput click/text` for input) and",
  "  `snapshot_display`. This exemption covers workspace-built apps only; general desktop control belongs to",
  "  Computer Use, the single control channel — do not drive unrelated apps or system UI through `uitest`.",
  "- The `ohos-dev` bundled skill holds the full recipes (scaffold, hvigorw env, signing, deploy, debugging);",
  "  load it before developing a HarmonyOS app here.",
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
