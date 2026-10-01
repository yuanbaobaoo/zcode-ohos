/*
 * OHOS 碰一碰投送收件（main 进程）：监听沙箱收件目录（ArkTS 侧落盘），搬运到数据根
 * 后经 PlatformChannels.ExternalFilesReceived 转发聚焦窗口。沙箱收件的唯一所有者，
 * 幂等键 batchId；规则见 specs/ohos-port/05-碰一碰投送接收.md。
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { PlatformChannels, isOhosRuntime } from "@zcode/shared";
import type { ExternalFilesReceivedPayload } from "@zcode/shared";
import {
  OHOS_SHARE_MANIFEST_FILENAME,
  parseOhosShareInboxManifest,
  resolveOhosShareInboxPaths,
  selectExpiredOhosShareBatches,
  type OhosShareInboxManifest,
} from "@zcode/services/ohos-share-inbox";
import { OHOS_SANDBOX_FILES } from "./desktopEarlyOhosEnvBootstrap.js";

const DELIVERED_MARKER = ".delivered";
/** 启动补投窗口：搬运后崩溃的批次仅在该时长内重投，超过则视为遗留（TTL 清理）。 */
const STARTUP_REDELIVER_WINDOW_MS = 10 * 60 * 1000;
/** 沙箱内无 manifest 的残批（接收被打断）保留时长，超时回收。 */
const SANDBOX_STALE_BATCH_MS = 60 * 60 * 1000;
/** fs.watch 不可用时对沙箱收件目录的轮询间隔（el2 inotify 可用性未实证，自动降级）。 */
const SANDBOX_POLL_INTERVAL_MS = 2000;

type ShareInboxLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

interface ShareInboxRuntime {
  logger: ShareInboxLogger;
  sandboxInboxCandidates: string[];
  dataInbox: string;
  processedBatchIds: Set<string>;
}

async function getTargetWebContents(): Promise<import("electron").WebContents | undefined> {
  const { BrowserWindow } = await import("electron");
  const win =
    BrowserWindow.getAllWindows().find((candidate) => candidate.isFocused()) ??
    BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return undefined;
  return win.webContents;
}

/** rename 跨文件系统（沙箱 el2 → 真实 home）会 EXDEV，失败回退递归复制+删除。 */
function moveBatchDir(sourceDir: string, targetDir: string): void {
  mkdirSync(dirname(targetDir), { recursive: true });
  try {
    renameSync(sourceDir, targetDir);
  } catch {
    cpSync(sourceDir, targetDir, { recursive: true });
    rmSync(sourceDir, { recursive: true, force: true });
  }
}

function listBatchDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

function readManifestIfComplete(batchDir: string): OhosShareInboxManifest | undefined {
  const manifestPath = join(batchDir, OHOS_SHARE_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) return undefined;
  try {
    const parsed = parseOhosShareInboxManifest(readFileSync(manifestPath, "utf8"));
    // manifest 是批次完整性的唯一事实：清单缺任一文件即整批作废，不部分注入。
    if (parsed && !parsed.files.every((file) => existsSync(join(batchDir, file.filename)))) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function deliverBatch(
  runtime: ShareInboxRuntime,
  batchId: string,
  dataBatchDir: string,
  manifest: OhosShareInboxManifest,
): void {
  void (async () => {
    let payload: ExternalFilesReceivedPayload;
    try {
      payload = {
        batchId,
        files: manifest.files.map((file) => {
          const localPath = join(dataBatchDir, file.filename);
          return {
            localPath,
            filename: file.filename,
            sizeBytes: file.sizeBytes ?? statSync(localPath).size,
            ...(file.mimeType ? { mimeType: file.mimeType } : {}),
          };
        }),
      };
    } catch (error) {
      runtime.logger.warn(
        `[ohos-share-inbox] batch ${batchId} stat failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    // 启动扫描先于首窗就绪是常态：等窗口出现再投，用户正等附件出现在输入框。
    const deadline = Date.now() + 60_000;
    let webContents = await getTargetWebContents();
    while (!webContents && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      webContents = await getTargetWebContents();
    }
    if (!webContents) {
      runtime.logger.warn(
        `[ohos-share-inbox] batch ${batchId} has no target window, pending next startup`,
      );
      return;
    }
    webContents.send(PlatformChannels.ExternalFilesReceived, payload);
    // 标记晚于 send：极端情况下丢标记最多造成一次补投（renderer 侧 batchId 幂等），反向则可能丢投。
    if (!existsSync(join(dataBatchDir, DELIVERED_MARKER))) {
      writeFileSync(join(dataBatchDir, DELIVERED_MARKER), String(Date.now()));
    }
    runtime.logger.info(
      `[ohos-share-inbox] batch ${batchId} delivered: ${payload.files.length} files`,
    );
  })();
}

function processSandboxBatch(runtime: ShareInboxRuntime, batchDir: string): void {
  const batchId = basename(batchDir);
  if (!batchId) return;
  const dataBatchDir = join(runtime.dataInbox, batchId);
  if (runtime.processedBatchIds.has(batchId) || existsSync(dataBatchDir)) {
    // 同批次重复 manifest / 重放：数据根已有即判重，收掉沙箱副本。
    rmSync(batchDir, { recursive: true, force: true });
    runtime.logger.info(`[ohos-share-inbox] batch ${batchId} duplicate, sandbox copy dropped`);
    return;
  }
  const manifest = readManifestIfComplete(batchDir);
  if (!manifest) {
    const mtimeMs = (() => {
      try {
        return statSync(batchDir).mtimeMs;
      } catch {
        return Date.now();
      }
    })();
    if (Date.now() - mtimeMs > SANDBOX_STALE_BATCH_MS) {
      rmSync(batchDir, { recursive: true, force: true });
      runtime.logger.warn(`[ohos-share-inbox] stale batch ${batchId} dropped`);
    }
    return;
  }
  moveBatchDir(batchDir, dataBatchDir);
  runtime.processedBatchIds.add(batchId);
  deliverBatch(runtime, batchId, dataBatchDir, manifest);
}

function scanSandboxInbox(runtime: ShareInboxRuntime): void {
  for (const candidate of runtime.sandboxInboxCandidates) {
    for (const batchDir of listBatchDirs(candidate)) {
      processSandboxBatch(runtime, batchDir);
    }
  }
}

/** 启动回收：数据根超期批次清理；未投递且新鲜的批次在窗口就绪后补投。 */
function recoverDataInbox(runtime: ShareInboxRuntime): void {
  const batches: Array<{ dir: string; id: string; manifest?: OhosShareInboxManifest }> = [];
  for (const dir of listBatchDirs(runtime.dataInbox)) {
    const id = basename(dir);
    runtime.processedBatchIds.add(id);
    batches.push({ dir, id, manifest: readManifestIfComplete(dir) });
  }
  const expired = selectExpiredOhosShareBatches(
    batches.map((batch) => ({
      batchId: batch.id,
      receivedAt: batch.manifest?.receivedAt ?? 0,
    })),
    Date.now(),
  );
  for (const id of expired) {
    rmSync(join(runtime.dataInbox, id), { recursive: true, force: true });
    runtime.logger.info(`[ohos-share-inbox] expired batch ${id} cleaned`);
  }
  const redeliver = batches.filter(
    (batch) =>
      batch.manifest &&
      !existsSync(join(batch.dir, DELIVERED_MARKER)) &&
      Date.now() - batch.manifest.receivedAt < STARTUP_REDELIVER_WINDOW_MS,
  );
  if (redeliver.length === 0) return;
  const deadline = Date.now() + 60_000;
  void (async () => {
    while (Date.now() < deadline) {
      if (await getTargetWebContents()) {
        for (const batch of redeliver) {
          if (batch.manifest) deliverBatch(runtime, batch.id, batch.dir, batch.manifest);
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    runtime.logger.warn(
      `[ohos-share-inbox] ${redeliver.length} undelivered batches kept (no window in 60s)`,
    );
  })();
}

/**
 * main 启动接线（index.ts whenReady 内调用，非 OHOS 环境空操作）。
 * el2 上 fs.watch 有静默失效形态（不报错也不触发，真机实证），轮询兜底常开，watch 仅作加速。
 */
export function bootstrapOhosShareInbox(logger: ShareInboxLogger): void {
  if (!isOhosRuntime()) return;
  const paths = resolveOhosShareInboxPaths({
    sandboxFilesDir: OHOS_SANDBOX_FILES,
    dataBaseDir: process.env.ZCODE_DATA_BASE_DIR ?? OHOS_SANDBOX_FILES,
  });
  for (const candidate of paths.sandboxInboxCandidates) {
    mkdirSync(candidate, { recursive: true });
  }
  const runtime: ShareInboxRuntime = {
    logger,
    sandboxInboxCandidates: paths.sandboxInboxCandidates,
    dataInbox: paths.dataInbox,
    processedBatchIds: new Set(),
  };
  recoverDataInbox(runtime);
  scanSandboxInbox(runtime);
  for (const candidate of paths.sandboxInboxCandidates) {
    try {
      const watcher = watch(candidate, { recursive: true }, () => scanSandboxInbox(runtime));
      watcher.on("error", () => {
        watcher.close();
      });
      logger.info(`[ohos-share-inbox] watching ${candidate}`);
    } catch {
      // 单个候选 watch 失败不影响其他候选；轮询兜底已常开。
    }
  }
  startPollingFallback(runtime);
}

function startPollingFallback(runtime: ShareInboxRuntime): void {
  const timer = setInterval(() => scanSandboxInbox(runtime), SANDBOX_POLL_INTERVAL_MS);
  timer.unref?.();
}
