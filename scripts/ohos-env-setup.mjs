#!/usr/bin/env node
// `pnpm install` 之后的 OHOS 开发环境脚手架（幂等、永不阻塞安装）。
//
// 规则（三平台一致）：
// 1. 没有 .env 就从 .env.example 生成一份（.env 不入库），并提示开发者按需修改；
// 2. 读 .env：已配置 DEVECO_CLI_CLT_PATH 就只报告；
// 3. 未配置时先在「已装 / PATH / 项目缓存」里找 command-line-tools，找到就写回 .env；
// 4. 都没有时自动获取（下载 → 逐卷 sha256 → 解压到 .cache）并回写 .env；
//    下载失败只提示，不让 install 失败；
// 5. CI（存在 CI 变量）整段跳过：流水线的工具链由 workflow 自己准备，不在流水线里下载 2GB 级工具链。
//
// 为什么不看 TTY：pnpm 会接管生命周期脚本的 stdout，即使终端是真 TTY，postinstall 里拿到的也是
// 管道（实测 ConPTY 下 `process.stdout.isTTY` 仍为 undefined）。所以“是否自动下载”只由 CI 决定。

import { copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  ensureCommandLineTools,
  findCachedCommandLineTools,
} from "../packages/desktop/scripts/ohos-clt.mjs";
import {
  persistOhosDotEnvValue,
  readOhosDotEnvValue,
  resolveCommandLineToolsRoot,
} from "../packages/desktop/scripts/ohos-env.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const label = "[ohos-env]";

// 纯决策函数：便于测试，也把“安装期该做什么”写死在一处。
export function resolveSetupDecision({
  ci = Boolean(process.env.CI),
  configuredPath = null,
  foundRoot = null,
} = {}) {
  if (ci) return "skip-ci";
  if (configuredPath) return "report";
  if (foundRoot) return "persist";
  return "provision";
}

async function main({ log = console.log, warn = console.warn } = {}) {
  // CI 判断必须在任何落盘动作之前：流水线既不该被改写 .env，也不该触发 2GB 级下载。
  if (resolveSetupDecision({ ci: Boolean(process.env.CI) }) === "skip-ci") {
    log(`${label} CI 环境：跳过 .env 脚手架（工具链由 CI 自己准备）`);
    return;
  }

  const dotEnvPath = join(repoRoot, ".env");
  const examplePath = join(repoRoot, ".env.example");

  if (!existsSync(dotEnvPath)) {
    if (!existsSync(examplePath)) {
      warn(`${label} 缺少 .env 与 .env.example，跳过 OHOS 环境检查`);
      return;
    }
    copyFileSync(examplePath, dotEnvPath);
    log(`${label} 未找到 .env，已从 .env.example 生成（.env 不入库，请按需检查/修改）`);
  }

  const configuredPath = readOhosDotEnvValue("DEVECO_CLI_CLT_PATH");
  const foundRoot = configuredPath
    ? null
    : (resolveCommandLineToolsRoot() ?? findCachedCommandLineTools());

  const decision = resolveSetupDecision({ configuredPath, foundRoot });
  if (decision === "report") {
    log(`${label} .env 已配置 DEVECO_CLI_CLT_PATH=${configuredPath}`);
    return;
  }
  if (decision === "persist") {
    persistOhosDotEnvValue("DEVECO_CLI_CLT_PATH", foundRoot);
    log(`${label} 已找到 command-line-tools，并写入 .env：${foundRoot}`);
    return;
  }

  // decision === "provision"：首次安装就把 CLT 取到项目缓存并写进 .env。
  log(`${label} 未检测到 command-line-tools，开始自动获取（约 2.1–2.7GB，仅首次）…`);
  try {
    const { root } = await ensureCommandLineTools();
    log(`${label} command-line-tools 已就绪并写入 .env：${root}`);
  } catch (error) {
    warn(
      `${label} 自动获取失败（不影响 install）：${error instanceof Error ? error.message : error}。` +
        "首次 `pnpm dev:ohos` / `pnpm bundle:desktop:ohos` 会重试；已有安装的话把路径写进 .env 即可。",
    );
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    await main();
  } catch (error) {
    // 安装期脚手架永远不让 install 失败。
    console.warn(
      `${label} 检查失败（忽略，不影响安装）：${error instanceof Error ? error.message : error}`,
    );
  }
}
