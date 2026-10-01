import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OHOS_SHARE_INBOX_TTL_MS,
  parseOhosShareInboxManifest,
  resolveOhosShareInboxPaths,
  selectExpiredOhosShareBatches,
} from "../src/ohos/ohosShareInbox.js";

test("resolveOhosShareInboxPaths 演算收件目录候选并覆盖 haps 形态", () => {
  const flat = resolveOhosShareInboxPaths({
    sandboxFilesDir: "/data/storage/el2/base/files/",
    dataBaseDir: "/storage/Users/currentUser/.zcode",
  });
  // 扁平形态（Electron main 视角）补 haps/electron 候选（ArkTS filesDir 真实落点）。
  assert.deepEqual(flat.sandboxInboxCandidates, [
    "/data/storage/el2/base/files/share-inbox",
    "/data/storage/el2/base/haps/electron/files/share-inbox",
  ]);
  assert.equal(flat.dataInbox, "/storage/Users/currentUser/.zcode/share-inbox");
  // haps 形态（ArkTS 视角）反向补扁平候选，保证两个视角互通。
  const haps = resolveOhosShareInboxPaths({
    sandboxFilesDir: "/data/storage/el2/base/haps/electron/files",
    dataBaseDir: "/storage/Users/currentUser/.zcode",
  });
  assert.deepEqual(haps.sandboxInboxCandidates, [
    "/data/storage/el2/base/haps/electron/files/share-inbox",
    "/data/storage/el2/base/files/share-inbox",
  ]);
});

test("parseOhosShareInboxManifest 接受合法 manifest", () => {
  const manifest = parseOhosShareInboxManifest(
    JSON.stringify({
      type: "zcode-share-inbox-manifest",
      batchId: "batch-1",
      receivedAt: 1790000000000,
      files: [{ filename: "a.png", sizeBytes: 10, mimeType: "image/png" }, { filename: "b.pdf" }],
    }),
  );
  assert.equal(manifest?.batchId, "batch-1");
  assert.equal(manifest?.files.length, 2);
  assert.equal(manifest?.files[0]?.mimeType, "image/png");
});

test("parseOhosShareInboxManifest 拒绝废件（不部分注入）", () => {
  const invalid: unknown[] = [
    "not-json",
    JSON.stringify({ type: "other" }),
    JSON.stringify({ type: "zcode-share-inbox-manifest" }), // 缺字段
    JSON.stringify({
      type: "zcode-share-inbox-manifest",
      batchId: "",
      receivedAt: 1,
      files: [{ filename: "a" }],
    }),
    JSON.stringify({
      type: "zcode-share-inbox-manifest",
      batchId: "b",
      receivedAt: 1,
      files: [],
    }),
    JSON.stringify({
      type: "zcode-share-inbox-manifest",
      batchId: "b",
      receivedAt: 1,
      // 文件名带路径分隔符：防目录逃逸
      files: [{ filename: "../escape.png" }],
    }),
  ];
  for (const raw of invalid) {
    assert.equal(parseOhosShareInboxManifest(String(raw)), undefined, String(raw));
  }
});

test("selectExpiredOhosShareBatches 按保留期筛选", () => {
  const now = 1_000_000_000_000;
  const expired = selectExpiredOhosShareBatches(
    [
      { batchId: "old", receivedAt: now - OHOS_SHARE_INBOX_TTL_MS - 1 },
      { batchId: "fresh", receivedAt: now - 1000 },
    ],
    now,
  );
  assert.deepEqual(expired, ["old"]);
});
