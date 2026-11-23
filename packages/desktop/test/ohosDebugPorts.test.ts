/*
 * 调试端口契约守卫（specs/ohos-port/01、20）：
 * 9229 必须留给 renderer 的 Chromium DevTools，main 的 Node inspector 固定 9330。
 *
 * 背景：厂商默认参数原本是裸 `--inspect`（默认 127.0.0.1:9229），会抢占 9229，
 * 使 main 的 `--remote-debugging-port=9229` 绑定失败，`ohos-device-cdp.mjs` 报
 * `no page target`（真机实测）。任何人把裸 `--inspect` 加回 DEFAULT_ARGS 都会让
 * 真机 UI 自动化与 Performance trace 再次失效，因此在这里钉死。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function readRepoFile(relativePath: string): string {
  return readFileSync(`${repoRoot}/${relativePath}`, "utf8");
}

const CMD_ARGS_HELPER = "packages/desktop/ohos/web_engine/src/main/ets/utils/CmdArgsHelper.ets";
const DEVICE_CDP_SCRIPT = "packages/desktop/scripts/ohos-device-cdp.mjs";
const DESKTOP_MAIN_INDEX = "packages/desktop/src/main/index.ts";

describe("OHOS 调试端口契约", () => {
  it("main 的 Node inspector 固定在 9330", () => {
    const source = readRepoFile(CMD_ARGS_HELPER);
    const defaultArgs = source.slice(
      source.indexOf("DEFAULT_ARGS"),
      source.indexOf("BLOCKED_ARGS_NAME"),
    );
    expect(defaultArgs).toContain('"--inspect=9330"');
  });

  it("DEFAULT_ARGS 不允许出现裸 --inspect 占住 9229", () => {
    const source = readRepoFile(CMD_ARGS_HELPER);
    const defaultArgs = source.slice(
      source.indexOf("DEFAULT_ARGS"),
      source.indexOf("BLOCKED_ARGS_NAME"),
    );
    expect(defaultArgs).not.toMatch(/"--inspect"/);
  });

  it("renderer CDP 仍由 main 绑到 9229", () => {
    const source = readRepoFile(DESKTOP_MAIN_INDEX);
    expect(source).toContain('appendSwitch("remote-debugging-port", "9229")');
  });

  it("真机 UI 自动化默认连 9229 的 page target", () => {
    const source = readRepoFile(DEVICE_CDP_SCRIPT);
    expect(source).toContain('"http://127.0.0.1:9229"');
  });
});
