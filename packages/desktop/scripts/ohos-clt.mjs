#!/usr/bin/env node
// command-line-tools 的跨平台获取入口：三平台同一套开发者流程——
// `pnpm install` 之后直接 `pnpm ohos:run` / `pnpm ohos:bundle`，
// 首次 OHOS 构建时按需下载到 packages/desktop/.cache/ohos-clt/（.gitignore 已覆盖 .cache）。
//
// 优先级：DEVECO_CLI_CLT_PATH 或 PATH 反推（CI、已装 DevEco 的机器）> 项目缓存 > 自动下载。
// 下载源与 CI 相同（GitCode ohos-tools Release v26.0 官方原包分卷），逐分卷校验 sha256 后合并解压，
// 与 fetch-ohos-runtime.mjs / ohos-native-deps.mjs 同一套路：下载物不入库，取回方式可复现。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  persistOhosDotEnvValue,
  resolveCltTool,
  resolveCommandLineToolsRoot,
} from "./ohos-env.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");

export const OHOS_CLT_CACHE_ROOT = join(desktopRoot, ".cache", "ohos-clt");

// 缓存落在仓库内，而仓库根 package.json 是 `"type": "module"`；CLT 的 hvigorw.js / pm-cli.js
// 是 CJS，Node 会按最近的 package.json 决定模块类型，于是把它们当 ESM 解析并报
// `require is not defined in ES module scope`。在缓存版本目录写一层 CJS 标记即可，
// 不碰解压出来的 CLT 本体（避免影响其自身脚本对包布局的假设）。
const CLI_CACHE_MANIFEST = Object.freeze({
  name: "ohos-clt-cache",
  private: true,
  type: "commonjs",
});

function writeCommonJsMarker(versionDir) {
  const manifestPath = join(versionDir, "package.json");
  if (existsSync(manifestPath)) return;
  writeFileSync(manifestPath, `${JSON.stringify(CLI_CACHE_MANIFEST, null, 2)}\n`, "utf8");
}

const RELEASE_BASE = "https://gitcode.com/yuanbaobaoo/ohos-tools/releases/download/v26.0";

// 分卷与 sha256 取自该 Release 的资产摘要。统一用“有序分卷列表”表达，单卷包就是长度 1。
const CLT_ARCHIVES = Object.freeze({
  "win32-x64": {
    version: "26.0.0.865",
    approxBytes: 2.72 * 1024 ** 3,
    parts: [
      {
        name: "commandline-tools-windows-x64-26.0.0.865.zip.part1",
        sha256: "3cf0d00bdafde304893be377a62b120abfca85804e2d1b3dc8d03a8400e63858",
      },
      {
        name: "commandline-tools-windows-x64-26.0.0.865.zip.part2",
        sha256: "c3193ef0519ccf41fcef2d5ff1805692988aa42e593348e58142e1bb2dfb560e",
      },
    ],
  },
  "linux-x64": {
    version: "26.0.0.851",
    approxBytes: 2.35 * 1024 ** 3,
    parts: [
      {
        name: "commandline-tools-linux-x64-26.0.0.851.zip.part1",
        sha256: "c57ebdd4850bbd1eb4744da661e58c0e3fed5c492fdd2aa35c4d91edd22166d7",
      },
      {
        name: "commandline-tools-linux-x64-26.0.0.851.zip.part2",
        sha256: "830ae286a66d89a43f7a88504ffab4c13317b72e29efb15bbc722b4ce16f2837",
      },
    ],
  },
  "darwin-arm64": {
    version: "26.0.0.865",
    approxBytes: 2.14 * 1024 ** 3,
    parts: [
      {
        name: "commandline-tools-mac-arm64-26.0.0.865.zip.part1",
        sha256: "cec2f76626ac50302317d62d7cd4ceb232898eecbecd2e072c94688965dc645b",
      },
      {
        name: "commandline-tools-mac-arm64-26.0.0.865.zip.part2",
        sha256: "31be5940d1a02d03b87720ab4352d03c27a7395398838dc336ee68b758f0ed80",
      },
    ],
  },
});

function log(message) {
  console.log(`[ohos-clt] ${message}`);
}

export function cltArchivePlan({ platform = process.platform, arch = process.arch } = {}) {
  const key = `${platform}-${arch}`;
  const plan = CLT_ARCHIVES[key];
  return plan
    ? { key, version: plan.version, approxBytes: plan.approxBytes, parts: plan.parts }
    : null;
}

// 缓存里任何已解压的完整 CLT 都可用（不绑定具体版本号，便于换包后平滑过渡）。
export function findCachedCommandLineTools({
  cacheRoot = OHOS_CLT_CACHE_ROOT,
  platform = process.platform,
} = {}) {
  if (!existsSync(cacheRoot)) return null;
  for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(cacheRoot, entry.name, "command-line-tools");
    if (resolveCltTool(candidate, "hvigorw", platform)) return candidate;
  }
  return null;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function downloadPart(url, dest, label) {
  log(`下载 ${label}…`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`下载失败 HTTP ${response.status}：${url}`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  let lastReportMb = 0;
  const body = Readable.fromWeb(response.body);
  body.on("data", (chunk) => {
    received += chunk.length;
    const mb = Math.floor(received / (128 * 1024 * 1024));
    if (mb > lastReportMb) {
      lastReportMb = mb;
      log(
        `  ${(received / 1024 / 1024).toFixed(0)}${total > 0 ? `/${(total / 1024 / 1024).toFixed(0)}` : ""}MB`,
      );
    }
  });
  const tempPath = `${dest}.tmp`;
  await pipeline(body, createWriteStream(tempPath));
  renameSync(tempPath, dest);
}

// 分卷是字节级拼接（CI 用 `cat` / `copy /b`）；按顺序流式追写，避免把 2GB 读进内存。
async function joinParts(partPaths, joinedPath) {
  rmSync(joinedPath, { force: true });
  copyFileSync(partPaths[0], joinedPath);
  for (const part of partPaths.slice(1)) {
    await pipeline(createReadStream(part), createWriteStream(joinedPath, { flags: "a" }));
  }
}

// Windows 自带 bsdtar 能读 zip；POSIX 用 unzip（CI/macOS 均自带）。
function extractArchiveTo(archivePath, workDir) {
  const toArg = (value) => (process.platform === "win32" ? value.replaceAll("\\", "/") : value);
  const [command, args] =
    process.platform === "win32"
      ? ["tar", ["-xf", toArg(archivePath), "-C", toArg(workDir)]]
      : ["unzip", ["-o", "-q", archivePath, "-d", workDir]];
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `解压 command-line-tools 失败（${command}，退出码 ${result.status ?? result.error?.message}）`,
    );
  }
}

// 构建期只做发现：找不到就报错并指向 ohos:setup，绝不在构建里下载 2GB 工具链
// （下载的唯一入口是 `pnpm ohos:setup`，即本模块 ensureCommandLineTools 的唯一调用方）。
export function requireCommandLineTools({
  platform = process.platform,
  discover = () => resolveCommandLineToolsRoot(process.env, platform),
  cached = () => findCachedCommandLineTools({ platform }),
} = {}) {
  const discovered = discover();
  if (discovered) return { root: discovered, origin: "existing" };
  const cachedRoot = cached();
  if (cachedRoot) return { root: cachedRoot, origin: "cache" };
  throw new Error(
    "未找到 OHOS command-line-tools（hvigorw）。先运行 pnpm ohos:setup 获取（约 2.1–2.7GB），" +
      "或自行下载后把根目录写进 .env 的 DEVECO_CLI_CLT_PATH（也可以把 bin/ 加进 PATH）。",
  );
}

export async function ensureCommandLineTools({
  platform = process.platform,
  arch = process.arch,
  cacheRoot = OHOS_CLT_CACHE_ROOT,
  discover = () => resolveCommandLineToolsRoot(),
  plan = cltArchivePlan({ platform, arch }),
  downloadPartImpl = downloadPart,
  joinPartsImpl = joinParts,
  extractImpl,
  persistImpl = persistOhosDotEnvValue,
  log: logFn = log,
  // 显式配置（CI 的 workflow 变量、用户 export 或 .env 已有值）优先，且不回写 .env。
  // 允许注入：用例不该被宿主 ambient env 影响（开发机通常 export 了它）。
  explicitConfig = Boolean(process.env.DEVECO_CLI_CLT_PATH?.trim()),
} = {}) {
  const hadExplicitConfig = explicitConfig;

  const finish = (root, origin) => {
    // .env 是 CLT 路径的唯一落盘处：解析/下载到之后回写，后续命令直接从 .env 读，
    // 不再依赖 PATH 或缓存探测。显式配置存在时保持原样，避免改写用户/CI 的选择。
    if (!hadExplicitConfig) {
      try {
        persistImpl("DEVECO_CLI_CLT_PATH", root);
        logFn(`已把 CLT 路径写入 .env：${root}`);
      } catch (error) {
        logFn(
          `写入 .env 失败（忽略，本次仍可用）：${error instanceof Error ? error.message : error}`,
        );
      }
    }
    return { root, origin };
  };

  // 1) 已装好的 CLT（DEVECO_CLI_CLT_PATH / PATH）优先：CI 与已装 DevEco 的机器零下载。
  const discovered = discover();
  if (discovered) return finish(discovered, "existing");

  // 2) 项目缓存。
  const cached = findCachedCommandLineTools({ cacheRoot, platform });
  if (cached) {
    // 旧缓存可能没有 CJS 标记（升级前下载的包），这里补齐，保证 hvigorw.js 能按 CJS 加载。
    writeCommonJsMarker(dirname(cached));
    logFn(`复用缓存的 command-line-tools：${cached}`);
    return finish(cached, "cache");
  }

  // 3) 自动下载。没有对应平台资产时给出明确的人工安装指引。
  if (!plan) {
    throw new Error(
      `没有 ${platform}-${arch} 的 command-line-tools 自动获取源。请手动安装 CLT，` +
        "并把 DEVECO_CLI_CLT_PATH 指向其根目录（可写仓库根 .env）或把 bin/ 加入 PATH。",
    );
  }

  const versionDir = join(cacheRoot, plan.version);
  const archivesDir = join(versionDir, ".archives");
  mkdirSync(archivesDir, { recursive: true });
  logFn(
    `首次在 ${plan.key} 上构建：下载 command-line-tools ${plan.version}（约 ` +
      `${Math.round(plan.approxBytes / 1024 ** 3)}GB），缓存到 ${versionDir}`,
  );

  const partPaths = [];
  for (const part of plan.parts) {
    const partPath = join(archivesDir, part.name);
    await downloadPartImpl(`${RELEASE_BASE}/${part.name}`, partPath, part.name);
    const actual = sha256File(partPath);
    if (actual !== part.sha256) {
      rmSync(partPath, { force: true });
      throw new Error(
        `${part.name} sha256 不匹配：期望 ${part.sha256}，实得 ${actual}（镜像内容被换？）`,
      );
    }
    partPaths.push(partPath);
  }

  const joinedPath = join(archivesDir, "commandline-tools.zip");
  try {
    await joinPartsImpl(partPaths, joinedPath);
    (extractImpl ?? extractArchiveTo)(joinedPath, versionDir);
  } finally {
    rmSync(archivesDir, { recursive: true, force: true });
  }

  const root = join(versionDir, "command-line-tools");
  if (!resolveCltTool(root, "hvigorw", platform)) {
    throw new Error(`解压后未找到 command-line-tools/bin/hvigorw：${root}`);
  }
  writeCommonJsMarker(versionDir);
  logFn(`command-line-tools 已就绪：${root}`);
  return finish(root, "download");
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  const { root, origin } = await ensureCommandLineTools();
  console.log(`[ohos-clt] root=${root} origin=${origin}`);
}
