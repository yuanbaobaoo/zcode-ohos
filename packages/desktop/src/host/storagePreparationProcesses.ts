import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { Worker } from "node:worker_threads";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  databaseStartupErrorCodeSchema,
  databaseMigrationFactsSchema,
  type DatabaseMigrationFacts,
  databaseStartupErrorDetailsSchema,
  zcodeStoragePreparationFrameSchema,
  type DatabaseStartupState,
} from "@zcode/shared";
import { resolveDefaultZCodeAgentCommand } from "@zcode/services/storage-startup";

type Phase = NonNullable<DatabaseStartupState["databasePhase"]>;
const workerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("progress"),
      migration: databaseMigrationFactsSchema.optional(),
      phase: z.enum([
        "checking",
        "waiting_for_lock",
        "migrating",
        "committing",
        "maintaining",
        "ready",
      ]),
    })
    .strict(),
  z.object({ type: z.literal("done") }).strict(),
  z
    .object({
      type: z.literal("failed"),
      errorCode: databaseStartupErrorCodeSchema,
      migration: databaseMigrationFactsSchema.optional(),
      ...databaseStartupErrorDetailsSchema.shape,
    })
    .strict(),
]);
const statusError = (
  kind: string,
  details?: {
    sqliteCode?: number;
    systemCode?: string;
    migrationId?: string;
    migration?: DatabaseMigrationFacts;
  },
  databaseId?: string,
) =>
  Object.assign(new Error(`Storage preparation failed: ${kind}`), {
    kind,
    errcode: details?.sqliteCode,
    code: details?.systemCode,
    migrationId: details?.migrationId,
    migrationUpdate:
      databaseId && details?.migration ? { databaseId, migration: details.migration } : undefined,
  });

export function prepareHostStorage(
  path: string,
  report: (phase: Phase, migration?: DatabaseMigrationFacts) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./tasksStorageWorker.js", import.meta.url), {
      workerData: { path },
    });
    let done = false;
    let failure: unknown;
    let firstState = false;
    const firstStateTimer = setTimeout(() => {
      failure = statusError("startup_status_timeout");
      void worker.terminate();
    }, 30_000);
    const abort = () => {
      failure = statusError("transport_closed");
      void worker.terminate();
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (raw: unknown) => {
      const result = workerMessageSchema.safeParse(raw);
      if (!result.success) {
        // 装机排障（OHOS）：worker 帧不合规时此前只余 transport_closed，无从下手；
        // 保留 zod 路径诊断（kind 保持枚举，供 classify 使用）。
        failure = Object.assign(statusError("transport_closed"), {
          workerFrameError: result.error.issues
            .map((issue) => `${issue.path.join(".")}:${issue.message}`)
            .join("; ")
            .slice(0, 512),
        });
        void worker.terminate();
        return;
      }
      firstState = true;
      clearTimeout(firstStateTimer);
      const message = result.data;
      if (message.type === "progress") report(message.phase, message.migration);
      else if (message.type === "done") done = true;
      else failure = statusError(message.errorCode, message, "tasks-index");
    });
    worker.once("error", (error) => {
      failure = error;
    });
    worker.once("exit", (code) => {
      clearTimeout(firstStateTimer);
      signal.removeEventListener("abort", abort);
      if (done && code === 0 && !failure && firstState) resolve();
      else {
        // 装机排障（OHOS）：worker 无 error 事件静默退出时，退出码是区分
        // 崩溃/主动 exit/被 terminate 的唯一线索，随错误对象带出（kind 不变）。
        if (!failure)
          failure = Object.assign(statusError(`transport_closed (worker exit code ${code})`), {
            workerExitCode: code,
          });
        reject(failure);
      }
    });
    if (signal.aborted) abort();
  });
}

/** 在 Host 所属 Worker 运行同一 CLI bundle 的存储入口；Host 退出不会留下持锁孤儿进程。 */
export async function prepareSessionStorage(options: {
  cwd: string;
  env?: Record<string, string>;
  signal: AbortSignal;
  report: (
    phase: Phase,
    details?: { databaseId: string; migration?: DatabaseMigrationFacts },
  ) => void;
  preparedPaths?: Set<string>;
  observePath: (path: string) => Promise<void>;
}): Promise<void> {
  const command = resolveDefaultZCodeAgentCommand({
    workspacePath: options.cwd,
    workspaceKey: options.cwd,
    presentationSurface: "desktop",
  });
  if (!command?.supportsStorageStartup || !command.storagePreparationEntry)
    throw statusError("unsupported_runtime");
  const entry = command.storagePreparationEntry;
  await new Promise<void>((resolve, reject) => {
    const child = new Worker(entry, {
      argv: ["app-server", "--stdio", "--prepare-storage", "--cwd", command.cwd ?? options.cwd],
      env: { ...process.env, ...options.env, ...command.env },
      stdin: true,
      stdout: true,
      stderr: true,
    });
    const input = child.stdin!;
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let prepared = false;
    let pathReceived = false;
    let preparedPath: string | undefined;
    let failure: unknown;
    // 装机排障（OHOS）：CLI worker 无声死亡时死前遗言只在 stderr，此前被直接排空丢弃。
    // 只留本地诊断尾窗（随错误对象进 host-log，不进 schema 字段，不跨进程上报）。
    const stderrTail: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail.push(chunk.toString("utf8"));
      if (stderrTail.length > 64) stderrTail.shift();
    });
    const terminate = () => {
      void child.terminate();
    };
    const abort = () => {
      failure ??= statusError("transport_closed");
      terminate();
    };
    const firstStateTimer = setTimeout(() => {
      failure = statusError("startup_status_timeout");
      terminate();
    }, 30_000);
    options.signal.addEventListener("abort", abort, { once: true });
    input.on("error", (error) => {
      failure ??= error;
      terminate();
    });
    lines.on("line", (line) => {
      try {
        if (line.length > 65536) throw statusError("transport_closed");
        const frame = zcodeStoragePreparationFrameSchema.parse(JSON.parse(line));
        clearTimeout(firstStateTimer);
        if (frame.method === "startup/storagePath") {
          if (pathReceived) throw statusError("transport_closed");
          pathReceived = true;
          void (async () => {
            // 仅复用同一次准备中已成功关闭的真实库，不能按不同 cwd 误判为不同数据库。
            preparedPath = await realpath(frame.params.path).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return resolvePath(frame.params.path);
                throw error;
              },
            );
            if (settled || failure || options.signal.aborted) return;
            const reuse = options.preparedPaths?.has(preparedPath) ?? false;
            if (!reuse) await options.observePath(frame.params.path);
            if (!settled && !failure && !options.signal.aborted)
              input.write(`${JSON.stringify({ method: "startup/storagePathReady", reuse })}\n`);
          })().catch((error) => {
            failure ??= error;
            terminate();
          });
        } else if (frame.method === "startup/storagePrepared") {
          prepared = pathReceived;
          input.end();
        } else if (frame.params.phase === "failed")
          failure ??= statusError(
            frame.params.errorCode ?? "sql_failed",
            frame.params,
            frame.params.databaseId,
          );
        else
          options.report(frame.params.phase, {
            databaseId: frame.params.databaseId,
            migration: frame.params.migration,
          });
      } catch (error) {
        failure ??= error;
        terminate();
      }
    });
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("exit", (code) => {
      settled = true;
      clearTimeout(firstStateTimer);
      options.signal.removeEventListener("abort", abort);
      lines.close();
      if (code === 0 && prepared && !failure) {
        if (preparedPath) options.preparedPaths?.add(preparedPath);
        resolve();
      } else {
        // 装机排障（OHOS）：退出码 + stderr 尾窗是 CLI worker 无声死亡的唯二线索（kind 不变）。
        if (!failure)
          failure = Object.assign(statusError(`transport_closed (worker exit code ${code})`), {
            workerExitCode: code,
          });
        if (stderrTail.length > 0)
          Object.assign(failure as object, { workerStderrTail: stderrTail.join("").slice(-2048) });
        reject(failure);
      }
    });
    if (options.signal.aborted) abort();
  });
}
