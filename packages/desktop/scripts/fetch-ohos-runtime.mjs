#!/usr/bin/env node
// OHOS Electron 运行时供应（libelectron.so 187MB 等三件 .so 不入库）：
// 统一从本仓库 ohos-tools Release 的 v40.0.1.20260928.2-release.zip 提取——
// 内容为华为鸿蒙团队构建的 Electron 40.1.0 / Chromium 144.0.7559.76 / Node 24.11.1
// 运行时（2026-09-28 构建），容器层级：zip → libelectron_144.tar.gz → ohos_hap 工程。
// ZCODE_OHOS_ELECTRON_URL 可换源（须为同内容 zip 直链）。
//
// 目标位置：
//   ohos/entry/libs/arm64-v8a/   —— 活跃布局（HAP libs，装机物化到 bundle/libs/arm64）
//   ohos/hnp/lib/arm64-v8a/        —— 休眠 HNP 布局（hnpPackages 当前在 module.json5 注释停用，
//                                    保持同步防止将来启用时拿到旧版）
//   ohos/web_engine/src/main/resources/resfile/ —— pak/icudtl/快照/启动器/locales/vulkan，
//                                    与 .so 同源，避免运行时升级后资源与引擎版本错配。
// Node 24 基线已内建 node:sqlite / withResolvers / fs.glob，且 libuv 已移除 io_uring
// （不再需要 ohos-patch-libelectron.mjs 的补丁——脚本对「字符串缺失」按跳过处理）。
// 终极兜底：源码构建（specs/ohos-port/01）。

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { applyOhosDotEnv } from "./ohos-env.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const ohosRoot = resolve(desktopRoot, "ohos");

const ZIP_SHA256 = "5caab8b2ad33a1b9389abdc3d1d171c84e9dd66670adaf14c632ef1d0e95240a";
const DEFAULT_URL =
  "https://github.com/yuanbaobaoo/zcode-ohos/releases/download/ohos-tools/v40.0.1.20260928.2-release.zip";

// zip 内 tar.gz 中的路径前缀（libelectron_144.tar.gz 解出后的工程内位置）
const TAR_PREFIX = "libelectron/ohos_hap/electron/libs/arm64-v8a";
const TAR_RESFILE_PREFIX = "libelectron/ohos_hap/web_engine/src/main/resources/resfile";
// 三件 .so 及其内容哈希（v40 构建的发布态；本基线无 io_uring 补丁，哈希即装机内容）。
// electron 启动器：v40 起 utilityProcess 经 module.json5 的 electron_exec_path_ohos
// 元数据 re-exec（指向 bundle/libs/arm64/electron），必须与 .so 同源同步放置。
const FILES = [
  {
    name: "libelectron.so",
    sha256: "961fb4719a17eb56821bc7505762d538ca49d60a3f03efba80ebafa9ca78d63f",
  },
  {
    name: "libadapter.so",
    sha256: "fbc96bd91e547a31bcaa2d5641d8cecdf51e442c90686be657fb47d96816bf3f",
  },
  {
    name: "libffmpeg.so",
    sha256: "9e1d6a49393c29f8040fde039819eba0ae652dca89fc5f47fb4997a6111fb1b8",
  },
  {
    name: "electron",
    tarPrefix: TAR_RESFILE_PREFIX,
    sha256: "4e93b86e6f3b94520131a8bc43227aae3ad2cea64635cd084e7a982d86770de4",
  },
];
const DEST_DIRS = [
  resolve(ohosRoot, "entry/libs/arm64-v8a"),
  resolve(ohosRoot, "hnp/lib/arm64-v8a"),
];
// 启动器只进活跃布局的 libs（module.json5 元数据路径）；不进休眠的 hnp/lib。
const LAUNCHER_DEST_DIRS = [resolve(ohosRoot, "entry/libs/arm64-v8a")];
const RESFILE_DIR = resolve(ohosRoot, "web_engine/src/main/resources/resfile");

// 与 .so 同源的 Chromium 资源；全部由本脚本从同一个 zip 提取，不再入库。
const RESFILE_FILES = [
  {
    name: "chrome_100_percent.pak",
    resfile: true,
    sha256: "b0ca385453ca1adc15f34b3d18b50dbd56cd8305ef7964dc83506849e5ccffe5",
  },
  {
    name: "chrome_200_percent.pak",
    resfile: true,
    sha256: "093ca6b723ab5807fea7073a1bdbeff796ff0d5f61415e4baca905af494fcdad",
  },
  {
    name: "electron",
    resfile: true,
    sha256: "4e93b86e6f3b94520131a8bc43227aae3ad2cea64635cd084e7a982d86770de4",
  },
  {
    name: "icudtl.dat",
    resfile: true,
    sha256: "1cf67874b5a87a8363a86fb3f81e3cbbed54d389062dab8fb52308d5cf8c8612",
  },
  {
    name: "locales/en-US.pak",
    resfile: true,
    sha256: "e5e068850f65e69f06066c8c63c8083557de2a60a68f351a87550d2367fd4e5e",
  },
  {
    name: "locales/zh-CN.pak",
    resfile: true,
    sha256: "6d786b64f41f55a1c0632c6ff8c653da660f6f2ca427354cd8e7b047ea4fc2c9",
  },
  {
    name: "resources.pak",
    resfile: true,
    sha256: "d47559c9930a4b557f9e09c4bfe5c190af929473101cb287a26bb74348f67b29",
  },
  {
    name: "snapshot_blob.bin",
    resfile: true,
    sha256: "03c600ee3bc481dc0b60d75c07407ec27973f73f885d04354a90cf205f4e2a49",
  },
  {
    name: "v8_context_snapshot.bin",
    resfile: true,
    sha256: "8f98ba05fba760e292cc08d8afcf8dbb6451835b9afb0b494b782c9f1f46caf4",
  },
  {
    name: "vulkan/icd.d/vk_swiftshader_icd.json",
    resfile: true,
    sha256: "34d4d9ebcd8841f2c34ccdbdcc00442bce76fae9b4de1da24c03c0ffb4e60503",
  },
];
const ALL_FILES = [...FILES, ...RESFILE_FILES];

function tarPrefixFor(file) {
  return file.tarPrefix ?? (file.resfile ? TAR_RESFILE_PREFIX : TAR_PREFIX);
}

function destDirsFor(file) {
  if (file.resfile) return [RESFILE_DIR];
  return file.name === "electron" ? LAUNCHER_DEST_DIRS : DEST_DIRS;
}

async function digestFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

// 本地文件全部就位且哈希匹配才算有效；任一缺失/不符即整组重取（三件套必须同源）。
// 不做尺寸下限门槛——哈希即完整性证据（启动器仅 6.5KB，尺寸门槛会误判）。
async function localFilesValid() {
  for (const file of ALL_FILES) {
    for (const dir of destDirsFor(file)) {
      const path = resolve(dir, file.name);
      if (!existsSync(path)) return false;
      if ((await digestFile(path)) !== file.sha256) return false;
    }
  }
  return true;
}

async function download(url, tempPath) {
  console.log(`[fetch-ohos-runtime] downloading ${url}`);
  if (url.startsWith("file://")) {
    const source = decodeURIComponent(new URL(url).pathname);
    const result = spawnSync("cp", [source, tempPath]);
    if (result.status !== 0) throw new Error(`file:// 复制失败：${source}`);
    return;
  }
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`下载失败 HTTP ${response.status}（检查镜像地址与网络）`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  let lastReportMb = 0;
  const body = Readable.fromWeb(response.body);
  body.on("data", (chunk) => {
    received += chunk.length;
    const mb = Math.floor(received / (64 * 1024 * 1024));
    if (mb > lastReportMb) {
      lastReportMb = mb;
      console.log(
        `[fetch-ohos-runtime] ${(received / 1024 / 1024).toFixed(0)}${total > 0 ? `/${(total / 1024 / 1024).toFixed(0)}` : ""}MB`,
      );
    }
  });
  await pipeline(body, createWriteStream(tempPath));
}

// zip → tar.gz → 运行时文件。用系统 unzip/tar，免引入依赖（macOS 与 CI Linux 均自带）。
function extract(zipPath, workDir) {
  mkdirSync(workDir, { recursive: true });
  let result = spawnSync("unzip", ["-o", "-q", zipPath, "-d", workDir]);
  if (result.status !== 0) throw new Error("zip 解包失败（unzip）");
  const tarGz = resolve(workDir, "libelectron_144.tar.gz");
  if (!existsSync(tarGz)) throw new Error("zip 内未找到 libelectron_144.tar.gz（包结构变更？）");
  const members = [...new Set(ALL_FILES.map((f) => `${tarPrefixFor(f)}/${f.name}`))];
  result = spawnSync("tar", ["xzf", tarGz, "-C", workDir, ...members]);
  if (result.status !== 0) throw new Error("tar.gz 解包失败（tar 内层）");
  return ALL_FILES.map((f) => ({ ...f, path: resolve(workDir, tarPrefixFor(f), f.name) }));
}

async function main() {
  // 镜像地址可来自仓库根 .env/.env.local（白名单见 ohos-env.mjs；真实环境变量优先）。
  await applyOhosDotEnv();
  if (await localFilesValid()) {
    console.log("[fetch-ohos-runtime] 运行时文件已存在且哈希匹配，跳过");
    return;
  }

  const url = process.env.ZCODE_OHOS_ELECTRON_URL || DEFAULT_URL;
  const tempZip = resolve(ohosRoot, "entry/libs/arm64-v8a/.runtime-download.zip");
  const workDir = resolve(ohosRoot, "entry/libs/arm64-v8a/.runtime-work");
  try {
    await download(url, tempZip);
    const zipHash = await digestFile(tempZip);
    if (zipHash !== ZIP_SHA256) {
      throw new Error(`zip sha256 不匹配：期望 ${ZIP_SHA256}，实得 ${zipHash}（镜像内容被换？）`);
    }
    const extracted = extract(tempZip, workDir);
    for (const file of extracted) {
      const got = await digestFile(file.path);
      if (got !== file.sha256) {
        throw new Error(`${file.name} sha256 不匹配：期望 ${file.sha256}，实得 ${got}`);
      }
      for (const dir of destDirsFor(file)) {
        const target = resolve(dir, file.name);
        mkdirSync(dirname(target), { recursive: true });
        // 先复制到同目录临时文件再原子改名，避免半截文件被误判为就位。
        const tempTarget = `${target}.tmp`;
        spawnSync("cp", [file.path, tempTarget], { stdio: "inherit" });
        renameSync(tempTarget, target);
        // 启动器须带执行位（utilityProcess 经它 re-exec）；resfile 副本不执行。
        if (file.name === "electron" && !file.resfile) spawnSync("chmod", ["+x", target]);
      }
      console.log(`[fetch-ohos-runtime] ${file.name}${file.resfile ? " (resfile)" : ""} OK`);
    }
  } finally {
    if (existsSync(tempZip)) rmSync(tempZip, { force: true });
    if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[fetch-ohos-runtime] ERROR: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
