import { parentPort, workerData } from "node:worker_threads";
import { tasksStorageWorkerDataSchema } from "./contract.js";
import { prepareTasksIndexStorage, createSettingService } from "@zcode/services/storage-startup";
import {
  classifyDatabaseStartupError,
  databaseStartupErrorDetails,
  databaseMigrationFactsSchema,
} from "@zcode/shared";
import { installOhosNodeRuntimeCompat } from "@zcode/shared/ohos-node-runtime-compat";

// Worker 线程有独立模块注册表：main/host 装好的 Node 20 兼容（node:sqlite require
// 钩子 + withResolvers polyfill）不跨线程，这里在 worker 业务求值前重装（OHOS no-op）。
installOhosNodeRuntimeCompat();

const data = tasksStorageWorkerDataSchema.parse(workerData);

// 装机排障（OHOS）：worker 内未捕获异常/unhandled rejection 默认只让线程静默退出，
// 宿主只看到 transport_closed 无从定位；死亡前把结构化 failed 帧发给宿主。
const postFailed = (error: unknown) => {
  try {
    const migration = databaseMigrationFactsSchema.safeParse(
      error && typeof error === "object"
        ? (error as { startupMigration?: unknown }).startupMigration
        : undefined,
    );
    parentPort?.postMessage({
      type: "failed",
      migration: migration.success ? migration.data : undefined,
      errorCode: classifyDatabaseStartupError(error),
      ...databaseStartupErrorDetails(error),
      // 装机排障（OHOS）：storage worker 挂掉只剩 transport_closed；workerMessageSchema
      // 是 strict 的，error.message 只能走已声明的 systemCode 通道透传（≤64 字符）。
      systemCode:
        databaseStartupErrorDetails(error).systemCode ??
        String((error as Error)?.message ?? (error as Error)?.stack?.slice(0, 64) ?? "").slice(
          0,
          64,
        ),
    });
  } catch {
    /* last-gasp 上报自身失败时维持默认行为（宿主按 exit code 诊断）。 */
  }
};
process.on("uncaughtException", (error) => {
  postFailed(error);
  // 让 failed 帧先跨线程送达宿主（postMessage 递交走宿主事件循环），再退线程。
  setTimeout(() => process.exit(1), 100);
});
process.on("unhandledRejection", (reason) => {
  postFailed(reason);
  setTimeout(() => process.exit(1), 100);
});

try {
  // Worker 必须携带旧设置完成项目迁移，否则后续 Host 只能看到已记账的空项目种子。
  const settings = await createSettingService().get();
  await prepareTasksIndexStorage(
    data.path,
    (phase, migration) => parentPort?.postMessage({ type: "progress", phase, migration }),
    settings,
  );
  parentPort?.postMessage({ type: "done" });
} catch (error) {
  postFailed(error);
} finally {
  parentPort?.close();
}
