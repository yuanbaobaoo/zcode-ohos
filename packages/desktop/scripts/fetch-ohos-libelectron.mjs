#!/usr/bin/env node
// libelectron.so 供应脚本：该文件（167MB）不入库，历史上依赖作者私有仓
// （gitcode ohos-linux-zcode）git-lfs 取回——私有仓一旦消失即构建断供。
// 本脚本把供应改为可配置镜像 + sha256 校验：
//   1. ZCODE_OHOS_ELECTRON_URL 指定的任意 http(s)/file URL
//   2. 默认 GitHub Release 镜像（本仓库 ohos-runtime tag 下的 libelectron.so 资产）
// 预期哈希为已打 io_uring 补丁的版本（build-ohos 的补丁脚本幂等，重放无害）。
// 终极兜底 = 从 openharmony-sig/electron 源码构建，见 specs/ohos-port/01-构建与打包.md。

import { createReadStream, createWriteStream, existsSync, renameSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { applyOhosDotEnv } from "./ohos-env.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const targetPath = resolve(desktopRoot, "ohos/electron/libs/arm64-v8a/libelectron.so");
// 镜像内容必须是这份已验证文件（若换镜像源需同步更新此处哈希）。
const EXPECTED_SHA256 = "6cd73b114ac3dd80d28cc58be9318a9af89480c7ff91b264cd56b325e624844a";
// 官方镜像：本仓库 ohos-tools Release（与 command-line-tools 分卷同处，统一资源源；
// 升级 libelectron 时更新该资产并同步下方哈希）。
const DEFAULT_URL =
  "https://github.com/yuanbaobaoo/ZCode-ohos/releases/download/ohos-tools/libelectron.so";

async function digestFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function isValidLocalFile() {
  return existsSync(targetPath) && statSync(targetPath).size >= 100 * 1024 * 1024;
}

async function download(url, tempPath) {
  console.log(`[fetch-libelectron] downloading ${url}`);
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
    const mb = Math.floor(received / (32 * 1024 * 1024));
    if (mb > lastReportMb) {
      lastReportMb = mb;
      console.log(
        `[fetch-libelectron] ${(received / 1024 / 1024).toFixed(0)}${total > 0 ? `/${(total / 1024 / 1024).toFixed(0)}` : ""}MB`,
      );
    }
  });
  await pipeline(body, createWriteStream(tempPath));
}

async function main() {
  // 镜像地址可来自仓库根 .env/.env.local（白名单见 ohos-env.mjs；真实环境变量优先）。
  await applyOhosDotEnv();
  if (isValidLocalFile()) {
    const current = await digestFile(targetPath);
    if (current === EXPECTED_SHA256) {
      console.log("[fetch-libelectron] 已存在且哈希匹配，跳过");
      return;
    }
    console.log(`[fetch-libelectron] 本地哈希 ${current} 与预期不符，重新获取覆盖`);
  }

  const url = process.env.ZCODE_OHOS_ELECTRON_URL || DEFAULT_URL;
  const tempPath = `${targetPath}.download`;
  try {
    await download(url, tempPath);
    const got = await digestFile(tempPath);
    if (got !== EXPECTED_SHA256) {
      throw new Error(
        `sha256 不匹配：期望 ${EXPECTED_SHA256}，实得 ${got}（镜像内容未同步更新？）`,
      );
    }
    renameSync(tempPath, targetPath);
    console.log(`[fetch-libelectron] OK → ${targetPath}`);
  } finally {
    if (existsSync(tempPath)) spawnSync("rm", ["-f", tempPath]);
  }
}

main().catch((error) => {
  console.error(`[fetch-libelectron] ERROR: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
