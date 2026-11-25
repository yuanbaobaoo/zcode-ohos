#!/usr/bin/env node
// OHOS 原生编译输入（Node 头文件 / sqlite 融合源）的项目内缓存与自动获取。
//
// 为什么需要它：三个 native 产物要编译，但这两样输入仓库不收录——sqlite3.c 被
// native/ohos-zcode-sqlite/.gitignore 排除，node_api.h 属于本机 Node 安装内容。过去靠
// shell 变量 NODE_INCLUDE 和位置参数传路径，而 `pnpm ohos:bundle` 没法表达这些，
// 只能手工准备。现在统一落到 packages/desktop/.cache/ohos-native/（仓库 .gitignore 里
// 的 `.cache` 规则已覆盖），缺失时按 sha256 校验后自动下载，缓存命中即跳过。思路与
// fetch-ohos-runtime.mjs 一致：下载物永远不入库，但取回方式是可复现的。
//
// 用法：node packages/desktop/scripts/ohos-native-deps.mjs   # 预热缓存并打印两个路径

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, posix, resolve, win32 } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(import.meta.dirname, "..");
const sqliteNativeDir = join(desktopRoot, "native", "ohos-zcode-sqlite");

export const OHOS_NATIVE_CACHE_ROOT = join(desktopRoot, ".cache", "ohos-native");

// sqlite 官方融合源（与 CI 同一版本）；zip 哈希锁定，换版本必须同步改这里与 CI。
const SQLITE_AMALGAMATION = Object.freeze({
  version: "3530400",
  archiveSha256: "1e71ddf93849c6a6ecf58b827c0692073d2dd7ee40196158068f7b29f422e87d",
  url: "https://sqlite.org/2026/sqlite-amalgamation-3530400.zip",
});

// Node 头文件必须与运行构建的 Node 主版本一致（NAPI ABI 稳定，但仍取本机版本最稳）。
// 先国内镜像，失败再退官方 dist；两者都用官方 SHASUMS256.txt 校验。
const NODE_HEADER_BASES = ["https://npmmirror.com/mirrors/node", "https://nodejs.org/dist"];

function log(message) {
  console.log(`[ohos-native-deps] ${message}`);
}

// 传入的路径串可能来自另一个平台（例如用例给 Windows 字符串），因此按 platform 选路径实现，
// 不能跟随宿主，否则纯函数在 POSIX 上测不出 Windows 行为。
function pathForPlatform(platform) {
  return platform === "win32" ? win32 : posix;
}

export function nodeHeadersCacheDir({
  version = process.versions.node,
  cacheRoot = OHOS_NATIVE_CACHE_ROOT,
  platform = process.platform,
} = {}) {
  return pathForPlatform(platform).join(cacheRoot, "node-headers", `node-v${version}`);
}

export function sqliteCacheDir({ cacheRoot = OHOS_NATIVE_CACHE_ROOT } = {}) {
  return join(cacheRoot, "sqlite-amalgamation-3530400");
}

function hasNodeApiHeader(dir) {
  return Boolean(dir) && existsSync(join(dir, "node_api.h"));
}

// 头文件候选顺序：本机 Node 安装（官方安装包/nvm 完整包都带） > 项目缓存。
// Windows 的 node.exe 在安装根目录（<root>/include/node），POSIX 在 bin/ 下
// （<prefix>/include/node），两边都要覆盖。
export function nodeHeadersCandidateDirs({
  execPath = process.execPath,
  platform = process.platform,
  version = process.versions.node,
  cacheRoot = OHOS_NATIVE_CACHE_ROOT,
} = {}) {
  const path = pathForPlatform(platform);
  const nodeDir = path.dirname(execPath);
  const installed =
    platform === "win32"
      ? [path.join(nodeDir, "include", "node"), path.resolve(nodeDir, "..", "include", "node")]
      : [path.resolve(nodeDir, "..", "include", "node"), path.join(nodeDir, "include", "node")];
  const cacheDir = nodeHeadersCacheDir({ version, cacheRoot, platform });
  return [...installed, path.join(cacheDir, "include", "node")];
}

// sqlite 融合源候选顺序：native 目录里已有的（历史手工放置/上次 staging 的拷贝） > 项目缓存。
export function sqliteSourceCandidates({
  workDir = sqliteNativeDir,
  cacheRoot = OHOS_NATIVE_CACHE_ROOT,
} = {}) {
  return [workDir, sqliteCacheDir({ cacheRoot })];
}

// 归档只有几 MB，同步读一次算哈希比流式实现更直观。
function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function downloadToFile(url, dest) {
  log(`下载 ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`下载失败 HTTP ${response.status}：${url}`);
  }
  const tempPath = `${dest}.tmp`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));
  renameSync(tempPath, dest);
}

async function fetchExpectedSha256(shasumsUrl, fileName) {
  const response = await fetch(shasumsUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`无法获取校验清单 HTTP ${response.status}：${shasumsUrl}`);
  }
  const text = await response.text();
  for (const line of text.split(/\r?\n/u)) {
    const [hash, name] = line.trim().split(/\s+/u);
    if (name === fileName || name === `*${fileName}`) return hash.toLowerCase();
  }
  throw new Error(`校验清单中找不到 ${fileName}：${shasumsUrl}`);
}

function extractArchive({ archivePath, workDir, kind }) {
  const toArg = (value) => (process.platform === "win32" ? value.replaceAll("\\", "/") : value);
  // Windows 自带 bsdtar 能直接读 zip；POSIX 的 GNU tar 不能，压缩包仍是 .zip 时用 unzip。
  const command =
    kind === "tar.gz" || process.platform === "win32"
      ? [
          "tar",
          kind === "tar.gz"
            ? ["-xzf", toArg(archivePath), "-C", toArg(workDir)]
            : ["-xf", toArg(archivePath), "-C", toArg(workDir)],
        ]
      : ["unzip", ["-o", "-q", archivePath, "-d", workDir]];
  const result = spawnSync(command[0], command[1], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `解包失败（${command[0]}，退出码 ${result.status ?? result.error?.message}）：${archivePath}`,
    );
  }
}

async function fetchNodeHeaders({ version = process.versions.node, log: logFn = log } = {}) {
  const fileName = `node-v${version}-headers.tar.gz`;
  const cacheDir = nodeHeadersCacheDir({ version });
  const archivePath = join(dirname(cacheDir), fileName);
  const includeDir = join(cacheDir, "include", "node");
  if (hasNodeApiHeader(includeDir)) return includeDir;

  mkdirSync(dirname(cacheDir), { recursive: true });
  let lastError;
  for (const base of NODE_HEADER_BASES) {
    try {
      const expected = await fetchExpectedSha256(`${base}/v${version}/SHASUMS256.txt`, fileName);
      logFn(`本机 Node ${version} 未安装头文件，从 ${base} 取 ${fileName}`);
      await downloadToFile(`${base}/v${version}/${fileName}`, archivePath);
      const actual = sha256File(archivePath);
      if (actual !== expected) {
        throw new Error(`${fileName} sha256 不匹配：期望 ${expected}，实得 ${actual}`);
      }
      extractArchive({ archivePath, workDir: dirname(cacheDir), kind: "tar.gz" });
      rmSync(archivePath, { force: true });
      if (!hasNodeApiHeader(includeDir)) {
        throw new Error(`解包后未找到 include/node/node_api.h：${includeDir}`);
      }
      logFn(`Node 头文件已就绪：${includeDir}`);
      return includeDir;
    } catch (error) {
      lastError = error;
      rmSync(archivePath, { force: true });
    }
  }
  throw new Error(
    `无法获取 Node ${version} 头文件（编译 NAPI 绑定必需）：` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}。` +
      `可手工把 include/node/node_api.h 放到 ${nodeHeadersCacheDir({ version })} 下。`,
  );
}

async function fetchSqliteSources({ log: logFn = log } = {}) {
  const cacheDir = sqliteCacheDir();
  const sqlite3c = join(cacheDir, "sqlite3.c");
  if (existsSync(sqlite3c)) return cacheDir;

  mkdirSync(OHOS_NATIVE_CACHE_ROOT, { recursive: true });
  const archivePath = join(OHOS_NATIVE_CACHE_ROOT, "sqlite-amalgamation.zip");
  logFn(`sqlite3.c 缺失，取官方融合源 ${SQLITE_AMALGAMATION.url}`);
  try {
    await downloadToFile(SQLITE_AMALGAMATION.url, archivePath);
    const actual = sha256File(archivePath);
    if (actual !== SQLITE_AMALGAMATION.archiveSha256) {
      throw new Error(
        `sqlite 融合源 sha256 不匹配：期望 ${SQLITE_AMALGAMATION.archiveSha256}，实得 ${actual}`,
      );
    }
    extractArchive({ archivePath, workDir: OHOS_NATIVE_CACHE_ROOT, kind: "zip" });
  } finally {
    rmSync(archivePath, { force: true });
  }
  if (!existsSync(sqlite3c)) {
    throw new Error(`sqlite 融合源解包后仍缺 sqlite3.c：${cacheDir}`);
  }
  logFn(`sqlite 融合源已就绪：${cacheDir}`);
  return cacheDir;
}

// 返回 node_api.h 所在目录：安装自带 → 项目缓存 → 自动下载到缓存。
export function findNodeHeaders() {
  return nodeHeadersCandidateDirs().find(hasNodeApiHeader) ?? null;
}

export function findSqliteSources() {
  return sqliteSourceCandidates().find((dir) => existsSync(join(dir, "sqlite3.c"))) ?? null;
}

// 构建期只做检查：缺了指向 ohos:setup，不在构建中途下载。
export function requireNodeHeaders(find = findNodeHeaders) {
  const dir = find();
  if (!dir) {
    throw new Error(
      "未找到 Node 头文件（node_api.h）。先运行 pnpm ohos:setup 一次备齐原生编译输入，" +
        "或把本机 Node 的 include/node 放到 packages/desktop/.cache/ohos-native/ 下。",
    );
  }
  return dir;
}

export function requireSqliteSources(find = findSqliteSources) {
  const dir = find();
  if (!dir) {
    throw new Error(
      "未找到 sqlite 融合源（sqlite3.c）。先运行 pnpm ohos:setup 一次备齐，" +
        "或把 sqlite-amalgamation 解到 packages/desktop/.cache/ohos-native/ 下。",
    );
  }
  return dir;
}

export async function ensureNodeHeaders({ log: logFn = log } = {}) {
  const existing = findNodeHeaders();
  if (existing) return existing;
  return fetchNodeHeaders({ log: logFn });
}

// 返回 sqlite3.c 所在目录：native 目录已有 → 项目缓存 → 自动下载到缓存。
export async function ensureSqliteSources({ log: logFn = log } = {}) {
  const existing = findSqliteSources();
  if (existing) return existing;
  return fetchSqliteSources({ log: logFn });
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  const nodeInclude = await ensureNodeHeaders();
  const sqliteSrc = await ensureSqliteSources();
  console.log(`[ohos-native-deps] node headers -> ${nodeInclude}`);
  console.log(`[ohos-native-deps] sqlite source -> ${sqliteSrc}`);
}
