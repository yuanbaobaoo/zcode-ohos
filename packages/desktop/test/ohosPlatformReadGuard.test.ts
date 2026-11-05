// spec：specs/ohos-port/15-单控制通道与平台适配治理.md（M5）
// 平台身份守卫：OHOS 适配面不允许直接读 `process.platform` 做分支，只能把 platform 作为
// **默认参数**接收（可测、可注入），否则又会回到"进程换了宿主二进制就整层失效"的老路
// （spec 15 背景：MCP 子进程 platform 报 linux 导致 CUA 全链路不可用）。
//
// 允许的两种形态：
//   1) 默认参数：`platform: NodeJS.Platform | string = process.platform`
//   2) 注释里的说明（`// ... process.platform ...`）
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");
// 只覆盖 OHOS 适配面：这些目录里的分支必须走 isOhosRuntime/显式参数。
const SCAN_ROOTS = [
  "packages/desktop/src/main/ohos",
  "packages/services/src/ohos",
  "apps/zcode-cli/packages/core/src/capabilities/ohos-device",
];
const PARAM_DEFAULT = /\bplatform\s*:\s*(?:NodeJS\.Platform|string)[^\n]*=\s*process\.platform/u;

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) collectFiles(path, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

function offendingLines(): string[] {
  const offenders: string[] = [];
  for (const root of SCAN_ROOTS) {
    let files: string[];
    try {
      files = collectFiles(join(repoRoot, root));
    } catch {
      continue; // 目录不存在（子集检出）时跳过
    }
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (!line.includes("process.platform")) continue;
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        if (PARAM_DEFAULT.test(line)) continue;
        offenders.push(`${relative(repoRoot, file)}:${index + 1}: ${trimmed}`);
      }
    }
  }
  return offenders;
}

describe("OHOS 适配面的平台身份守卫", () => {
  it("不得直接读 process.platform 做分支（只允许默认参数或注释）", () => {
    expect(offendingLines()).toEqual([]);
  });
});
