import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@zcode/contracts";
import { isOhosRuntime } from "@zcode/shared";
import { createMcpNodeFallbackProvider, type McpNodeFallbackProvider } from "@zcode/adapters/mcp";
import { bundleBaseDirs } from "./bundled-plugins.js";

/** 随包 npm 相对 zcode.cjs 的位置；与 desktop prepare:agent-bundle 的 staging 目录同一约定。 */
const BUNDLED_NPM_RELATIVE_SEGMENTS = ["node-runtime", "npm"] as const;

export interface McpNodeFallbackRuntime {
  /** 入口文件目录、bundle 自身目录（按优先级）。 */
  baseDirs: readonly string[];
  /** `process.versions.electron`；undefined 表示 agent 不在 Electron Node 上运行。 */
  electronVersion: string | undefined;
  execPath: string;
}

export interface ResolveMcpNodeFallbackProviderOptions {
  cliStorageRoot: string;
  logger?: Logger;
  /** 测试注入；缺省读取当前进程。 */
  runtime?: McpNodeFallbackRuntime;
}

/**
 * 只有 agent 自己跑在 Electron Node（桌面）上时才提供 fallback：纯 Node CLI、SEA 与远端
 * 不需要它，远端沿用 prependRunningNodeDirectory。规格见 docs/design/v2/mcp-node-fallback.md。
 */
export function resolveMcpNodeFallbackProvider(
  options: ResolveMcpNodeFallbackProviderOptions,
): McpNodeFallbackProvider | undefined {
  const runtime = options.runtime ?? currentRuntime();
  if (!runtime.electronVersion) return undefined;
  return createMcpNodeFallbackProvider({
    execPath: resolveOhosSpawnableNodeExecPath(runtime.execPath),
    logger: options.logger,
    npmRootCandidates: bundledNpmRootCandidates(runtime.baseDirs),
    storageRoot: options.cliStorageRoot,
  });
}

export function bundledNpmRootCandidates(baseDirs: readonly string[]): string[] {
  return [...new Set(baseDirs.map((dir) => join(dir, ...BUNDLED_NPM_RELATIVE_SEGMENTS)))];
}

function currentRuntime(): McpNodeFallbackRuntime {
  return {
    baseDirs: bundleBaseDirs(),
    electronVersion: process.versions.electron,
    execPath: process.execPath,
  };
}

// OHOS 真机（spec 03）：bundle 树 ELF 一律无执行位，子进程 execve process.execPath
// （electron stub）必 EACCES，官方 stdio MCP server 因此全部 spawn 失败。真机唯一可执行
// 的 node 来自用户环境（harmonybrew/HiShell，已在 PATH），探测顺序：显式 env > PATH >
// home 已知布局；找不到时维持 execPath 原值 fail-closed（行为与修复前一致）。
// 结果按进程缓存；非 ohos 平台原样返回。
let cachedOhosSpawnableNode: string | undefined | null = null;

export function resolveOhosSpawnableNodeExecPath(
  execPath: string,
  platform: string = process.platform,
): string {
  if (!isOhosRuntime(platform)) return execPath;
  if (cachedOhosSpawnableNode === null) {
    const home = process.env.HOME ?? "";
    const candidates = [
      process.env.ZCODE_OHOS_SPAWNABLE_NODE,
      ...(process.env.PATH ?? "")
        .split(":")
        .filter(Boolean)
        .map((dir) => join(dir, "node")),
      ...(home
        ? [join(home, "harmonybrew/bin/node"), join(home, ".harmonybrew/bin/node")]
        : []),
    ].filter((candidate): candidate is string => Boolean(candidate));
    cachedOhosSpawnableNode = candidates.find((candidate) => {
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  }
  return cachedOhosSpawnableNode ?? execPath;
}

/** 测试注入后复位探测缓存。 */
export function resetOhosSpawnableNodeCacheForTest(): void {
  cachedOhosSpawnableNode = null;
}
