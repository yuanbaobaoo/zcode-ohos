#!/usr/bin/env node
// OHOS 构建输入脚手架。三个入口，职责分开：
//   pnpm install（默认 check）：只判断输入是否齐备，不写盘、不下载，永远退出 0；
//   pnpm ohos:check（--check）：同一套判断，缺任一输入时退出 1，供 CI/预检当门禁；
//   pnpm ohos:setup（--install）：检测 → 必要时下载 → 把 CLT 路径写进仓库根 .env。
// 三类输入：command-line-tools、Electron 运行时（约 368MB）、原生编译输入（Node 头文件 + sqlite 源，约 13MB）。
// 构建脚本只校验（require*）；下载只发生在本脚本的 install 模式。

import { copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  cltArchivePlan,
  ensureCommandLineTools,
  findCachedCommandLineTools,
  OHOS_CLT_CACHE_ROOT,
} from "../packages/desktop/scripts/ohos-clt.mjs";
import {
  persistOhosDotEnvValue,
  readOhosDotEnvValue,
  resolveCltTool,
  resolveCommandLineToolsRoot,
} from "../packages/desktop/scripts/ohos-env.mjs";
import {
  ensureOhosRuntime,
  hasOhosRuntimeFiles,
} from "../packages/desktop/scripts/fetch-ohos-runtime.mjs";
import {
  ensureNodeHeaders,
  ensureSqliteSources,
  findNodeHeaders,
  findSqliteSources,
} from "../packages/desktop/scripts/ohos-native-deps.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const LABELS = Object.freeze({ check: "[ohos:check]", install: "[ohos:setup]" });
const DOTENV_KEY = "DEVECO_CLI_CLT_PATH";
// 与 fetch-ohos-runtime.mjs / ohos-native-deps.mjs 的下载物对应，只用于提示体积。
const RUNTIME_SIZE = "约 368MB";
const NATIVE_INPUT_SIZE = "约 13MB";

export const SETUP_MODES = Object.freeze(["check", "install"]);

// 纯决策函数：把"CLT 当前该做什么"写死在一处，便于用例钉住（不碰文件系统）。
// check：装完依赖后只报告；install：显式命令，可以写 .env 与下载。
export function resolveSetupDecision({
  mode = "check",
  ci = false,
  configuredPath = null,
  foundRoot = null,
} = {}) {
  if (mode === "check") {
    if (ci) return "skip-ci";
    if (configuredPath) return "configured";
    if (foundRoot) return "discovered";
    return "missing";
  }
  if (configuredPath) return "report";
  if (foundRoot) return "persist";
  return "provision";
}

export function formatApproxSize(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

export function describeProvisionPlan(plan = cltArchivePlan()) {
  return plan
    ? {
        version: plan.version,
        size: formatApproxSize(plan.approxBytes),
        parts: plan.parts.length,
        cacheDir: OHOS_CLT_CACHE_ROOT,
      }
    : null;
}

// 只读取，不改动 .env：.env 里的路径同样要过存在性校验，避免旧值把人引到空目录。
// 环境变量由调用方传入（用例不能依赖宿主 export）。
function readConfiguredPath(root, fromEnv = null) {
  const fromDotEnv = readOhosDotEnvValue(DOTENV_KEY, { root });
  const candidates = [
    { value: fromEnv, source: "env" },
    { value: fromDotEnv, source: "dotenv" },
  ];
  for (const candidate of candidates) {
    if (candidate.value && resolveCltTool(candidate.value, "hvigorw")) return candidate;
  }
  return { value: null, source: fromDotEnv ? "dotenv" : null, stale: fromDotEnv };
}

function ensureDotEnv(root, { log = console.log, label = LABELS.install } = {}) {
  const dotEnvPath = join(root, ".env");
  const examplePath = join(root, ".env.example");
  if (existsSync(dotEnvPath) || !existsSync(examplePath)) return dotEnvPath;
  copyFileSync(examplePath, dotEnvPath);
  log(`${label} 已从 .env.example 生成 .env（不入库，按需修改）`);
  return dotEnvPath;
}

function cltStatus(configured, foundRoot) {
  if (configured.value) {
    const origin = configured.source === "env" ? "环境变量" : ".env";
    return { ready: true, text: `已配置 ${configured.value}（来源：${origin}）` };
  }
  if (foundRoot) return { ready: true, text: `检测到 ${foundRoot}（尚未写入 .env）` };
  return { ready: false, text: "缺失" };
}

export async function main({
  mode = "check",
  // check 模式默认只提示（postinstall 不能把 install 弄崩）；--check 用 strict 当门禁。
  strict = false,
  log = console.log,
  warn = console.warn,
  root = repoRoot,
  envPath = process.env[DOTENV_KEY]?.trim() || null,
  discover = () => resolveCommandLineToolsRoot(),
  cached = () => findCachedCommandLineTools(),
  ensure = ensureCommandLineTools,
  runtimeReady = () => hasOhosRuntimeFiles(),
  nativeInputsReady = () => Boolean(findNodeHeaders() && findSqliteSources()),
  ensureRuntime = () => ensureOhosRuntime(),
  ensureNativeInputs = async () => {
    await ensureNodeHeaders();
    await ensureSqliteSources();
  },
} = {}) {
  if (!SETUP_MODES.includes(mode)) throw new Error(`未知模式：${mode}`);

  const label = LABELS[mode];
  const configured = readConfiguredPath(root, envPath);
  const foundRoot = configured.value ? null : (cached() ?? discover());
  const clt = cltStatus(configured, foundRoot);
  const runtime = runtimeReady();
  const nativeInputs = nativeInputsReady();

  if (configured.stale && !configured.value) {
    warn(`${label} .env 里的 ${DOTENV_KEY} 不可用（找不到 hvigorw）：${configured.stale}`);
  }

  if (mode === "check") {
    if (process.env.CI) {
      log(`${label} CI 环境：跳过 OHOS 构建输入检查`);
      return 0;
    }
    log(`${label} command-line-tools：${clt.text}`);
    log(`${label} Electron 运行时：${runtime ? "就绪" : "缺失"}`);
    log(`${label} 原生编译输入（Node 头文件 / sqlite 源）：${nativeInputs ? "就绪" : "缺失"}`);
    if (clt.ready && runtime && nativeInputs) return 0;

    log(`${label} 构建输入不齐（只有构建 HAP 需要，Web / Server 可忽略）`);
    log(
      `${label}   · 一次备齐：pnpm ohos:setup（CLT 2.1–2.7GB + 运行时 ${RUNTIME_SIZE} + 原生输入 ${NATIVE_INPUT_SIZE}）`,
    );
    log(`${label}   · 自行下载：CLT 写进 .env 的 ${DOTENV_KEY}；运行时用 fetch-ohos-runtime.mjs`);
    return strict ? 1 : 0;
  }

  // ── install：把三类输入都备齐 ──
  if (!clt.ready) {
    const plan = describeProvisionPlan();
    if (!plan) {
      warn(`${label} 当前平台/架构没有预置的 command-line-tools 包，请自行下载后写入 .env`);
      return 1;
    }
    log(
      `${label} 未检测到 command-line-tools，开始下载 ${plan.size}（${plan.parts} 卷，版本 ${plan.version}）`,
    );
    log(`${label} 缓存目录：${plan.cacheDir}（下载物不入库，可随时删除重取）`);
    try {
      const { root: resolvedRoot, origin } = await ensure();
      log(`${label} command-line-tools 已就绪（${origin}）：${resolvedRoot}`);
      // 显式环境变量优先时 ensure 不回写；按 .env 实际内容决定说哪句。
      if (readOhosDotEnvValue(DOTENV_KEY, { root })) {
        log(`${label} 已写入 .env`);
      } else {
        log(`${label} 未回写 .env（显式环境变量优先）`);
      }
    } catch (error) {
      warn(
        `${label} command-line-tools 获取失败：${error instanceof Error ? error.message : error}` +
          `。也可以自行下载后把根目录写进 .env 的 ${DOTENV_KEY}`,
      );
      return 1;
    }
  } else if (!configured.value && foundRoot) {
    ensureDotEnv(root, { log, label });
    persistOhosDotEnvValue(DOTENV_KEY, foundRoot, { root });
    log(`${label} 已找到 command-line-tools，并写入 .env：${foundRoot}`);
  } else if (configured.value) {
    log(`${label} 复用已配置的 command-line-tools：${configured.value}`);
  }

  if (!runtime) {
    log(`${label} 获取 Electron 运行时（${RUNTIME_SIZE}）…`);
    try {
      await ensureRuntime();
      log(`${label} Electron 运行时已就绪`);
    } catch (error) {
      warn(`${label} Electron 运行时获取失败：${error instanceof Error ? error.message : error}`);
      return 1;
    }
  }
  if (!nativeInputs) {
    log(`${label} 获取原生编译输入（Node 头文件 + sqlite 源，${NATIVE_INPUT_SIZE}）…`);
    try {
      await ensureNativeInputs();
      log(`${label} 原生编译输入已就绪`);
    } catch (error) {
      warn(`${label} 原生编译输入获取失败：${error instanceof Error ? error.message : error}`);
      return 1;
    }
  }

  log(`${label} 构建输入已齐：pnpm ohos:run / pnpm ohos:bundle 可直接运行`);
  return 0;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  if (argv.includes("--install")) return { mode: "install", strict: true };
  if (argv.includes("--check")) return { mode: "check", strict: true };
  return { mode: "check", strict: false };
}

function printHelp(log = console.log) {
  log("用法：");
  log(
    "  node scripts/ohos-env-setup.mjs              # 只检测，永远退出 0（pnpm install 的 postinstall）",
  );
  log("  node scripts/ohos-env-setup.mjs --check      # 只检测，缺输入退出 1（pnpm ohos:check）");
  log("  node scripts/ohos-env-setup.mjs --install    # 备齐三类输入（pnpm ohos:setup）");
  log("");
  log(
    "检测链：DEVECO_CLI_CLT_PATH（环境变量或 .env）> PATH 反推 > 项目缓存；只有 --install 会下载。",
  );
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "help") {
    printHelp();
  } else {
    try {
      process.exitCode = await main(options);
    } catch (error) {
      // postinstall 永远不让 install 失败；--check / --install 才把错误暴露成退出码。
      const label = LABELS[options.mode] ?? "[ohos]";
      console.warn(
        `${label} 检查失败${options.strict ? "" : "（忽略，不影响安装）"}：${
          error instanceof Error ? error.message : error
        }`,
      );
      process.exitCode = options.strict ? 1 : 0;
    }
  }
}
