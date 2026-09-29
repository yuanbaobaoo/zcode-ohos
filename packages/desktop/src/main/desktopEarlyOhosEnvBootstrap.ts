import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isOhosRuntime } from "@zcode/shared";
import { loadNodeSqlite } from "@zcode/shared/nodeSqliteCompat";
import {
  applyOhosUserShellEnvToProcessEnv,
  resolveHarmonybrewPrefix,
  resolveOhosRealHome,
} from "@zcode/services/ohos";

// 鸿蒙早期运行环境引导：必须在任何子进程 spawn 之前执行（index.ts 顶部按 import
// 顺序求值）。GUI 应用继承不到 HiShell 的登录环境，harmonybrew（brew）安装的工具
// 在应用内全部不可见；agent 的非交互 spawn（Bash 工具等）不读任何 rc 文件，只能
// 靠进程环境继承——等价 `export PATH="$HOME/.harmonybrew/bin:$PATH"`。
// 数据根优先真实用户 home；不可写时先落沙箱并置授权待办（见 bootstrapOhosRuntimeEnv
// 与 desktopOhosHomeGrant.ts）。用户 shell 环境重放逻辑与 host 进程共享
// （services/ohos/ohosUserShellEnv，host 由 appspawn 拉起、不继承 main env）。
export const OHOS_SANDBOX_FILES = "/data/storage/el2/base/files";

// 以"能在 {dir}/.zcode 里真实落一个临时文件"作为写权探针。注意不能用
// mkdirSync(recursive) 的返回判断：目录已存在时它会静默成功，而应用真正
// 需要的是往目录里写（装机实测：.zcode 存在但不可写，logger 建 v2/logs
// 时 EPERM 崩溃）。
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

  // OHOS seccomp 白名单不含 io_uring（syscall 425，真机 crash dump 实证 SIGSYS）。
  // libuv（Node 20）首次做异步文件 IO 时按需创建 io_uring（sendText 的 transcript/
  // queue 写入首触），任何线程违规即击杀整进程。UV_USE_IO_URING=0 让 libuv 全程
  // 走线程池；在子进程 fork 前设置即可被子进程（host/agent Worker）继承。
  if (process.env.UV_USE_IO_URING === undefined) {
    process.env.UV_USE_IO_URING = "0";
  }
  // 装机排障：验证 NodeService 子进程是否继承 main 的 env。
  process.env.ZCODE_ENV_PROBE ??= "1";

  // 数据根策略：优先真实用户 home（harmonybrew、~/.zcode 都在其下，符合
  // `export PATH="$HOME/.harmonybrew/bin:$PATH"` 的语义）。应用 uid 对 home 的
  // 写权取决于用户目录授权：
  //   - 可写 → 直接以真实 home 为根，零交互；
  //   - 不可写 → 先落应用沙箱保证启动不崩（appspawn 的 HOME 指向真实用户目录，
  //     main 首个 logger mkdir 即 EPERM），并置授权待办，待首个窗口就绪后由
  //     desktopOhosHomeGrant 弹一次目录授权，授权成功即迁回真实 home。
  // 注意：JIT 引导与 brew 前缀解析不受 HOME 影响（分别走 sqlite 绑定加载与
  // /storage/Users 扫描）。
  const realHome = resolveOhosRealHome();
  const homeWritable = realHome ? isDirWritable(realHome) : false;
  // 追踪日志进 hilog（DevEco Log 窗口可见）：装机排障用，记录分支与关键 env
  console.log(
    `[ohos-bootstrap] realHome=${realHome ?? "(none)"} homeWritable=${homeWritable} ` +
      `uid=${process.getuid?.() ?? "?"} envHOME=${process.env.HOME ?? "(none)"}`,
  );
  if (realHome && homeWritable) {
    process.env.HOME = realHome;
    process.env.ZCODE_DATA_BASE_DIR ??= realHome;
    process.env.ZCODE_HOME ??= join(realHome, ".zcode");
    // 用户 shell 环境（~/.zshenv/.zprofile/.zshrc 的 export，典型为 harmonybrew 的
    // PATH 前置）必须在授权后生效：main 注入 process.env，终端经 pty-main 中继
    // 显式下发；host/agent 由 host 入口自行重放（不继承 main env，见
    // services/ohos/ohosUserShellEnv）。
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

  // V8 JIT 引导必须尽早：OHOS 沙箱默认禁止 RWX 映射，未 prctl(PRCTL_SET_JITFORT)
  // 前运行重负载 JS 会 "Failed to reserve virtual memory for CodeRange" 崩溃。
  // 加载随包 sqlite 绑定即触发该 prctl（模块初始化顺带开启，且被子进程继承）；
  // 同时把兼容层预热，后续 host/agent 首次 loadNodeSqlite() 直接命中缓存。
  try {
    loadNodeSqlite();
  } catch (error) {
    // 绑定缺失不阻断启动：main 自身可能不依赖 sqlite（chromeCookieManager 为
    // 懒加载场景），真正需要时的报错会出现在具体功能路径上。
    console.error("[ohos-bootstrap] sqlite adapter preload failed:", error);
  }

  // 内置 Provider 配置（zcode-builtin.json）随包在 resfile/resources/config 下；
  // 桌面版按 process.resourcesPath 拼路径，OHOS Electron 的 resourcesPath 语义
  // 与打包布局不保证对齐（装机实测两候选均 not-found → provider 配置降级空），
  // 显式指到实际落盘位置（resolver 第一优先读该 env）。
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
}

bootstrapOhosRuntimeEnv();
