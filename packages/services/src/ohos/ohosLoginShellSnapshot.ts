import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isOhosRuntime } from "@zcode/shared";
import { SHELL_EXPORT_SKIP_KEYS } from "./ohosUserShellEnv.js";

/**
 * OHOS 登录 shell 快照：main 采集落盘（host 视图无系统 zsh 且异步 spawn 才不触发
 * clone3 SIGSYS，specs/ohos-port/03），main/host 双入口合并。继承语义是 v2 基线
 * 差集：只存「相对采集基线新增或改值」的键——它们必然来自 rc 演算，可全量继承，
 * main 进程内部变量天然剔除；机制、时序与真机实证见 specs/ohos-port/02。
 */

// 真机实证 main 可见的系统 zsh（5.9，musl）；host 视图不存在，用 existsSync 天然分流。
const OHOS_SYSTEM_ZSH = "/usr/bin/zsh";
const CAPTURE_TIMEOUT_MS = 12_000;
const CAPTURE_MAX_BUFFER = 2 * 1024 * 1024;
const SNAPSHOT_MARKER = "__ZCODE_OHOS_LOGIN_ENV__";

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
  version: 2;
  capturedAt: number;
  /** 相对采集基线新增或改值的键（rc 演算产出）。 */
  env: Record<string, string>;
}

function runLoginZsh(realHome: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // 标记对提取：rc 的 stdout 污染（brew 输出、starship 转义等）在标记之前，不进快照。
    const child = spawn(OHOS_SYSTEM_ZSH, ["-ilc", `printf '%s\\0${SNAPSHOT_MARKER}\\0'; env -0`], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CAPTURE_TIMEOUT_MS,
      // HOME 显式指真实 home：沙箱回退分支下 process.env.HOME 可能是沙箱路径，
      // 而 rc 文件与 brew 前缀都在真实 home。TERM=dumb 防交互分支污染，不给 CI=1
      // （rc 的交互初始化正是要采集的环境来源）。
      env: { ...process.env, HOME: realHome, TERM: "dumb" },
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
  return Object.keys(env).length ? env : null;
}

/** 基线差集：只保留相对采集基线新增或改值的键（rc 演算产出，可安全继承）。 */
export function diffAgainstBaseline(
  captured: Record<string, string>,
  baseline: NodeJS.ProcessEnv,
): Record<string, string> {
  const diff: Record<string, string> = {};
  for (const [key, value] of Object.entries(captured)) {
    if (key === "_") continue; // shell 内部游标（上一命令），非用户环境
    if (baseline[key] === value) continue;
    diff[key] = value;
  }
  return diff;
}

export async function captureOhosLoginShellEnv(
  realHome: string,
): Promise<Record<string, string> | null> {
  if (!isOhosRuntime() || !existsSync(OHOS_SYSTEM_ZSH)) return null;
  try {
    const captured = extractMarkedEnvSnapshot(await runLoginZsh(realHome));
    if (!captured) return null;
    return diffAgainstBaseline(captured, process.env);
  } catch {
    // 慢 rc / rc 崩溃 / 输出超限：保持既有静态重放结果，下次启动重试。
    return null;
  }
}

/** main 启动后异步刷新快照落盘（fire-and-forget，不阻塞启动路径）。 */
export async function refreshOhosLoginShellSnapshot(realHome: string): Promise<boolean> {
  const env = await captureOhosLoginShellEnv(realHome);
  if (!env) return false;
  try {
    const snapshot: LoginSnapshotFile = {
      version: 2,
      capturedAt: Date.now(),
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
    if (parsed.version !== 2 || !parsed.env || typeof parsed.capturedAt !== "number") {
      return null;
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.env)) {
      if (typeof value === "string" && value) env[key] = value;
    }
    return Object.keys(env).length ? env : null;
  } catch {
    // 无快照（首启）或文件损坏：调用方保持静态重放结果。
    return null;
  }
}

/**
 * 把快照合并进 process.env：PATH 用快照值前置演算（rc 完整演算结果，含动态
 * 部分）；其余键是基线差集产物（纯用户环境）全量补缺不覆盖，SKIP_KEYS 仍防
 * 应用管理键。返回应用的键名供日志。PATH 前置的 wrapper/brew 兜底须在本函数
 * **之后**执行，保证遮蔽顺序。
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
    if (process.env[key] !== undefined) continue;
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
