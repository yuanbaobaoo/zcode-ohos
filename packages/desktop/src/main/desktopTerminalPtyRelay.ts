import { app, type MessagePortMain } from "electron";
import type { IPty } from "node-pty";
import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
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
function spawnNativeChildShell(params: {
  shell: string;
  cwd: string;
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
      const entryParams = [socketPath, params.shell, params.cwd, ...shellArgs].join("\n");
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
          mode: "pty" | "pipe" | "native-child",
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

        // v40 主进程 spawn 会被沙箱击杀（spec 09 §12.6），终端只走官方原生子进程通道。
        try {
          const nativeSession = await spawnNativeChildShell({
            shell: message.shell,
            cwd: message.cwd,
          });
          attach(nativeSession, "native-child", message.shell);
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
