// dev 与打包共用同一份 agent 暂存；只由打包链暂存时，dev 会静默复用陈旧 bundle。
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const AGENT_BUNDLE_SOURCE_RELATIVE = "apps/zcode-cli/packages/cli/dist/zcode.cjs";

// node_repl MCP 从 ~/.zcode cache 启动；dev bundle 无 SEA 资产，需把源码包 stage 到
// glm/packages/node-repl-host，让 seed 命中最新构建。
const STAGED_NODE_REPL_HOST_ENTRIES = [
  "dist",
  ".zcode-plugin",
  "package.json",
  "README.md",
  "scripts",
];

export function resolveAgentBundlePaths({ repoRoot, platformKey }) {
  const glmDir = resolve(repoRoot, "packages", "desktop", "bundled-agents", platformKey, "glm");
  return {
    cliBundlePath: resolve(repoRoot, AGENT_BUNDLE_SOURCE_RELATIVE),
    glmDir,
    stagedBundlePath: resolve(glmDir, "zcode.cjs"),
    stagedMetaPath: resolve(glmDir, ".node-bundle-meta.json"),
  };
}

/**
 * 干净重建 glm 目录再拷贝。清空是刻意的：electron-builder 整目录拷贝
 * bundled-agents/<平台>/glm → resources/glm，本地工作树里上一次构建残留的原生二进制
 * （zcode-agent / zcode-acp 等）和旧 meta 会被一并打进安装包（CI 干净检出不会有，本地会）。
 */
export function stageAgentBundle({ repoRoot, platformKey, log = console.log }) {
  const { cliBundlePath, glmDir, stagedBundlePath, stagedMetaPath } = resolveAgentBundlePaths({
    repoRoot,
    platformKey,
  });
  if (!existsSync(cliBundlePath)) {
    throw new Error(`[stage:agent-bundle] agent bundle 源产物不存在：${cliBundlePath}`);
  }
  rmSync(glmDir, { recursive: true, force: true });
  mkdirSync(glmDir, { recursive: true });
  copyFileSync(cliBundlePath, stagedBundlePath);
  // OHOS 兼容 preload 必须与 zcode.cjs 同目录（spec 09 §4.1.1）；存在性即开关。
  const compatPreloadSource = resolve(
    repoRoot,
    "apps/zcode-cli/packages/cli/dist/ohos-node-compat.cjs",
  );
  if (existsSync(compatPreloadSource)) {
    copyFileSync(compatPreloadSource, resolve(glmDir, "ohos-node-compat.cjs"));
  }
  const meta = {
    runtime: "electron-node",
    entry: "zcode.cjs",
    platform: platformKey,
    source: AGENT_BUNDLE_SOURCE_RELATIVE,
  };
  writeFileSync(stagedMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  // node-repl-host 暂存（见 STAGED_NODE_REPL_HOST_ENTRIES 注释）：dist 缺失说明调用方
  // 还没构建它（build-desktop-agent-cli 的 defaultBuildFilters 会先建再 stage），跳过
  // 并留给打包链报错，不在共享实现里重复校验。
  const nodeReplHostSource = resolve(repoRoot, "apps", "zcode-cli", "packages", "node-repl-host");
  const nodeReplHostTarget = resolve(glmDir, "packages", "node-repl-host");
  if (existsSync(resolve(nodeReplHostSource, "dist", "mcp", "server.js"))) {
    mkdirSync(nodeReplHostTarget, { recursive: true });
    for (const entry of STAGED_NODE_REPL_HOST_ENTRIES) {
      const sourcePath = resolve(nodeReplHostSource, entry);
      if (existsSync(sourcePath)) {
        cpSync(sourcePath, resolve(nodeReplHostTarget, entry), { recursive: true });
      }
    }
    log(`[stage:agent-bundle] staged node-repl-host runtime for dev self-seed`);
  }
  log(`[stage:agent-bundle] staged ${stagedBundlePath}`);
  return { stagedBundlePath, stagedMetaPath };
}
