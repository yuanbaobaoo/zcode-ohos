import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isOhosRuntime } from "@zcode/shared";
import { loadNodeSqlite } from "@zcode/shared/nodeSqliteCompat";
import { installOhosNodeRuntimeCompat } from "@zcode/shared/ohos-node-runtime-compat";
import { applyOhosUserShellEnvToProcessEnv, resolveOhosRealHome } from "@zcode/services/ohos";
import {
  refreshOhosLoginShellSnapshot,
  writeOhosTerminalShellHint,
} from "@zcode/services/ohos-login-snapshot";
import { resolveOhosZshPath } from "./desktopRuntimeEnv.js";

// 鸿蒙早期引导：必须在任何子进程 spawn 前执行（index.ts 顶部求值）。GUI 继承不到登录
// shell 环境，main/host 各自应用快照；数据根优先真实 home，不可写先落沙箱待授权迁回
// （与 host 共享）。
export const OHOS_SANDBOX_FILES = "/data/storage/el2/base/files";

// 写权探针：真实落一个临时文件。mkdirSync(recursive) 在目录已存在时静默成功，
// 掩盖「存在但不可写」（装机实测 .zcode 存在却不可写，logger 建 v2/logs 即 EPERM）。
export function isDirWritable(dir: string): boolean {
  try {
    mkdirSync(join(dir, ".zcode"), { recursive: true });
    const probe = join(dir, ".zcode", `.write-probe-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function bootstrapOhosRuntimeEnv(): void {
  if (!isOhosRuntime()) return;

  // seccomp 白名单不含 io_uring（首次异步文件 IO 即 SIGSYS 击杀进程），
  // fork 前设 UV_USE_IO_URING=0 让 libuv 走线程池并被子进程继承。
  if (process.env.UV_USE_IO_URING === undefined) {
    process.env.UV_USE_IO_URING = "0";
  }
  // 装机排障：验证 NodeService 子进程是否继承 main 的 env。
  process.env.ZCODE_ENV_PROBE ??= "1";

  // 数据根：优先真实 home（可写即用）；不可写先落沙箱保启动，置授权待办，
  // 首窗就绪后 desktopOhosHomeGrant 弹一次授权并迁回。JIT 引导不受 HOME 影响。
  const realHome = resolveOhosRealHome();
  const homeWritable = realHome ? isDirWritable(realHome) : false;
  // 追踪日志经 Electron 适配层进 hilog（tag Electron）：装机排障用，记录分支与
  // 关键 env。注意默认缓冲滚动极快，抓取配方见 specs/ohos-port/README.md（hilog -G 16M + -T Electron）。
  console.log(
    `[ohos-bootstrap] realHome=${realHome ?? "(none)"} homeWritable=${homeWritable} ` +
      `uid=${process.getuid?.() ?? "?"} envHOME=${process.env.HOME ?? "(none)"}`,
  );
  if (realHome && homeWritable) {
    process.env.HOME = realHome;
    process.env.ZCODE_DATA_BASE_DIR ??= realHome;
    process.env.ZCODE_HOME ??= join(realHome, ".zcode");
    // 用户 shell 环境（登录快照）：main 注入 process.env；host/agent 由 host
    // 入口自行应用（不继承 main env）。
    applyOhosUserShellEnvToProcessEnv((message) => {
      console.log(`[ohos-bootstrap] ${message}`);
    });
  } else {
    console.log(
      `[ohos-bootstrap] sandbox fallback: ZCODE_DATA_BASE_DIR=${OHOS_SANDBOX_FILES} ` +
        `grantPending=${realHome ? "1" : "0"}`,
    );
    process.env.HOME = OHOS_SANDBOX_FILES;
    process.env.ZCODE_DATA_BASE_DIR ??= OHOS_SANDBOX_FILES;
    process.env.ZCODE_HOME ??= join(OHOS_SANDBOX_FILES, ".zcode");
    if (!process.env.XDG_CONFIG_HOME) {
      process.env.XDG_CONFIG_HOME = join(OHOS_SANDBOX_FILES, ".config");
    }
    if (!process.env.XDG_CACHE_HOME) {
      process.env.XDG_CACHE_HOME = join(OHOS_SANDBOX_FILES, ".cache");
    }
    if (realHome) {
      process.env.ZCODE_OHOS_REAL_HOME = realHome;
      process.env.ZCODE_OHOS_HOME_GRANT_PENDING = "1";
    }
  }

  // V8 JIT 引导必须尽早：沙箱默认禁 RWX，未 prctl(SET_JITFORT) 前跑重负载 JS
  // 会 CodeRange 崩溃。加载 sqlite 绑定即触发该 prctl 并预热兼容层缓存。
  // Node 20 兼容接管（node:sqlite require 钩子 + Promise.withResolvers polyfill，
  // specs/ohos-port/09 §4.1）先于 sqlite 预热安装，覆盖 main 静态图里的迟到取值。
  installOhosNodeRuntimeCompat();
  try {
    loadNodeSqlite();
  } catch (error) {
    // 绑定缺失不阻断启动：main 自身多为懒加载场景，报错会出现在具体功能路径。
    console.error("[ohos-bootstrap] sqlite adapter preload failed:", error);
  }

  // OHOS Electron 的 resourcesPath 与打包布局不对齐（实测两候选均 not-found），
  // 显式指到内置 Provider 配置的实际落盘位置。
  const builtinProviderConfig = join(
    "/data/storage/el1/bundle/electron/resources/resfile/resources",
    "config/provider/zcode-builtin.json",
  );
  if (!process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE && existsSync(builtinProviderConfig)) {
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinProviderConfig;
  }

  // 登录 shell 快照刷新（异步落盘）：main 侧系统 zsh 可 exec（host 视图没有），
  // 采集 rc 演算的完整环境；快照是 main/host/终端的唯一用户环境来源（spec 02）。
  if (realHome) {
    ohosLoginShellSnapshotReady = refreshOhosLoginShellSnapshot(realHome).then(
      (captured) => {
        console.log(`[ohos-bootstrap] login shell snapshot v3 captured=${captured}`);
        return captured;
      },
      (error) => {
        console.log(`[ohos-bootstrap] login shell snapshot v3 failed: ${String(error)}`);
        return false;
      },
    );
    // 终端 shell hint：fork env 传不进 appspawn host（装机实证），exec 又在 main——
    // main 视图解析出的可 exec shell 经文件下发，host 的 resolveTerminalShell 读取。
    const terminalShell = resolveOhosZshPath();
    if (terminalShell) {
      writeOhosTerminalShellHint(realHome, terminalShell);
    }
  }
}

let ohosLoginShellSnapshotReady: Promise<boolean> | null = null;

/**
 * 首个 host spawn 前等待快照（有界）。快照是唯一用户环境来源（不再静态重放兜底），
 * 首次启动必须等采集完成，否则 agent/终端拿到的 PATH 缺 rc 演算结果（spec 02）。
 */
export async function waitForOhosLoginShellSnapshot(timeoutMs = 4_000): Promise<boolean> {
  const ready = ohosLoginShellSnapshotReady;
  if (!ready) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([ready, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

bootstrapOhosRuntimeEnv();
