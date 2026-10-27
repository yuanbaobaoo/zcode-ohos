import {
  accessSync,
  constants,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isOhosRuntime } from "@zcode/shared";
import {
  applyOhosLoginShellSnapshotToProcessEnv,
  readOhosTerminalShellHint,
} from "./ohosLoginShellSnapshot.js";
import { applyOhosExecShimToProcessEnv } from "./ohosExecShim.js";
import { ensureOhosSocketDir, ensureOhosTmpDir } from "./ohosTmpDir.js";

/**
 * OHOS 用户 shell 环境：登录 shell 快照 v3 是唯一来源（main 采集、落盘，main/host 双入口合并）。
 * 不再静态重放 rc/补 brew：无快照（首次启动、采集未完成）时保持引导自身的 PATH，下次启动自愈。
 * host 由 appspawn 拉起、不继承 main 的 env（装机实证），两入口必须各自应用。
 */

const OHOS_USER_STORAGE_ROOT = "/storage/Users";

// 采集登录 shell 的基线 PATH：与 HiShell 的 appspawn 基线一致，另补 `/bin` 覆盖
// agent 视图（`/usr/bin` 空挂载，spec 03）。
export const OHOS_SHELL_BASE_PATH =
  "/usr/local/bin:/data/app/bin:/data/service/hnp/bin:/usr/bin:/bin:/vendor/bin";

// 真实用户 home：优先 currentUser，其次首个非隐藏用户目录。可用 ZCODE_OHOS_REAL_HOME 覆盖。
export function resolveOhosRealHome(): string | undefined {
  const override = process.env.ZCODE_OHOS_REAL_HOME?.trim();
  if (override) return override;
  try {
    const entries = readdirSync(OHOS_USER_STORAGE_ROOT).filter((name) => !name.startsWith("."));
    const current = entries.find((name) => name === "currentUser");
    if (current) return join(OHOS_USER_STORAGE_ROOT, current);
    if (entries[0]) return join(OHOS_USER_STORAGE_ROOT, entries[0]);
  } catch {
    // 应用沙箱内 /storage/Users 不可读是常态，走标准路径回退
  }
  return isOhosRuntime() ? join(OHOS_USER_STORAGE_ROOT, "currentUser") : undefined;
}

// 这些键由应用引导自身管理（数据根/身份/显示），不能被用户配置覆盖。
export const SHELL_EXPORT_SKIP_KEYS = new Set([
  "HOME",
  "PATH",
  "PWD",
  "OLDPWD",
  "SHELL",
  "ZCODE_HOME",
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_RUNTIME_ENV",
  "ZCODE_OHOS_REAL_HOME",
  "ZCODE_OHOS_HOME_GRANT_PENDING",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "LD_LIBRARY_PATH",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_CTYPE",
  "LC_ALL",
  "TMPDIR",
]);

function isExecutableFileSync(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ssh/scp wrapper 目录：真实 home 下 .zcode/bridge/bin（应用桥接产物，与用户自己的
// bin 隔离；ZCODE_HOME 同根）。host/agent/终端子进程与用户都可见，用户目录 ELF 可
// exec 是实证前提。历史版本曾用 .zcode/bin，迁移时清理（见 ensureOhosSshWrappers）。
export function ohosSshWrapperBinDir(realHome: string): string {
  return join(realHome, ".zcode", "bridge", "bin");
}

const LEGACY_SSH_WRAPPER_BIN_DIR_SEGMENTS = [".zcode", "bin"] as const;

function buildSshWrapperScript(realHome: string, tool: "ssh" | "scp"): string {
  // 候选顺序：rc 演算出的 HOMEBREW_PREFIX（如有）→ 系统路径 → 运行时 PATH（排除自身）。
  // 这样 wrapper 不再依赖应用侧的 brew 前缀探测，与快照单一来源一致（spec 02）。
  const brewPrefix = process.env.HOMEBREW_PREFIX?.trim();
  const candidates = [
    ...(brewPrefix ? [join(brewPrefix, "bin", tool)] : []),
    `/usr/bin/${tool}`,
    `/bin/${tool}`,
  ];
  const selfBinDir = ohosSshWrapperBinDir(realHome);
  const configPath = join(realHome, ".ssh", "config");
  return [
    "#!/bin/sh",
    "# zcode-ohos 生成（可安全删除，下次启动重建）。存在的原因：",
    "# /storage/Users 属主被虚拟化层固定为 20001006，ssh 读默认路径 config 会因",
    "# 「属主!=进程uid」直接退出（Bad owner or permissions，chmod 也救不了）；",
    "# -F 显式指向同一文件可跳过校验。HiShell 侧靠 rc alias 做同样的事，但",
    "# alias 不随 env 继承，spawn 的子进程只有 wrapper 这一条路。详见 specs/ohos-port/02。",
    `for s in ${candidates.join(" ")}; do`,
    `  if [ -x "$s" ]; then exec "$s" -F ${configPath} "$@"; fi`,
    "done",
    `IFS=:; for d in $PATH; do`,
    `  [ -z "$d" ] && continue`,
    `  [ "$d" = "${selfBinDir}" ] && continue`,
    `  if [ -x "$d/${tool}" ]; then exec "$d/${tool}" -F ${configPath} "$@"; fi`,
    "done",
    `echo "zcode: ${tool} not found (tried: ${candidates.join(", ")})" >&2`,
    "exit 127",
    "",
  ].join("\n");
}

function ensureWrapperScript(path: string, content: string): boolean {
  try {
    let upToDate = false;
    try {
      upToDate = readFileSync(path, "utf8") === content && isExecutableFileSync(path);
    } catch {
      // 不存在或不可读：走重建
    }
    if (upToDate) return true; // 幂等：内容一致且可执行则不重写
    // 平台对已存在文件的 chmod 不可靠（实证 chmod 600 落成 660），权限不达标时
    // 删除重建，让 open(2) 的 mode 参数在创建时生效（specs/ohos-port/03）。
    try {
      unlinkSync(path);
    } catch {
      // 不存在
    }
    writeFileSync(path, content, { mode: 0o755 });
    return isExecutableFileSync(path);
  } catch {
    return false; // 目录不可写等：调用方不前置空目录，保持系统原行为
  }
}

/**
 * 生成 ssh/scp wrapper 并返回 wrapper bin 目录（PATH 前置用）。存在可读的
 * ~/.ssh/config 才生成——没有用户 ssh 配置时注入 wrapper 只会掩盖「未配置」。
 */
export function ensureOhosSshWrappers(realHome: string): string | undefined {
  try {
    accessSync(join(realHome, ".ssh", "config"), constants.R_OK);
  } catch {
    return undefined; // 无用户 ssh 配置：不生成，避免掩盖「未配置」
  }
  removeLegacySshWrappers(realHome);
  const binDir = ohosSshWrapperBinDir(realHome);
  try {
    mkdirSync(binDir, { recursive: true });
  } catch {
    return undefined;
  }
  const tools: Array<"ssh" | "scp"> = ["ssh", "scp"];
  let anyReady = false;
  for (const tool of tools) {
    if (ensureWrapperScript(join(binDir, tool), buildSshWrapperScript(realHome, tool))) {
      anyReady = true;
    }
  }
  return anyReady ? binDir : undefined;
}

// 迁移清理：删除旧位置（.zcode/bin）上本应用生成的 wrapper。只删内容带生成标记的
// 文件，用户自放的脚本不动；目录空了才删目录。
function removeLegacySshWrappers(realHome: string): void {
  const legacyDir = join(realHome, ...LEGACY_SSH_WRAPPER_BIN_DIR_SEGMENTS);
  for (const tool of ["ssh", "scp"] as const) {
    const legacyPath = join(legacyDir, tool);
    try {
      if (!readFileSync(legacyPath, "utf8").includes("zcode-ohos 生成")) continue;
      unlinkSync(legacyPath);
    } catch {
      // 不存在或不可读：无需清理
    }
  }
  try {
    if (readdirSync(legacyDir).length === 0) rmdirSync(legacyDir);
  } catch {
    // 目录不存在或非空：保留
  }
}

/**
 * 终端 shell 决策（OHOS）：ZCODE_OHOS_SHELL（fork env，适配层修复后可达）→
 * main 落盘的 hint 文件（fork env 装机实证传不进 appspawn host，且 exec 在
 * native child——路径必须按其视图回退，specs/ohos-port/02）。返回 null 走通用候选链。
 */
export function resolveOhosTerminalShell(): string | null {
  if (!isOhosRuntime()) return null;
  if (process.env.ZCODE_OHOS_SHELL) return process.env.ZCODE_OHOS_SHELL;
  const realHome = resolveOhosRealHome();
  if (!realHome) return null;
  return readOhosTerminalShellHint(realHome) ?? null;
}

export interface OhosUserShellEnvResult {
  realHome: string;
  pathTouched: boolean;
  appliedVars: string[];
  sshWrapperBinDir?: string;
}

/**
 * 把用户 shell 环境注入 process.env：快照 v3 是唯一来源（PATH 整体替换、其余键覆盖，
 * SKIP_KEYS 防应用管理键）。无快照时保持引导自身 PATH，不再重放 rc / 补 brew。
 */
export function applyOhosUserShellEnvToProcessEnv(
  log: (message: string) => void = () => {},
): OhosUserShellEnvResult | undefined {
  const realHome = resolveOhosRealHome();
  if (!realHome) return undefined;

  const snapshotApplied = applyOhosLoginShellSnapshotToProcessEnv(realHome, log);
  const hasSnapshotPath = snapshotApplied.includes("PATH");

  // ssh/scp wrapper 前置：平台属主校验坑 + 子进程视图差异的正解（02）。
  const wrapperBinDir = ensureOhosSshWrappers(realHome);
  if (wrapperBinDir) {
    const entries = (process.env.PATH ?? "").split(":").filter(Boolean);
    if (!entries.includes(wrapperBinDir)) {
      process.env.PATH = [wrapperBinDir, ...entries].join(":");
    }
  }

  const appliedVars = snapshotApplied.filter((key) => key !== "PATH");
  const result: OhosUserShellEnvResult = {
    realHome,
    pathTouched: hasSnapshotPath,
    appliedVars,
    ...(wrapperBinDir ? { sshWrapperBinDir: wrapperBinDir } : {}),
  };
  if (hasSnapshotPath || appliedVars.length > 0 || wrapperBinDir) {
    log(
      `user shell env injected: snapshot=${hasSnapshotPath ? "1" : "0"} ` +
        `vars=${appliedVars.join(",")} sshWrappers=${wrapperBinDir ?? "(none)"}`,
    );
  }
  return result;
}

/**
 * host（NodeService）入口注入：appspawn 拉起不继承 main 的 env，host 必须自行应用
 * 快照（agent Worker 及其 Bash 子进程经 process.env 继承）。非 OHOS 空操作。
 */
export function bootstrapOhosHostUserShellEnv(): void {
  if (!isOhosRuntime()) return;
  // 此入口早于 logger 接线，console 经 Electron 适配层落 hilog（tag Electron，
  // 抓取配方见 specs/ohos-port/README.md），是该时点唯一排障通道。
  applyOhosUserShellEnvToProcessEnv((message) => {
    console.log(`[ohos-host-env] ${message}`);
  });
  // TMPDIR 只作用于 host（agent）与继承它的终端；平台 /tmp 不可写（spec 03）。
  const realHome = resolveOhosRealHome();
  const tmpDir = realHome ? ensureOhosTmpDir(realHome) : undefined;
  if (tmpDir) {
    process.env.TMPDIR = tmpDir;
    console.log(`[ohos-host-env] TMPDIR=${tmpDir}`);
  }
  // socket 目录不能跟随 TMPDIR（真实 home 拦截 AF_UNIX bind），由 host 下发、
  // CLI 侧读取（node-repl broker 的 znr-*.sock）。
  const socketDir = ensureOhosSocketDir();
  if (socketDir) {
    process.env.ZCODE_OHOS_SOCKET_DIR = socketDir;
  }
  // shebang 改写 shim：本进程自身无法受益（LD_PRELOAD 需启动时注入），但 agent 的
  // Bash 子进程与后续 MCP/插件子进程经 env 继承生效（spec 03）。
  if (applyOhosExecShimToProcessEnv()) {
    console.log("[ohos-host-env] exec shim preloaded");
  }
  // 终端 shell 名：优先 brew 的 zsh（用户装了即用）；未装时不覆盖，让 hint 文件
  // （main 写入的 /usr/bin/zsh，终端由 main 域托管）成为默认——否则标签/`$SHELL`
  // 会显示 host 兜底的 bash，与实际进程不一致（真机 2026-10-27）。
  const terminalShell = resolveHostZsh();
  if (terminalShell) {
    process.env.ZCODE_OHOS_SHELL = terminalShell;
    console.log(`[ohos-host-env] terminal shell=${terminalShell}`);
  }
}

// host 视图没有 /usr/bin/zsh；只有 brew 安装的 zsh 才能在 host 域直接 exec。
function resolveHostZsh(): string | undefined {
  const brewPrefix = process.env.HOMEBREW_PREFIX?.trim();
  if (!brewPrefix) return undefined;
  const zsh = join(brewPrefix, "bin", "zsh");
  return isExecutableFileSync(zsh) ? zsh : undefined;
}
