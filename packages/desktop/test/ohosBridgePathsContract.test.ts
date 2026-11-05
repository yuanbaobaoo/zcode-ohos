// spec：specs/ohos-port/15-单控制通道与平台适配治理.md（M4）
// 同一批沙箱路径在 main / node_repl / ArkTS 三处各有一份表达，任何一处漂移都会在真机上
// 表现成"桥文件写了但没人读"。这里用源码文本把三方钉在一起——ArkTS 不能 import TS，
// node 侧又刻意不依赖 desktop 包，所以契约只能靠测试守。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OHOS_BRIDGE_PATHS, OHOS_HAPS_FILES_DIR } from "../src/main/ohos/paths.js";

const repoRoot = join(import.meta.dirname, "../../..");
const NODE_SIDE = join(repoRoot, "packages/zcode-cua/ohos-computer-use.js");
const ARKTS_SIDE = join(
  repoRoot,
  "packages/desktop/ohos/entry/src/main/ets/computerControl/ComputerControlService.ets",
);

describe("OHOS 桥路径三方契约", () => {
  it("所有桥路径都在 el2 haps 目录下（ArkTS context.filesDir 的同一文件）", () => {
    for (const [name, path] of Object.entries(OHOS_BRIDGE_PATHS)) {
      expect(path.startsWith(`${OHOS_HAPS_FILES_DIR}/`), `${name} 越出 haps 目录`).toBe(true);
    }
  });

  it("CUA 桥目录与 node 侧（CUA runtime）硬编码路径逐字一致", () => {
    const source = readFileSync(NODE_SIDE, "utf8");
    expect(source).toContain(`"${OHOS_BRIDGE_PATHS.computerControlDir}"`);
  });

  it("ArkTS 侧目录名与 main 侧一致（context.filesDir 视图）", () => {
    const source = readFileSync(ARKTS_SIDE, "utf8");
    const dirName = OHOS_BRIDGE_PATHS.computerControlDir.split("/").at(-1);
    expect(dirName).toBe("computer-control");
    expect(source).toContain(`const BRIDGE_DIR_NAME: string = '${dirName}'`);
    // 桥文件一律以 filesDir + 目录名拼出，不能写死绝对路径（视图由系统给）。
    expect(source).toContain("${context.filesDir}/${BRIDGE_DIR_NAME}");
  });

});
