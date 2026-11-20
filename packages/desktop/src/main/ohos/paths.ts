/*
 * OHOS 桥路径的唯一来源（specs/ohos-port/15 M4）。
 *
 * 为什么单独成文件：`OHOS_HAPS_FILES_DIR` 原先住在 `desktopOhosWindowTheme.ts`，被全盘访问、
 * 辅助操作权限、截图三个互不相关的能力 import——主题文件"拥有"了所有人的路径。而 node_repl
 * 的 CUA runtime 又在 `packages/zcode-cua/ohos-computer-use.js` 里手写了同一批绝对路径。
 * 同一批沙箱路径必须只有一个来源，否则打包/视图变化时只能靠真机发现（spec 02/07 双视图）。
 *
 * 约定：这里只放路径与文件名常量，不放行为；ArkTS 侧（`context.filesDir` 视图）与这里的
 * `computer-control` 目录名由 `ohosBridgePathsContract.test.ts` 钉住一致。
 */
import { join } from "node:path";

// el2/base/files 沙箱视图会映射到扁平目录，ArkTS 的 context.filesDir 在 haps 模块目录下
// （两者不同文件，见 share-inbox 的双候选先例）——桥必须落 haps 形态。
export const OHOS_HAPS_FILES_DIR = "/data/storage/el2/base/haps/electron/files";

/** CUA 桥目录名：main（读者/截图服务）与 ArkTS（写入方）共用。 */
export const OHOS_COMPUTER_CONTROL_DIR_NAME = "computer-control";

export const OHOS_BRIDGE_PATHS = {
  themeFile: join(OHOS_HAPS_FILES_DIR, "window-theme.json"),
  fullDiskAccessState: join(OHOS_HAPS_FILES_DIR, "full-disk-access.json"),
  fullDiskAccessRequest: join(OHOS_HAPS_FILES_DIR, "full-disk-access.request"),
  computerControlDir: join(OHOS_HAPS_FILES_DIR, OHOS_COMPUTER_CONTROL_DIR_NAME),
  computerControlToken: join(OHOS_HAPS_FILES_DIR, OHOS_COMPUTER_CONTROL_DIR_NAME, "token.json"),
  computerControlStatus: join(OHOS_HAPS_FILES_DIR, OHOS_COMPUTER_CONTROL_DIR_NAME, "status.json"),
  computerControlRequest: join(
    OHOS_HAPS_FILES_DIR,
    OHOS_COMPUTER_CONTROL_DIR_NAME,
    "permission.request",
  ),
} as const;

/**
 * node_repl（CUA runtime）视角的桥目录。runtime 用绝对路径读写同一批文件，
 * 因此它必须与 `OHOS_BRIDGE_PATHS.computerControlDir` 逐字一致（契约测试钉住）。
 */
export const OHOS_COMPUTER_CONTROL_BRIDGE_DIR = OHOS_BRIDGE_PATHS.computerControlDir;
