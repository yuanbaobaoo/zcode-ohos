import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isOhosRuntime } from "@zcode/shared";
import { loadNodeSqlite } from "@zcode/shared/nodeSqliteCompat";
import {
  applyOhosUserShellEnvToProcessEnv,
  resolveHarmonybrewPrefix,
  resolveOhosRealHome,
} from "@zcode/services/ohos";
import { runOhosEnvProbe } from "@zcode/services/ohos-env-probe";
import {
  refreshOhosLoginShellSnapshot,
  writeOhosTerminalShellHint,
} from "@zcode/services/ohos-login-snapshot";
import { resolveOhosBundledZshPath } from "./desktopRuntimeEnv.js";

// 鸿蒙早期引导：必须在任何子进程 spawn 前执行（index.ts 顶部求值）。GUI 继承不到登录
// 环境，brew PATH 靠重放注入；数据根优先真实 home，不可写先落沙箱待授权迁回（与 host 共享）。
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
  // 首窗就绪后 desktopOhosHomeGrant 弹一次授权并迁回。JIT 引导与 brew 前缀
  // 解析不受 HOME 影响。
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
    // 用户 shell 环境（export 重放）：main 注入 process.env；host/agent 由 host
    // 入口自行重放（不继承 main env）。
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

  // harmonybrew 前缀兜底：数据根走沙箱分支时上面的 shell 重放没有执行，这里仍要
  // 把前缀下发给终端服务（终端 PATH 合并逻辑据此构造）。
  const prefix = resolveHarmonybrewPrefix();
  if (prefix) {
    process.env.ZCODE_OHOS_BREW_PREFIX ??= prefix;
  }

  // 环境探针放最后：HOME/PATH 注入完成后取证才反映最终形态；异步不阻塞启动。
  runOhosEnvProbe("main");
  // 登录 shell 快照刷新（异步落盘）：main 侧系统 zsh 可 exec（host 视图没有），
  // 采集 rc 动态演算的完整环境，host 下次启动经 ohosUserShellEnv 读取合并。
  if (realHome) {
    void refreshOhosLoginShellSnapshot(realHome);
    // 终端 shell hint：fork env 传不进 appspawn host（装机实证），exec 又在 main——
    // main 视图解析出的可 exec shell 经文件下发，host 的 resolveTerminalShell 读取。
    const terminalShell = resolveOhosBundledZshPath();
    if (terminalShell) {
      writeOhosTerminalShellHint(realHome, terminalShell);
    }
  }
}

bootstrapOhosRuntimeEnv();
