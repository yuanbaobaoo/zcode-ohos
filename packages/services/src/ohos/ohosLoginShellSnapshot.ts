import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isOhosRuntime } from "@zcode/shared";
import { OHOS_SHELL_BASE_PATH, SHELL_EXPORT_SKIP_KEYS } from "./ohosUserShellEnv.js";
import { ensureOhosTmpDir } from "./ohosTmpDir.js";

/**
 * OHOS 登录 shell 快照 v3：main 采集（真机 cwd=home、显式最小基线）、落盘、main/host 合并。
 * 采集不在 host：host 视图无系统 zsh 且同步 spawn 触发 clone3 SIGSYS（specs/ohos-port/03）。
 */

// 真机实证 main 可见的系统 zsh（5.9，musl）；host 视图不存在，用 existsSync 天然分流。
const OHOS_SYSTEM_ZSH = "/usr/bin/zsh";
const CAPTURE_TIMEOUT_MS = 12_000;
const CAPTURE_MAX_BUFFER = 2 * 1024 * 1024;
const SNAPSHOT_MARKER = "__ZCODE_OHOS_LOGIN_ENV__";
// shell 自身状态不是用户环境；采集基线里的内部变量也不应进入快照。
const SHELL_INTERNAL_KEYS = new Set(["_", "SHLVL", "PWD", "OLDPWD", "TERM"]);

export function ohosLoginSnapshotPath(realHome: string): string {
  return join(realHome, ".zcode", "v2", "ohos-login-env.json");
}

/**
 * 终端 shell 提示文件：main 视图实证可 exec 的 shell 绝对路径（一行文本）。
 * fork env 传不进 appspawn 拉起的 host（装机实证），exec 又发生在 main 的 pty
 * 中继——host 无法自行验证系统 zsh（视图不可见），由 main 落盘、host 读取。
 */
export function ohosTerminalShellHintPath(realHome: string): string {
  return join(realHome, ".zcode", "v2", "ohos-terminal-shell");
}

export function writeOhosTerminalShellHint(realHome: string, shell: string): void {
  try {
    const hintPath = ohosTerminalShellHintPath(realHome);
    mkdirSync(dirname(hintPath), { recursive: true });
    writeFileSync(hintPath, `${shell}\n`, "utf8");
  } catch {
    // 落盘失败时 host 走候选链回退，不阻断引导
  }
}

export function readOhosTerminalShellHint(realHome: string): string | undefined {
  try {
    const shell = readFileSync(ohosTerminalShellHintPath(realHome), "utf8").trim();
    return shell.startsWith("/") ? shell : undefined;
  } catch {
    return undefined;
  }
}

interface LoginSnapshotFile {
  version: 3;
  capturedAt: number;
  shell: string;
  cwd: string;
  env: Record<string, string>;
}

// 显式基线：继承 process.env 会把 main 内部变量带进快照，并让 rc 的 PATH 演算在已污染的
// PATH 上叠加。cwd 必须是真实 home——登录 rc 里的工具链初始化要求 cwd 对进程 uid 可读
// （cwd=/ 时 shellenv 类脚本会直接失败，真机实证，spec 02）。
function buildCaptureEnv(realHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: realHome,
    PATH: OHOS_SHELL_BASE_PATH,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: "dumb",
  };
  const tmpDir = ensureOhosTmpDir(realHome);
  if (tmpDir) env.TMPDIR = tmpDir;
  return env;
}

function runLoginZsh(realHome: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // 标记对提取：rc 的 stdout 污染（工具链 banner、starship 转义等）在标记之前，不进快照。
    const child = spawn(OHOS_SYSTEM_ZSH, ["-ilc", `printf '%s\\0${SNAPSHOT_MARKER}\\0'; env -0`], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CAPTURE_TIMEOUT_MS,
      cwd: realHome,
      env: buildCaptureEnv(realHome),
    });
    let stdout = "";
    let settled = false;
    const settle = (error?: Error, output?: string) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(output!);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > CAPTURE_MAX_BUFFER) {
        child.kill("SIGKILL");
        settle(new Error("login shell capture exceeded max buffer"));
      }
    });
    child.on("error", (error: Error) => settle(error));
    child.on("close", (code, signal) => {
      if (signal) settle(new Error(`login shell capture killed by ${signal}`));
      else if (code !== 0) settle(new Error(`login shell capture exited ${code}`));
      else settle(undefined, stdout);
    });
  });
}

function extractMarkedEnvSnapshot(raw: string): Record<string, string> | null {
  const entries = raw.split("\0");
  const markerIndex = entries.indexOf(SNAPSHOT_MARKER);
  if (markerIndex < 0) return null;
  const env: Record<string, string> = {};
  for (const entry of entries.slice(markerIndex + 1)) {
    const sep = entry.indexOf("=");
    if (sep <= 0) continue;
    const key = entry.slice(0, sep);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = entry.slice(sep + 1);
  }
  return env;
}

/** 剔除 shell 内部键与空值；v3 存完整用户环境，不再与采集基线做差集。 */
export function sanitizeCapturedEnv(env: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!value || SHELL_INTERNAL_KEYS.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export async function captureOhosLoginShellEnv(
  realHome: string,
): Promise<Record<string, string> | null> {
  if (!isOhosRuntime() || !existsSync(OHOS_SYSTEM_ZSH)) return null;
  try {
    const captured = extractMarkedEnvSnapshot(await runLoginZsh(realHome));
    if (!captured) return null;
    const sanitized = sanitizeCapturedEnv(captured);
    return Object.keys(sanitized).length ? sanitized : null;
  } catch {
    // 慢 rc / rc 崩溃 / 输出超限：本次不更新快照，下次启动重试。
    return null;
  }
}

/** main 启动后异步刷新快照落盘（fire-and-forget，不阻塞启动路径）。 */
export async function refreshOhosLoginShellSnapshot(realHome: string): Promise<boolean> {
  const env = await captureOhosLoginShellEnv(realHome);
  if (!env) return false;
  try {
    const snapshot: LoginSnapshotFile = {
      version: 3,
      capturedAt: Date.now(),
      shell: OHOS_SYSTEM_ZSH,
      cwd: realHome,
      env,
    };
    writeFileSync(ohosLoginSnapshotPath(realHome), JSON.stringify(snapshot), "utf8");
    return true;
  } catch {
    return false;
  }
}

export function loadOhosLoginShellSnapshot(realHome: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(
      readFileSync(ohosLoginSnapshotPath(realHome), "utf8"),
    ) as Partial<LoginSnapshotFile>;
    if (
      parsed.version !== 3 ||
      !parsed.env ||
      typeof parsed.capturedAt !== "number" ||
      typeof parsed.shell !== "string" ||
      typeof parsed.cwd !== "string"
    ) {
      return null; // v2 及未知格式：按无快照处理
    }
    const env = sanitizeCapturedEnv(parsed.env);
    return Object.keys(env).length ? env : null;
  } catch {
    // 无快照（首启）或文件损坏：调用方保持引导自身 PATH。
    return null;
  }
}

/**
 * 合并快照：PATH 用快照整体替换（rc 完整演算结果）；其余键覆盖，SKIP_KEYS 防应用管理键
 * 被用户配置改写。返回应用的键名供日志。
 */
export function applyOhosLoginShellSnapshotToProcessEnv(
  realHome: string,
  log: (message: string) => void = () => {},
): string[] {
  const snapshot = loadOhosLoginShellSnapshot(realHome);
  if (!snapshot) return [];
  const applied: string[] = [];
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === "PATH" || SHELL_EXPORT_SKIP_KEYS.has(key)) continue;
    process.env[key] = value;
    applied.push(key);
  }
  if (snapshot.PATH) {
    process.env.PATH = snapshot.PATH;
    applied.push("PATH");
  }
  if (applied.length) {
    log(
      `login shell snapshot applied: vars=${applied.filter((k) => k !== "PATH").join(",")} ` +
        `pathReplaced=${snapshot.PATH ? "1" : "0"}`,
    );
  }
  return applied;
}
