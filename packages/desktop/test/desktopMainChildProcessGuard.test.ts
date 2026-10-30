import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const mainDir = join(testDir, "../src/main");
const repoRoot = join(testDir, "../../..");

// OHOS 的 Electron main 进程不能 child_process（libuv fork+exec 会同步终止应用，
// spec 02）。新增调用点必须先做平台/功能门禁，再登记到这里并写明理由。
const ALLOWED_MAIN_FILES = new Map<string, string>([
  ["applicationIcons.ts", "仅 darwin/win32 locator 分支"],
  ["chromeCredentialManager.ts", "Chrome 导入，desktopPlatform 未暴露"],
  ["chromeExecutableDiscovery.ts", "SUPPORTED_PLATFORMS 门禁"],
  ["chromeLocalStorageManager.ts", "Chrome 导入，desktopPlatform 未暴露"],
  ["chromeProfileDiscovery.ts", "Chrome 导入，desktopPlatform 未暴露"],
  ["cuaSystemSettingsWindowWatcher.ts", "platform !== darwin 直接返回"],
  ["desktopCuaPermissionIpc.ts", "darwin 分支"],
  ["desktopFinderOpenFolderWorkflow.ts", "platform !== darwin 直接返回"],
  ["desktopLinuxXdg.ts", "仅 Linux 集成调用"],
  // OHOS 终端中继：main 域托管系统 /usr/bin/zsh（isOhosRuntime 门控 + ohos-pty/spawn
  // 消息驱动；host/native child 域看不到系统 shell，spec 02）。
  ["desktopTerminalPtyRelay.ts", "OHOS 终端中继：main 域 spawn 系统 zsh"],
  // 上游 v3.17.1 原生打开方式探测：spawn 仅在 darwin/win32/linux 分支内调用；
  // OHOS 平台（platform="ohos"）query 返回空列表、open 抛 platform_not_supported。
  ["file-open-apps/native.ts", "上游原生打开方式探测，OHOS 平台不命中任何分支"],
  ["desktopMainIpcHelpers.ts", "darwin 分支；OHOS 走 shell.showItemInFolder"],
  ["desktopTraySupport.ts", "仅 Linux 托盘探测"],
  ["desktopWindowsOpenFolderContextMenu.ts", "platform !== win32 直接返回"],
  ["editors.ts", "where.exe/plutil 仅 Windows/macOS 分支"],
  ["fileApplications.ts", "reg.exe 仅 Windows 分支调用"],
  ["index.ts", "E2E 退出路径（ZCODE_E2E_RUN_ID）"],
  ["openInEditor.ts", "OHOS 走 filemanager 伪编辑器分支"],
  ["windowsAumidIcon.ts", "仅 Windows locator 分支"],
  ["windowsChromeAppBoundKey.ts", "Windows Chrome 解密"],
  ["windowsInstallResourceLocks.ts", "Windows 安装/更新"],
]);

const CHILD_PROCESS_PATTERN = /(?:from\s+|require\(\s*|import\(\s*)["']node:child_process["']/;

function listTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function findChildProcessFiles(): string[] {
  return listTypeScriptFiles(mainDir)
    .filter((file) => CHILD_PROCESS_PATTERN.test(readFileSync(file, "utf8")))
    .map((file) => relative(mainDir, file).split("\\").join("/"))
    .sort();
}

describe("desktop main child_process 门禁", () => {
  it("新增 spawn/exec 调用点必须登记并说明平台门禁", () => {
    const unregistered = findChildProcessFiles().filter((file) => !ALLOWED_MAIN_FILES.has(file));
    expect(unregistered).toEqual([]);
  });

  it("允许清单不保留已失效条目", () => {
    const actual = new Set(findChildProcessFiles());
    const stale = [...ALLOWED_MAIN_FILES.keys()].filter((file) => !actual.has(file));
    expect(stale).toEqual([]);
  });

  it("main 可达的 Docker 与 SSH 探测保留 OHOS 短路", () => {
    expect(readFileSync(join(mainDir, "desktopRuntimeEnv.ts"), "utf8")).toContain(
      "isMainProcessExternalCommandAllowed",
    );
    expect(
      readFileSync(join(repoRoot, "packages/services/src/system/sshConfigAlias.ts"), "utf8"),
    ).toContain("isOhosRuntime()");
  });
});
