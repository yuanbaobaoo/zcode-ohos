import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { isOhosRuntime } from "@zcode/shared";

export interface OhosAgentWorkerCommand {
  command: string;
  args: string[];
  storagePreparationEntry: string;
  cwd: string;
  inProcessWorker: true;
}

export interface OhosAgentWorkerSpawnPreflight {
  args: string[];
}

export function isOhosAgentWorkerRuntime(): boolean {
  return isOhosRuntime() && Boolean(process.versions.electron);
}

// zcode.cjs 的静态 node:sqlite import 在任何业务代码前取值，兼容 preload 必须先装好。
export function resolveOhosAgentCompatExecArgv(agentEntryPath: string): string[] {
  if (!isOhosRuntime()) return [];
  try {
    const preloadPath = join(dirname(agentEntryPath), "ohos-node-compat.cjs");
    if (existsSync(preloadPath)) {
      return [...process.execArgv, "--require", preloadPath];
    }
  } catch {
    // 探测失败按无 preload 继续，缺库错误由 bundle 内 shim 呈现。
  }
  return [];
}

export function resolveOhosAgentWorkerCommand(input: {
  bundlePath: string;
  spawnArgs: readonly string[];
  cwd: string;
}): OhosAgentWorkerCommand {
  return {
    command: input.bundlePath,
    args: [...input.spawnArgs],
    storagePreparationEntry: input.bundlePath,
    cwd: input.cwd,
    inProcessWorker: true,
  };
}

export function getOhosAgentWorkerResourceLimits():
  | { maxOldGenerationSizeMb: number; maxYoungGenerationSizeMb: number }
  | undefined {
  // 15MB+ bundle 的解析编译 + sqlite 初始化会压垮默认 V8 堆（spec 02）。
  return isOhosRuntime()
    ? { maxOldGenerationSizeMb: 2048, maxYoungGenerationSizeMb: 256 }
    : undefined;
}

export function spawnOhosAgentWorker(
  command: { command: string },
  spawnPreflight: OhosAgentWorkerSpawnPreflight,
  options: { cwd?: string; env: NodeJS.ProcessEnv },
  log: (...args: unknown[]) => void,
): ChildProcessWithoutNullStreams {
  void options.cwd; // Worker cwd 与宿主一致（工作区已由宿主解析）。
  const worker = new Worker(command.command, {
    // Worker argv 为 [execPath, workerFile, ...argv]，CLI slice(2) 即选项本体。
    argv: [...spawnPreflight.args],
    env: options.env as Record<string, string>,
    execArgv: resolveOhosAgentCompatExecArgv(command.command),
    resourceLimits: getOhosAgentWorkerResourceLimits(),
    stdin: true,
    stdout: true,
    stderr: true,
  });
  const state: { pid: number; killed: boolean; exitCode: number | null } = {
    pid: worker.threadId,
    killed: false,
    exitCode: null,
  };
  const adapter = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  adapter.stdin = worker.stdin!;
  adapter.stdout = worker.stdout!;
  adapter.stderr = worker.stderr!;
  Object.defineProperty(adapter, "pid", { get: () => state.pid });
  Object.defineProperty(adapter, "killed", { get: () => state.killed });
  Object.defineProperty(adapter, "exitCode", { get: () => state.exitCode });
  Object.defineProperty(adapter, "spawnfile", { value: command.command });
  worker.once("online", () => {
    // 以 "spawn" 事件触发 runtime lifecycle "available"（任务列表索引依赖）。
    adapter.emit("spawn");
  });
  // worker stderr 是 CLI 唯一实时诊断通道；协议 stdout 污染曾靠它定位（spec 02）。
  worker.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) log("ZCode agent worker stderr", { pid: state.pid, text: text.slice(0, 500) });
  });
  worker.once("exit", (code: number) => {
    state.killed = true;
    state.exitCode = code;
    adapter.emit("exit", code, null);
    adapter.emit("close", code, null);
  });
  worker.once("error", (error: Error) => adapter.emit("error", error));
  adapter.kill = (): boolean => {
    if (state.killed) return true;
    state.killed = true;
    void worker.terminate();
    return true;
  };
  return adapter;
}
