// OHOS v40：官方插件 MCP 以 process.execPath（appspawn 专用启动器）+ __zcode-plugin-host
// 拉起子进程，但该启动器在应用进程内 execve 被拒（EACCES，spec 09 §12.8）。
// 这里只接管这一条契约：用 worker_threads 以同样的 argv/env/stdio 语义在进程内运行
// plugin-host；其余 spawn 原样透传。

import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Worker } from "node:worker_threads";
import { isOhosRuntime } from "./runtimeEnv.js";

const PLUGIN_HOST_MARKER = "__zcode-plugin-host";

const WORKER_BOOTSTRAP = `
const { parentPort, workerData } = require("node:worker_threads");
const { Readable } = require("node:stream");
const emit = (type, chunk) => {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
  parentPort.postMessage({ type, data: buffer.toString("base64") });
};
const hook = (type) => (chunk, encoding, callback) => {
  emit(type, chunk);
  if (typeof encoding === "function") encoding();
  else if (typeof callback === "function") callback();
  return true;
};
process.stdout.write = hook("stdout");
process.stderr.write = hook("stderr");
const stdin = new Readable({ read() {} });
stdin.isTTY = false;
try { Object.defineProperty(process, "stdin", { value: stdin, configurable: true }); } catch {}
parentPort.on("message", (message) => {
  if (!message) return;
  if (message.type === "stdin") stdin.push(Buffer.from(message.data, "base64"));
  else if (message.type === "stdin-end") stdin.push(null);
});
process.argv = workerData.argv;
Object.assign(process.env, workerData.env || {});
const fail = (error) => {
  emit("stderr", String((error && error.stack) || error) + "\\n");
  process.exit(1);
};
process.once("uncaughtException", fail);
process.once("unhandledRejection", fail);
import(require("node:url").pathToFileURL(workerData.entry).href).catch(fail);
`;

class PluginHostWorkerChild extends EventEmitter {
  readonly pid: number;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly spawnfile: string;
  readonly spawnargs: string[];
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(
    private readonly worker: Worker,
    spawnfile: string,
    spawnargs: string[],
  ) {
    super();
    this.spawnfile = spawnfile;
    this.spawnargs = spawnargs;
    this.pid = worker.threadId;
    this.stdin.on("data", (chunk: Buffer) =>
      worker.postMessage({ type: "stdin", data: Buffer.from(chunk).toString("base64") }),
    );
    this.stdin.on("end", () => worker.postMessage({ type: "stdin-end" }));
    worker.on("message", (message: { type?: string; data?: string }) => {
      if (message?.type === "stdout") this.stdout.write(Buffer.from(message.data ?? "", "base64"));
      else if (message?.type === "stderr")
        this.stderr.write(Buffer.from(message.data ?? "", "base64"));
    });
    worker.on("error", (error) => {
      this.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      this.exitCode ??= 1;
      this.emit("error", error);
    });
    worker.on("exit", (code) => {
      this.exitCode = typeof code === "number" ? code : 1;
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", this.exitCode, null);
      this.emit("close", this.exitCode, null);
    });
    this.stdin.resume();
    queueMicrotask(() => this.emit("spawn"));
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    void this.worker.terminate();
    void signal;
    return true;
  }

  ref(): this {
    this.stdin.resume();
    return this;
  }

  unref(): this {
    return this;
  }
}

export function startPluginHostWorker(
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } | undefined,
): PluginHostWorkerChild {
  const entryIndex = args.indexOf(PLUGIN_HOST_MARKER) - 1;
  const entry = entryIndex >= 0 ? args[entryIndex] : process.argv[1];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options?.env ?? process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  const worker = new Worker(WORKER_BOOTSTRAP, {
    eval: true,
    workerData: { argv: [process.execPath, ...args], entry, env },
    stdout: false,
    stderr: false,
  });
  return new PluginHostWorkerChild(worker, process.execPath, [...args]);
}

export function installOhosSpawnCompat(): void {
  if (!isOhosRuntime()) return;
  const module = childProcess as unknown as {
    spawn: typeof childProcess.spawn;
    __ohosPluginHostPatched?: boolean;
  };
  if (module.__ohosPluginHostPatched) return;
  const originalSpawn = module.spawn;
  module.spawn = function patchedSpawn(
    command: string,
    args?: readonly string[],
    options?: { cwd?: string; env?: Record<string, string | undefined> },
  ) {
    if (command === process.execPath && Array.isArray(args) && args.includes(PLUGIN_HOST_MARKER)) {
      console.error(`[ohos-spawn] plugin-host in worker: ${args[args.length - 1] ?? ""}`);
      return startPluginHostWorker(args, options) as unknown as childProcess.ChildProcess;
    }
    return originalSpawn(command, args as string[], options as childProcess.SpawnOptions);
  } as typeof childProcess.spawn;
  module.__ohosPluginHostPatched = true;
}
