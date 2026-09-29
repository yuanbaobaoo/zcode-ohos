import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { prepareTasksIndexStorage } from "@zcode/services/storage-startup";
import {
  classifyDatabaseStartupError,
  databaseStartupErrorDetails,
  databaseMigrationFactsSchema,
} from "@zcode/shared";

const data = z
  .object({ path: z.string().min(1) })
  .strict()
  .parse(workerData);

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
      systemCode:
        databaseStartupErrorDetails(error).systemCode ??
        String((error as Error)?.message ?? "").slice(0, 64),
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
  await prepareTasksIndexStorage(data.path, (phase, migration) =>
    parentPort?.postMessage({ type: "progress", phase, migration }),
  );
  parentPort?.postMessage({ type: "done" });
} catch (error) {
  postFailed(error);
} finally {
  parentPort?.close();
}
