import { execFileSync } from "node:child_process";
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
import {
  isOhosRuntime,
  isZCodeCuaInternalFeatureEnabled,
  ZCODE_OHOS_CUA_RUNTIME_ENV_KEY,
  ZCODE_OHOS_RUNTIME_ENV_KEY,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  applyOhosLoginShellSnapshotToProcessEnv,
  readOhosTerminalShellHint,
} from "./ohosLoginShellSnapshot.js";
import { applyOhosExecShimToProcessEnv } from "./ohosExecShim.js";
import { applyOhosDevDataRootEnv, OHOS_SANDBOX_FILES } from "./ohosDevDataRoot.js";
import { ensureOhosSocketDir, ensureOhosTmpDir } from "./ohosTmpDir.js";

const logger = createServiceLogger("ohos-host-env");

// 登录 shell 快照 v3 是唯一来源：main 采集落盘，main/host 双入口各自合并。
// 无快照时保持引导 PATH，下次启动自愈（host 不继承 main env，spec 02）。

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
  // 开发包数据根与会话库（spec 24）：由引导按身份决定，用户 shell 同名变量不能覆盖。
  "ZCODE_DATA_ROOT_DIR",
  "ZCODE_SESSION_DB_PATH",
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
// exec 是前提。旧位置 .zcode/bin 上带生成标记的 wrapper 由 ensureOhosSshWrappers 清理。
export function ohosSshWrapperBinDir(realHome: string): string {
  return join(realHome, ".zcode", "bridge", "bin");
}

const LEGACY_SSH_WRAPPER_BIN_DIR_SEGMENTS = [".zcode", "bin"] as const;

function buildSshWrapperScript(realHome: string, tool: "ssh" | "scp"): string {
  // 候选顺序：系统路径 → 运行时 PATH（排除自身）。PATH 来自登录 shell 快照，
  // 用户安装的 ssh 会自然出现在其中（spec 02）。
  const candidates = [`/usr/bin/${tool}`, `/bin/${tool}`];
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

/**
 * devecocli 兼容 CLT 根：devecocli 不看 PATH，只从 `DEVECO_CLI_CLT_PATH` 推导
 * `<root>/sdk/default/openharmony/toolchains/hdc`。这里生成一个仅含版本信息与
 * `hdc` 转发器的骨架，让 `device`/`log`/`ui` 这些纯设备命令走随包 hdc-direct；
 * 构建类命令不经过这里（分发启动器对它们保持用户原环境）。
 */
export function ohosDevecocliShimDir(realHome: string): string {
  return join(realHome, ".zcode", "bridge", "devecocli-clt");
}

const DEVECOCLI_SHIM_CLT_VERSION = "# Version: 26.0.0";
const DEVECOCLI_SHIM_API_VERSION = 26;

function buildDevecocliHdcWrapper(hdcDirectPath: string): string {
  return [
    "#!/bin/sh",
    "# zcode-ohos 生成（可安全删除，下次启动重建）：devecocli 的 hdc 调用转到随包 hdc-direct。",
    `exec "${hdcDirectPath}" "$@"`,
    "",
  ].join("\n");
}

/** 生成兼容 CLT 骨架并返回根目录；目录不可写时返回 undefined。 */
export function ensureOhosDevecocliShim(realHome: string): string | undefined {
  const root = ohosDevecocliShimDir(realHome);
  const toolchainsDir = join(root, "sdk", "default", "openharmony", "toolchains");
  const hdcDirectPath = join(ohosSshWrapperBinDir(realHome), "hdc-direct");
  try {
    mkdirSync(toolchainsDir, { recursive: true });
    for (const rel of [
      ["sdk", "default", "openharmony", "native"],
      ["sdk", "default", "openharmony", "previewer"],
    ]) {
      mkdirSync(join(root, ...rel), { recursive: true });
    }
    writeFileSync(join(root, "version.txt"), `${DEVECOCLI_SHIM_CLT_VERSION}\n`, "utf8");
    writeFileSync(
      join(root, "sdk", "default", "sdk-pkg.json"),
      `${JSON.stringify({ apiVersion: DEVECOCLI_SHIM_API_VERSION })}\n`,
      "utf8",
    );
    writeFileSync(
      join(toolchainsDir, "oh-uni-package.json"),
      `${JSON.stringify({ apiVersion: DEVECOCLI_SHIM_API_VERSION })}\n`,
      "utf8",
    );
    if (!ensureWrapperScript(join(toolchainsDir, "hdc"), buildDevecocliHdcWrapper(hdcDirectPath))) {
      return undefined;
    }
    return root;
  } catch {
    return undefined;
  }
}

/** 生成 `devecocli` 分发启动器：设备命令换 shim CLT，其余保持用户环境。 */
export function ensureOhosDevecocliLauncher(
  realHome: string,
  shimRoot: string,
): string | undefined {
  const binDir = ohosSshWrapperBinDir(realHome);
  const script = [
    "#!/bin/sh",
    "# zcode-ohos 生成（可安全删除，下次启动重建）。",
    "# devecocli 只从 DEVECO_CLI_CLT_PATH 推导 hdc；device/log/ui 用应用生成的兼容",
    "# CLT 根（hdc -> 随包 hdc-direct），其余子命令保持用户原环境。",
    `SELF_DIR="${binDir}"`,
    'REAL=""',
    "IFS=:; for d in $PATH; do",
    '  [ -z "$d" ] && continue',
    '  [ "$d" = "$SELF_DIR" ] && continue',
    '  if [ -x "$d/devecocli" ]; then REAL="$d/devecocli"; break; fi',
    "done",
    'if [ -z "$REAL" ]; then echo "devecocli: not found in PATH" >&2; exit 127; fi',
    'case "$1" in',
    '  device|log|ui) DEVECO_CLI_CLT_PATH="' + shimRoot + '" exec "$REAL" "$@" ;;',
    '  *) exec "$REAL" "$@" ;;',
    "esac",
    "",
  ].join("\n");
  try {
    mkdirSync(binDir, { recursive: true });
  } catch {
    return undefined;
  }
  return ensureWrapperScript(join(binDir, "devecocli"), script) ? binDir : undefined;
}

/**
 * `hdc-direct` 启动器：应用自带的 TCP 直连客户端（spec 11）。
 *
 * 只暴露 `hdc-direct`，不接管用户环境里的 `hdc`——用户可以用任意方式提供 hdc
 * （HiShell PATH、.zshrc、CLT、brew…），应用不猜、也不写死任何安装布局。
 * 放在桥目录是因为它本来就在登录 shell 的 PATH 上；脚本只负责用 PATH 里的
 * `node` 执行随包 CLI，找不到资产或 node 时明确报错退出 127。
 */
function buildHdcDirectLauncherScript(): string {
  return [
    "#!/bin/sh",
    "# zcode-ohos 生成（可安全删除，下次启动重建）。",
    "# 随包 hdc-direct：TCP 直连设备 hdcd，不依赖本地 hdc server、CLT 或用户 PATH 里的 hdc。",
    'CLI="${ZCODE_BUNDLED_RESOURCE_DIR:-}/node-runtime/hdc-direct/dist/src/cli.js"',
    'if [ ! -f "$CLI" ]; then',
    '  echo "hdc-direct: bundled runtime missing ($CLI)" >&2',
    "  exit 127",
    "fi",
    'NODE_BIN="$(command -v node 2>/dev/null || true)"',
    'if [ -z "$NODE_BIN" ]; then',
    '  echo "hdc-direct: node not found in PATH" >&2',
    "  exit 127",
    "fi",
    'exec "$NODE_BIN" "$CLI" "$@"',
    "",
  ].join("\n");
}

/** 生成 `hdc` 启动器并返回桥目录；目录不可写时返回 undefined，不阻断启动。 */
export function ensureOhosHdcDirectLauncher(realHome: string): string | undefined {
  const binDir = ohosSshWrapperBinDir(realHome);
  try {
    mkdirSync(binDir, { recursive: true });
  } catch {
    return undefined;
  }
  return ensureWrapperScript(join(binDir, "hdc-direct"), buildHdcDirectLauncherScript())
    ? binDir
    : undefined;
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
 * 终端 shell 决策（OHOS）：main 落盘的 hint 是唯一来源——只有 main 视图能验证系统
 * zsh 可执行，终端 shell 也在 main 域启动（specs/ohos-port/02）。返回 null 走通用候选链。
 */
export function resolveOhosTerminalShell(): string | null {
  if (!isOhosRuntime()) return null;
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
 * SKIP_KEYS 防应用管理键）。无快照时保持引导自身 PATH。
 */
export function applyOhosUserShellEnvToProcessEnv(
  log: (message: string) => void = () => {},
): OhosUserShellEnvResult | undefined {
  const realHome = resolveOhosRealHome();
  if (!realHome) return undefined;

  const snapshotApplied = applyOhosLoginShellSnapshotToProcessEnv(realHome, log);
  const hasSnapshotPath = snapshotApplied.includes("PATH");

  // ssh/scp wrapper 前置：平台属主校验坑 + 子进程视图差异的正解（02）。
  // hdc-direct 放在同一桥目录（已在登录 shell PATH 上），不接管用户的 hdc（spec 11）。
  const sshWrapperBinDir = ensureOhosSshWrappers(realHome);
  const hdcBinDir = ensureOhosHdcDirectLauncher(realHome);
  const devecocliShimDir = hdcBinDir ? ensureOhosDevecocliShim(realHome) : undefined;
  if (devecocliShimDir) {
    ensureOhosDevecocliLauncher(realHome, devecocliShimDir);
  }
  const wrapperBinDir = sshWrapperBinDir ?? hdcBinDir;
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
/**
 * 把 `param get persist.hdc.port` 的输出转成 `ZCODE_HDC_TARGET`。
 * 非法值、空值与读取异常一律返回 undefined —— 注入失败不能阻断 host 启动（spec 11）。
 */
export function resolveOhosHdcTarget(readPort: () => string): string | undefined {
  try {
    const port = readPort().trim();
    if (!/^\d+$/u.test(port) || Number(port) <= 0) return undefined;
    return `127.0.0.1:${port}`;
  } catch {
    return undefined;
  }
}

/**
 * devecocli 只认 `COMMAND_LINE_TOOL_PATH`，不吃 `DEVECO_CLI_CLT_PATH`；而用户环境
 * 通常只配后者。这里补一个别名（显式值优先，不覆盖），让外置工具按正常流程找到
 * 真实 CLT，不依赖任何 shim（spec 11）。
 */
export function resolveCommandLineToolPath(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.COMMAND_LINE_TOOL_PATH?.trim();
  if (explicit) return explicit;
  return env.DEVECO_CLI_CLT_PATH?.trim() || undefined;
}

export function bootstrapOhosHostUserShellEnv(): void {
  if (!isOhosRuntime()) return;
  // 平台身份权威信号（spec 15）：MCP 子进程为绕开 bundle noexec 改由用户环境 node 启动，
  // 其 process.platform 报 "linux"。身份改由本标记跨解释器继承（agent / MCP 子进程 / Bash）。
  // ??= 让显式值优先，便于本地排查与测试。
  process.env[ZCODE_OHOS_RUNTIME_ENV_KEY] ??= "1";
  // TMPDIR 只作用于 host（agent）与继承它的终端；平台 /tmp 不可写（spec 03）。
  const realHome = resolveOhosRealHome();
  const tmpDir = realHome ? ensureOhosTmpDir(realHome) : undefined;
  // 开发包数据根（spec 24）：host 不继承 main env，按包内标记自设；TMPDIR 建得出来即真实 home 可写。
  const devRoot = applyOhosDevDataRootEnv(tmpDir && realHome ? realHome : OHOS_SANDBOX_FILES);
  if (devRoot) logger.info(undefined, `dev data root=${devRoot}`);
  applyOhosUserShellEnvToProcessEnv((message) => {
    logger.info(undefined, message);
  });
  if (tmpDir) {
    process.env.TMPDIR = tmpDir;
    logger.info(undefined, `TMPDIR=${tmpDir}`);
  }
  // 设备通道（spec 11）：`hdc` 由桥目录启动器转发到官方 CLI（见 apply 阶段），
  // 这里把本机 hdcd 端口解析成 ZCODE_HDC_TARGET 供 skill / Agent 直接使用。
  const commandLineToolPath = resolveCommandLineToolPath(process.env);
  if (commandLineToolPath) {
    process.env.COMMAND_LINE_TOOL_PATH = commandLineToolPath;
  }
  // 端口来自设备参数 persist.hdc.port；一次同步调用（startup 阶段、2s 上限），
  // 失败只跳过注入，不阻断 host 启动。
  if (!process.env.ZCODE_HDC_TARGET?.trim()) {
    const target = resolveOhosHdcTarget(() =>
      execFileSync("param", ["get", "persist.hdc.port"], {
        encoding: "utf-8",
        timeout: 2000,
      }),
    );
    if (target) {
      process.env.ZCODE_HDC_TARGET = target;
      logger.info(undefined, `ZCODE_HDC_TARGET=${target}`);
    } else {
      logger.warn(undefined, "ZCODE_HDC_TARGET skipped: persist.hdc.port unavailable");
    }
  }

  // socket 目录不能跟随 TMPDIR（真实 home 拦截 AF_UNIX bind），由 host 下发、
  // CLI 侧读取（node-repl broker 的 znr-*.sock）。
  const socketDir = ensureOhosSocketDir();
  if (socketDir) {
    process.env.ZCODE_OHOS_SOCKET_DIR = socketDir;
  }
  // Computer Use 运行时门（spec 15）：node-repl server 以 ZCODE_OHOS_CUA_RUNTIME 是否存在
  // 决定要不要建 runtime。不能沿用 ZCODE_CUA_PERMISSION_BROKER_SOCKET —— 那个键在
  // buildMcpStdioEnv → sanitizeZCodeRuntimeEnv 被剔除（confused-deputy 防护），只会定向
  // 回注给名为 zcode-cua 的 server；OHOS 的 runtime 住在 node_repl 里，永远拿不到它。
  // kill switch 关闭时不注入，保持 unavailable。
  if (isZCodeCuaInternalFeatureEnabled(process.env)) {
    process.env[ZCODE_OHOS_CUA_RUNTIME_ENV_KEY] ??= "1";
  }
  // shebang 改写 shim：本进程自身无法受益（LD_PRELOAD 需启动时注入），但 agent 的
  // Bash 子进程与后续 MCP/插件子进程经 env 继承生效（spec 03）。
  if (applyOhosExecShimToProcessEnv()) {
    logger.info(undefined, "exec shim preloaded");
  }
}
