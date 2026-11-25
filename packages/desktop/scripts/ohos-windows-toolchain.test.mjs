// OHOS 工具链在 Windows/POSIX 两侧的解析与参数口径（specs/ohos-port/01「Windows 原生构建」）。
// 这些用例只做纯函数/临时目录验证，不依赖本机是否装了 command-line-tools 或 OHOS SDK。

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

import {
  clangCandidateNames,
  buildCompilePlan,
  nativeSdkRootCandidates,
} from "./build-ohos-native.mjs";
import { cltArchivePlan, ensureCommandLineTools, findCachedCommandLineTools } from "./ohos-clt.mjs";
import {
  nodeHeadersCacheDir,
  nodeHeadersCandidateDirs,
  sqliteCacheDir,
  sqliteSourceCandidates,
} from "./ohos-native-deps.mjs";
import {
  cltToolCandidateNames,
  persistOhosDotEnvValue,
  readOhosDotEnvValue,
  resolveCltHdc,
  resolveCltTool,
  resolveCommandLineToolsRoot,
  spawnCltTool,
} from "./ohos-env.mjs";
import { resolveSetupDecision } from "../../../scripts/ohos-env-setup.mjs";

const fixtures = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempDir(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  fixtures.push(root);
  return root;
}

function makeCltLayout(entries) {
  const root = makeTempDir("ohos-clt ");
  mkdirSync(join(root, "bin"), { recursive: true });
  for (const entry of entries) {
    writeFileSync(join(root, "bin", entry), "#!/bin/sh\nexit 0\n", "utf-8");
  }
  return root;
}

it("工具入口按平台取扩展名：Windows 优先 .bat，POSIX 只有无扩展名", () => {
  expect(cltToolCandidateNames("hvigorw", "win32")).toEqual([
    "hvigorw.bat",
    "hvigorw.cmd",
    "hvigorw",
  ]);
  expect(cltToolCandidateNames("hvigorw", "linux")).toEqual(["hvigorw"]);
});

it("resolveCltTool 在 Windows 上命中 hvigorw.bat", () => {
  const cltRoot = makeCltLayout(["hvigorw.bat", "ohpm.bat"]);
  expect(resolveCltTool(cltRoot, "hvigorw", "win32")).toBe(join(cltRoot, "bin", "hvigorw.bat"));
  expect(resolveCltTool(cltRoot, "ohpm", "win32")).toBe(join(cltRoot, "bin", "ohpm.bat"));
  // 同一个目录在 POSIX 语义下没有锚点，不能误判成有效 CLT。
  expect(resolveCltTool(cltRoot, "hvigorw", "linux")).toBeNull();
});

it("resolveCltTool 在 POSIX 上命中无扩展名脚本", () => {
  const cltRoot = makeCltLayout(["hvigorw", "ohpm"]);
  expect(resolveCltTool(cltRoot, "hvigorw", "linux")).toBe(join(cltRoot, "bin", "hvigorw"));
  expect(resolveCltTool(cltRoot, "hvigorw", "win32")).toBe(join(cltRoot, "bin", "hvigorw"));
});

it("CLT 根解析以 hvigorw(.bat) 为锚点，DEVECO_CLI_CLT_PATH 优先", () => {
  const cltRoot = makeCltLayout(["hvigorw.bat"]);
  expect(resolveCommandLineToolsRoot({ DEVECO_CLI_CLT_PATH: cltRoot }, "win32")).toBe(cltRoot);
});

it("hdc 落在 SDK toolchains 下，Windows 是 hdc.exe", () => {
  const cltRoot = makeTempDir("ohos-clt-hdc ");
  const toolchains = join(cltRoot, "sdk", "default", "openharmony", "toolchains");
  mkdirSync(toolchains, { recursive: true });
  writeFileSync(join(toolchains, "hdc.exe"), "", "utf-8");
  writeFileSync(join(toolchains, "hdc"), "", "utf-8");
  expect(resolveCltHdc(cltRoot, "win32")).toBe(join(toolchains, "hdc.exe"));
  expect(resolveCltHdc(cltRoot, "linux")).toBe(join(toolchains, "hdc"));
  expect(resolveCltHdc(null, "win32")).toBeNull();
});

it.runIf(process.platform === "win32")("spawnCltTool 能执行含空格的 .bat 并传参", () => {
  const root = makeTempDir("ohos-clt space ");
  const bat = join(root, "probe.bat");
  writeFileSync(bat, "@echo off\r\necho ARG=%1\r\n", "utf-8");
  const result = spawnCltTool(bat, ["value with space"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(String(result.stdout)).toContain("value with space");
});

it.runIf(process.platform !== "win32")("spawnCltTool 在 POSIX 上直接执行脚本", () => {
  const root = makeTempDir("ohos-clt-posix ");
  const script = join(root, "probe.sh");
  writeFileSync(script, "#!/bin/sh\necho ARG=$1\n", "utf-8");
  chmodSync(script, 0o755);
  const result = spawnCltTool(script, ["value with space"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(String(result.stdout)).toContain("value with space");
});

it("Windows 只认 clang.exe：目标包装器在 Windows 包里是 sh 脚本", () => {
  expect(clangCandidateNames("win32")).toEqual([
    "aarch64-unknown-linux-ohos-clang.exe",
    "clang.exe",
  ]);
  expect(clangCandidateNames("darwin")).toEqual(["aarch64-unknown-linux-ohos-clang", "clang"]);
});

it("native SDK 候选跟着 CLT 根走，不需要额外覆盖变量", () => {
  const cltRoot = makeCltLayout(["hvigorw.bat"]);
  const previous = process.env.DEVECO_CLI_CLT_PATH;
  process.env.DEVECO_CLI_CLT_PATH = cltRoot;
  try {
    const candidates = nativeSdkRootCandidates({ platform: "win32" });
    expect(candidates).toContain(join(cltRoot, "sdk", "default", "openharmony", "native"));
  } finally {
    if (previous === undefined) delete process.env.DEVECO_CLI_CLT_PATH;
    else process.env.DEVECO_CLI_CLT_PATH = previous;
  }
});

it("原生编译输入落在项目内 .cache/ohos-native，不入库也不需要配置", () => {
  const cacheRoot = join("/repo/packages/desktop/.cache/ohos-native");
  expect(nodeHeadersCacheDir({ version: "24.9.0", cacheRoot })).toBe(
    join(cacheRoot, "node-headers", "node-v24.9.0"),
  );
  expect(sqliteCacheDir({ cacheRoot })).toBe(join(cacheRoot, "sqlite-amalgamation-3530400"));
});

it("Node 头文件候选：先本机 Node 安装，最后回落项目缓存", () => {
  const cacheRoot = "C:\\repo\\.cache";
  const windows = nodeHeadersCandidateDirs({
    execPath: "C:\\node\\node.exe",
    platform: "win32",
    version: "24.9.0",
    cacheRoot,
  });
  // Windows 的 node.exe 在安装根目录，头文件在 <root>/include/node。
  expect(windows[0]).toBe(join("C:\\node", "include", "node"));
  expect(windows.at(-1)).toBe(join(cacheRoot, "node-headers", "node-v24.9.0", "include", "node"));

  const posix = nodeHeadersCandidateDirs({
    execPath: "/usr/bin/node",
    platform: "linux",
    version: "24.9.0",
    cacheRoot: "/repo/.cache",
  });
  // POSIX 的 node 在 bin/ 下，头文件在 <prefix>/include/node。
  expect(posix[0]).toBe(resolve("/usr/bin", "..", "include", "node"));
});

it("sqlite 融合源候选：native 目录优先，其次项目缓存", () => {
  expect(sqliteSourceCandidates({ workDir: "/repo/native", cacheRoot: "/repo/.cache" })).toEqual([
    "/repo/native",
    join("/repo/.cache", "sqlite-amalgamation-3530400"),
  ]);
});

it("编译参数单一来源：目标三元组、define、输出路径", () => {
  const workDir = join("/work/native");
  const plan = buildCompilePlan({
    target: "sqlite",
    platform: "linux",
    workDir,
    nodeInclude: "/node/include",
  });
  expect(plan.args).toContain("-target");
  expect(plan.args).toContain("aarch64-linux-ohos");
  expect(plan.args).toContain("-DNAPI_VERSION=8");
  expect(plan.args).toContain("-DSQLITE_THREADSAFE=1");
  expect(plan.args).toContain("-I/node/include");
  expect(plan.args).toContain(join(workDir, "zcode_sqlite.c"));
  expect(plan.args).toContain(join(workDir, "sqlite3.c"));
  expect(plan.output).toBe(join(workDir, "zcode_sqlite.node"));
  // POSIX 走官方包装器时不额外传 sysroot，保持与改动前一致的编译口径。
  expect(plan.args.join(" ")).not.toContain("--sysroot");
  expect(plan.args).not.toContain("-fuse-ld=lld");
});

it("Windows 直调 clang.exe 时补 sysroot 与 lld", () => {
  const plan = buildCompilePlan({
    target: "asset-keyring",
    platform: "win32",
    workDir: "C:\\repo\\native",
    nodeInclude: "C:\\node\\include\\node",
    sysroot: "C:\\sdk\\native\\sysroot",
  });
  expect(plan.args).toContain("--sysroot=C:\\sdk\\native\\sysroot");
  expect(plan.args).toContain("-fuse-ld=lld");
  expect(plan.args).toContain("-lasset_ndk.z");
  expect(plan.args.join(" ")).toContain("aarch64-linux-ohos");
});

it("exec-shim 不需要 Node 头文件与 NAPI define", () => {
  const workDir = join("/w");
  const plan = buildCompilePlan({ target: "exec-shim", platform: "linux", workDir });
  expect(plan.args.join(" ")).not.toContain("-DNAPI_VERSION");
  // 只有源目录本身作为头文件搜索路径，不注入 Node 头。
  expect(plan.args.filter((arg) => arg.startsWith("-I"))).toEqual([`-I${workDir}`]);
  expect(plan.output).toBe(join(workDir, "libzcode_exec_shim.so"));
});

// ── command-line-tools：三平台同一套「已装 > 缓存 > 自动下载」链路 ──

it("CLT 自动获取按平台取分卷，未知平台不给计划", () => {
  const windows = cltArchivePlan({ platform: "win32", arch: "x64" });
  expect(windows.parts).toHaveLength(2);
  expect(windows.parts[0].name).toContain("windows-x64");
  expect(windows.parts[0].sha256).toMatch(/^[0-9a-f]{64}$/u);

  const linux = cltArchivePlan({ platform: "linux", arch: "x64" });
  expect(linux.parts[0].name).toContain("linux-x64");

  expect(cltArchivePlan({ platform: "linux", arch: "arm64" })).toBeNull();
});

it("已解压的 CLT 在缓存里时直接复用，不触发下载", async () => {
  const cacheRoot = makeTempDir("ohos-clt-cache ");
  const root = join(cacheRoot, "26.0.0.865", "command-line-tools");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "hvigorw.bat"), "@echo off\r\n", "utf-8");

  expect(findCachedCommandLineTools({ cacheRoot, platform: "win32" })).toBe(root);

  let downloads = 0;
  const result = await ensureCommandLineTools({
    platform: "win32",
    arch: "x64",
    cacheRoot,
    discover: () => null,
    persistImpl: () => {},
    downloadPartImpl: async () => {
      downloads += 1;
    },
  });
  expect(result).toEqual({ root, origin: "cache" });
  expect(downloads).toBe(0);
  // 旧缓存没有 CJS 标记时，复用路径也要补齐，保证 hvigorw.js 按 CJS 加载。
  const manifest = JSON.parse(readFileSync(join(cacheRoot, "26.0.0.865", "package.json"), "utf8"));
  expect(manifest.type).toBe("commonjs");
});

it("没有现成 CLT 时按计划下载、校验 sha256、解压并清理归档", async () => {
  const cacheRoot = makeTempDir("ohos-clt-download ");
  const payload = Buffer.from("part-bytes");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const plan = {
    key: "win32-x64",
    version: "test",
    approxBytes: 1024,
    parts: [{ name: "fake.zip.part1", sha256 }],
  };

  const result = await ensureCommandLineTools({
    platform: "win32",
    arch: "x64",
    cacheRoot,
    plan,
    discover: () => null,
    persistImpl: () => {},
    log: () => {},
    downloadPartImpl: async (_url, dest) => {
      writeFileSync(dest, payload);
    },
    joinPartsImpl: async (parts, joinedPath) => {
      copyFileSync(parts[0], joinedPath);
    },
    extractImpl: (_archivePath, workDir) => {
      mkdirSync(join(workDir, "command-line-tools", "bin"), { recursive: true });
      writeFileSync(join(workDir, "command-line-tools", "bin", "hvigorw.bat"), "", "utf-8");
    },
  });

  expect(result.origin).toBe("download");
  expect(result.root).toBe(join(cacheRoot, "test", "command-line-tools"));
  expect(existsSync(join(result.root, "bin", "hvigorw.bat"))).toBe(true);
  // 解压完成后不保留 2GB 级归档
  expect(existsSync(join(cacheRoot, "test", ".archives"))).toBe(false);
  // 缓存落在仓库内，必须写 CJS 标记，否则 hvigorw.js 会被仓库根的 "type":"module" 带成 ESM。
  const manifest = JSON.parse(readFileSync(join(cacheRoot, "test", "package.json"), "utf8"));
  expect(manifest.type).toBe("commonjs");
});

it("分卷 sha256 不匹配时失败并删掉坏分卷", async () => {
  const cacheRoot = makeTempDir("ohos-clt-badhash ");
  const plan = {
    key: "win32-x64",
    version: "test",
    approxBytes: 1024,
    parts: [{ name: "fake.zip.part1", sha256: "0".repeat(64) }],
  };
  const partPath = join(cacheRoot, "test", ".archives", "fake.zip.part1");

  await expect(
    ensureCommandLineTools({
      platform: "win32",
      arch: "x64",
      cacheRoot,
      plan,
      discover: () => null,
      log: () => {},
      downloadPartImpl: async (_url, dest) => {
        writeFileSync(dest, "not-matching");
      },
    }),
  ).rejects.toThrow(/sha256 不匹配/u);
  expect(existsSync(partPath)).toBe(false);
});

it("已装好的 CLT 优先于缓存与下载", async () => {
  const existing = makeCltLayout(["hvigorw"]);
  const result = await ensureCommandLineTools({
    platform: "linux",
    arch: "x64",
    discover: () => existing,
    persistImpl: () => {},
    downloadPartImpl: async () => {
      throw new Error("不应触发下载");
    },
  });
  expect(result).toEqual({ root: existing, origin: "existing" });
});

// ── .env：安装期脚手架与首次构建共用的落盘规则 ──

it(".env 写入幂等：缺键追加、有键原地替换、保留注释与其它键", () => {
  const root = makeTempDir("ohos-dotenv ");
  writeFileSync(join(root, ".env"), "# 注释\nZCODE_ENV=production\n", "utf-8");

  persistOhosDotEnvValue("DEVECO_CLI_CLT_PATH", "D:\\clt\\command-line-tools", { root });
  const first = readFileSync(join(root, ".env"), "utf8");
  expect(first).toContain("# 注释");
  expect(first).toContain("ZCODE_ENV=production");
  expect(first).toContain("DEVECO_CLI_CLT_PATH=D:\\clt\\command-line-tools");

  persistOhosDotEnvValue("DEVECO_CLI_CLT_PATH", "/opt/clt", { root });
  const second = readFileSync(join(root, ".env"), "utf8");
  expect(second.match(/DEVECO_CLI_CLT_PATH=/gu)).toHaveLength(1);
  expect(second).toContain("DEVECO_CLI_CLT_PATH=/opt/clt");
  expect(readOhosDotEnvValue("DEVECO_CLI_CLT_PATH", { root })).toBe("/opt/clt");
});

it("解析到 CLT 后回写 .env；已有显式配置时不改写", async () => {
  const existing = makeCltLayout(["hvigorw"]);
  const persisted = [];
  const result = await ensureCommandLineTools({
    platform: "linux",
    arch: "x64",
    discover: () => existing,
    persistImpl: (key, value) => persisted.push([key, value]),
  });
  expect(result.origin).toBe("existing");
  expect(persisted).toEqual([["DEVECO_CLI_CLT_PATH", existing]]);

  // 显式配置（CI 的 workflow 变量或用户 export）：保持原样，不回写 .env。
  persisted.length = 0;
  const previous = process.env.DEVECO_CLI_CLT_PATH;
  process.env.DEVECO_CLI_CLT_PATH = existing;
  try {
    await ensureCommandLineTools({
      platform: "linux",
      arch: "x64",
      discover: () => existing,
      persistImpl: (key, value) => persisted.push([key, value]),
    });
    expect(persisted).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.DEVECO_CLI_CLT_PATH;
    else process.env.DEVECO_CLI_CLT_PATH = previous;
  }
});

it("安装期脚手架决策：CI 跳过、已配置只报告、找到即回写、否则自动获取", () => {
  expect(resolveSetupDecision({ ci: true, configuredPath: "/x", foundRoot: "/y" })).toBe("skip-ci");
  expect(resolveSetupDecision({ ci: false, configuredPath: "/x" })).toBe("report");
  expect(resolveSetupDecision({ ci: false, configuredPath: null, foundRoot: "/y" })).toBe(
    "persist",
  );
  expect(resolveSetupDecision({ ci: false, configuredPath: null, foundRoot: null })).toBe(
    "provision",
  );
});
