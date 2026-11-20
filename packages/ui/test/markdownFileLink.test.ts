import { describe, expect, it } from "vitest";
import { resolveMarkdownFileLink } from "@/lib/markdownFileLink.js";

const OHOS_WORKSPACE = "/storage/Users/currentUser/Desktop/新建文件夹";

describe("resolveMarkdownFileLink", () => {
  it("OHOS 绝对路径不再拼 workspace 前缀（附件预览 ENOENT 回归）", () => {
    const absolute =
      "/storage/Users/currentUser/Documents/helloworld/screenshot-home.jpeg";
    expect(resolveMarkdownFileLink(OHOS_WORKSPACE, absolute)?.path).toBe(absolute);
  });

  it("workspace 内的绝对路径保持原样", () => {
    const inside = `${OHOS_WORKSPACE}/assets/icon.png`;
    expect(resolveMarkdownFileLink(OHOS_WORKSPACE, inside)?.path).toBe(inside);
  });

  it("markdown 根相对链接仍按 workspace 展开", () => {
    expect(resolveMarkdownFileLink("/repo", "/flappy.html")?.path).toBe(
      "/repo/flappy.html",
    );
  });
});
