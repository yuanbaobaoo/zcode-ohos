import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { isOhosRuntime } from "@zcode/shared";

// 终端 spawn 环境的补齐逻辑（PATH/locale/SHELL），从 terminalService 拆出保持单文件可维护。

function isUtf8Locale(value: string | undefined): boolean {
  return /utf-?8/i.test(value ?? "");
}

function isMissingOrCLocale(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toUpperCase();
  return normalized === "" || normalized === "C" || normalized === "POSIX";
}

export function isExecutable(command: string): boolean {
  try {
    if (/[\\/]/.test(command)) {
      accessSync(command, constants.X_OK);
      return true;
    }

    const pathEnv = process.env.PATH;
    if (!pathEnv) return false;

    return pathEnv.split(delimiter).some((dir) => {
      if (!dir) return false;
      try {
        accessSync(join(dir, command), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function isUsableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const DARWIN_GUI_FALLBACK_PATHS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
] as const;

// 鸿蒙终端环境：GUI 应用拿不到登录 shell 环境，按约定前置 $HOME/.harmonybrew/bin；
// 沙箱 HOME 可能被重定向，ZCODE_OHOS_BREW_PREFIX 指定真实用户前缀（未设退回当前 HOME）。
// PATH 只在终端 spawn 环境前置，不改全局 process.env。
const OHOS_HARMONYBREW_DIR_NAME = ".harmonybrew";

function resolveOhosBrewPrefix(env: NodeJS.ProcessEnv): string {
  const override = env.ZCODE_OHOS_BREW_PREFIX;
  if (override && override.trim()) return override;
  return join(homedir(), OHOS_HARMONYBREW_DIR_NAME);
}

// GUI 进程拿到的 PATH 只有 /data/app/bin:/data/service/hnp/bin，用户 zshrc 只会在
// $PATH 上追加；系统目录缺失会让 ls 等基础命令不可见。系统目录放末尾，保留用户/brew 优先级。
const OHOS_SYSTEM_PATH_ENTRIES = ["/usr/local/bin", "/bin", "/usr/bin"] as const;

function resolveOhosTerminalPath(env: NodeJS.ProcessEnv): string {
  const prefix = resolveOhosBrewPrefix(env);
  return mergePathEntries([
    join(prefix, "bin"),
    join(prefix, "sbin"),
    env.PATH,
    ...OHOS_SYSTEM_PATH_ENTRIES,
  ]);
}

// 随包 zsh 的 ncurses/tinfo 依赖目录（与 zsh 二进制同级的 lib/）。
// 应用沙箱的 ldso 不会从用户目录加载 .so，zsh 必须用随包依赖库。
function resolveOhosTerminalLibraryPath(env: NodeJS.ProcessEnv): string | undefined {
  const shell = env.ZCODE_OHOS_SHELL;
  if (!shell) return undefined;
  const libDir = join(dirname(shell), "lib");
  return isUsableDirectory(libDir) ? libDir : undefined;
}

export function mergePathEntries(entries: readonly (string | undefined)[]): string {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const value of entries) {
    for (const entry of value?.split(delimiter) ?? []) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }

  return merged.join(delimiter);
}

function resolveDarwinTerminalPath(env: NodeJS.ProcessEnv): string {
  return mergePathEntries([env.PATH, ...DARWIN_GUI_FALLBACK_PATHS]);
}

function resolveFallbackUtf8Locale(env: NodeJS.ProcessEnv): string {
  const inheritedUtf8Locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(isUtf8Locale);
  if (inheritedUtf8Locale) return inheritedUtf8Locale;

  return process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
}

export function resolveTerminalEnv(
  env: NodeJS.ProcessEnv = process.env,
  shell?: string,
): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  const fallbackLocale = resolveFallbackUtf8Locale(env);

  // macOS 从 Dock/Finder/登录项启动 Electron 时，父进程通常只带 /usr/bin:/bin:/usr/sbin:/sbin，
  // 甚至缺失 PATH；内置终端虽然打开了登录 shell，但 zsh/bash 仍会先继承这个过窄 PATH，
  // 导致 ls 以外的 npm/node/pnpm 等常用命令找不到，部分用户的 profile 又不会重新补齐。
  // 这里仅在传给 terminal 的环境里补常见 Homebrew 与系统路径，不改全局 process.env，并保留用户已有顺序。
  if (process.platform === "darwin") {
    nextEnv.PATH = resolveDarwinTerminalPath(env);
  }

  // 鸿蒙应用启动时同样继承不到 HiShell 的登录环境，终端里 harmonybrew 的 node/git 等
  // 全部不可见；前置 brew bin/sbin（等价 `export PATH="$HOME/.harmonybrew/bin:$PATH"`）。
  if (isOhosRuntime()) {
    nextEnv.PATH = resolveOhosTerminalPath(env);
    // 随包 zsh 的依赖库目录前置到 LD_LIBRARY_PATH（不覆盖已有条目顺序之外的部分）。
    const zshLibDir = resolveOhosTerminalLibraryPath(env);
    if (zshLibDir) {
      nextEnv.LD_LIBRARY_PATH = mergePathEntries([zshLibDir, env.LD_LIBRARY_PATH]);
    }
    // 终端 spawn 已显式指定 shell 路径，SHELL 变量供嵌套 shell 与工具（zsh 启动脚本、
    // starship 等）识别当前 shell；仅在缺失或指向不可用路径时回填，不覆盖用户显式配置。
    if (shell && (!nextEnv.SHELL || (nextEnv.SHELL !== shell && !isExecutable(nextEnv.SHELL)))) {
      nextEnv.SHELL = shell;
    }
  }

  // runtime 登录 shell 环境采集会用 TERM=dumb / CI=1 来避免 profile 脚本进入交互分支，
  // 但真实 terminal panel 必须作为交互终端启动，否则 starship、p10k、颜色能力检测等会降级成无样式输出。
  nextEnv.TERM = "xterm-256color";
  nextEnv.COLORTERM = nextEnv.COLORTERM?.trim() || "truecolor";
  if (nextEnv.CI === "1" && env.TERM === "dumb") {
    delete nextEnv.CI;
  }

  // Electron 从 GUI 启动时 host process 可能继承不到登录 shell 的 UTF-8 locale，
  // 子 shell 会落到 C/POSIX locale，中文路径会被 zsh/bash 显示成 \M-^ 这类转义乱码。
  // 这里只在 locale 缺失或明确为 C/POSIX 时补 UTF-8，保留用户已经配置好的 UTF-8 locale。
  if (isMissingOrCLocale(nextEnv.LANG)) {
    nextEnv.LANG = fallbackLocale;
  }
  if (isMissingOrCLocale(nextEnv.LC_CTYPE)) {
    nextEnv.LC_CTYPE = fallbackLocale;
  }
  if (nextEnv.LC_ALL !== undefined && isMissingOrCLocale(nextEnv.LC_ALL)) {
    nextEnv.LC_ALL = fallbackLocale;
  }

  return nextEnv;
}
