import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { Worker } from "node:worker_threads";
import { createInterface } from "node:readline";
import {
  type DatabaseMigrationFacts,
  zcodeStoragePreparationFrameSchema,
  type DatabaseStartupState,
  isOhosRuntime,
} from "@zcode/shared";
import { resolveDefaultZCodeAgentCommand } from "@zcode/services/storage-startup";

type Phase = NonNullable<DatabaseStartupState["databasePhase"]>;
import { workerMessageSchema } from "./contract.js";
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
  // OHOS：utilityProcess（NodeService）的 Worker spawn 不可用（new Worker 无论
  // file URL 还是绝对路径都立刻 transport_closed，且 worker 通道不落 hilog）。
  // storage worker 只是把 prepareTasksIndexStorage 搬到独立线程做写锁/进度上报；
  // OHOS 上直接在 Host 进程内同步执行——同一 Host 生命周期、同一数据根，锁语义不变。
  if (isOhosRuntime()) {
    return prepareHostStorageInProcess(path, report, signal);
  }
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

// OHOS 进程内 storage 启动：与 worker 同一份 prepareTasksIndexStorage，设置权威
// 用 createSettingService() 快照，进度帧直接回传（不经 workerMessageSchema）。
async function prepareHostStorageInProcess(
  path: string,
  report: (phase: Phase, migration?: DatabaseMigrationFacts) => void,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw statusError("transport_closed");
  const { prepareTasksIndexStorage, createSettingService } = await import(
    "@zcode/services/storage-startup"
  );
  const settings = await createSettingService().get();
  try {
    await prepareTasksIndexStorage(
      path,
      (phase, migration) => report(phase as Phase, migration),
      settings,
    );
  } catch (error) {
    // 装机排障（OHOS）：进程内 storage 失败只剩 sql_failed，host 活着时直出首因
    // 到 Electron 日志通道，定位是路径权限还是 sqlite 兼容性。
    console.error(
      `[ohos-host-storage] prepareTasksIndexStorage failed for ${path}:`,
      (error as Error)?.message ?? String(error),
    );
    throw error;
  }
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
  // OHOS：Worker spawn 不可用（同 prepareHostStorage）。session 库的迁移由 Agent
  // 启动时自行完成（sqlite-session-store 的 runSqliteSessionMigrationsAsync），
  // Host 的预热只是性能优化；OHOS 上跳过预热并把 session 库路径登记进
  // preparedPaths（真实路径），不阻断启动。
  if (isOhosRuntime()) {
    if (options.signal.aborted) throw statusError("transport_closed");
    options.report("ready", { databaseId: "session" });
    return;
  }
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
