import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isOhosRuntime } from "@zcode/shared";

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
const SHELL_EXPORT_SKIP_KEYS = new Set([
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
}

/**
 * 把用户 shell 环境重放进当前 process.env：
 * 1. ~/.zshenv/.zprofile/.zshrc 的 export PATH 按 zsh 加载顺序重放（$HOME 展开、
 *    $PATH 插入位、去重）；
 * 2. 其他 export 补齐应用未定义的键（不覆盖引导自身管理的键）；
 * 3. harmonybrew 前缀的 bin/sbin 兜底前置（zshrc 未配 PATH 时仍可用 brew 工具）。
 * 幂等：重复调用不会重复注入（PATH 去重 + 只补未定义键）。
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

  // harmonybrew 兜底：zshrc 未配 PATH 时仍保证 brew 工具可见。
  const brewPrefix = resolveHarmonybrewPrefix();
  if (brewPrefix) {
    process.env.ZCODE_OHOS_BREW_PREFIX ??= brewPrefix;
    const brewEntries = [join(brewPrefix, "bin"), join(brewPrefix, "sbin")].filter(
      isAccessiblePath,
    );
    const existingEntries = (process.env.PATH ?? "").split(":").filter(Boolean);
    const missing = brewEntries.filter((entry) => !existingEntries.includes(entry));
    if (missing.length > 0) {
      process.env.PATH = [...missing, ...existingEntries].join(":");
    }
  }

  const result: OhosUserShellEnvResult = {
    realHome,
    pathTouched: Boolean(pathResult),
    pathInjectedEntries: pathResult?.injectedEntries ?? [],
    appliedVars: appliedNames,
    ...(brewPrefix ? { brewPrefix } : {}),
  };
  if (pathResult || appliedNames.length > 0) {
    log(
      `user shell env injected: vars=${appliedNames.join(",")} pathEntries=${result.pathInjectedEntries.length} brewPrefix=${brewPrefix ?? "(none)"}`,
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
