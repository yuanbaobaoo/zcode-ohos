#!/usr/bin/env node
// OHOS HAP 标准打包编排：由 packages/desktop bundle --os ohos 分流进入。
// 职责链：build-ohos（源码产物 + resfile 组装 + libelectron 补丁）→ 清 hvigor
// 缓存（增量不感知 resfile，发布通道正确性优先）→ assembleHap → 产物按标准
// 命名规则（{productName}-{version}-{platform}-{arch}.{ext}）落 packages/desktop/dist/。
//
// 前置（一次性）：command-line-tools（hvigor/ohpm/hdc）、devecocli 签名材料、
// libelectron.so 经旧仓 LFS 取回。详见 ohos/docs/01-构建与打包.md。

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { resolveDesktopProductIdentity } from "../../packages/desktop/scripts/desktop-product-identity.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const ohosRoot = resolve(import.meta.dirname, "..");
const distRoot = resolve(repoRoot, "packages/desktop/dist");
const hapOutputDir = resolve(
  ohosRoot,
  "electron/build/default/outputs/default",
);

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const passThrough = ["--skip-build", "--skip-agent"].filter((flag) => args.has(flag));

function log(step, message) {
  console.log(`[bundle:ohos] ${step}: ${message}`);
}

function fail(message) {
  console.error(`[bundle:ohos] ERROR: ${message}`);
  process.exit(1);
}

// hvigorw 解析：显式 env > SDK 根 env > 已知安装位置扫描。可执行文件路径级
// 精确（不做 PATH 搜索，保证与签名/SDK 版本可追溯）。
function resolveHvigorw() {
  const candidates = [];
  if (process.env.OHOS_HVIGORW) candidates.push(process.env.OHOS_HVIGORW);
  for (const sdkEnv of [process.env.OHOS_COMMAND_LINE_TOOLS, process.env.DEVECO_SDK_HOME]) {
    if (sdkEnv) candidates.push(resolve(sdkEnv, "bin/hvigorw"));
  }
  candidates.push(
    "/Users/Shared/local/ohos/command-line-tools_26.0.0_Beta1/bin/hvigorw",
  );
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const version = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
).version;
const productName = resolveDesktopProductIdentity(process.env).productName;
const artifactBase = `${productName}-${version}-ohos-arm64`;

// ── 前置检查（显式目标显式失败：缺工具链时给出可行动的指引）──
const libelectron = resolve(ohosRoot, "electron/libs/arm64-v8a/libelectron.so");
if (!existsSync(libelectron) || statSync(libelectron).size < 100 * 1024 * 1024) {
  // libelectron.so 不入库；缺失时先尝试镜像自动获取（ZCODE_OHOS_ELECTRON_URL
  // 可覆盖源地址，默认本仓库 GitHub Release），断供风险与取回方式见
  // ohos/scripts/fetch-libelectron.mjs 头注。AUTOFETCH=0 保持纯报错。
  if (process.env.ZCODE_OHOS_ELECTRON_AUTOFETCH === "0") {
    fail(
      `libelectron.so 缺失或异常（${libelectron}）。` +
        "运行 ohos/scripts/fetch-libelectron.mjs 自动获取，或见 ohos/docs/01-构建与打包.md。",
    );
  }
  log("libelectron", "缺失，尝试镜像自动获取（fetch-libelectron.mjs）");
  const fetchResult = spawnSync(
    process.execPath,
    [resolve(ohosRoot, "scripts/fetch-libelectron.mjs")],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (fetchResult.status !== 0) {
    fail("libelectron.so 自动获取失败（看上方输出；也可手动放置后重试）。");
  }
}
const hvigorw = resolveHvigorw();
if (!hvigorw) {
  fail(
    "未找到 hvigorw。设置 OHOS_HVIGORW（可执行文件路径）或 OHOS_COMMAND_LINE_TOOLS" +
      "/DEVECO_SDK_HOME（SDK 根目录），或安装 command-line-tools 到已知位置。",
  );
}
// build-profile.json5 机器相关（含签名材料路径/密码）不入库；缺失时从模板
// 自动复制（空签名 → 只产出未签名 HAP，实测 hvigor SignHap 自动跳过）。
const buildProfile = resolve(ohosRoot, "build-profile.json5");
if (!existsSync(buildProfile)) {
  copyFileSync(resolve(ohosRoot, "build-profile.template.json5"), buildProfile);
  log(
    "build-profile",
    "缺失，已从模板复制（无签名配置，本次仅产出未签名 HAP）；" +
      "签名方法见模板内注释（devecocli signature generate）",
  );
}
// ohos 原生依赖（oh_modules 不入库）：CI/新环境冷 checkout 后必须先 ohpm install
// （本地 DevEco/devecocli 初始化过的环境已有 oh_modules，自动跳过）。
if (!existsSync(resolve(ohosRoot, "oh_modules"))) {
  const ohpm = resolve(dirname(hvigorw), "ohpm");
  if (!existsSync(ohpm)) {
    fail(`ohos/oh_modules 缺失且未找到 ohpm（${ohpm}）。请在 ohos/ 下执行 ohpm install。`);
  }
  log("ohpm", "oh_modules 缺失，执行 ohpm install --all");
  const ohpmResult = spawnSync(ohpm, ["install", "--all"], { cwd: ohosRoot, stdio: "inherit" });
  if (ohpmResult.status !== 0) {
    fail("ohpm install 失败（检查网络与 oh-package-lock.json5）。");
  }
}
log("target", `${productName} ${version} ohos/arm64, hvigor=${hvigorw}`);

if (dryRun) {
  log("dry-run", `node scripts/build-ohos.mjs ${passThrough.join(" ") || "(full)"}`);
  log("dry-run", "rm -rf ohos/.hvigor ohos/electron/build ohos/web_engine/build");
  log("dry-run", `${hvigorw} assembleHap --mode module -p product=default -p buildMode=debug --no-daemon`);
  log("dry-run", `copy → ${distRoot}/${artifactBase}[-unsigned].hap`);
  process.exit(0);
}

// ── 1. 源码产物 + resfile 组装（含 libelectron io_uring 补丁，幂等）──
log("build", `scripts/build-ohos.mjs ${passThrough.join(" ") || "(full)"}`);
const buildResult = spawnSync(
  process.execPath,
  ["scripts/build-ohos.mjs", ...passThrough],
  { cwd: repoRoot, stdio: "inherit", env: { ...process.env, ZCODE_TARGET_OS: "linux", ZCODE_TARGET_ARCH: "arm64" } },
);
if (buildResult.status !== 0) {
  fail("build-ohos.mjs 失败（看上方完整输出；out/ 不因失败回滚，勿直接装机）。");
}

// ── 2. 清 hvigor 缓存：增量构建不感知 resfile/libs 变化，发布通道必须全量 ──
for (const cache of [
  resolve(ohosRoot, ".hvigor"),
  resolve(ohosRoot, "electron/build"),
  resolve(ohosRoot, "web_engine/build"),
]) {
  rmSync(cache, { recursive: true, force: true });
}

// ── 3. HAP 组装（debug buildMode；签名材料存在时 hvigor SignHap 产出签名版）──
log("assemble", "hvigorw assembleHap");
const hvigorResult = spawnSync(
  hvigorw,
  ["assembleHap", "--mode", "module", "-p", "product=default", "-p", "buildMode=debug", "--no-daemon"],
  { cwd: ohosRoot, stdio: "inherit" },
);
if (hvigorResult.status !== 0) {
  fail("hvigor assembleHap 失败。首次使用需 devecocli auth login + signature generate 生成签名材料。");
}

// ── 4. 产物落标准输出目录（与桌面版同一命名规则/目录）──
// dist 目录可能不存在（未跑过桌面打包），copyFileSync 不建目录。
mkdirSync(distRoot, { recursive: true });
const artifacts = [
  { source: "electron-default-unsigned.hap", target: `${artifactBase}-unsigned.hap`, required: true },
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
  log(
    "artifact",
    `${target}（${(size / 1024 / 1024).toFixed(0)}MB）sha256=${sha256(targetPath)}`,
  );
}
log("done", `输出目录 ${distRoot}`);
