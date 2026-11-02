import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  HDC_DIRECT_BRIDGE_ENV,
  isHdcDirectBridgeEnabled,
  resolveHdcDirectPackageRoot,
  stageBundledHdcDirect,
} from "../scripts/bundled-hdc-direct-assets.mjs";

// 每个用例的临时根目录，afterEach 统一清理
const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-hdc-direct-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/**
 * 造一个最小可用的 hdc-direct 安装目录（npm tgz 解包布局）。
 */
async function createFakePackage(root: string, options: { withIndex?: boolean } = {}) {
  const packageRoot = join(root, "package");
  await mkdir(join(packageRoot, "dist", "src"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "hdc-direct", version: "9.9.9" }),
  );
  await writeFile(join(packageRoot, "dist", "src", "cli.js"), "// cli");
  if (options.withIndex !== false) {
    await writeFile(join(packageRoot, "dist", "src", "index.js"), "// index");
  }
  return packageRoot;
}

describe("bundled hdc-direct switch", () => {
  it("默认启用，ZCODE_OHOS_HDC_BRIDGE 关闭后停用", () => {
    expect(isHdcDirectBridgeEnabled({})).toBe(true);
    expect(isHdcDirectBridgeEnabled({ [HDC_DIRECT_BRIDGE_ENV]: "0" })).toBe(false);
    expect(isHdcDirectBridgeEnabled({ [HDC_DIRECT_BRIDGE_ENV]: "native" })).toBe(false);
  });
});

describe("resolveHdcDirectPackageRoot", () => {
  it("解析到 pnpm 安装的包（依赖声明在 packages/desktop）", () => {
    const root = resolveHdcDirectPackageRoot();
    expect(root).toContain("node_modules/hdc-direct");
    expect(existsSync(join(root, "dist", "src", "index.js"))).toBe(true);
  });
});

describe("stageBundledHdcDirect", () => {
  it("把已安装包复制到 glm/node-runtime/hdc-direct", async () => {
    const root = await makeRoot();
    const packageRoot = await createFakePackage(root);
    const staged = await stageBundledHdcDirect({ glmDir: join(root, "glm"), packageRoot });
    expect(staged).toBe(join(root, "glm", "node-runtime", "hdc-direct"));
    expect(existsSync(join(staged, "package.json"))).toBe(true);
    expect(existsSync(join(staged, "dist", "src", "cli.js"))).toBe(true);
    expect(existsSync(join(staged, "dist", "src", "index.js"))).toBe(true);
  });

  it("重复 stage 是幂等的（先删后复制）", async () => {
    const root = await makeRoot();
    const packageRoot = await createFakePackage(root);
    const glmDir = join(root, "glm");
    await stageBundledHdcDirect({ glmDir, packageRoot });
    await stageBundledHdcDirect({ glmDir, packageRoot });
    expect(existsSync(join(glmDir, "node-runtime", "hdc-direct", "dist", "src", "cli.js"))).toBe(
      true,
    );
  });

  it("缺入口文件时失败并提示 pnpm install", async () => {
    const root = await makeRoot();
    const packageRoot = await createFakePackage(root, { withIndex: false });
    await expect(stageBundledHdcDirect({ glmDir: join(root, "glm"), packageRoot })).rejects.toThrow(
      /missing dist\/src\/index\.js.*pnpm install/,
    );
  });
});
