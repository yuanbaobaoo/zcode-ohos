import { describe, expect, it, vi } from "vitest";

class FakeClipboardItem {
  constructor(readonly items: Record<string, Blob>) {}
}

// 能力在模块加载期固化，因此每个用例先用 doMock 设定模拟运行时再重新导入。
async function loadWriter(electronModule: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock("electron", () => electronModule);
  return (await import("../src/main/pluginSandbox/clipboardImage.js")).writePngToClipboard;
}

describe("plugin sandbox clipboard image write", () => {
  it("Electron 40 没有 ClipboardItem 时回退同步 writeImage", async () => {
    const writeImage = vi.fn();
    const createFromBuffer = vi.fn(() => ({ tag: "native-image" }));
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const writePngToClipboard = await loadWriter({
      ClipboardItem: undefined,
      clipboard: { writeImage },
      nativeImage: { createFromBuffer },
    });

    await writePngToClipboard(png);

    expect(createFromBuffer).toHaveBeenCalledWith(Buffer.from(png));
    expect(writeImage).toHaveBeenCalledWith({ tag: "native-image" });
  });

  it("Electron 44 有 ClipboardItem 时走异步 write 并传 PNG Blob", async () => {
    const write = vi.fn(async () => {});
    const writeImage = vi.fn();
    const png = Uint8Array.from([1, 2, 3]);
    const writePngToClipboard = await loadWriter({
      ClipboardItem: FakeClipboardItem,
      clipboard: { write, writeImage },
      nativeImage: { createFromBuffer: vi.fn() },
    });

    await writePngToClipboard(png);

    expect(write).toHaveBeenCalledOnce();
    const items = write.mock.calls[0]![0] as unknown[];
    expect(items[0]).toBeInstanceOf(FakeClipboardItem);
    const blob = (items[0] as InstanceType<typeof FakeClipboardItem>).items["image/png"];
    expect(blob.type).toBe("image/png");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(writeImage).not.toHaveBeenCalled();
  });

  it("运行时两条路径都缺失时显式失败，不静默丢图", async () => {
    const writePngToClipboard = await loadWriter({
      ClipboardItem: undefined,
      clipboard: {},
      nativeImage: { createFromBuffer: vi.fn() },
    });

    await expect(writePngToClipboard(Uint8Array.from([0]))).rejects.toThrow(
      "Clipboard image write is unavailable",
    );
  });
});
