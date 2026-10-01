#!/usr/bin/env node
// 组装鸿蒙 HAP 的 resfile 资源（ohos/web_engine/.../resfile/resources/{app,glm,tools,config}）。
// 布局对齐桌面版 electron-builder 语义，仅容器不同：桌面组 app.asar，OHOS 从明文目录加载。
// resources/app = out/ + package.json + 运行时 node_modules 闭包；glm/tools/config 同构映射。
// 用法：node build-ohos.mjs [--skip-agent（跳过 agent bundle）|--skip-build（跳过 tsup/vite）]

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { collectRuntimeModuleClosureEntries } from "./runtime-dependency-closure.mjs";
import { runDesktopProductionBuild } from "./run-production-build.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const desktopRoot = join(repoRoot, "packages", "desktop");
const ohosProjectRoot = join(desktopRoot, "ohos");
const resfileDir = join(ohosProjectRoot, "web_engine", "src", "main", "resources", "resfile");
const resResourcesDir = join(resfileDir, "resources");
const appDir = join(resResourcesDir, "app");

const args = new Set(process.argv.slice(2));
const skipAgent = args.has("--skip-agent");
const skipBuild = args.has("--skip-build");

function log(step, message) {
  console.log(`[build-ohos] ${step}: ${message}`);
}

function run(command, cwd) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
      // agent bundle 与 native 工具按 <platform>-<arch> 落盘；OHOS 目标恒为
      // linux-arm64，不注入会按构建宿主平台落错目录，组装阶段取不到。
      ZCODE_TARGET_OS: process.env.ZCODE_TARGET_OS ?? "linux",
      ZCODE_TARGET_ARCH: process.env.ZCODE_TARGET_ARCH ?? "arm64",
    },
  });
  if (result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${command} (in ${cwd})`);
  }
}

// tsup 保持 node_modules 裸导入 external，运行时按 flat 布局从 app/node_modules 解析，
// 因此闭包根取 desktop dependencies 全集（不含 workspace 包与 electron 本体）。
function resolveDesktopRuntimeDependencyNames() {
  const packageJson = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
  return Object.keys(packageJson.dependencies ?? {}).filter(
    (name) => name !== "electron" && !name.startsWith("@zcode/"),
  );
}

function moduleLookupRoots() {
  const root = join(repoRoot, "node_modules");
  return [
    repoRoot,
    desktopRoot,
    join(root, ".pnpm", "node_modules"),
    join(desktopRoot, "node_modules"),
  ];
}

function copyPruned(source, target, { pruneMaps = false } = {}) {
  cpSync(source, target, {
    recursive: true,
    filter: (sourcePath) => {
      if (pruneMaps && sourcePath.endsWith(".map")) return false;
      return true;
    },
  });
}

function stageApp() {
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });

  const desktopPackageJson = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
  // package.json 只保留运行时需要的字段；main/type 决定 OHOS Electron 如何加载入口。
  const appPackageJson = {
    name: desktopPackageJson.name,
    version: desktopPackageJson.version,
    private: true,
    type: desktopPackageJson.type,
    main: desktopPackageJson.main,
  };
  writeFileSync(join(appDir, "package.json"), `${JSON.stringify(appPackageJson, null, 2)}\n`);

  log("app", "staging out/");
  for (const entry of readdirSync(join(desktopRoot, "out"))) {
    copyPruned(join(desktopRoot, "out", entry), join(appDir, "out", entry), { pruneMaps: true });
  }

  log("app", "collecting runtime node_modules closure");
  const dependencyNames = resolveDesktopRuntimeDependencyNames();
  const entries = collectRuntimeModuleClosureEntries(dependencyNames, moduleLookupRoots());
  mkdirSync(join(appDir, "node_modules"), { recursive: true });
  let copied = 0;
  for (const { moduleName: name, sourceModulePath: packageRoot } of entries) {
    const target = join(appDir, "node_modules", name);
    if (existsSync(target)) continue; // flat 布局先到先得，多版本同名以闭包首个为准
    if (!packageRoot || !statSync(packageRoot).isDirectory()) continue;
    cpSync(packageRoot, target, { recursive: true, filter: (p) => !p.endsWith(".map") });
    copied += 1;
  }
  log("app", `node_modules: ${copied} packages`);

  // node-pty 1.x 按 prebuilds/<platform>-<arch>/pty.node 探测，openharmony-arm64
  // 产物由交叉编译流程提供（暂以 ohos/electron/libs 下的 pty.node 占位）。
  const ohosPty = join(ohosProjectRoot, "electron", "libs", "arm64-v8a", "pty.node");
  const ptyPrebuildDir = join(appDir, "node_modules", "node-pty", "prebuilds", "openharmony-arm64");
  if (existsSync(ohosPty)) {
    mkdirSync(ptyPrebuildDir, { recursive: true });
    cpSync(ohosPty, join(ptyPrebuildDir, "pty.node"));
    log("app", "node-pty openharmony-arm64 prebuild injected");
  } else {
    log("app", "WARN: ohos pty.node missing, terminal will be unavailable");
  }
}

function stageRuntimeResources() {
  // 与 electron-builder extraResources 映射一致（config/、glm/、tools/）。
  copyPruned(join(repoRoot, "config"), join(resResourcesDir, "config"));

  // 随包 zsh（终端默认 shell）：鸿蒙沙箱内系统 rootfs 的 /usr/bin/zsh 不可见，
  // zsh 以应用资产分发（musl 静态依赖 ncurses/tinfo 一并携带，运行时经
  // LD_LIBRARY_PATH 指向 app/tools/zsh/lib）。主进程解析路径后经
  // ZCODE_OHOS_SHELL 下发给 host 的终端服务。
  const zshAssets = join(ohosProjectRoot, "app-assets", "zsh");
  if (existsSync(join(zshAssets, "zsh"))) {
    rmSync(join(appDir, "tools", "zsh"), { recursive: true, force: true });
    copyPruned(zshAssets, join(appDir, "tools", "zsh"));
    log("resources", "bundled zsh staged (tools/zsh)");
  } else {
    log(
      "resources",
      "WARN: packages/desktop/ohos/app-assets/zsh missing, terminal falls back to /bin/sh",
    );
  }

  // 自有 sqlite NAPI 绑定（packages/desktop/native/ohos-zcode-sqlite 交叉编译产物，语义正确
  // 且用户域可加载）：node:sqlite 兼容层（shared/nodeSqliteCompat）的 OHOS 首选后端，落在
  // app 根目录（兼容层候选路径之一）；同时复制进 electron/libs（HAP libs）——
  // utility/host 进程的 .node require 有 loader 重定向（bundle libs），放一份才能
  // 在 host 进程里加载成功。
  const zcodeSqlite = join(desktopRoot, "native", "ohos-zcode-sqlite", "zcode_sqlite.node");
  if (existsSync(zcodeSqlite)) {
    cpSync(zcodeSqlite, join(appDir, "zcode_sqlite.node"));
    cpSync(
      zcodeSqlite,
      join(ohosProjectRoot, "electron", "libs", "arm64-v8a", "zcode_sqlite.node"),
    );
    log("resources", "zcode_sqlite.node staged (app root + HAP libs)");
  } else {
    log("resources", "WARN: zcode_sqlite.node missing, falls back to ohos_sqlite_adapter");
  }

  const glmSource = join(desktopRoot, "bundled-agents", "linux-arm64", "glm");
  if (existsSync(glmSource)) {
    rmSync(join(resResourcesDir, "glm"), { recursive: true, force: true });
    copyPruned(glmSource, join(resResourcesDir, "glm"));
    log("resources", "glm agent bundle staged");
  } else {
    log("resources", "WARN: glm bundle missing (run without --skip-agent)");
  }

  for (const toolId of ["ripgrep", "bfs", "ugrep"]) {
    const toolSource = join(desktopRoot, "bundled-tools", "linux-arm64", toolId);
    if (existsSync(toolSource)) {
      copyPruned(toolSource, join(resResourcesDir, "tools", toolId));
      log("resources", `tools/${toolId} staged`);
    }
  }
}

async function main() {
  // libelectron.so 的 io_uring 禁用补丁（seccomp 拒 syscall 425 → SIGSYS 击杀 NodeService，
  // 见 scripts/ohos-patch-libelectron.mjs）。libelectron 不入库（大文件，缺失时由
  // bundle-ohos.mjs 或 fetch-ohos-libelectron.mjs 自动获取）；补丁按内容定位、幂等，
  // 纯 Node 实现，不为单个构建步骤引入额外解释器依赖。
  // 此前 so 缺失时仅 WARN 跳过——构建成功但产物装机必崩，静默降级比失败更糟，
  // 改为硬失败并给出可行动指引。
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync(process.execPath, ["scripts/ohos-patch-libelectron.mjs"], {
      cwd: desktopRoot,
      stdio: "inherit",
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message.split(String.fromCharCode(10))[0] : String(error);
    throw new Error(
      `libelectron io_uring 补丁失败（${reason}），该补丁不能跳过（缺失时产物装机即 SIGSYS）。` +
        "libelectron.so 缺失：先运行 packages/desktop/scripts/fetch-ohos-libelectron.mjs；" +
        "其余失败见上方补丁脚本输出（通常为 libelectron 版本变更导致锚点不匹配）。",
    );
  }

  if (!skipBuild) {
    // workspace 包（@zcode/shared 等）的 exports 指向 src/*.ts，tsup 的 noExternal 能内联
    // TS 源，但 vite/原生 ESM 加载链不行；先构建 workspace dist（等价根目录 build:bootstrap）。
    log("build", "workspace packages (build:bootstrap)");
    run('pnpm -r --filter "./packages/*" --filter "!@zcode/desktop" build', repoRoot);

    log("build", "desktop production build (tsup + vite)");
    run("node scripts/build-metadata.mjs", desktopRoot);
    await runDesktopProductionBuild({ cwd: desktopRoot });
  }

  if (!skipAgent) {
    log("agent", "building desktop agent bundle (zcode.cjs)");
    run("node scripts/build-desktop-agent-cli.mjs", repoRoot);
    run("pnpm prepare:agent-bundle", desktopRoot);
  }

  stageApp();
  stageRuntimeResources();

  log("done", `resfile staged at ${resfileDir}`);
  log(
    "next",
    "assemble HAP: pnpm bundle:desktop:ohos（或 cd packages/desktop/ohos && hvigorw assembleHap --mode module）",
  );
}

main().catch((error) => {
  console.error(`[build-ohos] failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
