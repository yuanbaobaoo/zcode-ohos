import { app, type MessagePortMain } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IPty } from "node-pty";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  describeNativeProcessBridgeError,
  loadNativeProcessBridge,
} from "./ohosNativeChildProcess.js";
import { isOhosRuntime } from "@zcode/shared";
import type {
  OhosPtyHostToMainMessage,
  OhosPtyMainToHostMessage,
} from "@zcode/services/terminal/ohosTerminalPty";

// OHOS 终端 pty 中继（Main 侧）：Host 的 forkpty 被 /dev/ptmx SELinux 拒，伪终端与 shell
// 由 Main 创建、经专用 MessagePort 与 Host 通信（协议见 ohosTerminalPty.ts）；ptmx 被拒时
// 降级哑终端（无全屏交互）。仅 OHOS 启用，桌面仍走 Host node-pty。

interface RelayDependencies {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

/**
 * main 域直接托管的 shell（默认路径）：main 视图有 `/usr/bin/zsh`（与 HiShell 同域，
 * 登录 shell 快照也在这里采集），不受 native child 域「禁止 exec 非系统 ELF」限制。
 * 无 tty（ptmx 被拒）：行级回显仍在本地补。
 */
class MainPipeShellSession implements IPty {
  readonly cols = 0;
  readonly rows = 0;
  readonly process: string;
  readonly handleFlowControl = false;
  #dataListener?: (data: string) => unknown;
  #exitListener?: (event: { exitCode: number }) => unknown;
  #closed = false;
  #lastOutputChar = "";

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    processName: string,
  ) {
    this.process = processName;
    const onData = (chunk: Buffer | string) => {
      this.#dataListener?.(this.#normalizeOutput(chunk.toString()));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", () => this.finish(1));
    child.once("close", (code) => this.finish(code ?? 1));
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  // 无 tty 就没有内核 ONLCR：输出的 \n 补 \r（spec 09 §12.9）。
  #normalizeOutput(chunk: string): string {
    let output = "";
    for (const char of chunk) {
      if (char === "\n" && this.#lastOutputChar !== "\r") {
        output += "\r";
      }
      output += char;
      this.#lastOutputChar = char;
    }
    return output;
  }

  private finish(exitCode: number): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#exitListener?.({ exitCode });
  }

  write(data: string | Buffer): void {
    const text = typeof data === "string" ? data : data.toString("utf8");
    const { echo, toShell } = echoTransform(text);
    if (echo) this.#dataListener?.(echo);
    if (toShell && !this.child.stdin.destroyed) this.child.stdin.write(toShell);
  }

  resize(): void {
    /* 无 tty：尺寸仅影响渲染端。 */
  }

  clear(): void {
    /* 渲染层职责。 */
  }

  pause(): void {
    this.child.stdout.pause();
    this.child.stderr.pause();
  }

  resume(): void {
    this.child.stdout.resume();
    this.child.stderr.resume();
  }

  kill(signal?: string): void {
    try {
      this.child.kill((signal ?? "SIGTERM") as NodeJS.Signals);
    } catch {
      /* 子进程已退出。 */
    }
    this.child.stdin.destroy();
  }

  readonly onData = (listener: (data: string) => unknown): { dispose(): void } => {
    this.#dataListener = listener;
    return { dispose: () => (this.#dataListener = undefined) };
  };

  readonly onExit = (listener: (event: { exitCode: number }) => unknown): { dispose(): void } => {
    this.#exitListener = listener;
    return { dispose: () => (this.#exitListener = undefined) };
  };
}

// main 视图内的 shell 候选：系统 zsh（HiShell 同款）→ host 下发的 shell → /bin/sh。
function resolveMainShellHosted(preferred: string): string {
  for (const candidate of ["/usr/bin/zsh", preferred, "/bin/sh"]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "/bin/sh";
}

async function spawnMainProcessShell(params: {
  shell: string;
  cwd: string;
  env: Record<string, string | undefined>;
}): Promise<MainPipeShellSession> {
  const shell = resolveMainShellHosted(params.shell);
  const args = shell.endsWith("zsh") ? ["-il"] : ["-i"];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(params.env)) {
    if (typeof value === "string" && value && !/[\n\r]/.test(value)) env[key] = value;
  }
  env.TERM = env.TERM ?? "xterm-256color";
  const child = spawn(shell, args, {
    cwd: params.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    child.once("error", onError);
    child.once("spawn", () => {
      child.removeListener("error", onError);
      resolve();
    });
  });
  return new MainPipeShellSession(child, shell);
}

/** 无 tty 环境的行级回显：把用户按键转成可见输出（shell 在管道 stdin 上不做 echo）。 */
function echoTransform(chunk: string): { echo: string; toShell: string } {
  let echo = "";
  let toShell = "";
  for (const ch of chunk) {
    if (ch === "\r") {
      echo += "\r\n";
      toShell += "\n";
    } else if (ch === "\u007f") {
      // DEL/退格：光标左移一格并清字符（xterm 会解释 \b）。
      echo += "\b \b";
    } else {
      echo += ch;
      toShell += ch;
    }
  }
  return { echo, toShell };
}

/** 原生子进程 shell 会话（IPty 面）：unix socket + 本地回显（无 tty）。 */
class NativeChildShellSession implements IPty {
  readonly cols = 0;
  readonly rows = 0;
  readonly process: string;
  readonly handleFlowControl = false;
  #dataListener?: (data: string) => unknown;
  #exitListener?: (event: { exitCode: number }) => unknown;
  #closed = false;
  #lastOutputChar = "";

  constructor(
    readonly pid: number,
    private readonly socket: Socket,
    processName: string,
  ) {
    this.process = processName;
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.#dataListener?.(this.#normalizeOutput(chunk)));
    this.socket.on("close", () => this.finish(0));
    this.socket.on("error", () => this.finish(1));
  }

  // 无 tty 就没有内核 ONLCR：shell 输出的 \n 要补 \r，否则光标停在上一行列尾，
  // 后续每一行都会向右累积缩进（spec 09 §12.9）。
  #normalizeOutput(chunk: string): string {
    let output = "";
    for (const char of chunk) {
      if (char === "\n" && this.#lastOutputChar !== "\r") {
        output += "\r";
      }
      output += char;
      this.#lastOutputChar = char;
    }
    return output;
  }

  private finish(exitCode: number): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#exitListener?.({ exitCode });
  }

  write(data: string | Buffer): void {
    const text = typeof data === "string" ? data : data.toString("utf8");
    const { echo, toShell } = echoTransform(text);
    if (echo) this.#dataListener?.(echo);
    if (toShell && !this.socket.destroyed) this.socket.write(toShell);
  }

  resize(): void {
    /* 无 tty：尺寸仅影响渲染端。 */
  }

  clear(): void {
    /* 渲染层职责。 */
  }

  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  kill(signal?: string): void {
    try {
      process.kill(this.pid, (signal ?? "SIGTERM") as NodeJS.Signals);
    } catch {
      /* 子进程已退出。 */
    }
    this.socket.destroy();
  }

  readonly onData = (listener: (data: string) => unknown): { dispose(): void } => {
    this.#dataListener = listener;
    return { dispose: () => (this.#dataListener = undefined) };
  };

  readonly onExit = (listener: (event: { exitCode: number }) => unknown): { dispose(): void } => {
    this.#exitListener = listener;
    return { dispose: () => (this.#exitListener = undefined) };
  };
}

// v40 主进程 spawn 会被沙箱击杀（spec 09 §12.6），终端只走官方原生子进程通道：
// 主进程先 listen unix socket，再让 appspawn 拉起 libzcode_pty.so，子进程连回后 exec shell。
const ENV_MARKER = "@@ZCODE_ENV@@";
const MAX_ENV_LINES_BYTES = 48 * 1024;

function buildNativeShellEntryParams(input: {
  socketPath: string;
  shell: string;
  cwd: string;
  shellArgs: string[];
  env: Record<string, string | undefined>;
}): string {
  const env: Record<string, string | undefined> = { ...input.env };
  const envLines: string[] = [];
  let bytes = 0;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || !value || /[\n\r]/.test(value)) continue;
    const line = `${key}=${value}`;
    if (bytes + line.length > MAX_ENV_LINES_BYTES) continue;
    bytes += line.length + 1;
    envLines.push(line);
  }
  // 行式协议：socket / shell / cwd / argv... / marker / env...；子进程 exec 前应用 env。
  return [
    input.socketPath,
    input.shell,
    input.cwd,
    ...input.shellArgs,
    ENV_MARKER,
    ...envLines,
  ].join("\n");
}

function spawnNativeChildShell(params: {
  shell: string;
  cwd: string;
  env: Record<string, string | undefined>;
}): Promise<NativeChildShellSession> {
  return new Promise<NativeChildShellSession>((resolve, reject) => {
    const bridge = loadNativeProcessBridge();
    if (!bridge) {
      reject(new Error(`native child bridge unavailable: ${describeNativeProcessBridgeError()}`));
      return;
    }
    const socketDir = join(app.getPath("userData"), "zcode-pty");
    mkdirSync(socketDir, { recursive: true });
    const socketPath = join(socketDir, `${process.pid}-${Date.now()}.sock`);
    rmSync(socketPath, { force: true });

    const server: Server = createServer();
    let childPid = -1;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      rmSync(socketPath, { force: true });
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("native child connect timeout")), 5000);
    server.once("error", fail);
    server.listen(socketPath, () => {
      const shellArgs = params.shell.includes("zsh") ? ["-il"] : ["-i"];
      const entryParams = buildNativeShellEntryParams({
        socketPath,
        shell: params.shell,
        cwd: params.cwd,
        shellArgs,
        env: params.env,
      });
      childPid = bridge.startNativeProcess(entryParams);
      if (childPid <= 0) {
        fail(new Error(`StartNativeChildProcess failed: ${childPid}`));
      }
    });
    server.once("connection", (socket: Socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      rmSync(socketPath, { force: true });
      resolve(new NativeChildShellSession(childPid, socket, params.shell));
    });
  });
}

export function shouldAttachTerminalPtyRelay(): boolean {
  if (!isOhosRuntime()) return false;
  // 诊断开关：v40 上主进程 spawn 会被沙箱静默击杀（见 spec 09 §12.5），
  // ZCODE_OHOS_TERMINAL_RELAY=0 可临时禁用中继保应用可用（终端退化为报错）。
  const value = process.env.ZCODE_OHOS_TERMINAL_RELAY?.trim().toLowerCase();
  return value !== "0" && value !== "false";
}

export function attachTerminalPtyRelay(
  port: MessagePortMain,
  dependencies: RelayDependencies,
): void {
  const sessions = new Map<string, IPty>();
  let nextSessionId = 0;

  port.on("message", (event: Electron.MessageEvent) => {
    const message = event.data as OhosPtyHostToMainMessage;
    void (async () => {
      if (message.type === "ohos-pty/spawn") {
        const sessionId = String(++nextSessionId);
        const postExit = (exitCode: number) => {
          sessions.delete(sessionId);
          port.postMessage({
            type: "ohos-pty/exit",
            sessionId,
            exitCode,
          } satisfies OhosPtyMainToHostMessage);
        };
        const attach = (
          pty: IPty,
          mode: "pty" | "pipe" | "native-child" | "main-shell",
          shell = message.shell,
        ) => {
          sessions.set(sessionId, pty);
          pty.onData((data) =>
            port.postMessage({
              type: "ohos-pty/data",
              sessionId,
              data,
            } satisfies OhosPtyMainToHostMessage),
          );
          pty.onExit(({ exitCode }) => postExit(exitCode));
          dependencies.logger.info(
            `[ohos-pty] session ${sessionId} spawned (${mode}) shell=${shell} pid=${pty.pid}`,
          );
          port.postMessage({
            type: "ohos-pty/spawned",
            requestId: message.requestId,
            sessionId,
            pid: pty.pid,
          } satisfies OhosPtyMainToHostMessage);
        };

        // 默认走 main 域托管 shell（有 /usr/bin/zsh，与 HiShell/快照同域）；诊断或
        // 平台回归时 ZCODE_OHOS_TERMINAL_MAIN_SPAWN=0 退回 native child 通道。
        const useMainSpawn = process.env.ZCODE_OHOS_TERMINAL_MAIN_SPAWN !== "0";
        try {
          const session = useMainSpawn
            ? await spawnMainProcessShell({
                shell: message.shell,
                cwd: message.cwd,
                env: message.env,
              })
            : await spawnNativeChildShell({
                shell: message.shell,
                cwd: message.cwd,
                env: message.env,
              });
          attach(session, useMainSpawn ? "main-shell" : "native-child", session.process);
        } catch (error) {
          const failure = `native child shell failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          dependencies.logger.error(`[ohos-pty] ${failure}`);
          port.postMessage({
            type: "ohos-pty/spawn-failed",
            requestId: message.requestId,
            message: failure,
          } satisfies OhosPtyMainToHostMessage);
        }
        return;
      }

      const session = sessions.get(message.sessionId);
      if (!session) return;
      if (message.type === "ohos-pty/write") session.write(message.data);
      else if (message.type === "ohos-pty/resize") {
        try {
          session.resize(message.cols, message.rows);
        } catch (error) {
          // 会话退出竞态下的 resize 失败是良性噪声，不中断中继。
          dependencies.logger.warn(`[ohos-pty] resize failed on ${message.sessionId}:`, error);
        }
      } else if (message.type === "ohos-pty/kill") {
        try {
          session.kill();
        } finally {
          sessions.delete(message.sessionId);
        }
      }
    })();
  });
  port.start();
}
