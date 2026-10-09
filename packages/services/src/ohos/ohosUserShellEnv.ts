import {
  accessSync,
  constants,
  existsSync,
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

/**
 * OHOS 用户 shell 环境（~/.zshenv/.zprofile/.zshrc 的 export）注入。
 * host 由 appspawn 拉起、不继承 main 的 env（装机实证），agent/终端要拿到
 * harmonybrew 的 PATH 必须在 main 与 host 两个入口各自重放，四端才一致。
 */

const OHOS_USER_STORAGE_ROOT = "/storage/Users";
const HARMONYBREW_DIR_NAME = ".harmonybrew";

function isAccessiblePath(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// 真实用户 home 下的 harmonybrew 前缀（沙箱 HOME 已被重定向，不能从 $HOME 推）。
// /storage/Users 顶层 readdir/glob 不可用但子目录直访正常：先探测标准 currentUser，
// 扫描只作多用户补充。可用 ZCODE_OHOS_BREW_PREFIX 覆盖。
export function resolveHarmonybrewPrefix(): string | undefined {
  const override = process.env.ZCODE_OHOS_BREW_PREFIX?.trim();
  if (override) return override;

  const direct = join(OHOS_USER_STORAGE_ROOT, "currentUser", HARMONYBREW_DIR_NAME);
  if (existsSync(join(direct, "bin"))) {
    return direct;
  }
  try {
    for (const entry of readdirSync(OHOS_USER_STORAGE_ROOT)) {
      const prefix = join(OHOS_USER_STORAGE_ROOT, entry, HARMONYBREW_DIR_NAME);
      if (existsSync(join(prefix, "bin"))) {
        return prefix;
      }
    }
  } catch {
    // /storage/Users 不可读（非 OHOS 沙箱形态或权限变化）时静默跳过，
    // 终端服务会回退到当前 HOME 下的 .harmonybrew。
  }
  return undefined;
}

// 真实用户 home：优先取带 harmonybrew 的用户目录；沙箱内 /storage/Users 通常不可见，
// 回退标准 currentUser。可用 ZCODE_OHOS_REAL_HOME 覆盖。
export function resolveOhosRealHome(): string | undefined {
  const override = process.env.ZCODE_OHOS_REAL_HOME?.trim();
  if (override) return override;
  try {
    const entries = readdirSync(OHOS_USER_STORAGE_ROOT).filter((name) => !name.startsWith("."));
    const sorted = [...entries].sort((a, b) => {
      const aBrew = existsSync(join(OHOS_USER_STORAGE_ROOT, a, HARMONYBREW_DIR_NAME)) ? 0 : 1;
      const bBrew = existsSync(join(OHOS_USER_STORAGE_ROOT, b, HARMONYBREW_DIR_NAME)) ? 0 : 1;
      return aBrew - bBrew;
    });
    if (sorted[0]) return join(OHOS_USER_STORAGE_ROOT, sorted[0]);
  } catch {
    // 应用沙箱内 /storage/Users 不可读是常态，走标准路径回退
  }
  return isOhosRuntime() ? join(OHOS_USER_STORAGE_ROOT, "currentUser") : undefined;
}

// 真实 home 的 zsh 初始化文件（按 zsh 实际加载顺序），复刻登录 shell 的环境注入。
const OHOS_USER_SHELL_ENV_FILES = [".zshenv", ".zprofile", ".zshrc"] as const;

// 单行 export 语句（export NAME=value / "value" / 'value'）；不匹配 alias、函数体、
// 裸 export NAME、多行值——环境注入只需要这些。
const SHELL_EXPORT_RE =
  /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:(["'])([^"'\n]*)\2|([^\s#&;|<>()[\]{}]*))\s*$/;

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
]);

interface ShellExportStatement {
  name: string;
  value: string;
}

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

function buildSshWrapperScript(
  realHome: string,
  brewPrefix: string | undefined,
  tool: "ssh" | "scp",
): string {
  // 候选链自适应 main/host 的 rootfs 视图差异（host 无 /usr/bin/ssh，见 03）：
  // 装了 brew openssh 则 host 侧也能走通，未装则明确报缺而不是误报属主错误。
  const candidates = [...(brewPrefix ? [join(brewPrefix, "bin", tool)] : []), `/usr/bin/${tool}`];
  return [
    "#!/bin/sh",
    "# zcode-ohos 生成（可安全删除，下次启动重建）。存在的原因：",
    "# /storage/Users 属主被虚拟化层固定为 20001006，ssh 读默认路径 config 会因",
    "# 「属主!=进程uid」直接退出（Bad owner or permissions，chmod 也救不了）；",
    "# -F 显式指向同一文件可跳过校验。HiShell 侧靠 rc alias 做同样的事，但",
    "# alias 不随 env 继承，spawn 的子进程只有 wrapper 这一条路。详见 specs/ohos-port/02。",
    `for s in ${candidates.join(" ")}; do`,
    `  if [ -x "$s" ]; then exec "$s" -F ${join(realHome, ".ssh", "config")} "$@"; fi`,
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
  const brewPrefix = resolveHarmonybrewPrefix();
  const tools: Array<"ssh" | "scp"> = ["ssh", "scp"];
  let anyReady = false;
  for (const tool of tools) {
    if (
      ensureWrapperScript(join(binDir, tool), buildSshWrapperScript(realHome, brewPrefix, tool))
    ) {
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
 * main——路径必须由 main 视图验证，specs/ohos-port/02）。返回 null 走通用候选链。
 */
export function resolveOhosTerminalShell(): string | null {
  if (!isOhosRuntime()) return null;
  if (process.env.ZCODE_OHOS_SHELL) return process.env.ZCODE_OHOS_SHELL;
  const realHome = resolveOhosRealHome();
  return realHome ? (readOhosTerminalShellHint(realHome) ?? null) : null;
}

function parseShellExportLines(content: string): ShellExportStatement[] {
  const statements: ShellExportStatement[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = SHELL_EXPORT_RE.exec(line);
    if (!match) continue;
    const [, name, , quoted, bare] = match;
    if (!name) continue;
    statements.push({ name, value: (quoted ?? bare ?? "").trim() });
  }
  return statements;
}

function expandShellValue(value: string, realHome: string): string {
  let expanded = value.replaceAll(/^~(?=\/|$)/g, realHome);
  expanded = expanded.replaceAll("$HOME", realHome).replaceAll("${HOME}", realHome);
  return expanded;
}

/**
 * 复刻 zsh 登录 shell 的 PATH 演算：按加载顺序重放 export PATH 行。
 * `$PATH`/`${PATH}` 是「既有 PATH 插入位」（覆盖前置/后置两种写法）；
 * 不含 `$PATH` 的赋值语义为整体替换（与 zsh 一致）。返回 null 表示无需变更。
 */
function replayShellPath(
  statementsByFile: Array<{ file: string; statements: ShellExportStatement[] }>,
  currentPath: string,
  realHome: string,
): { path: string; injectedEntries: string[] } | null {
  let entries = currentPath.split(":").filter(Boolean);
  const injectedEntries: string[] = [];
  let touched = false;
  for (const { file, statements } of statementsByFile) {
    for (const statement of statements) {
      if (statement.name !== "PATH") continue;
      touched = true;
      const expanded = expandShellValue(statement.value, realHome);
      const parts = expanded.split(":");
      const markerIndex = parts.findIndex((part) => part === "$PATH" || part === "${PATH}");
      const cleanParts = parts.filter((part) => part !== "$PATH" && part !== "${PATH}");
      if (markerIndex === -1) {
        entries = cleanParts;
      } else {
        entries = [
          ...cleanParts.slice(0, markerIndex),
          ...entries,
          ...cleanParts.slice(markerIndex),
        ];
      }
      injectedEntries.push(
        `${file}: ${cleanParts.filter((p) => p && !currentPath.includes(p)).join(":")}`,
      );
    }
  }
  if (!touched) return null;
  const seen = new Set<string>();
  const deduped = entries.filter((entry) => (seen.has(entry) ? false : (seen.add(entry), true)));
  return { path: deduped.join(":"), injectedEntries: injectedEntries.filter(Boolean) };
}

export interface OhosUserShellEnvResult {
  realHome: string;
  pathTouched: boolean;
  pathInjectedEntries: string[];
  appliedVars: string[];
  brewPrefix?: string;
  sshWrapperBinDir?: string;
}

/**
 * 把用户 shell 环境重放进 process.env：rc 文件 export PATH 按加载顺序重放（$PATH 插入位、
 * 去重）；其他 export 只补未定义键；harmonybrew bin/sbin 兜底前置。幂等（不重复注入）。
 */
export function applyOhosUserShellEnvToProcessEnv(
  log: (message: string) => void = () => {},
): OhosUserShellEnvResult | undefined {
  const realHome = resolveOhosRealHome();
  if (!realHome) return undefined;

  const statementsByFile: Array<{ file: string; statements: ShellExportStatement[] }> = [];
  for (const fileName of OHOS_USER_SHELL_ENV_FILES) {
    const filePath = join(realHome, fileName);
    try {
      const content = readFileSync(filePath, "utf8");
      statementsByFile.push({ file: fileName, statements: parseShellExportLines(content) });
    } catch {
      /* 文件不存在或不可读（未授权/未创建）按缺省处理 */
    }
  }

  // PATH：按 zsh 加载顺序重放（$HOME 展开、$PATH 插入位、去重）。
  const pathResult = statementsByFile.length
    ? replayShellPath(statementsByFile, process.env.PATH ?? "", realHome)
    : null;
  if (pathResult && pathResult.path) {
    log(
      `user shell PATH applied from ${OHOS_USER_SHELL_ENV_FILES.join("+")}: ` +
        pathResult.injectedEntries.join(" | ").slice(0, 400),
    );
    process.env.PATH = pathResult.path;
  }

  // 其他 export 补齐应用未定义的键（不覆盖引导自身管理的键），子进程经继承生效。
  const appliedNames: string[] = [];
  for (const { statements } of statementsByFile) {
    for (const statement of statements) {
      if (statement.name === "PATH" || SHELL_EXPORT_SKIP_KEYS.has(statement.name)) continue;
      if (!statement.value) continue;
      if (process.env[statement.name] !== undefined) continue;
      process.env[statement.name] = expandShellValue(statement.value, realHome);
      appliedNames.push(statement.name);
    }
  }

  // 登录 shell 快照合并（main 上次启动采集落盘）：PATH 整体替换（rc 完整演算，
  // 含静态重放吃不到的动态语句），其余键补缺。wrapper 与 brew 兜底在其后前置，
  // 保证遮蔽顺序：wrapper bin 最前 → brew bin/sbin → 快照/静态 PATH。
  applyOhosLoginShellSnapshotToProcessEnv(realHome, log);

  // ssh/scp wrapper 前置：平台属主校验坑 + host rootfs 视图差异的正解（02）。
  const wrapperBinDir = ensureOhosSshWrappers(realHome);
  if (wrapperBinDir) {
    const entries = (process.env.PATH ?? "").split(":").filter(Boolean);
    if (!entries.includes(wrapperBinDir)) {
      process.env.PATH = [wrapperBinDir, ...entries].join(":");
    }
  }

  // harmonybrew 兜底：zshrc 未配 PATH 时仍保证 brew 工具可见。组装顺序固定
  // wrapper → brew → 其余：若 brew 装了 openssh，未包装的 brew ssh 不能遮蔽 wrapper。
  const brewPrefix = resolveHarmonybrewPrefix();
  if (brewPrefix) {
    process.env.ZCODE_OHOS_BREW_PREFIX ??= brewPrefix;
    const brewEntries = [join(brewPrefix, "bin"), join(brewPrefix, "sbin")].filter(
      isAccessiblePath,
    );
    const existingEntries = (process.env.PATH ?? "").split(":").filter(Boolean);
    const missing = brewEntries.filter((entry) => !existingEntries.includes(entry));
    if (missing.length > 0) {
      const rest = existingEntries.filter((entry) => entry !== wrapperBinDir);
      process.env.PATH = [wrapperBinDir, ...missing, ...rest].filter(Boolean).join(":");
    }
  }

  const result: OhosUserShellEnvResult = {
    realHome,
    pathTouched: Boolean(pathResult),
    pathInjectedEntries: pathResult?.injectedEntries ?? [],
    appliedVars: appliedNames,
    ...(brewPrefix ? { brewPrefix } : {}),
    ...(wrapperBinDir ? { sshWrapperBinDir: wrapperBinDir } : {}),
  };
  if (pathResult || appliedNames.length > 0 || wrapperBinDir) {
    log(
      `user shell env injected: vars=${appliedNames.join(",")} pathEntries=${result.pathInjectedEntries.length} ` +
        `brewPrefix=${brewPrefix ?? "(none)"} sshWrappers=${wrapperBinDir ?? "(none)"}`,
    );
  }
  return result;
}

/**
 * host（NodeService）入口注入：appspawn 拉起不继承 main 的 env，host 必须自行重放
 * 用户 shell 环境（agent Worker 及其 Bash 子进程经 process.env 继承）。非 OHOS 空操作。
 */
export function bootstrapOhosHostUserShellEnv(): void {
  if (!isOhosRuntime()) return;
  // 此入口早于 logger 接线，console 经 Electron 适配层落 hilog（tag Electron，
  // 抓取配方见 specs/ohos-port/README.md），是该时点唯一排障通道。
  applyOhosUserShellEnvToProcessEnv((message) => {
    console.log(`[ohos-host-env] ${message}`);
  });
}
