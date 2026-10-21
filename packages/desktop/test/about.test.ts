import { describe, expect, it } from "vitest";
import {
  createAboutSnapshot,
  formatAboutDetail,
  formatAboutOptimizationLine,
  resolveOhosAboutVersion,
} from "../src/main/about.js";
import { createCustomAboutDialogHtml } from "../src/main/aboutWindow.js";

describe("about", () => {
  const appleSiliconSnapshot = createAboutSnapshot({
    appVersion: "0.1.7",
    environment: "production",
    buildMetadata: {
      appVersion: "0.1.7",
      buildCommitId: "abc1234",
      buildTime: "2026-03-28T10:20:30.000Z",
      electronBuilderVersion: "26.8.1",
    },
    runtimeVersions: {
      electron: "41.0.3",
      chrome: "141.0.7390.122",
      node: "24.0.0",
      v8: "14.1.146.11-electron.0",
    },
    osInfo: {
      type: "Darwin",
      platform: "darwin",
      release: "25.0.0",
      version: "Darwin Kernel Version 25.0.0",
      arch: "arm64",
      hostname: "zcode-mbp",
    },
  });

  it("应格式化完整的 about 文本信息", () => {
    const detail = formatAboutDetail(appleSiliconSnapshot);

    expect(detail).toContain("Version: 0.1.7");
    expect(detail).toContain("Commit: abc1234");
    expect(detail).toContain("Build Time: 2026-03-28T10:20:30.000Z");
    expect(detail).toContain("Electron: 41.0.3");
    expect(detail).toContain("Electron Builder: 26.8.1");
    expect(detail).toContain("Chromium: 141.0.7390.122");
    expect(detail).toContain("Node.js: 24.0.0");
    expect(detail).toContain("V8: 14.1.146.11-electron.0");
    expect(detail).toContain("OS Platform: darwin");
    expect(detail).toContain("OS Arch: arm64");
    expect(detail).toContain("Hostname: zcode-mbp");
  });

  it("应生成参考图样式的自定义 About 内容", () => {
    const html = createCustomAboutDialogHtml({
      applicationName: "ZCode Desktop App",
      appVersion: appleSiliconSnapshot.appVersion,
      githubLabel: "Github: ",
      githubUrl: "https://github.com/yuanbaobaoo/zcode-ohos",
      optimizationLine: "Optimized for Apple Silicon.",
      versionLabel: "version",
      okButtonLabel: "OK",
    });

    expect(html).toContain("ZCode Desktop App");
    expect(html).toContain("version 0.1.7");
    expect(html).toContain("Optimized for Apple Silicon.");
    expect(html).toContain("Github: ");
    expect(html).toContain('class="github-link"');
    expect(html).toContain('href="https://github.com/yuanbaobaoo/zcode-ohos"');
    expect(html).toContain(">https://github.com/yuanbaobaoo/zcode-ohos</a");
    expect(html).not.toContain("Copyright ©");
    expect(html).toContain('class="ok-button"');
    expect(html).toContain(">OK</button>");
    expect(html).toContain('class="app-logo"');
    expect(html).toContain('viewBox="0 0 256 218"');
    expect(html).toContain("linear-gradient(180deg, #000000 0%, #151718 100%)");
    expect(html).toContain('class="about-window"');
    expect(html).toContain("border-radius: 0");
    expect(html).toContain("background: var(--about-primary)");
    expect(html).toContain("color: var(--about-primary-foreground)");
    expect(html).toContain("font-weight: 400");
    expect(html).toContain("--startup-page-bg: #171717");
    expect(html).not.toContain("<animate");
    expect(html).not.toContain("box-shadow: 0 28px 70px");
  });

  it("应生成中文自定义 About 内容", () => {
    const html = createCustomAboutDialogHtml({
      applicationName: "ZCode Desktop App",
      appVersion: appleSiliconSnapshot.appVersion,
      githubLabel: "Github：",
      githubUrl: "https://github.com/yuanbaobaoo/zcode-ohos",
      optimizationLine: "已针对 Apple Silicon 优化。",
      versionLabel: "版本",
      okButtonLabel: "确定",
    });

    expect(html).toContain("版本 0.1.7");
    expect(html).toContain("已针对 Apple Silicon 优化。");
    expect(html).toContain("Github：");
    expect(html).toContain('class="github-link"');
    expect(html).toContain('href="https://github.com/yuanbaobaoo/zcode-ohos"');
    expect(html).not.toContain("版权所有");
    expect(html).toContain(">确定</button>");
  });

  it("非 Apple Silicon 不展示 Apple Silicon 优化文案", () => {
    expect(formatAboutOptimizationLine({ osPlatform: "darwin", osArch: "x64" }, "en-US")).toBe("");
    expect(formatAboutOptimizationLine({ osPlatform: "win32", osArch: "arm64" }, "en-US")).toBe("");
  });

  it("OHOS About 版本与 HAP versionName 同源：tag 去前缀，开发态回退 0.0.0-dev", () => {
    expect(resolveOhosAboutVersion({ ohosReleaseVersion: "v3.14.3-ohos-patch7" })).toBe(
      "3.14.3-ohos-patch7",
    );
    expect(resolveOhosAboutVersion({ ohosReleaseVersion: "v3.15.1" })).toBe("3.15.1");
    expect(resolveOhosAboutVersion({ ohosReleaseVersion: null })).toBe("0.0.0-dev");
    expect(resolveOhosAboutVersion(null)).toBe("0.0.0-dev");
  });
});
