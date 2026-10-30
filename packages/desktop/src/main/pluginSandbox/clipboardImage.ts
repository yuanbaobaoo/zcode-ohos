import * as electronRuntime from "electron";
import { clipboard, nativeImage } from "electron";

type ClipboardItemCtor = new (items: Record<string, Blob>) => unknown;
type RuntimeClipboard = {
  write?: (items: unknown[]) => Promise<void>;
  writeImage?: (image: Electron.NativeImage) => void;
};

/**
 * 把 PNG 写入系统剪贴板。
 *
 * 上游 v3.17.1 为 Electron 44 改用 `clipboard.write([new ClipboardItem(...)])`，但 OHOS
 * 运行时是 Electron 40：`electron` 模块没有 `ClipboardItem` 导出，main 的 ESM 具名导入会在
 * 实例化阶段抛 SyntaxError，整个主进程起不来（真机黑屏 + JavaScript error 弹窗）。
 * 故改为命名空间访问 + 能力探测：44+ 走异步 ClipboardItem，40 回退 44 才移除的 writeImage。
 */
const runtime = electronRuntime as unknown as {
  ClipboardItem?: ClipboardItemCtor;
  clipboard?: RuntimeClipboard;
};
// 运行时能力在进程生命周期内不变，加载期取一次即可（避免每次写图重复探测）。
const ClipboardItemClass = runtime.ClipboardItem;
const runtimeClipboard = runtime.clipboard ?? (clipboard as RuntimeClipboard);

export async function writePngToClipboard(png: Uint8Array): Promise<void> {
  if (typeof runtimeClipboard.write === "function" && typeof ClipboardItemClass === "function") {
    await runtimeClipboard.write([
      new ClipboardItemClass({ "image/png": new Blob([Uint8Array.from(png)], { type: "image/png" }) }),
    ]);
    return;
  }
  if (typeof runtimeClipboard.writeImage === "function") {
    runtimeClipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(png)));
    return;
  }
  throw new Error("Clipboard image write is unavailable in this Electron runtime");
}
