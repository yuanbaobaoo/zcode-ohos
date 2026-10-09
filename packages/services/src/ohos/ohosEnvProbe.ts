import { spawn } from "node:child_process";
import { isOhosRuntime } from "@zcode/shared";

/**
 * OHOS 环境探针（装机排障）：外部 hdc/hdcd 都看不到 /storage/Users，用户 shell
 * 环境只能由应用进程取证后经 hilog 带出。ZCODE_ENV_PROBE=1 门控（bootstrap 默认
 * 置 1）；main/host 双入口各跑一次（appspawn env 隔离，两侧 PATH 不同），异步不
 * 阻塞启动。机制与真机实证记录见 specs/ohos-port/02。
 */

const PROBE_TIMEOUT_MS = 8_000;
const LOGIN_PROBE_TIMEOUT_MS = 12_000;
const LOG_SLICE = 1_600;
const REAL_HOME = "/storage/Users/currentUser";

const probedScopes = new Set<string>();

function runProbeCommand(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    try {
      const child = spawn("/bin/sh", ["-c", command], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        env: process.env,
      });
      let out = "";
      child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (out += chunk.toString()));
      // close 携带 signal：spawn 的 timeout 到点发 SIGTERM，超时与正常退出统一从 close 结算。
      child.on("error", (error: Error) => resolve(`spawn-error:${error.message}`));
      child.on("close", (code, signal) => resolve(signal ? `killed-by-${signal}:{${out}}` : out));
    } catch (error) {
      resolve(`threw:${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export function runOhosEnvProbe(scope: "main" | "host"): void {
  if (!isOhosRuntime()) return;
  // gate 仅对 main 生效：host 由 appspawn 拉起、不继承 main env（装机实证），
  // ZCODE_ENV_PROBE 传不进 host，若统一 gate 则 host 侧永远不跑。
  if (scope === "main" && process.env.ZCODE_ENV_PROBE !== "1") return;
  if (probedScopes.has(scope)) return;
  probedScopes.add(scope);

  const probes: Array<[name: string, command: string, timeoutMs?: number]> = [
    ["id-env", `id; echo "HOME=$HOME"; echo "SHELL=$SHELL"`],
    ["path", `echo "$PATH"`],
    [
      "tools",
      `for t in ssh scp git node zsh python3 curl; do printf '%s=%s;' "$t" "$(command -v "$t" 2>/dev/null || echo MISSING)"; done`,
    ],
    ["dot-ssh", `ls -la ${REAL_HOME}/.ssh/ 2>&1 | head -12`],
    ["ssh-config", `sed -n '1,25p' ${REAL_HOME}/.ssh/config 2>&1`],
    [
      "home-top",
      `ls ${REAL_HOME}/ 2>&1 | head -30; echo ---dotdirs; ls -d ${REAL_HOME}/.*/ 2>/dev/null | head -25`,
    ],
    [
      "rc-zshenv-zprofile",
      `echo ===zshenv; cat ${REAL_HOME}/.zshenv 2>&1; echo ===zprofile; cat ${REAL_HOME}/.zprofile 2>&1`,
    ],
    ["rc-zshrc", `cat ${REAL_HOME}/.zshrc 2>&1 | head -80`],
    [
      "brew-bin",
      `ls ${REAL_HOME}/.harmonybrew/bin ${REAL_HOME}/.harmonybrew/sbin 2>&1 | tr '\\n' ',' | head -c 700`,
    ],
    [
      "find-ssh-hishell",
      `find ${REAL_HOME} -maxdepth 3 \\( -name ssh -o -name sshd -o -iname '*hishell*' \\) 2>/dev/null | head -8`,
    ],
    ["zsh-exec", `/usr/bin/zsh -c 'echo ZSH-EXEC-OK; /usr/bin/zsh --version' 2>&1`],
    [
      // 登录 shell 快照：复刻 HiShell 交互登录语义（读全部 rc），TERM=dumb 防颜色码
      // 污染输出；不给 CI=1——rc 的交互分支（agent 启动、工具 init）正是要取证的环境来源。
      "zsh-login-env",
      `/usr/bin/zsh -ilc 'echo ZSH-LOGIN-OK; env | sort' 2>&1 | head -c 2800`,
      LOGIN_PROBE_TIMEOUT_MS,
    ],
    [
      // 对照实验：裸 ssh（默认 config 路径）预期 Bad owner or permissions（平台属主校验，
      // /storage/Users 属主固定 20001006 ≠ 应用 uid）；-F 显式指向同一文件预期跳过校验成功。
      "ssh-bare",
      `ssh -G hsl 2>&1 | head -8`,
    ],
    [
      "ssh-with-f",
      `/usr/bin/ssh -F ${REAL_HOME}/.ssh/config -G hsl 2>&1 | grep -E 'hostname|user |port|identityfile|userknownhosts' | head -8`,
    ],
    [
      // 验收 PATH 注入后的 wrapper：command -v 应命中 .zcode/bin/ssh，裸 `ssh -G`
      // （不带 -F）经 wrapper 转发后应成功解析 hsl 别名。
      "ssh-wrapper",
      `command -v ssh; ls -la ${REAL_HOME}/.zcode/bin/ 2>&1 | head -6; ssh -G hsl 2>&1 | grep -E 'hostname|identityfile' | head -3`,
    ],
    [
      // 用户工具可达性抽查（loh 等 HiShell 生态命令）：登录演算 PATH + 快照合并后
      // 应与 HiShell 一致；找不到时 find 定位实际安装位置，区分「注入丢失」与「无来源」。
      "user-tools",
      `for t in loh hoh bsk bun deno; do printf '%s=%s;' "$t" "$(command -v "$t" 2>/dev/null || echo MISSING)"; done`,
    ],
    [
      "loh-detail",
      `command -v loh 2>/dev/null && loh --help 2>&1 | head -4; find ${REAL_HOME} -maxdepth 3 -name 'loh*' 2>/dev/null | head -4`,
    ],
    [
      // 用户实证 HiShell 域里 loh 在 /usr/bin/loh，但应用域 command -v 找不到：
      // 看 main 视角 /usr/bin 的真实内容与 loh 的存在性/权限，定性「rootfs 视图
      // 差异」还是「权限拒」。
      "usrbin-view",
      `ls -la /usr/bin/loh 2>&1; ls /usr/bin 2>/dev/null | tr '\\n' ',' | head -c 500`,
    ],
    [
      // loh 本体在 /bin/loh（/usr/bin 是软链）。若 main 能读本体，则可由应用自动
      // 镜像到用户域（用户 ELF 可 exec 实证）；读不到则需 HiShell 侧手动拷一次。
      "loh-origin",
      `ls -la /bin/loh /system/bin/loh 2>&1; head -c 8 /bin/loh 2>/dev/null | od -An -c | head -1; /bin/loh --help 2>&1 | head -3`,
    ],
    [
      // 终端形态等价验证：spawnPipeShell 的精确同构（zsh -il + stdin 管道喂命令），
      // 验证交互登录 shell 在应用域能完成 rc 加载并执行命令（UI 点击之外的正路）。
      "zsh-il-pipe",
      `echo 'echo ZSH-IL-PIPE-OK; echo PATH=$PATH | head -c 120; alias ll 2>/dev/null | head -1' | TERM=xterm-256color /usr/bin/zsh -il 2>&1 | head -6`,
    ],
    // 注意：不要加「真实建连」探针。排障期间每轮热更都真连远端曾触发引擎侧
    // 防暴力策略（连 Mac 对照源都被 pre-auth 断开）；-G/-V 等本地解析已足够验证
    // wrapper/config/key 链路，真连接由用户在终端按需执行。
  ];

  void (async () => {
    for (const [name, command, timeoutMs] of probes) {
      const out = await runProbeCommand(command, timeoutMs ?? PROBE_TIMEOUT_MS);
      const trimmed = out.trim().replaceAll("\n", " ⏎ ");
      console.log(`[ohos-env-probe][${scope}] ${name}={${trimmed.slice(0, LOG_SLICE)}}`);
    }
    console.log(`[ohos-env-probe][${scope}] done`);
  })();
}
