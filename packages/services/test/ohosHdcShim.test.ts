// spec：specs/ohos-port/11-hdc-direct-接入.md —— devecocli 的 hdc 入口 shim（迷你 CLT）
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureOhosHdcShimClt,
  ohosHdcShimCltDir,
  resolveHdcdCliPath,
} from "../src/ohos/ohosHdcShim.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ohos-hdc-shim-"));
  dirs.push(dir);
  return dir;
}
function seedGlm(root: string): string {
  const cli = join(root, "node-runtime", "hdc-direct", "dist", "src", "cli.js");
  mkdirSync(join(root, "node-runtime", "hdc-direct", "dist", "src"), { recursive: true });
  writeFileSync(cli, "// cli\n", "utf8");
  return cli;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("ohos devecocli hdc shim", () => {
  it("生成迷你 CLT：version.txt + 可执行 hdc shim + API 元数据", () => {
    const glm = tempDir();
    const home = tempDir();
    const cli = seedGlm(glm);

    const root = ensureOhosHdcShimClt(home, { ZCODE_BUNDLED_RESOURCE_DIR: glm });

    expect(root).toBe(ohosHdcShimCltDir(home));
    expect(readFileSync(join(root!, "version.txt"), "utf8")).toContain("# Version: 26.0.0");
    const shim = join(root!, "sdk", "default", "openharmony", "toolchains", "hdc");
    expect(statSync(shim).mode & 0o111).not.toBe(0);
    const script = readFileSync(shim, "utf8");
    // devecocli 会 exec 这个文件；它必须把参数透传给 hdc-direct CLI。
    expect(script).toContain(cli);
    expect(script).toContain('"$@"');
    expect(readFileSync(join(root!, "sdk", "default", "sdk-pkg.json"), "utf8")).toContain("26");
  });

  it("找不到 hdc-direct 资产时返回 undefined（不阻塞启动）", () => {
    const empty = tempDir();
    const home = tempDir();
    expect(resolveHdcdCliPath({ ZCODE_BUNDLED_RESOURCE_DIR: empty })).toBeUndefined();
    expect(ensureOhosHdcShimClt(home, { ZCODE_BUNDLED_RESOURCE_DIR: empty })).toBeUndefined();
  });

  it("幂等：重复调用内容一致", () => {
    const glm = tempDir();
    const home = tempDir();
    seedGlm(glm);
    const first = ensureOhosHdcShimClt(home, { ZCODE_BUNDLED_RESOURCE_DIR: glm });
    const shim = join(first!, "sdk", "default", "openharmony", "toolchains", "hdc");
    const before = readFileSync(shim, "utf8");
    const second = ensureOhosHdcShimClt(home, { ZCODE_BUNDLED_RESOURCE_DIR: glm });
    expect(second).toBe(first);
    expect(readFileSync(shim, "utf8")).toBe(before);
  });
});
