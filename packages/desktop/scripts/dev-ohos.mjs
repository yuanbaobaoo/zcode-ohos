#!/usr/bin/env node
// OHOS 快速迭代环（dev）：resfile 重组 → 变更检测 → hqf quickfix 热推（或全量装机）。
// 关键事实（真机实证，详见 specs/ohos-port/README.md）：
//  1. resfile 内 JS/HTML 可经签名 hqf + quickfix 热推生效（~8s），无需重装整包；
//  2. hqf 协议自实现（hvigor assembleDevHqf + hdc bm quickfix）——devecocli 同功能
//     有 Studio 硬门禁且定位是外部 AI 工具，不入本项目工具链；
//  3. hvigor 增量/watch 均不感知 resfile 变更，全量必须清缓存，变更检测用基线 hash。
//
// 用法：pnpm dev:ohos [-- --build|-- --agent|-- --full|-- --device <sn>]
//   （--build 连 desktop 构建一起跑；--full 全量装机；.so 变更需 --full）

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { applyOhosDotEnv } from "./ohos-env.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const ohosRoot = join(desktopRoot, "ohos");
const scanRoot = join(ohosRoot, "web_engine/src/main/resources/resfile/resources");
// 基线放在 ohos/build/（gitignore 已覆盖）：.hvigor/ 与模块 build/ 会被全量路径清理，
// 不能存状态。
const baselinePath = join(ohosRoot, "build/zcode-dev-baseline.json");
// hqf 补丁规模阈值：超出走全量（quickfix 面向小步快跑，大变更整包更可靠）。
const FULL_THRESHOLD_FILES = 200;
const FULL_THRESHOLD_BYTES = 50 * 1024 * 1024;

const args = new Set(process.argv.slice(2));
const device = (() => {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--device");
  return index !== -1 ? argv[index + 1] : undefined;
})();
const withBuild = args.has("--build");
const withAgent = args.has("--agent");
const forceFull = args.has("--full");

function log(step, message) {
  console.log(`[dev:ohos] ${step}: ${message}`);
}

function fail(message) {
  console.error(`[dev:ohos] ERROR: ${message}`);
  process.exit(1);
}

// command-line-tools 根解析（与 bundle-ohos.mjs 的 hvigorw 解析同规则）：
// OHOS_COMMAND_LINE_TOOLS_ROOT > ~/command-line-tools > PATH 中的 hvigorw 反推。
function resolveCommandLineToolsRoot() {
  if (process.env.OHOS_COMMAND_LINE_TOOLS_ROOT) {
    const root = process.env.OHOS_COMMAND_LINE_TOOLS_ROOT;
    // 显式配置（env 或 .env）指向无效目录时立即报错，不静默回退——否则下游会
    // 拼出错误的 hvigorw/hdc 路径，报出难以定位的间接错误。
    if (!existsSync(join(root, "bin/hvigorw"))) {
      fail(
        `OHOS_COMMAND_LINE_TOOLS_ROOT 指向的目录无效（${root}，需包含 bin/hvigorw）——检查环境变量或仓库根 .env/.env.local。`,
      );
    }
    return root;
  }
  if (process.env.HOME) {
    const candidate = join(process.env.HOME, "command-line-tools");
    if (existsSync(join(candidate, "bin/hvigorw"))) return candidate;
  }
  const which = spawnSync("sh", ["-c", "command -v hvigorw"], { encoding: "utf8" });
  const hvigorw = which.status === 0 ? which.stdout.trim() : "";
  if (hvigorw) return resolve(hvigorw, "..", "..");
  return null;
}

// 工具链变量可来自仓库根 .env/.env.local（白名单见 ohos-env.mjs；真实环境变量优先），
// 必须在 CLT 根解析之前应用。
await applyOhosDotEnv();

const cltRoot = resolveCommandLineToolsRoot();
if (!cltRoot) {
  fail(
    "未找到 command-line-tools：设置 OHOS_COMMAND_LINE_TOOLS_ROOT（可写入仓库根 .env）、解压到 " +
      "~/command-line-tools、或把 bin/ 加入 PATH（与 bundle:desktop:ohos 相同）。",
  );
}
const hvigorw = join(cltRoot, "bin/hvigorw");
const hdc = join(cltRoot, "sdk/default/openharmony/toolchains/hdc");

// 单设备自动选择；多设备时必须 --device 显式指定。
function resolveDeviceSerial() {
  if (device) return device;
  const result = spawnSync(hdc, ["list", "targets"], { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) return null;
  const targets = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("["));
  return targets.length === 1 ? targets[0] : null;
}
const serial = resolveDeviceSerial();
if (!serial) {
  fail("无法确定唯一目标设备（hdc list targets 为空或不唯一）——用 --device <sn> 指定。");
}

function runHdc(hdcArgs, inherit = true) {
  const result = spawnSync(hdc, hdcArgs, { stdio: inherit ? "inherit" : "pipe" });
  return result.status === 0;
}

// ── resfile 扫描与基线比对 ──
function scanManifest() {
  const manifest = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const rel = relative(ohosRoot, path);
        if (isScanIgnored(rel)) continue;
        manifest.set(rel, createHash("sha256").update(readFileSync(path)).digest("hex"));
      }
    }
  };
  walk(scanRoot);
  return manifest;
}

// 扫描忽略：每次构建必变但与运行无关的文件（build-ready 标记/构建元数据/.bin 符号链接），
// 忽略后 diff 才反映真实代码变更（否则零变更重建产生 20 改 + 11 删噪声）。
function isScanIgnored(rel) {
  return (
    /\/out\/\.[a-z]+-build-ready$/.test(rel) ||
    rel.endsWith("out/metadata/build-meta.json") ||
    rel.endsWith("node_modules/.bin/electron")
  );
}

// 删除豁免：tsup 的内容哈希 chunk 每次构建换名，旧 chunk 成为无人引用的孤儿，
// 无需整包重装；其余删除（真正下线的文件）仍强制全量。
function isChunkChurnRemoval(rel) {
  return /\/out\/(main|host)\/chunk-[A-Z0-9]{8}\.(js|js\.map)$/.test(rel);
}

function loadBaseline() {
  if (!existsSync(baselinePath)) return null;
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(baselinePath, "utf8"))));
  } catch {
    return null;
  }
}

const startedAt = Date.now();

// ── 1. resfile 重组（out/ 需已构建；--build 连生产构建一起跑）──
const buildArgs = [];
if (!withBuild) buildArgs.push("--skip-build");
if (!withAgent) buildArgs.push("--skip-agent");
log("stage", `build-ohos.mjs ${buildArgs.join(" ") || "(full)"}`);
const buildResult = spawnSync(process.execPath, ["scripts/build-ohos.mjs", ...buildArgs], {
  cwd: desktopRoot,
  stdio: "inherit",
  env: { ...process.env, ZCODE_TARGET_OS: "linux", ZCODE_TARGET_ARCH: "arm64" },
});
if (buildResult.status !== 0) {
  fail("build-ohos.mjs 失败（看上方输出）。");
}

// ── 2. 变更检测 ──
log("scan", "hashing resfile …");
const manifest = scanManifest();
const baseline = loadBaseline();
const changed = [];
let removed = 0;
let churned = 0;
if (baseline) {
  for (const [rel, hash] of manifest) {
    if (baseline.get(rel) !== hash) changed.push(rel);
  }
  for (const rel of baseline.keys()) {
    if (manifest.has(rel)) continue;
    if (isChunkChurnRemoval(rel)) churned += 1;
    else removed += 1;
  }
  const changedBytes = changed.reduce(
    (total, rel) => total + statSync(join(ohosRoot, rel)).size,
    0,
  );
  log(
    "scan",
    `${manifest.size} 个文件，${changed.length} 处变更，${removed} 处删除` +
      (churned > 0 ? `（另 ${churned} 个 tsup chunk 换名按孤儿豁免）` : ""),
  );
  if (removed > 0) log("scan", "存在删除（hqf 不支持删文件），本次走全量");
  if (changed.length > FULL_THRESHOLD_FILES) {
    log("scan", `变更文件数超过阈值 ${FULL_THRESHOLD_FILES}，本次走全量`);
  } else if (changedBytes > FULL_THRESHOLD_BYTES) {
    log("scan", `变更体积 ${(changedBytes / 1024 / 1024).toFixed(0)}MB 超过阈值，本次走全量`);
  }
} else {
  log("scan", `${manifest.size} 个文件；无基线（首次运行），本次走全量装机`);
}

const needsFull =
  forceFull ||
  !baseline ||
  removed > 0 ||
  changed.length > FULL_THRESHOLD_FILES ||
  changed.reduce((total, rel) => total + statSync(join(ohosRoot, rel)).size, 0) >
    FULL_THRESHOLD_BYTES;

// ── 3a. hqf 热推（默认路径）──
// 协议自实现（changedFileList/buildConfig 输入格式逆向自 devecocli，出处见头注）：
// ①把变更清单写入 hvigor PrepareQuickfix 的约定位置（<module>/build/<product>/
//   intermediates/patch/default/changedFileList.json，resfile 文件归 resources.resFile）；
// ②hvigor assembleDevHqf 生成签名 hqf（签名走 build-profile 材料，与 SignHap 同源，
//   CLT hvigor 即可，无需 Studio）；
// ③hdc 停应用 → file send → `bm quickfix -a -f <hqf> -d -o` → 重启（-o 为 API>17
//   参数，本工程 compatibleSdkVersion 6.0.2(22) 恒满足）。任一步失败回退全量，
//   保证结果正确。
function applyPath() {
  if (changed.length === 0) {
    log("apply", "无变更——设备已是最新（如需强制装机用 --full）");
    return;
  }
  const run = (command, commandArgs, options = {}) => {
    const result = spawnSync(command, commandArgs, { stdio: "inherit", ...options });
    return result.status === 0;
  };

  // ① 编译配置 + 变更清单（格式逆向自 devecocli）：buildConfig.json 指向上一轮
  //    编译中间产物，changedFileList 是本轮补丁内容（只重写不合并，diff 即唯一事实源）。
  const moduleDir = join(ohosRoot, "electron");
  const buildDir = join(moduleDir, "build", "default");
  const intermediates = join(buildDir, "intermediates");
  const loaderOut = join(intermediates, "loader_out", "default");
  const resDir = join(intermediates, "res", "default");
  const buildConfigPath = join(moduleDir, "build", "config", "buildConfig.json");
  mkdirSync(dirname(buildConfigPath), { recursive: true });
  writeFileSync(
    buildConfigPath,
    JSON.stringify(
      {
        compileConfig: {
          deviceType: "default",
          buildMode: "debug",
          compilerType: "ark",
          note: "false",
          logLevel: "3",
          hapMode: "false",
          img2bin: "true",
          Path: `${join(cltRoot, "tool", "node", "bin")}${sep}`,
          projectProfilePath: join(ohosRoot, "build-profile.json5"),
          localPropertiesPath: join(ohosRoot, "local.properties"),
          appResource: join(resDir, "ResourceTable.txt"),
          cachePath: join(
            buildDir,
            "cache",
            "default",
            "default@CompileArkTS",
            "esmodule",
            "debug",
          ),
          aceBuildJson: join(intermediates, "loader", "default", "loader.json"),
          aceModuleJsonPath: join(resDir, "module.json"),
          aceSoPath: join(loaderOut, "nativeDependencies.txt"),
          aceModuleRoot: join(moduleDir, "src", "main", "ets"),
          aceModuleBuild: join(loaderOut, "ets"),
          aceProfilePath: join(resDir, "resources", "base", "profile"),
          aceSuperVisualPath: join(moduleDir, "src", "main", "supervisual"),
          watchMode: "true",
        },
        patchConfig: {
          enableMap: "true",
          mode: "hotReload",
          oldMapFilePath: join(loaderOut, "ets"),
          changedFileList: join(intermediates, "patch", "default", "changedFileList.json"),
          patchAbcPath: join(intermediates, "patch", "default", "ets"),
          removeChangedFileListInSdk: "true",
        },
      },
      null,
      2,
    ),
  );
  const patchList = join(intermediates, "patch", "default", "changedFileList.json");
  mkdirSync(dirname(patchList), { recursive: true });
  // resFile 条目为 {filePath, resourcePath} 对象（hvigor 按二者相对路径展开为
  // hqf 内的 resfile/ 布局）。
  const resourceRoot = join(ohosRoot, "web_engine/src/main/resources");
  writeFileSync(
    patchList,
    JSON.stringify({
      resources: {
        resFile: changed.map((rel) => ({
          filePath: join(ohosRoot, rel),
          resourcePath: resourceRoot,
        })),
        rawFile: [],
      },
      modifiedFiles: [],
    }),
  );
  // ColdReloadArkTS 读 hotReload 清单的 modifiedFilesV2（无 ets 改动时须为空数组，
  // 缺失该文件会 undefined.map 崩溃）。
  const hotReloadList = join(intermediates, "hotReload", "changedFileList.json");
  mkdirSync(dirname(hotReloadList), { recursive: true });
  writeFileSync(hotReloadList, JSON.stringify({ modifiedFilesV2: [] }, null, 2));

  // ② 生成签名 hqf
  log("apply", `hvigor assembleDevHqf（${changed.length} 个文件）`);
  const hqfBuilt = run(
    hvigorw,
    [
      "--mode",
      "module",
      "-p",
      "module=electron@default",
      "-p",
      "product=default",
      "-p",
      "debuggable=true",
      "assembleDevHqf",
      "--analyze=normal",
      "--parallel",
      "--incremental",
      "--no-daemon",
    ],
    { cwd: ohosRoot },
  );
  const hqf = join(ohosRoot, "electron/build/default/outputs/default/electron-default-signed.hqf");
  if (!hqfBuilt || !existsSync(hqf)) {
    log("apply", "hqf 生成失败（看上方输出），回退全量");
    fullPath();
    return;
  }

  // ③ quickfix 安装 + 重启（stop → install → launch）
  log("apply", `bm quickfix → ${serial}`);
  runHdc(["-t", serial, "shell", "aa force-stop ai.ohpc.zcode"], false);
  const devicePath = `/data/local/tmp/zcode-dev-${Date.now()}.hqf`;
  const pushed = runHdc(["-t", serial, "file", "send", hqf, devicePath], false);
  const installed =
    pushed && runHdc(["-t", serial, "shell", "bm", "quickfix", "-a", "-f", devicePath, "-d", "-o"]);
  runHdc(["-t", serial, "shell", "rm", "-f", devicePath], false);
  if (!installed) {
    log("apply", "quickfix 安装失败（常见原因：无签名材料/设备不支持），回退全量");
    fullPath();
    return;
  }
  runHdc(["-t", serial, "shell", "aa start -a EntryAbility -b ai.ohpc.zcode"]);
  log("apply", "hqf 热推完成（应用已重启）");
}

// ── 3b. 全量装机（首次 / 大变更 / 删除 / --full）──
function fullPath() {
  // 与 bundle-ohos.mjs 相同的清缓存策略：hvigor 增量不感知 resfile 变化。
  for (const cache of [
    join(ohosRoot, ".hvigor"),
    join(ohosRoot, "electron/build"),
    join(ohosRoot, "web_engine/build"),
  ]) {
    rmSync(cache, { recursive: true, force: true });
  }
  log("full", "hvigorw assembleHap（已清缓存，正确性优先）");
  const hvigorResult = spawnSync(
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
    fail("hvigor assembleHap 失败（看上方输出）。");
  }
  // 装机 + 启动（纯 hdc，手动流程见 specs/ohos-port/README.md；签名版优先，缺失时退未签名）。
  const outputs = join(ohosRoot, "electron/build/default/outputs/default");
  const hap = existsSync(join(outputs, "electron-default-signed.hap"))
    ? join(outputs, "electron-default-signed.hap")
    : join(outputs, "electron-default-unsigned.hap");
  log("full", `hdc install -r + aa start → ${serial}（${hap.split("/").pop()}）`);
  runHdc(["-t", serial, "shell", "aa force-stop ai.ohpc.zcode"], false);
  const installed = runHdc(["-t", serial, "install", "-r", hap]);
  if (!installed) {
    fail("hdc install 失败（看上方输出）。");
  }
  runHdc(["-t", serial, "shell", "aa start -a EntryAbility -b ai.ohpc.zcode"]);
}

if (needsFull) {
  fullPath();
} else {
  applyPath();
}

// ── 4. 成功后落基线（ohos/build/ 不在 hvigor 清理清单内，可持久保存）──
mkdirSync(join(ohosRoot, "build"), { recursive: true });
writeFileSync(baselinePath, `${JSON.stringify(Object.fromEntries(manifest))}\n`);
log(
  "done",
  `基线已更新（${manifest.size} 文件），耗时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s`,
);
