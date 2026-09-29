import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, release } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { Emitter, type Event } from "@zcode/rpc";
import { isOhosRuntime } from "@zcode/shared";
import type { IPty } from "node-pty";
import type { ISettingService } from "../setting/setting.js";
import type { OhosPtyTransport } from "./ohosTerminalPty.js";
import type { ITerminalService, TerminalWindowsPtyInfo } from "./terminal.js";
import {
  resolveTerminalFontProfile,
  type TerminalFontFamilySource,
  type TerminalThemeProfile,
} from "./terminalProfile.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

const require = createRequire(import.meta.url);
type NodePtyModule = typeof import("node-pty");
type PtySpawnOptions = Parameters<NodePtyModule["spawn"]>[2];

interface TerminalInstance {
  pty: IPty;
  dataEmitter: Emitter<string>;
  exitEmitter: Emitter<number>;
}

let hasEnsuredNodePtyHelper = false;
let nodePtyModulePromise: Promise<NodePtyModule> | null = null;

async function loadNodePtyModule(): Promise<NodePtyModule> {
  if (!nodePtyModulePromise) {
    nodePtyModulePromise = import("node-pty").catch((error: unknown) => {
      nodePtyModulePromise = null;
      const message = error instanceof Error ? error.message : String(error);
      // remote server 启动时会先创建所有服务，之前这里顶层 import node-pty，
      // 只要当前平台缺少 pty.node，就会在服务注册阶段直接崩掉，整条远程连接链路都失败。
      // 改成延迟加载后，server 可以先完成握手，仅在真正创建终端时再暴露“terminal 不可用”的错误。
      throw new Error(`node-pty is unavailable in this runtime: ${message}`);
    }) as Promise<NodePtyModule>;
  }

  return nodePtyModulePromise;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseWindowsBuildNumber(releaseText: string): number | undefined {
  const buildText = releaseText.split(".")[2];
  if (!buildText) return undefined;
  const buildNumber = Number.parseInt(buildText, 10);
  return Number.isFinite(buildNumber) ? buildNumber : undefined;
}

function resolveTerminalWindowsPtyInfo(
  platform: NodeJS.Platform = process.platform,
  releaseText: string = release(),
): TerminalWindowsPtyInfo | undefined {
  if (platform !== "win32") return undefined;

  return {
    backend: "conpty",
    buildNumber: parseWindowsBuildNumber(releaseText),
  };
}

function isExecutable(command: string): boolean {
  try {
    if (/[\\/]/.test(command)) {
      accessSync(command, constants.X_OK);
      return true;
    }

    const pathEnv = process.env.PATH;
    if (!pathEnv) return false;

    return pathEnv.split(delimiter).some((dir) => {
      if (!dir) return false;
      try {
        accessSync(join(dir, command), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function isUsableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveNodePtySpawnHelperPath(): string | null {
  if (process.platform !== "darwin") return null;

  try {
    const utils = require("node-pty/lib/utils") as {
      loadNativeModule(name: string): { dir: string };
    };
    const native = utils.loadNativeModule("pty");
    const unixTerminalPath = require.resolve("node-pty/lib/unixTerminal.js");

    let helperPath = resolve(dirname(unixTerminalPath), `${native.dir}/spawn-helper`);
    helperPath = helperPath.replace("app.asar", "app.asar.unpacked");
    helperPath = helperPath.replace("node_modules.asar", "node_modules.asar.unpacked");
    return helperPath;
  } catch {
    return null;
  }
}

function ensureNodePtySpawnHelperExecutable(): void {
  if (hasEnsuredNodePtyHelper || process.platform !== "darwin") return;
  hasEnsuredNodePtyHelper = true;

  const helperPath = resolveNodePtySpawnHelperPath();
  if (!helperPath || !existsSync(helperPath)) return;

  try {
    accessSync(helperPath, constants.X_OK);
    return;
  } catch {
    // 当前环境里的 node-pty spawn-helper 丢了执行权限，
    // child_process.spawn 还能工作，但 node-pty 在 macOS 上启动伪终端时会先调用这个 helper，
    // helper 不可执行就会直接报 posix_spawnp failed。
    // 这里在真正 spawn 前把 helper 修正为 0755，避免终端因为安装产物权限漂移而无法打开。
  }

  try {
    chmodSync(helperPath, 0o755);
    accessSync(helperPath, constants.X_OK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`node-pty spawn-helper is not executable: ${helperPath}. ${message}`);
  }
}

function shouldFallbackFromConptyDll(error: unknown): boolean {
  const message = getErrorMessage(error);
  return /conpty\.node module handle|conpty\.node module file name|cannot find conpty\.dll|error code:\s*126/i.test(
    message,
  );
}

function isUtf8Locale(value: string | undefined): boolean {
  return /utf-?8/i.test(value ?? "");
}

function isMissingOrCLocale(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized === "" || normalized === "C" || normalized === "POSIX";
}

const DARWIN_GUI_FALLBACK_PATHS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
] as const;

// 鸿蒙（openharmony）终端环境：
// - GUI 应用拿不到登录 shell 环境（HiShell 的 PATH/变量不会注入应用沙箱），终端里看不到
//   harmonybrew（brew）安装的工具；按用户约定把 `$HOME/.harmonybrew/bin` 前置进终端 PATH。
//   应用沙箱内 HOME 可能被重定向（不可写真实 home），所以允许主进程通过
//   ZCODE_OHOS_BREW_PREFIX 显式指定真实用户的 brew 前缀（/storage/Users/<user>/.harmonybrew），
//   未设置时退回当前 HOME 下的 .harmonybrew（开发/HiShell 场景即真实路径）。
// - PATH 只在传给终端 spawn 的环境里前置，不改全局 process.env，与 macOS 分支的边界一致。
const OHOS_HARMONYBREW_DIR_NAME = ".harmonybrew";

function resolveOhosBrewPrefix(env: NodeJS.ProcessEnv): string {
  const override = env.ZCODE_OHOS_BREW_PREFIX;
  if (override && override.trim()) return override;
  return join(homedir(), OHOS_HARMONYBREW_DIR_NAME);
}

function resolveOhosTerminalPath(env: NodeJS.ProcessEnv): string {
  const prefix = resolveOhosBrewPrefix(env);
  return mergePathEntries([join(prefix, "bin"), join(prefix, "sbin"), env.PATH]);
}

// 随包 zsh 的 ncurses/tinfo 依赖目录（与 zsh 二进制同级的 lib/）。
// 应用沙箱的 ldso 不会从用户目录加载 .so，zsh 必须用随包依赖库。
function resolveOhosTerminalLibraryPath(env: NodeJS.ProcessEnv): string | undefined {
  const shell = env.ZCODE_OHOS_SHELL;
  if (!shell) return undefined;
  const libDir = join(dirname(shell), "lib");
  return isUsableDirectory(libDir) ? libDir : undefined;
}

function mergePathEntries(entries: readonly (string | undefined)[]): string {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const value of entries) {
    for (const entry of value?.split(delimiter) ?? []) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }

  return merged.join(delimiter);
}

function resolveDarwinTerminalPath(env: NodeJS.ProcessEnv): string {
  return mergePathEntries([env.PATH, ...DARWIN_GUI_FALLBACK_PATHS]);
}

function resolveFallbackUtf8Locale(env: NodeJS.ProcessEnv): string {
  const inheritedUtf8Locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(isUtf8Locale);
  if (inheritedUtf8Locale) return inheritedUtf8Locale;

  return process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

function resolveTerminalEnv(
  env: NodeJS.ProcessEnv = process.env,
  shell?: string,
): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  const fallbackLocale = resolveFallbackUtf8Locale(env);

  // macOS 从 Dock/Finder/登录项启动 Electron 时，父进程通常只带 /usr/bin:/bin:/usr/sbin:/sbin，
  // 甚至缺失 PATH；内置终端虽然打开了登录 shell，但 zsh/bash 仍会先继承这个过窄 PATH，
  // 导致 ls 以外的 npm/node/pnpm 等常用命令找不到，部分用户的 profile 又不会重新补齐。
  // 这里仅在传给 terminal 的环境里补常见 Homebrew 与系统路径，不改全局 process.env，并保留用户已有顺序。
  if (process.platform === "darwin") {
    nextEnv.PATH = resolveDarwinTerminalPath(env);
  }

  // 鸿蒙应用启动时同样继承不到 HiShell 的登录环境，终端里 harmonybrew 的 node/git 等
  // 全部不可见；前置 brew bin/sbin（等价 `export PATH="$HOME/.harmonybrew/bin:$PATH"`）。
  if (isOhosRuntime()) {
    nextEnv.PATH = resolveOhosTerminalPath(env);
    // 随包 zsh 的依赖库目录前置到 LD_LIBRARY_PATH（不覆盖已有条目顺序之外的部分）。
    const zshLibDir = resolveOhosTerminalLibraryPath(env);
    if (zshLibDir) {
      nextEnv.LD_LIBRARY_PATH = mergePathEntries([zshLibDir, env.LD_LIBRARY_PATH]);
    }
    // 终端 spawn 已显式指定 shell 路径，SHELL 变量供嵌套 shell 与工具（zsh 启动脚本、
    // starship 等）识别当前 shell；仅在缺失或指向不可用路径时回填，不覆盖用户显式配置。
    if (shell && (!nextEnv.SHELL || (nextEnv.SHELL !== shell && !isExecutable(nextEnv.SHELL)))) {
      nextEnv.SHELL = shell;
    }
  }

  // runtime 登录 shell 环境采集会用 TERM=dumb / CI=1 来避免 profile 脚本进入交互分支，
  // 但真实 terminal panel 必须作为交互终端启动，否则 starship、p10k、颜色能力检测等会降级成无样式输出。
  nextEnv.TERM = "xterm-256color";
  nextEnv.COLORTERM = nextEnv.COLORTERM?.trim() || "truecolor";
  if (nextEnv.CI === "1" && env.TERM === "dumb") {
    delete nextEnv.CI;
  }

  // Electron 从 GUI 启动时 host process 可能继承不到登录 shell 的 UTF-8 locale，
  // 子 shell 会落到 C/POSIX locale，中文路径会被 zsh/bash 显示成 \M-^ 这类转义乱码。
  // 这里只在 locale 缺失或明确为 C/POSIX 时补 UTF-8，保留用户已经配置好的 UTF-8 locale。
  if (isMissingOrCLocale(nextEnv.LANG)) {
    nextEnv.LANG = fallbackLocale;
  }
  if (isMissingOrCLocale(nextEnv.LC_CTYPE)) {
    nextEnv.LC_CTYPE = fallbackLocale;
  }
  if (nextEnv.LC_ALL !== undefined && isMissingOrCLocale(nextEnv.LC_ALL)) {
    nextEnv.LC_ALL = fallbackLocale;
  }

  return nextEnv;
}

function spawnTerminalProcess(params: {
  nodePty: NodePtyModule;
  shell: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): IPty {
  const { nodePty, shell, cols, rows, cwd, env } = params;

  if (process.platform !== "win32") {
    return nodePty.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
      encoding: "utf8",
    });
  }

  const windowsBaseOptions = {
    useConpty: true,
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env,
    encoding: "utf8",
  } satisfies PtySpawnOptions;

  try {
    return nodePty.spawn(shell, [], {
      ...windowsBaseOptions,
      useConptyDll: true,
    });
  } catch (error) {
    if (!shouldFallbackFromConptyDll(error)) {
      throw error;
    }

    // Windows 下开启 node-pty 的实验性 useConptyDll 时，某些 Electron/安装包环境会在 shell 真正启动前
    // 就因为 conpty.node / conpty.dll 的原生模块定位失败直接报错，导致终端整个打不开。
    // 这里仅在命中这类 DLL 加载错误时回退到系统内置 ConPTY，既保留新版路径的优先级，也避免把普通启动失败误判成可重试。
    return nodePty.spawn(shell, [], {
      ...windowsBaseOptions,
      useConptyDll: false,
    });
  }
}

function resolveTerminalShell(): string {
  if (process.platform === "win32") {
    // Windows PowerShell 5.1 的 PSReadLine 在 ConPTY 下更容易把输入行空白重绘成 ANSI black 背景。
    // PowerShell 7+ 的终端兼容性更接近桌面端，优先使用已安装的 pwsh，找不到再回退到系统自带 shell。
    const candidates = ["pwsh.exe", "powershell.exe", process.env.ComSpec, "cmd.exe"];

    for (const candidate of candidates) {
      if (candidate && isExecutable(candidate)) return candidate;
    }

    throw new Error("No usable Windows shell found for terminal startup");
  }

  // 之前直接信任 SHELL 环境变量，外部环境如果残留了一个不存在的 shell 路径，
  // node-pty 底层会把这个坏路径直接交给 posix_spawnp，终端创建时就会报错。
  // 这里先校验 SHELL 是否真的可执行，不可用时再按常见 shell 顺序回退，避免启动直接失败。
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];

  // 鸿蒙沙箱内系统 rootfs 的 /usr/bin/zsh 对应用不可见，可用 zsh 以应用资产形式随包分发；
  // 主进程解析出随包 zsh 路径后通过 ZCODE_OHOS_SHELL 注入（$SHELL 在沙箱里通常是 toybox sh
  // 或缺失）。候选顺序：随包 zsh → $SHELL → 系统 zsh → bash → sh。
  if (isOhosRuntime()) {
    candidates.unshift(process.env.ZCODE_OHOS_SHELL, "/usr/bin/zsh");
  }

  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) return candidate;
  }

  throw new Error("No usable shell found for terminal startup");
}

function resolveTerminalCwd(cwd?: string): string {
  // 工作区目录可能已经被删除、移动，或者启动时传进来的是一个失效路径。
  // 之前把这个 cwd 原样传给 node-pty，同样会在 spawn 阶段失败。
  // 这里优先使用传入目录，不可用时回退到 HOME / 系统 home / 根目录，保证终端还能拉起。
  const candidates = [cwd, process.env.HOME, homedir(), "/"];

  for (const candidate of candidates) {
    if (candidate && isUsableDirectory(candidate)) return candidate;
  }

  throw new Error("No usable working directory found for terminal startup");
}

export function createTerminalService(dependencies: {
  settingService: ISettingService;
  /** OHOS 注入的 Main 进程 pty 中继；未注入时走本地 node-pty（桌面默认）。 */
  ptyTransport?: OhosPtyTransport;
}): ITerminalService {
  const terminals = new Map<string, TerminalInstance>();
  let nextId = 0;
  // 内存诊断计数器：客户端断连不回收 pty 时
  // 这里会只增不减。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("terminal", () => ({
    open: terminals.size,
  }));

  function getTerminal(id: string): TerminalInstance {
    const t = terminals.get(id);
    if (!t) throw new Error(`Terminal not found: ${id}`);
    return t;
  }

  function cleanupTerminal(id: string): void {
    const terminal = terminals.get(id);
    if (!terminal) {
      return;
    }

    terminal.pty.kill();
    terminal.dataEmitter.dispose();
    terminal.exitEmitter.dispose();
    terminals.delete(id);
  }

  const service: ITerminalService & { disposeAll(): void } = {
    async create(params: { cols: number; rows: number; cwd?: string }): Promise<{
      id: string;
      shell: string;
      fontFamily: string;
      fontSize?: number;
      theme?: TerminalThemeProfile;
      fontFamilySource: TerminalFontFamilySource;
      windowsPty?: TerminalWindowsPtyInfo;
    }> {
      const id = String(nextId++);
      const shell = resolveTerminalShell();
      const cwd = resolveTerminalCwd(params.cwd);
      const env = resolveTerminalEnv(process.env, shell);
      const terminalProfileSettings = await dependencies.settingService.get().catch(() => ({
        terminalFontFamily: undefined,
        terminalInheritSystemProfile: true,
      }));
      const fontProfile = resolveTerminalFontProfile({
        settings: terminalProfileSettings,
        env: process.env,
      });
      const dataEmitter = new Emitter<string>();
      const exitEmitter = new Emitter<number>();

      let p: IPty;
      try {
        // OHOS：utility 进程禁止 fork（forkpty(3) 失败），pty 由 Main 进程创建并经
        // 专用 MessagePort 中继（ohosTerminalPty）；其余平台保持本地 node-pty。
        if (dependencies.ptyTransport) {
          p = await dependencies.ptyTransport.spawn({
            shell,
            cols: params.cols,
            rows: params.rows,
            cwd,
            env,
            name: "xterm-256color",
          });
        } else {
          const nodePty = await loadNodePtyModule();
          ensureNodePtySpawnHelperExecutable();
          p = spawnTerminalProcess({
            nodePty,
            shell,
            cols: params.cols,
            rows: params.rows,
            cwd,
            env,
          });
        }
      } catch (error) {
        throw new Error(
          `Failed to start terminal with shell '${shell}' in '${cwd}': ${getErrorMessage(error)}`,
        );
      }

      p.onData((data) => dataEmitter.fire(data));
      p.onExit(({ exitCode }) => {
        exitEmitter.fire(exitCode);
        dataEmitter.dispose();
        exitEmitter.dispose();
        terminals.delete(id);
      });

      terminals.set(id, { pty: p, dataEmitter, exitEmitter });
      return {
        id,
        shell,
        fontFamily: fontProfile.fontFamily,
        fontSize: fontProfile.fontSize,
        theme: fontProfile.theme,
        fontFamilySource: fontProfile.source,
        windowsPty: resolveTerminalWindowsPtyInfo(),
      };
    },

    async write(params: { id: string; data: string }): Promise<void> {
      getTerminal(params.id).pty.write(params.data);
    },

    async resize(params: { id: string; cols: number; rows: number }): Promise<void> {
      getTerminal(params.id).pty.resize(params.cols, params.rows);
    },

    async dispose(params: { id: string }): Promise<void> {
      cleanupTerminal(params.id);
    },

    onDynamicData(id: string): Event<string> {
      return getTerminal(id).dataEmitter.event;
    },

    onDynamicExit(id: string): Event<number> {
      return getTerminal(id).exitEmitter.event;
    },

    disposeAll(): void {
      memoryDiagnostics.dispose();
      // app 关闭时 host process 以前只会结束自身，terminal 里的子 shell 没有逐个显式 kill。
      // 这里补一个本地清理入口，让 host 在退出链路里能同步回收所有仍存活的终端进程。
      for (const id of Array.from(terminals.keys())) {
        cleanupTerminal(id);
      }
    },
  };

  return service;
}
