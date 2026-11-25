#!/usr/bin/env node
// OHOS aarch64 原生适配产物的唯一编译实现（sqlite 绑定 / 资产库密钥 / exec shim）。
//
// 为什么从三个 native/*/build.sh 收敛到这里：原实现依赖 sh + CLT 里无扩展名的
// aarch64-unknown-linux-ohos-clang 包装器。Windows 上这两个前提都不成立——系统没有 sh，
// 且 Windows 版 SDK 里的同名包装器仍是 sh 脚本、不可执行，只能直调 clang.exe 并显式传
// --sysroot。把编译参数放在一处，build.sh 退化为 POSIX/CI 的薄入口，避免两份参数漂移。
//
// 用法：node packages/desktop/scripts/build-ohos-native.mjs --target <sqlite|asset-keyring|exec-shim>
//       [--sqlite-src <sqlite-amalgamation 目录>]
// 工具链：CLT 根由 ohos-env.mjs 候选链解析（DEVECO_CLI_CLT_PATH 或 PATH 反推），无额外变量。
// 输入：Node 头文件与 sqlite 融合源由 ohos-native-deps.mjs 取到 packages/desktop/.cache/；
//       --sqlite-src 仅用于 CI/手工显式指定融合源（等价于迁移前 build.sh 的位置参数）。

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { applyOhosDotEnv, resolveCommandLineToolsRoot } from "./ohos-env.mjs";
import { requireNodeHeaders, requireSqliteSources } from "./ohos-native-deps.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");

// 三个产物的编译口径（与迁移前的 build.sh 逐字对齐，改参数只改这里）。
export const NATIVE_TARGETS = Object.freeze({
  sqlite: {
    dir: "ohos-zcode-sqlite",
    sources: ["zcode_sqlite.c", "sqlite3.c"],
    output: "zcode_sqlite.node",
    defines: [
      "NAPI_VERSION=8",
      "SQLITE_ENABLE_COLUMN_METADATA=1",
      "SQLITE_THREADSAFE=1",
      "SQLITE_DEFAULT_journal_mode=1",
    ],
    libraries: [],
    requiresNodeHeaders: true,
    requiresSqliteSources: true,
  },
  "asset-keyring": {
    dir: "ohos-asset-keyring",
    sources: ["asset_keyring.c"],
    output: "ohos_asset_keyring.node",
    defines: ["NAPI_VERSION=8"],
    libraries: ["asset_ndk.z"],
    requiresNodeHeaders: true,
    requiresSqliteSources: false,
  },
  "exec-shim": {
    dir: "ohos-exec-shim",
    sources: ["exec_shim.c"],
    output: "libzcode_exec_shim.so",
    defines: [],
    libraries: [],
    requiresNodeHeaders: false,
    requiresSqliteSources: false,
  },
});

// Windows 包里 aarch64-unknown-linux-ohos-clang 是 sh 脚本；只有 .exe 可执行。
// 直调 clang.exe 时目标三元组仍由参数给出，效果与包装器等价。
export function clangCandidateNames(platform = process.platform) {
  return platform === "win32"
    ? ["aarch64-unknown-linux-ohos-clang.exe", "clang.exe"]
    : ["aarch64-unknown-linux-ohos-clang", "clang"];
}

function isExecutableFile(filePath, platform) {
  if (!existsSync(filePath)) return false;
  if (platform === "win32") return filePath.toLowerCase().endsWith(".exe");
  return (statSync(filePath).mode & 0o111) !== 0;
}

// native SDK 根候选：harmonybrew（历史本机落点）> CLT 自带 SDK。
// 不需要额外变量：CLT 根由 ohos-env.mjs 的候选链解析（DEVECO_CLI_CLT_PATH 或 PATH 反推）。
export function nativeSdkRootCandidates({ platform = process.platform } = {}) {
  const candidates = [join(homedir(), ".harmonybrew", "opt", "ohos-sdk", "native")];
  const cltRoot = resolveCommandLineToolsRoot(process.env, platform);
  if (cltRoot) candidates.push(join(cltRoot, "sdk", "default", "openharmony", "native"));
  return candidates;
}

// usesTargetWrapper：命中的是 CLT 官方目标包装器（自带 --target 与 sysroot），
// 此时不再额外传 --sysroot，保持 POSIX/CI 行为与本改动前完全一致。
export function resolveOhosClang({ platform = process.platform } = {}) {
  for (const nativeRoot of nativeSdkRootCandidates({ platform })) {
    const names = clangCandidateNames(platform);
    for (const [index, name] of names.entries()) {
      const clang = join(nativeRoot, "llvm", "bin", name);
      if (isExecutableFile(clang, platform)) {
        return { clang, nativeRoot, usesTargetWrapper: index === 0 };
      }
    }
  }
  return null;
}

// 编译参数单一来源；测试可直接断言平台差异（sysroot / lld / 目标三元组）。
export function buildCompilePlan({
  target,
  platform = process.platform,
  workDir,
  nodeInclude = null,
  sysroot = null,
}) {
  const spec = NATIVE_TARGETS[target];
  if (!spec) throw new Error(`不支持的原生目标: ${String(target)}`);

  const args = ["-target", "aarch64-linux-ohos", "-shared", "-fPIC", "-O2"];
  for (const define of spec.defines) args.push(`-D${define}`);
  if (nodeInclude) args.push(`-I${nodeInclude}`);
  args.push(`-I${workDir}`);
  if (sysroot) args.push(`--sysroot=${sysroot}`);
  if (platform === "win32") {
    // 直调 clang.exe 时包装器里固化的链接器选择不生效，不指定 lld 会退到 MSVC link.exe。
    args.push("-fuse-ld=lld");
  }
  for (const library of spec.libraries) args.push(`-l${library}`);
  for (const source of spec.sources) args.push(join(workDir, source));
  const output = join(workDir, spec.output);
  args.push("-o", output);
  return { output, args };
}

function parseArgs(argv) {
  const options = { target: null, sqliteSrc: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") {
      options.target = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg.startsWith("--target=")) {
      options.target = arg.slice("--target=".length);
      continue;
    }
    if (arg === "--sqlite-src") {
      options.sqliteSrc = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg.startsWith("--sqlite-src=")) {
      options.sqliteSrc = arg.slice("--sqlite-src=".length);
      continue;
    }
    throw new Error(`不支持的参数: ${arg}`);
  }
  return options;
}

function fail(message) {
  console.error(`[build-ohos-native] ERROR: ${message}`);
  process.exit(1);
}

// sqlite 绑定的融合源与 Node 头文件都不入库：显式 --sqlite-src（CI/手工）优先，否则由
// ohos-native-deps.mjs 在 packages/desktop/.cache/ohos-native/ 里按需下载并校验。
function stageSqliteSources(sqliteSrcDir, workDir) {
  if (sqliteSrcDir === workDir) return;
  // 与迁移前的 build.sh 一致：融合源拷进 native 目录后再编译，产物与该目录自包含。
  for (const name of ["sqlite3.c", "sqlite3.h"]) {
    const source = join(sqliteSrcDir, name);
    if (existsSync(source)) copyFileSync(source, join(workDir, name));
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.target) fail(`缺少 --target（可选: ${Object.keys(NATIVE_TARGETS).join(", ")}）`);
  const spec = NATIVE_TARGETS[options.target];
  if (!spec) fail(`不支持的原生目标: ${options.target}`);

  const workDir = join(desktopRoot, "native", spec.dir);
  const sdk = resolveOhosClang();
  if (!sdk) {
    fail(
      "未找到 OHOS SDK clang。设 DEVECO_CLI_CLT_PATH 指向 command-line-tools 根目录" +
        "（可写仓库根 .env；Windows 上其 sdk/default/openharmony/native/llvm/bin 应含 clang.exe），" +
        "或把 CLT 的 bin/ 加入 PATH 让候选链反推。",
    );
  }

  // 目标包装器自带 sysroot；直调 clang（Windows 必然、POSIX 兜底）时必须显式给出。
  const sysrootDir = join(sdk.nativeRoot, "sysroot");
  let sysroot = null;
  if (!sdk.usesTargetWrapper) {
    if (!existsSync(sysrootDir)) {
      fail(`native SDK 缺 sysroot 目录（${sysrootDir}）——SDK 不完整或 CLT 安装异常。`);
    }
    sysroot = sysrootDir;
  }

  let nodeInclude = null;
  if (spec.requiresNodeHeaders) {
    try {
      nodeInclude = requireNodeHeaders();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  if (spec.requiresSqliteSources) {
    let sqliteSrcDir = options.sqliteSrc;
    try {
      if (sqliteSrcDir) {
        if (!existsSync(join(sqliteSrcDir, "sqlite3.c"))) {
          fail(`--sqlite-src 目录里没有 sqlite3.c：${sqliteSrcDir}`);
        }
      } else {
        sqliteSrcDir = requireSqliteSources();
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    stageSqliteSources(sqliteSrcDir, workDir);
  }

  const plan = buildCompilePlan({ target: options.target, workDir, nodeInclude, sysroot });
  const result = spawnSync(sdk.clang, plan.args, { cwd: workDir, stdio: "inherit" });
  if (result.error) fail(`调用 clang 失败：${result.error.message}`);
  if (result.status !== 0) fail(`clang 退出码 ${result.status}（看上方编译输出）`);
  if (!existsSync(plan.output) || statSync(plan.output).size === 0) {
    fail(`clang 未产出 ${plan.output}`);
  }
  console.log(`built: ${plan.output}`);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  // 独立执行（CI 的 build.sh、手工排查）时也让仓库根 .env 里的工具链变量生效；
  // 由 build-ohos.mjs 派发时父进程已应用过，真实环境变量优先，不会互相覆盖。
  await applyOhosDotEnv();
  try {
    await main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
