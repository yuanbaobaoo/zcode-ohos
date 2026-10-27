import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOhosExecShimToProcessEnv } from "../src/ohos/ohosExecShim.js";
import { ensureOhosTmpDir, ohosTmpDirPath } from "../src/ohos/ohosTmpDir.js";
import { resolveDefaultSpawnCwd } from "../src/ohos/ohosSpawnCwd.js";

test("ensureOhosTmpDir: 创建 ~/.zcode/tmp 且权限 0700", () => {
  const home = mkdtempSync(join(tmpdir(), "zcode-ohos-tmp-"));
  try {
    const dir = ensureOhosTmpDir(home);
    assert.equal(dir, join(home, ".zcode", "tmp"));
    assert.equal(dir, ohosTmpDirPath(home));
    assert.equal(statSync(dir!).mode & 0o777, 0o700);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensureOhosTmpDir: 目录已存在时幂等", () => {
  const home = mkdtempSync(join(tmpdir(), "zcode-ohos-tmp-"));
  try {
    const first = ensureOhosTmpDir(home);
    const second = ensureOhosTmpDir(home);
    assert.equal(first, second);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveDefaultSpawnCwd: 非 OHOS 保持 process.cwd()", () => {
  assert.equal(resolveDefaultSpawnCwd("darwin"), process.cwd());
});

test("applyOhosExecShimToProcessEnv: shim 缺失时不注入、存在时前置且幂等", () => {
  const saved = process.env.LD_PRELOAD;
  try {
    delete process.env.LD_PRELOAD;
    assert.equal(
      applyOhosExecShimToProcessEnv(() => false),
      false,
      "shim 缺失不注入",
    );
    assert.equal(process.env.LD_PRELOAD, undefined);

    assert.equal(
      applyOhosExecShimToProcessEnv(() => true),
      true,
    );
    const injected = process.env.LD_PRELOAD ?? "";
    assert.match(injected, /libzcode_exec_shim\.so$/);
    applyOhosExecShimToProcessEnv(() => true);
    assert.equal(process.env.LD_PRELOAD, injected, "重复调用不叠加");

    process.env.LD_PRELOAD = "/system/lib64/libother.so";
    applyOhosExecShimToProcessEnv(() => true);
    assert.equal(
      process.env.LD_PRELOAD,
      `${injected}:/system/lib64/libother.so`,
      "已有预加载项保留在后",
    );
  } finally {
    if (saved === undefined) delete process.env.LD_PRELOAD;
    else process.env.LD_PRELOAD = saved;
  }
});

test("resolveDefaultSpawnCwd: OHOS 落到真实 home", () => {
  const home = mkdtempSync(join(tmpdir(), "zcode-ohos-cwd-"));
  const previous = process.env.ZCODE_OHOS_REAL_HOME;
  process.env.ZCODE_OHOS_REAL_HOME = home;
  try {
    assert.equal(resolveDefaultSpawnCwd("ohos"), home);
    assert.equal(resolveDefaultSpawnCwd("openharmony"), home);
  } finally {
    if (previous === undefined) delete process.env.ZCODE_OHOS_REAL_HOME;
    else process.env.ZCODE_OHOS_REAL_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
