#!/usr/bin/env node
// OHOS 快速迭代环：resfile 重组 → 全量 HAP 装机到 hdc 可见的所有设备（默认，~30s）。
// 显式 --hqf 才走增量热推（变更 → 签名 hqf → quickfix 装入运行中应用 → 重启，~8s）。
// 真机实证细节（hqf 协议、hvigor 增量盲区）见 specs/ohos-port/01-构建与打包.md。

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
import { applyOhosDotEnv, resolveCltHdc, resolveCltTool, spawnCltTool } from "./ohos-env.mjs";
import { requireCommandLineTools } from "./ohos-clt.mjs";
import { devBundleNameFrom, ensureDevSigning } from "./ohos-dev-identity.mjs";
import { ensureOhosAppJson5, readOhosBundleName } from "./ohos-version.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const ohosRoot = join(desktopRoot, "ohos");
const scanRoot = join(ohosRoot, "web_engine/src/main/resources/resfile/resources");
// 基线放在 ohos/build/（gitignore 已覆盖）：.hvigor/ 与模块 build/ 会被全量路径清理，
// 不能存状态。
// 基线按包名分文件：开发身份与正式身份各自独立，互不影响零变更早退。
const baselinePath = (bundleName) => join(ohosRoot, `build/zcode-dev-baseline-${bundleName}.json`);
// hqf 补丁规模阈值：超出走全量（quickfix 面向小步快跑，大变更整包更可靠）。
const FULL_THRESHOLD_FILES = 200;
const FULL_THRESHOLD_BYTES = 50 * 1024 * 1024;
// 应用包名从 AppScope/app.template.json5 派生开发身份（唯一来源 + .dev），hdc 命令
// （bm dump / aa force-stop / aa start）不再各自抄字面量。dev:ohos 只操作开发包，
// 正式包由 bundle:desktop:ohos 维护；两者同机共存（specs/ohos-port/19）。
const RELEASE_BUNDLE_NAME = readOhosBundleName(ohosRoot);
const OHOS_BUNDLE_NAME = devBundleNameFrom(RELEASE_BUNDLE_NAME);

const args = new Set(process.argv.slice(2));
const device = (() => {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("--device");
  return index !== -1 ? argv[index + 1] : undefined;
})();
const withBuild = args.has("--build");
const withAgent = args.has("--agent");
// --resign：强制重新生成 dev 调试签名（权限/ACL 变更或 profile 异常时用）。
const resign = args.has("--resign");
// 默认全量覆盖所有设备；--hqf 显式选择单设备增量热推。
const useHqf = args.has("--hqf");

function log(step, message) {
  console.log(`[dev:ohos] ${step}: ${message}`);
}

function fail(message) {
  console.error(`[dev:ohos] ERROR: ${message}`);
  process.exit(1);
}

// 工具链变量可来自仓库根 .env/.env.local（白名单见 ohos-env.mjs；真实环境变量优先），
// 必须在 CLT 解析之前应用。CLT 只做发现（已装 > 项目缓存），缺了报错指向 install:ohos ——
// 构建期不下载工具链，与 bundle:desktop:ohos 同一条链。
await applyOhosDotEnv();

let cltInfo;
try {
  cltInfo = requireCommandLineTools();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const cltRoot = cltInfo.root;
process.env.DEVECO_CLI_CLT_PATH ??= cltRoot;
const hvigorw = resolveCltTool(cltRoot, "hvigorw");
if (!hvigorw) {
  fail(`command-line-tools 缺少 hvigorw 入口：${cltRoot}`);
}
// CLT 内 hdc 的固定相对位置（POSIX 是 toolchains/hdc，Windows 是 toolchains/hdc.exe）；
// 布局异常时提前报错，避免装机环节才炸。
const hdc = resolveCltHdc(cltRoot);
if (!hdc) {
  fail(
    `hdc 不在 CLT 预期位置（${join(cltRoot, "sdk/default/openharmony/toolchains")}）——command-line-tools 安装不完整，请重装。`,
  );
}

// 默认部署到 hdc 可见的全部设备；--device <sn> 收窄到单台。
function resolveDeviceSerials() {
  const result = spawnSync(hdc, ["list", "targets"], { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) return [];
  const targets = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("["));
  return device ? targets.filter((target) => target === device) : targets;
}
const devices = resolveDeviceSerials();
if (devices.length === 0) {
  fail(
    device
      ? `--device ${device} 不在 hdc list targets 中。`
      : "hdc list targets 为空——没有可用设备。",
  );
}
if (useHqf && devices.length > 1) {
  fail("hqf 热推一次只支持一台设备——用 --device 指定，或去掉 --hqf 走默认全量。");
}
const serial = devices[0];

// dev 身份前置：补齐本机 build-profile 的 dev product/target，并在签名不可用时生成
// dev 调试签名（devecocli 只认 AppScope/app.json5 的 bundleName，函数内部临时改写再还原）。
ensureDevSigning({
  ohosRoot,
  hdcPath: hdc,
  serials: devices,
  force: resign,
  log: (message) => log("sign", message),
});

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
  const path = baselinePath(OHOS_BUNDLE_NAME);
  if (!existsSync(path)) return null;
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(path, "utf8"))));
  } catch {
    return null;
  }
}

// 应用是否仍安装在本机基线对应的设备上：基线只记录 resfile 哈希，不感知卸载，
// 「零变更」早退会把已卸载的设备误判为最新（实证：卸载后 dev:ohos 不装也不启动）。
// bm dump 对未装应用退出码可能仍为 0，按输出内容判断。
// 应用是否仍安装在指定设备上：仅 hqf 路径需要（基线只记录 resfile 哈希，不感知卸载，
// 「零变更」早退会把已卸载的设备误判为最新）。bm dump 对未装应用退出码可能仍为
// 0，按输出内容判断。
function isAppInstalled(targetSerial) {
  const result = spawnSync(
    hdc,
    ["-t", targetSerial, "shell", "bm", "dump", "-n", OHOS_BUNDLE_NAME],
    {
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  // 正式包名是开发包名的前缀（…zcode ⊂ …zcode.dev），不能用 includes。
  const escaped = OHOS_BUNDLE_NAME.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    result.status === 0 &&
    new RegExp(`"bundleName"\\s*:\\s*"${escaped}"`, "u").test(result.stdout ?? "")
  );
}

const startedAt = Date.now();

// ── 1. resfile 重组（out/ 需已构建；--build 连生产构建一起跑）──
const buildArgs = ["--dev-identity"];
if (!withBuild) buildArgs.push("--skip-build");
// --build 语义 = 全量闭环：必须连带 agent CLI 包（resources/glm/zcode.cjs）。它默认从
// bundled-agents 产物 stage，漏 rebuild 会把 apps/zcode-cli 的改动静默回退出包
// （官方插件会整体消失）。--agent 仍可单独给 CLI 快速迭代用。
if (!withAgent && !withBuild) buildArgs.push("--skip-agent");
log("stage", `build-ohos.mjs ${buildArgs.join(" ") || "(full)"}`);
const buildResult = spawnSync(process.execPath, ["scripts/build-ohos.mjs", ...buildArgs], {
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
  fail("build-ohos.mjs 失败（看上方输出）。");
}

// ── 2. 变更检测（仅 --hqf 增量路径消费；基线落盘供下轮 hqf 使用）──
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
  log(
    "scan",
    `${manifest.size} 个文件，${changed.length} 处变更，${removed} 处删除` +
      (churned > 0 ? `（另 ${churned} 个 tsup chunk 换名按孤儿豁免）` : ""),
  );
} else {
  log("scan", `${manifest.size} 个文件；无基线`);
}

// hqf 路径的回退条件（默认路径不走增量，短路避免多余的设备探测）。
const hqfNeedsFull =
  !useHqf ||
  !baseline ||
  !isAppInstalled(serial) ||
  removed > 0 ||
  changed.length > FULL_THRESHOLD_FILES ||
  changed.reduce((total, rel) => total + statSync(join(ohosRoot, rel)).size, 0) >
    FULL_THRESHOLD_BYTES;

// ── 3a. hqf 热推（--hqf 显式选择）──
// hqf 协议自实现（格式逆向自 devecocli，出处见头注）：变更清单写 PrepareQuickfix 约定位置
// → assembleDevHqf 出签名 hqf → hdc bm quickfix 应用 → 重启；任一步失败回退全量装机。
function applyPath() {
  if (changed.length === 0) {
    log("apply", "无变更——设备已是最新（要强制装机去掉 --hqf）");
    return;
  }
  const run = (command, commandArgs, options = {}) => {
    // Windows 下 hvigorw 是 .bat，必须经 cmd.exe，见 ohos-env.mjs 的 spawnCltTool。
    const result = spawnCltTool(command, commandArgs, { stdio: "inherit", ...options });
    return result.status === 0;
  };

  // ① 编译配置 + 变更清单（格式逆向自 devecocli）：buildConfig.json 指向上一轮
  //    编译中间产物，changedFileList 是本轮补丁内容（只重写不合并，diff 即唯一事实源）。
  const moduleDir = join(ohosRoot, "entry");
  const buildDir = join(moduleDir, "build", "dev");
  const intermediates = join(buildDir, "intermediates");
  const loaderOut = join(intermediates, "loader_out", "dev");
  const resDir = join(intermediates, "res", "dev");
  const buildConfigPath = join(moduleDir, "build", "config", "buildConfig.json");
  mkdirSync(dirname(buildConfigPath), { recursive: true });
  writeFileSync(
    buildConfigPath,
    JSON.stringify(
      {
        compileConfig: {
          // deviceType 是 devecocli 的固定字面量，不是 target 名。
          deviceType: "default",
          buildMode: "debug",
          compilerType: "ark",
          note: "false",
          logLevel: "3",
          hapMode: "false",
          img2bin: "true",
          // Windows 的 CLT 只带 tool/node/node.exe（POSIX 在 tool/node/bin 下）。
          Path: `${join(cltRoot, "tool", "node", ...(process.platform === "win32" ? [] : ["bin"]))}${sep}`,
          projectProfilePath: join(ohosRoot, "build-profile.json5"),
          localPropertiesPath: join(ohosRoot, "local.properties"),
          appResource: join(resDir, "ResourceTable.txt"),
          cachePath: join(buildDir, "cache", "dev", "dev@CompileArkTS", "esmodule", "debug"),
          aceBuildJson: join(intermediates, "loader", "dev", "loader.json"),
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
          changedFileList: join(intermediates, "patch", "dev", "changedFileList.json"),
          patchAbcPath: join(intermediates, "patch", "dev", "ets"),
          removeChangedFileListInSdk: "true",
        },
      },
      null,
      2,
    ),
  );
  const patchList = join(intermediates, "patch", "dev", "changedFileList.json");
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
      "module=electron@dev",
      "-p",
      "product=dev",
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
  const hqf = join(ohosRoot, "entry/build/dev/outputs/dev/electron-dev-signed.hqf");
  if (!hqfBuilt || !existsSync(hqf)) {
    log("apply", "hqf 生成失败（看上方输出），回退全量");
    fullPath();
    return;
  }

  // ③ quickfix 安装 + 重启（stop → install → launch）
  log("apply", `bm quickfix → ${serial}`);
  runHdc(["-t", serial, "shell", `aa force-stop ${OHOS_BUNDLE_NAME}`], false);
  const devicePath = `/data/local/tmp/zcode-dev-${Date.now()}.hqf`;
  const pushed = runHdc(["-t", serial, "file", "send", hqf, devicePath], false);
  // 设备在 quickfix 部署失败时仍可能返回 0（实测输出 "apply quickfix failed"），
  // 只看退出码会把失败当成功、既不重启也不回退全量；按输出内容判定。
  const quickfix = pushed
    ? spawnSync(
        hdc,
        ["-t", serial, "shell", "bm", "quickfix", "-a", "-f", devicePath, "-d", "-o"],
        { encoding: "utf8", stdio: "pipe" },
      )
    : null;
  const quickfixOutput = `${quickfix?.stdout ?? ""}${quickfix?.stderr ?? ""}`;
  if (quickfixOutput) process.stdout.write(quickfixOutput);
  const installed = Boolean(quickfix) && quickfix.status === 0 && !/fail/iu.test(quickfixOutput);
  runHdc(["-t", serial, "shell", "rm", "-f", devicePath], false);
  if (!installed) {
    log("apply", "quickfix 安装失败（常见原因：无签名材料/设备不支持），回退全量");
    fullPath();
    return;
  }
  runHdc(["-t", serial, "shell", `aa start -a EntryAbility -b ${OHOS_BUNDLE_NAME}`]);
  log("apply", "hqf 热推完成（应用已重启）");
}

// ── 3b. 全量装机（默认路径：无论是否已安装，一律用本次 dev 构建覆盖所有目标设备）──
function fullPath() {
  // 与 bundle-ohos.mjs 相同的清缓存策略：hvigor 增量不感知 resfile 变化。
  for (const cache of [
    join(ohosRoot, ".hvigor"),
    join(ohosRoot, "entry/build"),
    join(ohosRoot, "web_engine/build"),
  ]) {
    rmSync(cache, { recursive: true, force: true });
  }
  // 开发态装机版本固定 0.0.0-dev / 大 versionCode，见 specs/ohos-port/04-版本与更新.md。
  ensureOhosAppJson5(ohosRoot, { log: (message) => log("full", message) });
  log("full", "hvigorw assembleHap（已清缓存，正确性优先）");
  const hvigorResult = spawnCltTool(
    hvigorw,
    [
      "assembleHap",
      "--mode",
      "module",
      "-p",
      "product=dev",
      "-p",
      "buildMode=debug",
      "--no-daemon",
    ],
    { cwd: ohosRoot, stdio: "inherit" },
  );
  if (hvigorResult.status !== 0) {
    fail("hvigor assembleHap 失败（看上方输出）。");
  }
  // 装机 + 启动（纯 hdc，手动流程见 specs/ohos-port/README.md）。dev 装机必须签名：
  // 未签名 HAP 装不上，静默退未签名只会把问题推迟到 install 阶段，这里提前报可行动错误。
  // HAP 只打一次，逐台覆盖；单台失败不阻断其余设备，最后汇总报错。
  const outputs = join(ohosRoot, "entry/build/dev/outputs/dev");
  const hap = join(outputs, "electron-dev-signed.hap");
  if (!existsSync(hap)) {
    fail(
      "未产出签名的 dev HAP：确认 devecocli 已登录且设备已连接；" +
        "签名材料异常时加 --resign 重新生成（specs/ohos-port/19）。",
    );
  }
  const failedDevices = [];
  for (const target of devices) {
    log("full", `hdc install -r + aa start → ${target}（${hap.split("/").pop()}）`);
    runHdc(["-t", target, "shell", `aa force-stop ${OHOS_BUNDLE_NAME}`], false);
    if (!runHdc(["-t", target, "install", "-r", hap])) {
      failedDevices.push(target);
      continue;
    }
    runHdc(["-t", target, "shell", `aa start -a EntryAbility -b ${OHOS_BUNDLE_NAME}`]);
  }
  if (failedDevices.length > 0) {
    fail(`hdc install 失败的设备：${failedDevices.join(", ")}（看上方输出）。`);
  }
}

if (!useHqf) {
  fullPath();
} else if (hqfNeedsFull) {
  log("apply", "增量条件不满足（无基线/应用未安装/有删除/超阈值），本次走全量");
  fullPath();
} else {
  applyPath();
}

// ── 4. 成功后落基线（ohos/build/ 不在 hvigor 清理清单内，可持久保存）──
mkdirSync(join(ohosRoot, "build"), { recursive: true });
writeFileSync(baselinePath(OHOS_BUNDLE_NAME), `${JSON.stringify(Object.fromEntries(manifest))}\n`);
log(
  "done",
  `基线已更新（${manifest.size} 文件），耗时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s`,
);
