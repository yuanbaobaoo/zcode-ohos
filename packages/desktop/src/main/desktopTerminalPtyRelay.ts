import type { MessagePortMain } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IPty } from "node-pty";
import { existsSync } from "node:fs";
import { isOhosRuntime } from "@zcode/shared";
import { isOhosEmulatorRuntime } from "./desktopOhosDeviceProfile.js";
import type {
  OhosPtyHostToMainMessage,
  OhosPtyMainToHostMessage,
} from "@zcode/services/terminal/ohosTerminalPty";

// OHOS 终端中继（Main 侧）：Host 的 forkpty 被 /dev/ptmx SELinux 拒，shell 由 Main 域
// 托管、经专用 MessagePort 与 Host 通信（协议见 ohosTerminalPty.ts）；无 tty 时降级为
// 管道哑终端（无全屏交互）。仅 OHOS 启用，桌面仍走 Host node-pty。

interface RelayDependencies {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

/**
 * main 域直接托管的 shell：main 视图有系统 `/usr/bin/zsh`，登录 shell 快照也在同域采集；
 * Host/native child 域没有 `/usr/bin` 且禁止 exec 非系统 ELF。
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

export function shouldAttachTerminalPtyRelay(): boolean {
  if (!isOhosRuntime()) return false;
  // 模拟器沙箱拒绝应用进程 fork+exec：main 域 spawn 会 SIGABRT 击杀整个应用
  // （specs/ohos-port/03、09 §12.6）。模拟器上不挂中继，终端由 host 走 node-pty 失败但
  // 应用存活；真机异步 spawn 可用，继续由 main 托管系统 zsh（spec 02）。
  return !isOhosEmulatorRuntime();
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
        const attach = (pty: IPty, shell = message.shell) => {
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
            `[ohos-pty] session ${sessionId} spawned (main-shell) shell=${shell} pid=${pty.pid}`,
          );
          port.postMessage({
            type: "ohos-pty/spawned",
            requestId: message.requestId,
            sessionId,
            pid: pty.pid,
          } satisfies OhosPtyMainToHostMessage);
        };

        // 终端 shell 由 main 域托管：系统 zsh 只在该域可见，登录 shell 快照也在
        // 同域采集（spec 02）。
        try {
          const session = await spawnMainProcessShell({
            shell: message.shell,
            cwd: message.cwd,
            env: message.env,
          });
          attach(session, session.process);
        } catch (error) {
          const failure = `main shell failed: ${
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
