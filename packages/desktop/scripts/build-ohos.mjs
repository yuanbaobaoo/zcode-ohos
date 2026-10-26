#!/usr/bin/env node
// 组装鸿蒙 HAP 的 resfile（resources/app = out/ + package.json + node_modules 闭包，
// glm/tools/config 同构映射）。用法：node build-ohos.mjs [--skip-agent|--skip-build]

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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

// HAP 打包会过滤 resfile 里点开头的文件/目录（实证：.zcode-plugin、.mcp.json 进不了包），
// 官方插件协议依赖它们做存在性证据与 seed 清单。stage 时平铺成非点副本（zcode-flat/*），
// CLI 侧 flatFileCanonicalPath 反向还原（bundled-plugins.ts），缓存形态跨平台一致。
function stageFlatDotEntries(packagesDir) {
  if (!existsSync(packagesDir)) return;
  const dotEntries = [
    [join(".zcode-plugin", "plugin.json"), join("zcode-flat", "plugin.json")],
    [".mcp.json", join("zcode-flat", "mcp.json")],
  ];
  let staged = 0;
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = join(packagesDir, entry.name);
    for (const [dotPath, flatPath] of dotEntries) {
      const source = join(packageDir, dotPath);
      if (!existsSync(source)) continue;
      const target = join(packageDir, flatPath);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      staged += 1;
    }
  }
  if (staged > 0) log("resources", `glm dot entries flattened (zcode-flat/*): ${staged}`);
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

// OHOS 兼容（specs/ohos-port/09 §4.1.1）：上游 v3.16.1 新增的 sqlite 消费模块
// （sqlite-migrations/backup|restore、localUsageEvidence）静态 import "node:sqlite"。
// OHOS Electron（Node 20.18.1）没有该 builtin，Electron 从 ESM 入口解析静态 import
// 时无法运行期拦截，main 会在窗口创建前抛 ERR_UNKNOWN_BUILTIN_MODULE。
// 桌面 ESM bundle 把这三个消费模块外部化保留静态 import，这里把它们重写到一个
// 就地惰性 shim：shim 走 loadNodeSqlite() 惰性解析（OHOS 落原生绑定），模块求值
// 顺带安装 Node 20 运行期兼容。兼容加载器走 createRequire（被运行期 require 钩子
// 接管），绝不能改写，否则兼容层自己不可加载。
// OHOS 兼容（specs/ohos-port/09 §4.1.1）：上游 v3.16.1 新增的 sqlite 消费模块
// （sqlite-migrations/backup|restore、localUsageEvidence）静态 import "node:sqlite"。
// OHOS Electron（Node 20.18.1）没有该 builtin，Electron 从 ESM 入口解析静态 import
// 时无法运行期拦截，main 会在窗口创建前抛 ERR_UNKNOWN_BUILTIN_MODULE。
// 桌面 ESM bundle 把这三个消费模块外部化保留静态 import，这里把它们重写到一个
// 就地惰性 shim：shim 走 loadNodeSqlite() 惰性解析（OHOS 落原生绑定），模块求值
// 顺带安装 Node 20 运行期兼容。兼容加载器走 createRequire（被运行期 require 钩子
// 接管），绝不能改写，否则兼容层自己不可加载。
function patchOhosNodeSqliteStaticImports(outRoot) {
  const files = collectJsFiles(outRoot);
  // shim 符号从含 loadNodeSqlite 的参考 chunk 反查：优先从 export 块找本地绑定名
  // （普通 chunk），找不到时从函数定义直接拿名并重导出（ESM 入口 chunk 无 export
  // 块，loadNodeSqlite 定义就在入口里）。
  let refFile;
  let loadSymbol;
  let exportedName;
  let needsReexport = false;
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    if (!content.includes("[ohos-sqlite] backend loaded")) continue;
    const exportBlock = content.match(/export\{([^}]+)\};?\s*$/m);
    const exportEntries = exportBlock
      ? exportBlock[1].split(",").map((x) => x.trim().split(/\s+as\s+/))
      : [];
    for (const parts of exportEntries) {
      const local = parts[0];
      if (!local) continue;
      // 可靠判别：minify 后 loadNodeSqlite 的控制流形状会变体（if-return / return-or /
      // 缓存链），但函数体必含 "node:sqlite" 字面量（非 OHOS 分支
      // nodeRequire("node:sqlite")）。getDataBaseDir 等同形态函数不含该字面量。
      const fn = content.match(
        new RegExp(`function\\s+${escapeRegExp(local)}\\s*\\(\\)\\{[^}]{0,500}`),
      );
      if (fn && fn[0].includes("node:sqlite")) {
        loadSymbol = local;
        exportedName = parts[1] ?? local;
        refFile = file;
        break;
      }
    }
    if (!loadSymbol) {
      // 入口 chunk：loadNodeSqlite 本地定义但不在 export 块里（同样按字面量判别）。
      for (const m of content.matchAll(/function\s+(\w+)\s*\(\)\{[^}]{0,500}/g)) {
        if (m[0].includes("node:sqlite")) {
          loadSymbol = m[1];
          refFile = file;
          needsReexport = true;
          break;
        }
      }
    }
    if (loadSymbol) break;
  }
  if (!refFile || !loadSymbol) {
    throw new Error(
      "ohos node:sqlite 构建期重写失败：未找到 loadNodeSqlite 定义 " +
        "（nodeSqliteCompat 聚合 chunk 缺失或形态漂移），无法生成 shim。",
    );
  }
  const refDir = dirname(refFile);
  const shimPath = join(refDir, "ohos-node-sqlite-shim.mjs");
  const refBase = basename(refFile).replace(/\.js$/, "");
  if (needsReexport) {
    // 给入口 chunk 追加重导出（幂等：重复构建不重复追加）；导出名统一固定。
    exportedName = "zcodeOhosLoadNodeSqlite";
    const reexportLine = `export { ${loadSymbol} as ${exportedName} };`;
    const content = readFileSync(refFile, "utf8");
    if (!content.includes(reexportLine)) {
      writeFileSync(refFile, `${content}\n${reexportLine}\n`);
    }
  }
  const shimContent = [
    "// OHOS build-time shim（由 build-ohos.mjs 写入）：桌面 ESM bundle 的 node:sqlite",
    "// 静态 import 在 OHOS Electron（Node 20.18.1）上无法解析，这里把消费模块的 import",
    "// 重写到此惰性 shim，内部经 loadNodeSqlite() 在 OHOS 落原生绑定。Node 20 运行期",
    "// 兼容（require 钩子 + polyfill）由入口引导与 Agent Worker preload 安装，不在此重挂。",
    `import { ${exportedName} as ${loadSymbol} } from "./${refBase}.js";`,
    "",
    `const __target = () => ${loadSymbol}().DatabaseSync;`,
    "export const DatabaseSync = new Proxy(function DatabaseSync() {}, {",
    "  apply() { throw new Error('node:sqlite DatabaseSync must be constructed'); },",
    "  construct(t, args) { return Reflect.construct(__target(), args); },",
    "  get(t, p, r) { return Reflect.get(__target(), p, r); },",
    "  set(t, p, v, r) { return Reflect.set(__target(), p, v, r); },",
    "  has(t, p) { return p in __target(); },",
    "  getPrototypeOf() { return Reflect.getPrototypeOf(__target()); },",
    "});",
    `export const backup = (source, destination) => ${loadSymbol}().backup(source, destination);`,
    `export { ${exportedName} as loadNodeSqlite } from "./${refBase}.js";`,
    "",
  ].join("\n");
  writeFileSync(shimPath, shimContent);
  // 写出即校验： shim 内容异常（如换行被转义成全行注释）会让消费模块在装机后
  // 才报 "does not provide an export"，构建期必须硬失败暴露。
  const writtenShim = readFileSync(shimPath, "utf8");
  if (!writtenShim.includes("export const DatabaseSync") || writtenShim.split("\n").length < 5) {
    throw new Error(`ohos node:sqlite shim 写出内容异常（${shimPath}），检查模板拼接。`);
  }
  const staticImport = /from\s*"node:sqlite"/g;
  let patched = 0;
  for (const file of files) {
    if (file === shimPath) continue;
    const content = readFileSync(file, "utf8");
    if (!staticImport.test(content)) {
      staticImport.lastIndex = 0;
      continue;
    }
    staticImport.lastIndex = 0;
    const relative = relativePath(dirname(file), shimPath);
    writeFileSync(file, content.replace(staticImport, `from "${relative}"`));
    patched += 1;
  }
  // 第二 pass：sourceServerWorkspaceAliasRepo / controllerRemoteIdentityMigration
  // 用 createRequire(import.meta.url)("node:sqlite") 取值，不走静态 import。
  // 解构形状 `{backup?:,DatabaseSync?:}=\w+("node:sqlite")` 在消费 chunk 出现。
  // 参考 chunk 与消费 chunk 可能不同（host/index.js 的 createRequire 落在入口
  // chunk，loadNodeSqlite 在另一 chunk），局部符号跨 chunk 不可见——必须经 shim
  // 的 loadNodeSqlite 命名导出（ESM import），不能用参考 chunk 的局部符号。
  let requirePatched = 0;
  const destructureRe = /(\{[^{}]*DatabaseSync[^{}]*\})\s*=\s*\w+\(\s*["\']node:sqlite["\']\s*\)/g;
  for (const file of files) {
    if (file === shimPath) continue;
    const content = readFileSync(file, "utf8");
    if (!destructureRe.test(content)) {
      destructureRe.lastIndex = 0;
      continue;
    }
    destructureRe.lastIndex = 0;
    const relative = relativePath(dirname(file), shimPath);
    const shimImport = `import { loadNodeSqlite as zcodeOhosNodeSqlite } from "${relative}";`;
    let next = content.replace(destructureRe, `$1=zcodeOhosNodeSqlite() /* ohos shim */`);
    if (next !== content) {
      if (!next.includes("zcodeOhosNodeSqlite")) {
        next = `${shimImport}\n${next}`;
      } else if (!next.includes(shimImport)) {
        next = `${shimImport}\n${next}`;
      }
      writeFileSync(file, next);
      requirePatched += 1;
    }
  }
  if (requirePatched > 0) {
    log("build", `node:sqlite createRequire call-sites rewritten in ${requirePatched} chunk(s)`);
  }
  patched += requirePatched;
  if (patched === 0) {
    // 幂等友好：上一轮已改写完（shim 存在且 chunk 无剩余静态 import）时只跳
    // 静态 import 重写；createRequire pass 可能还有残留（如新 chunk 引入），继续跑。
    const shimExists = existsSync(join(refDir, "ohos-node-sqlite-shim.mjs"));
    if (shimExists) {
      log("build", "node:sqlite static imports already rewritten; running createRequire pass only");
    } else {
      throw new Error(
        `ohos node:sqlite 构建期重写未命中任何 chunk（outRoot=${outRoot}）；` +
          "请检查桌面 ESM 产物结构与 sqlite 消费模块命名。",
      );
    }
  }
  log("build", `node:sqlite static imports rewritten to OHOS shim in ${patched} chunk(s)`);
  return patched;
}

function relativePath(fromDir, toFile) {
  const fromParts = fromDir.split(/[\\/]/).filter(Boolean);
  const toParts = toFile.split(/[\\/]/).filter(Boolean);
  while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }
  const up = fromParts.map(() => "..");
  return [...up, ...toParts].join("/").replace(/^(?!\.)/, "./");
}

function collectJsFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  }
  return files;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  // 产物由交叉编译流程提供（暂以 ohos/entry/libs 下的 pty.node 占位）。
  const ohosPty = join(ohosProjectRoot, "entry", "libs", "arm64-v8a", "pty.node");
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

  // 随包 zsh：沙箱内系统 /usr/bin/zsh 不可见，以应用资产分发（ncurses/tinfo 一并携带），
  // 路径经 ZCODE_OHOS_SHELL 下发 host 终端服务。
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

  // OHOS 首选 sqlite 后端：双份复制（resfile app 根 + HAP libs，host 进程 require 有
  // loader 重定向必须后者）。产物缺失先自动编译，仍缺即硬失败（issue #1，详见 specs/ohos-port/02）。
  const zcodeSqliteNativeDir = join(desktopRoot, "native", "ohos-zcode-sqlite");
  const zcodeSqlite = join(zcodeSqliteNativeDir, "zcode_sqlite.node");
  if (!existsSync(zcodeSqlite)) {
    log("resources", "zcode_sqlite.node missing, building via build.sh");
    const build = spawnSync("sh", [join(zcodeSqliteNativeDir, "build.sh")], {
      cwd: zcodeSqliteNativeDir,
      stdio: "inherit",
    });
    if (build.status !== 0 || !existsSync(zcodeSqlite)) {
      throw new Error(
        "zcode_sqlite.node 缺失且自动编译失败（resfile 副本缺位会使 HarmonyOS 7 PC " +
          "装机即崩，不能跳过）。排查：① 看上方 build.sh 输出；② 需 OHOS SDK clang" +
          "（设 OHOS_COMMAND_LINE_TOOLS_ROOT 指向 command-line-tools，或解压至 " +
          "~/command-line-tools）；③ sqlite3.c 融合源缺失时传所在目录：" +
          "sh native/ohos-zcode-sqlite/build.sh <sqlite-amalgamation 目录>。",
      );
    }
  }
  cpSync(zcodeSqlite, join(appDir, "zcode_sqlite.node"));
  cpSync(zcodeSqlite, join(ohosProjectRoot, "entry", "libs", "arm64-v8a", "zcode_sqlite.node"));
  log("resources", "zcode_sqlite.node staged (app root + HAP libs)");

  // 终端原生子进程（spec 09 §12.7）：v40 主进程 spawn 被沙箱击杀，改由 appspawn 拉起
  // 宿主库再 exec shell；宿主库按名加载必须进 HAP libs，NAPI 桥与 sqlite 同址双份。
  const zcodePtyNativeDir = join(desktopRoot, "native", "ohos-zcode-pty");
  const zcodePtyBridge = join(zcodePtyNativeDir, "zcode_ohos_process.node");
  const zcodePtyHost = join(zcodePtyNativeDir, "libzcode_pty.so");
  if (!existsSync(zcodePtyBridge) || !existsSync(zcodePtyHost)) {
    log("resources", "ohos-zcode-pty artifacts missing, building via build.sh");
    const build = spawnSync("sh", [join(zcodePtyNativeDir, "build.sh")], {
      cwd: zcodePtyNativeDir,
      stdio: "inherit",
    });
    if (build.status !== 0 || !existsSync(zcodePtyBridge) || !existsSync(zcodePtyHost)) {
      throw new Error(
        "ohos-zcode-pty 编译失败（终端不可用）：需 OHOS SDK clang 与 node headers，见 build.sh。",
      );
    }
  }
  cpSync(zcodePtyBridge, join(appDir, "zcode_ohos_process.node"));
  cpSync(zcodePtyBridge, join(ohosProjectRoot, "entry", "libs", "arm64-v8a", "zcode_ohos_process.node"));
  cpSync(zcodePtyHost, join(ohosProjectRoot, "entry", "libs", "arm64-v8a", "libzcode_pty.so"));
  // 随包 zsh 在 resfile 为 noexec，镜像一份到可执行的 HAP libs（任意后缀均可 execve）。
  const bundledZsh = join(desktopRoot, "ohos", "app-assets", "zsh", "zsh");
  if (existsSync(bundledZsh)) {
    cpSync(bundledZsh, join(ohosProjectRoot, "entry", "libs", "arm64-v8a", "libzsh.so"));
  }
  log("resources", "ohos-zcode-pty staged (libzcode_pty.so + zcode_ohos_process.node)");

  const glmSource = join(desktopRoot, "bundled-agents", "linux-arm64", "glm");
  if (existsSync(glmSource)) {
    rmSync(join(resResourcesDir, "glm"), { recursive: true, force: true });
    copyPruned(glmSource, join(resResourcesDir, "glm"));
    stageFlatDotEntries(join(resResourcesDir, "glm", "packages"));
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
  // libelectron.so 的 io_uring 禁用补丁（seccomp 拒 syscall 425 → SIGSYS 击杀 NodeService）。
  // so 不入库（缺失自动获取）；v40 基线（Node 24 libuv）已移除 io_uring，补丁脚本自动跳过；
  // 其余失败必须硬失败——静默跳过在旧基线上曾产出装机必崩的包。
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
        "libelectron.so 缺失：先运行 packages/desktop/scripts/fetch-ohos-runtime.mjs；" +
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

    // OHOS 兼容（specs/ohos-port/09 §4.1.1）：上游 v3.16.1 新增的 sqlite 消费模块
    // （sqlite-migrations/backup|restore、localUsageEvidence）直接静态 import
    // "node:sqlite"，OHOS Electron（Node 20.18.1）没有该 builtin，Electron 从 ESM
    // 入口解析静态 import 时无法运行期拦截，main 进程会在窗口创建前抛
    // ERR_UNKNOWN_BUILTIN_MODULE。桌面 ESM bundle 里这三个消费模块也被 esbuild
    // 外部化保留静态 import，这里按精确模式把它们重写到一个就地惰性 shim：
    // shim 导出的 DatabaseSync 走 loadNodeSqlite() 惰性解析（OHOS 落原生绑定），
    // 模块求值顺带安装 Node 20 运行期兼容。兼容加载器走 createRequire（被运行期
    // require 钩子接管），绝不能改写，否则兼容层自己不可加载。
  }

  if (!skipAgent) {
    log("agent", "building desktop agent bundle (zcode.cjs)");
    run("node scripts/build-desktop-agent-cli.mjs", repoRoot);
    // OHOS Node 20 兼容 preload（specs/ohos-port/09 §4.1.1）：zcode.cjs 入口第一行
    // 静态 import sqlite-migrations（内部 require node:sqlite），钩子与 polyfill
    // 必须在 bundle 解析前装好。编译为自包含 CJS 落到 bundle 同目录，由
    // stage-agent-bundle 暂存、spawnZCodeAgentInProcessWorker 以 execArgv 挂载。
    const agentDistDir = join(repoRoot, "apps/zcode-cli/packages/cli/dist");
    // pnpm 布局下 esbuild 只提升到仓库根 .bin（desktop 经 tsup 传递依赖，无本地入口）。
    const esbuildBin = join(repoRoot, "node_modules/.bin/esbuild");
    run(
      [
        JSON.stringify(esbuildBin),
        JSON.stringify(join(repoRoot, "packages/shared/src/ohosNodeCompatPreload.ts")),
        "--bundle",
        "--platform=node",
        "--format=cjs",
        "--target=node20",
        `--outfile=${JSON.stringify(join(agentDistDir, "ohos-node-compat.cjs"))}`,
      ].join(" "),
      repoRoot,
    );
    run("pnpm prepare:agent-bundle", desktopRoot);
  }

  stageApp();

  // 桌面产物重写必须在 stageApp() 之后：stageApp 会 rm 重建 appDir，提前打补丁
  // 会被覆盖清空（2026-10-20 实证：顺序颠倒导致 main 进程 ERR_UNKNOWN_BUILTIN_MODULE
  // 弹窗）。只改 resfile 里的组装副本，不碰本地 out/；--skip-build 迭代时同样生效。
  patchOhosNodeSqliteStaticImports(join(appDir, "out", "main"));
  for (const graph of ["host", "scheduler"]) {
    try {
      patchOhosNodeSqliteStaticImports(join(appDir, "out", graph));
    } catch (error) {
      // host/scheduler 的 sqlite 消费链可能不进入该图（main 已崩溃前置拦截）；
      // 缺位不是产物错误，跳过即可。
      log("build", `${graph} node:sqlite rewrite skipped: ${error.message.split("\n")[0]}`);
    }
  }
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
