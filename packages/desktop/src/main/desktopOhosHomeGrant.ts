/*
 * OHOS 用户目录授权流程（main 进程）。
 *
 * 设计：数据与配置默认落在真实用户 home（~/.zcode），harmonybrew 也在其下。
 * 应用 uid 对 home 的写权限取决于用户是否在系统目录授权中放行：
 *   1. 启动早期（desktopEarlyOhosEnvBootstrap）探测可写性——可写则直接以真实
 *      home 为根，无需任何交互；
 *   2. 不可写时先落到应用沙箱（保证启动不崩），置 ZCODE_OHOS_HOME_GRANT_PENDING，
 *      待首个窗口就绪后弹一次目录授权（默认定位用户 home）。授权经 ArkTS 层的
 *      UriGrantHelper 持久化（冷启动自动复活），随后把数据根迁回真实 home。
 * 授权提示每次状态变化只弹一次（标记文件落在沙箱，应用自身必可写）。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isOhosRuntime } from "@zcode/shared";
import { setDataBaseDir } from "@zcode/services/node";
import { resolveOhosRealHome } from "@zcode/services/ohos";
import {
  isDirWritable,
  OHOS_SANDBOX_FILES,
} from "./desktopEarlyOhosEnvBootstrap.js";

const GRANT_MARKER = "ohos-home-grant.json";
const WINDOW_WAIT_TIMEOUT_MS = 60_000;


export function isDirWritable(dir: string): boolean {
  try {
    const probe = join(dir, ".zcode");
    mkdirSync(probe, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

async function waitForFirstWindow(): Promise<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any | undefined
> {
  const { BrowserWindow } = await import("electron");
  const deadline = Date.now() + WINDOW_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) return win;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return undefined;
}

/** 在首个窗口就绪后调用：需要授权则弹一次目录选择，授权成功即把数据根迁回真实 home。 */
export async function ensureOhosHomeGrant(logger: {
  info: (message: string) => void;
  warn: (message: string) => void;
}): Promise<void> {
  if (!isOhosRuntime()) return;
  if (process.env.ZCODE_OHOS_HOME_GRANT_PENDING !== "1") return;

  const realHome = process.env.ZCODE_OHOS_REAL_HOME?.trim() || resolveOhosRealHome();
  if (!realHome) {
    logger.warn("[ohos-home] real home not found, staying in sandbox");
    return;
  }

  const sandboxMarker = join(OHOS_SANDBOX_FILES, ".zcode", GRANT_MARKER);
  if (existsSync(sandboxMarker)) {
    logger.info("[ohos-home] grant prompt already shown once, staying in sandbox");
    return;
  }

  const win = await waitForFirstWindow();
  if (!win) {
    logger.warn("[ohos-home] no window within timeout, skip grant prompt");
    return;
  }

  logger.info(`[ohos-home] requesting user directory grant for ${realHome}`);
  try {
    const { dialog } = await import("electron");
    const result = await dialog.showOpenDialog(win, {
      title: "授权 ZCode 访问用户目录（存储会话数据与使用 harmonybrew 环境）",
      defaultPath: realHome,
      properties: ["openDirectory"],
      buttonLabel: "授权此目录",
    });

    // 无论授权与否都写标记：拒绝后不反复打扰；删除沙箱内标记文件可重新触发。
    mkdirSync(join(OHOS_SANDBOX_FILES, ".zcode"), { recursive: true });
    writeFileSync(
      sandboxMarker,
      JSON.stringify({ granted: !result.canceled, realHome, time: Date.now() }),
    );

    if (result.canceled || result.filePaths.length === 0) {
      logger.info("[ohos-home] user declined the grant, staying in sandbox");
      return;
    }

    if (!isDirWritable(realHome)) {
      logger.warn("[ohos-home] grant persisted but home still not writable, staying in sandbox");
      return;
    }

    // 授权生效：数据根迁回真实 home。本会话内已创建的沙箱文件保留（日志等），
    // 新写入全部走真实 home；env 更新对之后 fork 的 host/agent 子进程生效。
    mkdirSync(join(realHome, ".zcode"), { recursive: true });
    setDataBaseDir(realHome);
    process.env.HOME = realHome;
    process.env.ZCODE_DATA_BASE_DIR = realHome;
    process.env.ZCODE_HOME = join(realHome, ".zcode");
    delete process.env.ZCODE_OHOS_HOME_GRANT_PENDING;
    logger.info(`[ohos-home] data base dir migrated to real home: ${realHome}`);
  } catch (error) {
    logger.warn(`[ohos-home] grant flow failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
