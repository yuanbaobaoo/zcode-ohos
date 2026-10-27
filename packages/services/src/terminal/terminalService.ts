import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, release } from "node:os";
import { dirname, resolve } from "node:path";
import { Emitter, Event } from "@zcode/rpc";
import type { IPty } from "node-pty";
import type { ISettingService } from "../setting/setting.js";
import type { OhosPtyTransport } from "./ohosTerminalPty.js";
import { TerminalExitTombstones, exitedEvent } from "./terminalExitTombstones.js";
import { isExecutable, isUsableDirectory, resolveTerminalEnv } from "./terminalEnv.js";

export { resolveTerminalEnv } from "./terminalEnv.js";
import { resolveOhosTerminalShell } from "../ohos/ohosUserShellEnv.js";
import type { ITerminalService, TerminalWindowsPtyInfo } from "./terminal.js";
import {
  resolveTerminalFontProfile,
  type TerminalFontFamilySource,
  type TerminalThemeProfile,
} from "./terminalProfile.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const logger = createServiceLogger("terminal");

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

export function parseWindowsBuildNumber(releaseText: string): number | undefined {
  const buildText = releaseText.split(".")[2];
  if (!buildText) return undefined;
  const buildNumber = Number.parseInt(buildText, 10);
  return Number.isFinite(buildNumber) ? buildNumber : undefined;
}

export function resolveTerminalWindowsPtyInfo(
  platform: NodeJS.Platform = process.platform,
  releaseText: string = release(),
): TerminalWindowsPtyInfo | undefined {
  if (platform !== "win32") return undefined;

  return {
    backend: "conpty",
    buildNumber: parseWindowsBuildNumber(releaseText),
  };
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

export function resolveTerminalShell(): string {
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

  // 鸿蒙终端 shell 决策（main 落盘的 hint）见 ohosUserShellEnv。
  const ohosShell = resolveOhosTerminalShell();
  if (ohosShell) return ohosShell;

  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) return candidate;
  }

  throw new Error("No usable shell found for terminal startup");
}

export function resolveTerminalCwd(cwd?: string): string {
  // 修复原因：工作区目录可能已经被删除、移动，或者启动时传进来的是一个失效路径。
  // 之前把这个 cwd 原样传给 node-pty，同样会在 spawn 阶段失败。
  // 这里优先使用传入目录，不可用时回退到 HOME / 系统 home / 根目录，保证终端还能拉起。
  const candidates = [cwd, process.env.HOME, homedir(), "/"];

  for (const candidate of candidates) {
    if (candidate && isUsableDirectory(candidate)) return candidate;
  }

  throw new Error("No usable working directory found for terminal startup");
}

/** 无监听者期间最多保留的 PTY 输出字符数；超出后丢弃最旧的块，保留屏幕上最可能仍可见的尾部。 */
const TERMINAL_UNSUBSCRIBED_OUTPUT_MAX_CHARS = 1_048_576;

/**
 * Bug 原因（R3 远端终端 xterm 恒空，2026-09-14）：PTY 的首批输出（bash 提示符在 spawn 后约 10ms 就到达）
 * 在 renderer 通过 create() 拿到 id 并订阅 onDynamicData 之前就已 fire，而普通 Emitter 在没有监听者时
 * 直接丢弃事件，ProxyChannel 对 onDynamicXxx 也不做缓冲。本地链路往返只有毫秒级，多数时候能抢在提示符
 * 之前订阅；远端目标经 SSH 往返 40~200ms，首个提示符必丢，之后 shell 空闲再无输出，用户看到空白终端。
 * 修法：输出的唯一来源在这里，于是在没有监听者时把输出有界缓存，监听者到来后按序回放再转直通。
 * 订阅断开（例如远端连接换代）期间同样缓存，避免重连后丢失中间输出；不依赖任何超时。
 */
function createBufferedTerminalOutputEmitter(): {
  emitter: Emitter<string>;
  push: (data: string) => void;
} {
  const pending: string[] = [];
  let pendingChars = 0;
  let hasListener = false;

  const emitter: Emitter<string> = new Emitter<string>({
    // Emitter 会先登记监听者再触发该钩子，因此这里 fire 能直接送达刚订阅的监听者。
    onWillAddFirstListener: () => {
      hasListener = true;
      const buffered = pending.splice(0);
      pendingChars = 0;
      for (const chunk of buffered) {
        emitter.fire(chunk);
      }
    },
    onDidRemoveLastListener: () => {
      hasListener = false;
    },
  });

  return {
    emitter,
    push: (data) => {
      if (hasListener) {
        emitter.fire(data);
        return;
      }
      pending.push(data);
      pendingChars += data.length;
      while (pendingChars > TERMINAL_UNSUBSCRIBED_OUTPUT_MAX_CHARS && pending.length > 1) {
        pendingChars -= pending.shift()?.length ?? 0;
      }
    },
  };
}

export function createTerminalService(dependencies: {
  settingService: ISettingService;
  /** OHOS 注入的 Main 进程 pty 中继；未注入时走本地 node-pty（桌面默认）。 */
  ptyTransport?: OhosPtyTransport;
}): ITerminalService {
  const terminals = new Map<string, TerminalInstance>();
  const recentlyExited = new TerminalExitTombstones();
  let nextId = 0;
  // 内存诊断计数器：客户端断连不回收 pty 时
  // 这里会只增不减。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("terminal", () => ({
    open: terminals.size,
  }));

  function cleanupTerminal(id: string): void {
    recentlyExited.remove(id);
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
      // 上游 buffered emitter：远端终端首批输出先缓冲再订阅，修复首帧丢失。
      // node-pty 的加载延迟到确实走本地路径时执行（OHOS 走 Main 中继 transport，
      // 无条件加载会绕过 PTY 中继并拖入不可用的 fork 路径）。
      const terminalOutput = createBufferedTerminalOutputEmitter();
      const dataEmitter = terminalOutput.emitter;
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

      p.onData((data) => terminalOutput.push(data));
      p.onExit(({ exitCode }) => {
        // cleanupTerminal 之后再到的退出不记墓碑（已显式释放）。
        if (terminals.has(id)) recentlyExited.record(id, exitCode);
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
      const terminal = terminals.get(params.id);
      // 已退出终端上的输入是良性竞态（用户打字撞上 shell 退出），丢弃即可。
      if (!terminal) {
        logger.warn(undefined, `[terminal] write on exited/unknown terminal ${params.id}`);
        return;
      }
      terminal.pty.write(params.data);
    },

    async resize(params: { id: string; cols: number; rows: number }): Promise<void> {
      const terminal = terminals.get(params.id);
      if (!terminal) {
        logger.warn(undefined, `[terminal] resize on exited/unknown terminal ${params.id}`);
        return;
      }
      terminal.pty.resize(params.cols, params.rows);
    },

    async dispose(params: { id: string }): Promise<void> {
      cleanupTerminal(params.id);
    },

    onDynamicData(id: string): Event<string> {
      const terminal = terminals.get(id);
      if (terminal) return terminal.dataEmitter.event;
      // 墓碑命中是正常竞态；完全未知的 id 才值得告警。
      if (!recentlyExited.has(id)) {
        logger.warn(undefined, `[terminal] onDynamicData for unknown terminal ${id}`);
      }
      return Event.None;
    },

    onDynamicExit(id: string): Event<number> {
      const terminal = terminals.get(id);
      if (terminal) return terminal.exitEmitter.event;
      const exitCode = recentlyExited.get(id);
      if (exitCode !== undefined) return exitedEvent(exitCode);
      logger.warn(undefined, `[terminal] onDynamicExit for unknown terminal ${id}`);
      return Event.None;
    },

    disposeAll(): void {
      memoryDiagnostics.dispose();
      recentlyExited.clear();
      // app 关闭时 host process 以前只会结束自身，terminal 里的子 shell 没有逐个显式 kill。
      // 这里补一个本地清理入口，让 host 在退出链路里能同步回收所有仍存活的终端进程。
      for (const id of Array.from(terminals.keys())) {
        cleanupTerminal(id);
      }
    },
  };

  return service;
}
