import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import type { IPty } from "node-pty";
import type { OhosPtyTransport } from "./ohosTerminalPty.js";

/**
 * OHOS 终端 shell：由 host 直接 spawn（与 agent Bash 同域，CUSTOM_SANDBOX 允许 exec
 * 用户目录 ELF）。原生子进程（nativespawn）域不允许 exec 非系统路径，`libzsh.so`/用户
 * 目录副本来回验证均为 EACCES（真机 2026-10-27），因此终端不再走 Main 中继/native child。
 * 无 tty（ptmx 被拒）：行级回显由本模块补，换行补 \r（与旧中继行为一致，spec 02）。
 */

function echoTransform(chunk: string): { echo: string; toShell: string } {
  let echo = "";
  let toShell = "";
  for (const ch of chunk) {
    if (ch === "\r") {
      echo += "\r\n";
      toShell += "\n";
    } else if (ch === "\u007f") {
      echo += "\b \b";
      toShell += ch;
    } else {
      echo += ch;
      toShell += ch;
    }
  }
  return { echo, toShell };
}

class OhosPipeShellSession implements IPty {
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

  // 无 tty 就没有内核 ONLCR：输出的 \n 补 \r，避免光标停在行尾后逐行缩进（spec 09 §12.9）。
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

// host 本地回退的 shell 解析：hint 里的 /usr/bin/zsh 在 host 视图不存在，按
// brew zsh → brew bash → /bin/sh 逐个探测（真机实证，spec 03）。
function resolveHostLocalShell(preferred: string): string {
  const brewPrefix = process.env.HOMEBREW_PREFIX?.trim();
  const candidates = [
    preferred,
    ...(brewPrefix ? [`${brewPrefix}/bin/zsh`, `${brewPrefix}/bin/bash`] : []),
    "/bin/sh",
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && accessSync(candidate, constants.X_OK)) return candidate;
    } catch {
      // 继续下一个候选
    }
  }
  return "/bin/sh";
}

export function createOhosLocalPipePtyTransport(): OhosPtyTransport {
  return {
    async spawn(params) {
      const shell = resolveHostLocalShell(params.shell);
      // 只有 zsh 走登录+交互；bash 不加 -l——真机上 /etc/profile 被拒且用户 .profile 会
      // 尝试 re-exec zsh（未安装时整条登录链失败，spec 03）。
      const shellArgs = shell.endsWith("zsh") ? ["-il"] : ["-i"];
      const child = spawn(shell, shellArgs, {
        cwd: params.cwd,
        env: params.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return new OhosPipeShellSession(child, shell);
    },
  };
}
