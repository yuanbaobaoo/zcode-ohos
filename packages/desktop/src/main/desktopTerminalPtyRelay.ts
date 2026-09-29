import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { IPty } from "node-pty";
import type { MessagePortMain } from "electron";
import { isOhosRuntime } from "@zcode/shared";
import type {
  OhosPtyHostToMainMessage,
  OhosPtyMainToHostMessage,
} from "@zcode/services/terminal/ohosTerminalPty";

// OHOS 终端 pty 中继（Main 侧）。
//
// utility 进程（Host）在 OHOS 沙箱内 forkpty(3) 返回 -1（/dev/ptmx 对应用域
// Permission denied，SELinux 管控；fork+exec 本身可用——实测探针实证），伪终端
// 与 shell 均由 Main 进程创建并经专用 MessagePortMain 与 Host 侧
// createOhosPtyRelayClient 通信（协议见 services/terminal/ohosTerminalPty.ts）。
//
// 两级策略：
// 1. 首选 node-pty（真 pty）——若系统开放 ptmx（未来版本或特殊设备域）直接全功能；
// 2. pty 被拒时降级为「stdio 管道 + 应用层回显」的哑终端（社区 Terminator 同款
//    方案）：sh 照常执行命令与彩色输出，行编辑/回显由本层补齐，代价是无
//    vim/top 等全屏交互（无 TIOCSCTTY，社区结论一致）。
// 仅 OHOS 启用；桌面平台终端仍走 Host 本地 node-pty，不受本文件影响。

interface RelayDependencies {
  loadNodePty: () => Promise<typeof import("node-pty")>;
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

/** 管道形态的 shell 会话（IPty 面）：spawn -i 的 sh + stdio 管道 + 本地回显。 */
class PipeShellSession implements IPty {
  readonly pid: number;
  readonly cols = 0;
  readonly rows = 0;
  readonly process: string;
  readonly handleFlowControl = false;
  #dataListener?: (data: string) => unknown;
  #exitListener?: (event: { exitCode: number }) => unknown;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onExit: (session: PipeShellSession) => void,
  ) {
    this.pid = child.pid ?? -1;
    this.process = child.spawnfile;
    const forward = (stream: NodeJS.ReadableStream) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => this.#dataListener?.(chunk));
    };
    forward(child.stdout);
    forward(child.stderr);
    child.on("exit", (code) => {
      this.#exitListener?.({ exitCode: code ?? 0 });
      this.onExit(this);
    });
  }

  write(data: string | Buffer): void {
    const text = typeof data === "string" ? data : data.toString("utf8");
    const { echo, toShell } = echoTransform(text);
    if (echo) this.#dataListener?.(echo);
    if (toShell) this.child.stdin.write(toShell);
  }

  resize(): void {
    /* 无 tty：尺寸仅影响渲染端，shell 侧无窗口概念。 */
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
    this.child.kill(signal ?? "SIGTERM");
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

export function shouldAttachTerminalPtyRelay(): boolean {
  return isOhosRuntime();
}

function spawnPipeShell(params: {
  shell: string;
  cwd: string;
  env: Record<string, string | undefined>;
}): PipeShellSession {
  const child = spawn(params.shell, ["-i"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: params.cwd,
    env: params.env as Record<string, string>,
  }) as ChildProcessWithoutNullStreams;
  return new PipeShellSession(child, (session) => void session);
}

/** 一次性环境探针（装机排障）：ptmx 可开性 / 系统 zsh / brew 工具 exec / sh -i 行为。 */
async function runEnvironmentProbe(
  run: (command: string) => Promise<string>,
  logger: RelayDependencies["logger"],
): Promise<void> {
  const probes: Array<[string, string]> = [
    ["ptmx", "exec 3<>/dev/ptmx && echo PTMX-OK || echo PTMX-DENIED"],
    ["system-zsh", "/usr/bin/zsh -c 'echo ZSH-$ZSH_VERSION' 2>&1 || echo NO-SYS-ZSH"],
    [
      "brew-git",
      "/storage/Users/currentUser/.harmonybrew/bin/git --version 2>&1 || echo BREW-GIT-BLOCKED",
    ],
    ["sh-i", "echo 'echo SHI-OK' | /bin/sh -i 2>&1 | head -4"],
  ];
  for (const [name, command] of probes) {
    try {
      logger.info(`[ohos-pty][probe] ${name}={${(await run(command)).trim().slice(0, 160)}}`);
    } catch (error) {
      logger.warn(`[ohos-pty][probe] ${name} threw:`, error);
    }
  }
}

export function attachTerminalPtyRelay(
  port: MessagePortMain,
  dependencies: RelayDependencies,
): void {
  const sessions = new Map<string, IPty>();
  let nodePtyModule: Promise<typeof import("node-pty")> | undefined;
  let nextSessionId = 0;
  let probed = false;

  const loadNodePty = () => {
    nodePtyModule ??= dependencies.loadNodePty().catch((error: unknown) => {
      nodePtyModule = undefined;
      throw error;
    });
    return nodePtyModule;
  };

  const runShellCommand = (command: string) =>
    new Promise<string>((resolve) => {
      try {
        const probeChild = spawn("/bin/sh", ["-c", command], {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 8000,
        });
        let out = "";
        probeChild.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
        probeChild.stderr?.on("data", (chunk: Buffer) => (out += chunk.toString()));
        probeChild.on("error", (e: Error) => resolve(`spawn-error:${e.message}`));
        probeChild.on("close", () => resolve(out));
      } catch (error) {
        resolve(`threw:${error instanceof Error ? error.message : String(error)}`);
      }
    });

  const ensureProbed = () => {
    if (probed) return;
    probed = true;
    void runEnvironmentProbe(runShellCommand, dependencies.logger);
  };

  port.on("message", (event: Electron.MessageEventMain) => {
    const message = event.data as OhosPtyHostToMainMessage;
    void (async () => {
      if (message.type === "ohos-pty/spawn") {
        ensureProbed();
        const sessionId = String(++nextSessionId);
        const postExit = (exitCode: number) => {
          sessions.delete(sessionId);
          port.postMessage({ type: "ohos-pty/exit", sessionId, exitCode } satisfies OhosPtyMainToHostMessage);
        };
        const attach = (pty: IPty, mode: "pty" | "pipe") => {
          sessions.set(sessionId, pty);
          pty.onData((data) =>
            port.postMessage({ type: "ohos-pty/data", sessionId, data } satisfies OhosPtyMainToHostMessage),
          );
          pty.onExit(({ exitCode }) => postExit(exitCode));
          dependencies.logger.info(
            `[ohos-pty] session ${sessionId} spawned (${mode}) shell=${message.shell} pid=${pty.pid}`,
          );
          port.postMessage({
            type: "ohos-pty/spawned",
            requestId: message.requestId,
            sessionId,
            pid: pty.pid,
          } satisfies OhosPtyMainToHostMessage);
        };

        try {
          const nodePty = await loadNodePty();
          const pty = nodePty.spawn(message.shell, [], {
            name: message.name,
            cols: message.cols,
            rows: message.rows,
            cwd: message.cwd,
            env: message.env as Record<string, string>,
            encoding: "utf8",
          });
          attach(pty, "pty");
        } catch {
          // forkpty 被沙箱拒绝（/dev/ptmx Permission denied）→ 管道哑终端降级。
          dependencies.logger.warn(
            `[ohos-pty] forkpty denied for ${message.shell}, falling back to pipe shell`,
          );
          try {
            const pipeSession = spawnPipeShell({
              shell: message.shell,
              cwd: message.cwd,
              env: message.env,
            });
            attach(pipeSession, "pipe");
          } catch (error) {
            const failure = `pipe shell also failed for ${message.shell}: ${
              error instanceof Error ? error.message : String(error)
            }`;
            dependencies.logger.error(`[ohos-pty] ${failure}`);
            port.postMessage({
              type: "ohos-pty/spawn-failed",
              requestId: message.requestId,
              message: failure,
            } satisfies OhosPtyMainToHostMessage);
          }
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
