// 碰一碰投送收件目录的纯逻辑（manifest 解析/路径演算/TTL），fs 操作在 desktop main
// 的 desktopOhosShareInbox.ts，保持无 IO 便于 node:test（specs/ohos-port/05）。

/** ArkTS ShareReceiveCoordinator 在接收成功后写入的批次清单（批次完整性唯一事实）。 */
export interface OhosShareInboxManifest {
  type: "zcode-share-inbox-manifest";
  /** 幂等键：同一批次只消费一次。 */
  batchId: string;
  /** 毫秒时间戳（ArkTS 侧接收完成时刻）。 */
  receivedAt: number;
  files: Array<{
    filename: string;
    sizeBytes?: number;
    mimeType?: string;
  }>;
}

export const OHOS_SHARE_MANIFEST_FILENAME = "manifest.json";
/** 数据根收件目录内批次的保留期；过期批次由启动清理回收（7 天）。 */
export const OHOS_SHARE_INBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface OhosShareInboxPaths {
  /**
   * ArkTS receive() 落盘根候选：多模块应用 filesDir 带 haps/<module> 层级
   * （/data/storage/el2/base/haps/electron/files），与 Electron main 的
   * /data/storage/el2/base/files 不同，两个候选都覆盖。
   */
  sandboxInboxCandidates: string[];
  /** main 搬运后的数据根收件目录（renderer 附件的 localPath 来源）。 */
  dataInbox: string;
}

export function resolveOhosShareInboxPaths(params: {
  sandboxFilesDir: string;
  dataBaseDir: string;
}): OhosShareInboxPaths {
  const base = params.sandboxFilesDir.replace(/\/+$/, "");
  const candidates = [`${base}/share-inbox`];
  // base 形如 /data/storage/el2/base/files 时补 haps 模块候选；已是 haps 形态则补扁平候选。
  const otherCandidate = base.includes("/haps/")
    ? `${base.replace(/\/haps\/[^/]+\/files$/, "")}/files/share-inbox`
    : `${base.replace(/\/files$/, "")}/haps/electron/files/share-inbox`;
  if (!candidates.includes(otherCandidate)) candidates.push(otherCandidate);
  return {
    sandboxInboxCandidates: candidates,
    dataInbox: `${params.dataBaseDir.replace(/\/+$/, "")}/share-inbox`,
  };
}

/** 解析并校验 manifest：结构不符/文件名为空/清单为空一律判废（丢弃整批，不部分注入）。 */
export function parseOhosShareInboxManifest(raw: string): OhosShareInboxManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "zcode-share-inbox-manifest") return undefined;
  if (typeof record.batchId !== "string" || !record.batchId.trim()) return undefined;
  if (typeof record.receivedAt !== "number" || !Number.isFinite(record.receivedAt))
    return undefined;
  if (!Array.isArray(record.files) || record.files.length === 0) return undefined;
  const files: OhosShareInboxManifest["files"] = [];
  for (const entry of record.files) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const file = entry as Record<string, unknown>;
    if (typeof file.filename !== "string" || !file.filename.trim()) return undefined;
    // 文件名不允许路径分隔符：manifest 里的名字直接参与沙箱目录拼接。
    if (/[\\/]/.test(file.filename)) return undefined;
    if (file.sizeBytes !== undefined && typeof file.sizeBytes !== "number") return undefined;
    if (file.mimeType !== undefined && typeof file.mimeType !== "string") return undefined;
    files.push({
      filename: file.filename,
      ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
      ...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
    });
  }
  return {
    type: "zcode-share-inbox-manifest",
    batchId: record.batchId,
    receivedAt: record.receivedAt,
    files,
  };
}

export interface OhosShareInboxBatchListing {
  batchId: string;
  receivedAt: number;
}

/** 从数据根收件目录的批次目录名/时间戳列表中选出过期批次（启动清理用）。 */
export function selectExpiredOhosShareBatches(
  batches: OhosShareInboxBatchListing[],
  now: number,
  ttlMs: number = OHOS_SHARE_INBOX_TTL_MS,
): string[] {
  return batches.filter((batch) => now - batch.receivedAt > ttlMs).map((batch) => batch.batchId);
}
