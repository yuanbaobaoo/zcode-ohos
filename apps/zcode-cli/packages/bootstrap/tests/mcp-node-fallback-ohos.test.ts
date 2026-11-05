import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  bundledNpmRootCandidates,
  resetOhosSpawnableNodeCacheForTest,
  resolveOhosSpawnableNodeExecPath,
} from "../src/app/mcp-node-fallback.js";

const originalPath = process.env.PATH;
const originalExplicit = process.env.ZCODE_OHOS_SPAWNABLE_NODE;

function restoreEnv(): void {
  process.env.PATH = originalPath;
  if (originalExplicit === undefined) delete process.env.ZCODE_OHOS_SPAWNABLE_NODE;
  else process.env.ZCODE_OHOS_SPAWNABLE_NODE = originalExplicit;
  resetOhosSpawnableNodeCacheForTest();
}

afterEach(restoreEnv);

function createExecutableNode(dir: string): string {
  const nodePath = join(dir, "node");
  writeFileSync(nodePath, "#!/bin/sh\necho fake-node\n");
  chmodSync(nodePath, 0o755);
  return nodePath;
}

describe("resolveOhosSpawnableNodeExecPath", () => {
  it("非 ohos 平台原样返回 execPath", () => {
    expect(resolveOhosSpawnableNodeExecPath("/bundle/electron", "darwin")).toBe("/bundle/electron");
  });

  it("ohos 上按 PATH 探测到可执行 node 时替换 execPath（bundle 树 ELF 无执行位，spec 03）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohos-node-"));
    const nodePath = createExecutableNode(dir);
    process.env.PATH = `${dir}:/usr/bin`;
    delete process.env.ZCODE_OHOS_SPAWNABLE_NODE;
    resetOhosSpawnableNodeCacheForTest();
    expect(resolveOhosSpawnableNodeExecPath("/data/storage/el1/bundle/libs/arm64/electron", "ohos")).toBe(
      nodePath,
    );
  });

  it("ohos 上探测不到可执行 node 时 fail-closed 返回原 execPath", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "ohos-node-empty-"));
    process.env.PATH = emptyDir;
    delete process.env.ZCODE_OHOS_SPAWNABLE_NODE;
    resetOhosSpawnableNodeCacheForTest();
    expect(
      resolveOhosSpawnableNodeExecPath("/data/storage/el1/bundle/libs/arm64/electron", "ohos"),
    ).toBe("/data/storage/el1/bundle/libs/arm64/electron");
  });

  it("显式 ZCODE_OHOS_SPAWNABLE_NODE 优先于 PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "ohos-node-explicit-"));
    const explicit = createExecutableNode(dir);
    process.env.ZCODE_OHOS_SPAWNABLE_NODE = explicit;
    process.env.PATH = "/usr/bin:/bin";
    resetOhosSpawnableNodeCacheForTest();
    expect(resolveOhosSpawnableNodeExecPath("/bundle/electron", "harmonyos")).toBe(explicit);
  });
});

describe("bundledNpmRootCandidates", () => {
  it("按 baseDirs 顺序去重生成 node-runtime/npm 候选", () => {
    expect(bundledNpmRootCandidates(["/a", "/b", "/a"])).toEqual([
      join("/a", "node-runtime", "npm"),
      join("/b", "node-runtime", "npm"),
    ]);
  });
});
