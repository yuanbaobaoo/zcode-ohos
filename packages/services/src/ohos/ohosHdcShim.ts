/*
 * OHOS：给 devecocli 用的 hdc 直连 shim + 迷你 CLT（spec 11/14）。
 *
 * 背景（真机实证 2026-11-05）：
 * - 官方 hdc 是 client/server：客户端必须先连本机 hdc server，而应用沙箱拒绝 UDS bind，
 *   server 起不来 → `hdc list targets` 永远为空；
 * - devecocli 不读 PATH，而是按工具链根定位 `sdk/default/openharmony/toolchains/hdc`；
 *   未显式指定时回退到 HNP 的官方 hdc（同样起不了 server）；
 * - 把该位置的 hdc 换成 hdc-direct 的 CLI（纯 JS，TCP 直连设备 hdcd）后，devecocli 可用。
 *
 * 因此这里在应用自己的 home 下生成一个"迷你 CLT"：只有 version.txt + 一个 hdc shim，
 * 不碰用户安装的 CLT；再由 host 把 DEVECO_CLI_CLT_PATH / COMMAND_LINE_TOOL_PATH 指向它。
 *
 * 注意：构建类命令（hvigorw/ohpm/node）不在这个迷你 CLT 里，`devecocli run` 之类仍会失败；
 * 本 shim 只承诺设备侧调试命令（list/install/uninstall/start/stop/log/ui/screenshot）。
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GLM_ROOT_FALLBACK = "/data/storage/el1/bundle/electron/resources/resfile/resources/glm";
const HDCD_CLI_SEGMENTS = ["node-runtime", "hdc-direct", "dist", "src", "cli.js"] as const;
const TOOLCHAIN_SEGMENTS = ["sdk", "default", "openharmony", "toolchains"] as const;
// devecocli 的 assertCltVersion 默认要求 >= 26.0.0，version.txt 里必须是
// `# Version: <semver>` 的格式（真机验证）。
const CLT_VERSION_LINE = "# Version: 26.0.0";
const CLT_API_VERSION = 26;

/** 定位随包的 hdc-direct CLI 入口（bundle 内 glm 资产）。 */
export function resolveHdcdCliPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const roots = [
    env.ZCODE_BUNDLED_RESOURCE_DIR?.trim(),
    GLM_ROOT_FALLBACK,
    env.HOME?.trim() ? join(env.HOME.trim(), "resources", "glm") : undefined,
  ].filter((root): root is string => Boolean(root));
  for (const root of roots) {
    const candidate = join(root, ...HDCD_CLI_SEGMENTS);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 迷你 CLT 根目录：放应用 home 下，agent 与终端子进程都能看到。 */
export function ohosHdcShimCltDir(home: string): string {
  return join(home, ".zcode", "bridge", "clt");
}

function buildShimScript(cliPath: string): string {
  // 用运行时 PATH 里的 node：agent 的 Bash 里 node 可用（真机实证），
  // 不写死应用自身的可执行文件，避免升级换路径后失效。
  return [
    "#!/bin/sh",
    "# ZCode OHOS: hdc -> hdc-direct（TCP 直连设备 hdcd；官方 hdc 的 server 在沙箱起不来）",
    'NODE_BIN="$(command -v node 2>/dev/null || true)"',
    'if [ -z "$NODE_BIN" ]; then',
    '  echo "hdc: node not found in PATH" >&2',
    "  exit 127",
    "fi",
    `exec "$NODE_BIN" "${cliPath}" "$@"`,
    "",
  ].join("\n");
}

// 写 node/ohpm/hvigor 的最小入口与 sdk 目录骨架：只为通过 devecocli 的工具链校验。
function writeToolchainStubs(root: string): void {
  const nodeStub = [
    "#!/bin/sh",
    "# ZCode OHOS: 仅供 devecocli 工具链校验；实际 node 从 PATH 解析。",
    'exec node "$@"',
    "",
  ].join("\n");
  for (const rel of [["node", "bin", "node"], ["tool", "node", "bin", "node"]]) {
    const path = join(root, ...rel);
    mkdirSync(join(root, ...rel.slice(0, -1)), { recursive: true });
    writeFileSync(path, nodeStub, "utf8");
    chmodSync(path, 0o755);
  }
  for (const rel of [["ohpm", "bin", "pm-cli.js"], ["hvigor", "bin", "hvigorw.js"]]) {
    const path = join(root, ...rel);
    mkdirSync(join(root, ...rel.slice(0, -1)), { recursive: true });
    writeFileSync(
      path,
      '// ZCode OHOS: 占位入口，仅用于通过 devecocli 的 CLT 校验。\n' +
        'console.error("this stub CLT only supports device commands (hdc)");\n' +
        "process.exit(1);\n",
      "utf8",
    );
  }
  for (const rel of [["native"], ["previewer"]]) {
    mkdirSync(join(root, "sdk", "default", "openharmony", ...rel), { recursive: true });
  }
}

/**
 * 生成/刷新迷你 CLT，返回根目录。找不到 hdc-direct 资产时返回 undefined（不阻塞启动）。
 * 幂等：内容不变也重写（几十字节，避免版本漂移）。
 */
export function ensureOhosHdcShimClt(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const cliPath = resolveHdcdCliPath(env);
  if (!cliPath) return undefined;
  const root = ohosHdcShimCltDir(home);
  const toolchainsDir = join(root, ...TOOLCHAIN_SEGMENTS);
  const sdkDir = join(root, "sdk", "default");
  try {
    mkdirSync(toolchainsDir, { recursive: true });
    // version.txt 是 devecocli 判定"这是一个有效 CLT 根"的唯一依据。
    writeFileSync(join(root, "version.txt"), `${CLT_VERSION_LINE}\n`, "utf8");
    // API level：部分设备命令会读取；缺失只影响版本判断，不影响 hdc 调用。
    writeFileSync(
      join(sdkDir, "sdk-pkg.json"),
      `${JSON.stringify({ apiVersion: CLT_API_VERSION })}\n`,
      "utf8",
    );
    writeFileSync(
      join(toolchainsDir, "oh-uni-package.json"),
      `${JSON.stringify({ apiVersion: CLT_API_VERSION })}\n`,
      "utf8",
    );
    const shimPath = join(toolchainsDir, "hdc");
    writeFileSync(shimPath, buildShimScript(cliPath), "utf8");
    chmodSync(shimPath, 0o755);
    // devecocli 的 CLT 校验除了 version.txt，还要求工具链入口存在（真机实测：
    // 缺 node/ohpm/hvigor 会报 "COMMAND_LINE_TOOL_PATH is invalid"）。
    // 这里只提供能通过校验的最小入口；构建类命令仍应使用用户安装的真实 CLT。
    writeToolchainStubs(root);
    return root;
  } catch {
    return undefined;
  }
}
