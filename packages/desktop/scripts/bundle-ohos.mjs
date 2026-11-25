#!/usr/bin/env node
// OHOS HAP 打包编排：build-ohos（产物+resfile+补丁）→ 清 hvigor 缓存 → assembleHap → dist/。
// 前置（CLT、Electron 运行时、原生编译输入）由 pnpm ohos:setup 备齐；本脚本只校验。

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import process from "node:process";
import { join, resolve } from "node:path";
import { resolveDesktopProductIdentity } from "./desktop-product-identity.mjs";
import { isHdcDirectBridgeEnabled } from "./bundled-hdc-direct-assets.mjs";
import { applyOhosDotEnv, resolveCltTool, spawnCltTool } from "./ohos-env.mjs";
import { requireCommandLineTools } from "./ohos-clt.mjs";
import { requireOhosRuntime } from "./fetch-ohos-runtime.mjs";
import { ensureOhosAppJson5, resolveOhosArtifactVersion } from "./ohos-version.mjs";
import { getBuildMetadata } from "./build-metadata.mjs";

// 工具链变量可来自仓库根 .env/.env.local（白名单：DEVECO_CLI_CLT_PATH、
// ZCODE_OHOS_ELECTRON_URL；真实环境变量优先）。
await applyOhosDotEnv();

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");
const desktopRoot = resolve(import.meta.dirname, "..");
const ohosRoot = join(desktopRoot, "ohos");
const distRoot = join(desktopRoot, "dist");
const hapOutputDir = resolve(ohosRoot, "entry/build/default/outputs/default");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const passThrough = ["--skip-build", "--skip-agent"].filter((flag) => args.has(flag));

function log(step, message) {
  console.log(`[ohos:bundle] ${step}: ${message}`);
}

function fail(message) {
  console.error(`[ohos:bundle] ERROR: ${message}`);
  process.exit(1);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const version = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).version;
const productName = resolveDesktopProductIdentity(process.env).productName;
// 资产名带 patch：`ZCode-4.0.0-patch3-ohos-arm64-unsigned.hap`。基础版本/开发态回退
// package.json 的 4.0.0，避免本地构建假装成某个 patch；HAP 内部 versionName 仍由 tag 推导。
const artifactVersion = resolveOhosArtifactVersion(process.env, repoRoot, version);
const artifactBase = `${productName}-${artifactVersion}-ohos-arm64`;

// ── 前置检查（显式目标显式失败：缺输入时给出可行动的指引）──
// 运行时三件套与 resfile 资源都不入库（源地址 ZCODE_OHOS_ELECTRON_URL 可覆盖，
// 断供与取回方式见 fetch-ohos-runtime.mjs 头注）。构建期只校验，下载归口 pnpm ohos:setup。
try {
  requireOhosRuntime();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
// CLT 只做发现（DEVECO_CLI_CLT_PATH / PATH 优先，其次项目缓存）：缺了直接报错指向
// pnpm ohos:setup —— 构建期不下载工具链。
let cltInfo;
try {
  cltInfo = requireCommandLineTools();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const cltRoot = cltInfo.root;
// 子进程（build-ohos → build-ohos-native）复用同一 CLT，避免重复探测或重复下载。
process.env.DEVECO_CLI_CLT_PATH ??= cltRoot;
const hvigorw = resolveCltTool(cltRoot, "hvigorw");
if (!hvigorw) fail(`command-line-tools 缺少 hvigorw 入口：${cltRoot}`);
// build-profile.json5 机器相关（含签名材料路径/密码）不入库；缺失时从模板
// 自动复制（空签名 → 只产出未签名 HAP，实测 hvigor SignHap 自动跳过）。
const buildProfile = resolve(ohosRoot, "build-profile.json5");
if (!existsSync(buildProfile)) {
  copyFileSync(resolve(ohosRoot, "build-profile.template.json5"), buildProfile);
  log(
    "build-profile",
    "缺失，已从模板复制（无签名配置，本次仅产出未签名 HAP）；" +
      "签名方法见模板内注释（AGC 手动申请，或外部工具 devecocli 一键生成）",
  );
}
// ohos 原生依赖（oh_modules 不入库）：CI/新环境冷 checkout 后必须先 ohpm install
// （已执行过 ohpm install 的环境已有 oh_modules，自动跳过）。
if (!existsSync(resolve(ohosRoot, "oh_modules"))) {
  const ohpm = resolveCltTool(cltRoot, "ohpm");
  if (!ohpm) {
    fail(
      `oh_modules 缺失且未找到 ohpm（${join(cltRoot, "bin")}）。请在 packages/desktop/ohos/ 下执行 ohpm install。`,
    );
  }
  log("ohpm", "oh_modules 缺失，执行 ohpm install --all");
  const ohpmResult = spawnCltTool(ohpm, ["install", "--all"], { cwd: ohosRoot, stdio: "inherit" });
  if (ohpmResult.status !== 0) {
    fail("ohpm install 失败（检查网络与 oh-package-lock.json5）。");
  }
}
log("target", `${productName} ${artifactVersion} ohos/arm64, hvigor=${hvigorw}`);

if (dryRun) {
  log(
    "dry-run",
    `node packages/desktop/scripts/build-ohos.mjs ${passThrough.join(" ") || "(full)"}`,
  );
  log("dry-run", "rm -rf packages/desktop/ohos/{.hvigor,entry/build,web_engine/build}");
  log(
    "dry-run",
    `${hvigorw} assembleHap --mode module -p product=default -p buildMode=debug --no-daemon`,
  );
  log("dry-run", `copy → ${distRoot}/${artifactBase}[-unsigned].hap`);
  process.exit(0);
}

// ── 1. 源码产物 + resfile 组装（含 libelectron io_uring 补丁，幂等）──
log("build", `packages/desktop/scripts/build-ohos.mjs ${passThrough.join(" ") || "(full)"}`);
const buildResult = spawnSync(process.execPath, ["scripts/build-ohos.mjs", ...passThrough], {
  cwd: desktopRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    ZCODE_TARGET_OS: "linux",
    ZCODE_TARGET_ARCH: "arm64",
    ZCODE_OHOS_BUILD: "1",
  },
});
if (buildResult.status !== 0) {
  fail("build-ohos.mjs 失败（看上方完整输出；out/ 不因失败回滚，勿直接装机）。");
}

// ── 1.5 随包 hdc-direct 硬校验（鸿蒙设备通道）──
// 沙箱内官方 hdc server 不可用，install/shell 全靠这份资产；缺失时宁可失败也不产出
// 「能装但装不了应用」的 HAP（同 sqlite / exec-shim 的不降级原则）。
const hdcDirectEnabled = isHdcDirectBridgeEnabled();
const hdcDirectEntry = resolve(
  desktopRoot,
  "bundled-agents",
  "linux-arm64",
  "glm",
  "node-runtime",
  "hdc-direct",
  "dist",
  "src",
  "cli.js",
);
if (hdcDirectEnabled && !existsSync(hdcDirectEntry)) {
  fail(
    `随包 hdc-direct 缺失（${hdcDirectEntry}）。` +
      "规格见 specs/ohos-port/11-设备通道.md；" +
      "请用完整 agent bundle 打包（不要 --skip-agent），或检查 prepare-agent-node-bundle 的 staging 步骤。",
  );
}
log("hdc-direct", hdcDirectEnabled ? "bundled asset staged" : "bridge disabled, skipped");

// ── 2. 清 hvigor 缓存：增量构建不感知 resfile/libs 变化，发布通道必须全量 ──
for (const cache of [
  resolve(ohosRoot, ".hvigor"),
  resolve(ohosRoot, "entry/build"),
  resolve(ohosRoot, "web_engine/build"),
]) {
  rmSync(cache, { recursive: true, force: true });
}

// ── 2.5 生成 AppScope/app.json5：versionName 跟随发版 tag（build-ohos 刚写好 build-meta）──
ensureOhosAppJson5(ohosRoot, {
  buildMetadata: getBuildMetadata(),
  log: (message) => log("version", message),
});

// ── 3. HAP 组装（debug buildMode；签名材料存在时 hvigor SignHap 产出签名版）──
// Windows 上 hvigorw 是 .bat 包装，必须经 cmd.exe 执行，见 ohos-env.mjs 的 spawnCltTool。
log("assemble", "hvigorw assembleHap");
const hvigorResult = spawnCltTool(
  hvigorw,
  [
    "assembleHap",
    "--mode",
    "module",
    "-p",
    "product=default",
    "-p",
    "buildMode=debug",
    "--no-daemon",
  ],
  { cwd: ohosRoot, stdio: "inherit" },
);
if (hvigorResult.status !== 0) {
  fail(
    "hvigor assembleHap 失败（签名相关失败时：按 build-profile 模板注释准备材料，AGC 手动申请或外部工具 devecocli 生成）。",
  );
}

// ── 4. 产物落标准输出目录（与桌面版同一命名规则/目录）──
// dist 目录可能不存在（未跑过桌面打包），copyFileSync 不建目录。
mkdirSync(distRoot, { recursive: true });
const artifacts = [
  {
    source: "electron-default-unsigned.hap",
    target: `${artifactBase}-unsigned.hap`,
    required: true,
  },
  { source: "electron-default-signed.hap", target: `${artifactBase}.hap`, required: false },
];
const produced = [];
for (const { source, target, required } of artifacts) {
  const sourcePath = resolve(hapOutputDir, source);
  if (!existsSync(sourcePath)) {
    if (required) fail(`hvigor 未产出 ${source}（检查上方构建输出）。`);
    log("skip", `${source} 不存在（无签名材料时仅产出未签名版）`);
    continue;
  }
  const targetPath = resolve(distRoot, target);
  copyFileSync(sourcePath, targetPath);
  const size = statSync(targetPath).size;
  produced.push(targetPath);
  log("artifact", `${target}（${(size / 1024 / 1024).toFixed(0)}MB）sha256=${sha256(targetPath)}`);
}
// CI 用精确文件名做 checksum/latest/upload，避免宽 glob 同时匹配 latest 别名。
const unsignedTarget = artifacts[0].target;
if (existsSync(resolve(distRoot, unsignedTarget))) {
  writeFileSync(resolve(distRoot, "artifact-name.txt"), `${unsignedTarget}\n`);
}
log("done", `输出目录 ${distRoot}`);
