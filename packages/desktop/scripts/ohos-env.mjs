import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { parseEnv } from "node:util";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

// OHOS 工具链变量的 .env 支持：构建/开发脚本解析工具链前调用 applyOhosDotEnv()
// （真实环境变量 > .env.local > .env，语义与 load-endpoint-env.mjs 一致）。
// 只回写白名单键——.env 其余键（如 ZCODE_ENV 会翻转产品身份）不得经此通道进构建。
// 原生编译需要的 Node 头文件与 sqlite 融合源不再走变量，见 ohos-native-deps.mjs
// （项目内 .cache 自动获取）。
const OHOS_DOTENV_KEYS = ["DEVECO_CLI_CLT_PATH", "ZCODE_OHOS_ELECTRON_URL"];

export async function applyOhosDotEnv({ root = repoRoot } = {}) {
  const values = {};
  for (const name of [".env", ".env.local"]) {
    try {
      Object.assign(values, parseEnv(await readFile(resolve(root, name), "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const key of OHOS_DOTENV_KEYS) {
    const value = values[key]?.trim();
    if (value && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return process.env;
}

export function resolveOhosDotEnvPath({ root = repoRoot } = {}) {
  return resolve(root, ".env");
}

// 读取仓库根 .env 里的单个键（不存在返回 null）。用于“是否已配置”的判断，
// 不写 process.env，避免调用方隐式改变全局环境。
export function readOhosDotEnvValue(key, { root = repoRoot } = {}) {
  const dotEnvPath = resolveOhosDotEnvPath({ root });
  if (!existsSync(dotEnvPath)) return null;
  const value = parseEnv(readFileSync(dotEnvPath, "utf8"))[key]?.trim();
  return value ? value : null;
}

// 幂等写入仓库根 .env：已存在同名键就原地替换，否则追加；保留其余注释与顺序。
// 用于把首次解析/下载到的 CLT 路径落盘，让后续所有 OHOS 命令都从 .env 读。
export function persistOhosDotEnvValue(key, value, { root = repoRoot } = {}) {
  const dotEnvPath = resolveOhosDotEnvPath({ root });
  const current = existsSync(dotEnvPath) ? readFileSync(dotEnvPath, "utf8") : "";
  const line = `${key}=${value}`;
  const keyPattern = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, "mu");
  let next;
  if (keyPattern.test(current)) {
    next = current.replace(keyPattern, line);
  } else {
    const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    next = `${current}${separator}${line}\n`;
  }
  if (next !== current) writeFileSync(dotEnvPath, next, "utf8");
  return dotEnvPath;
}

// 平台差异：官方 command-line-tools 的 bin/ 在 POSIX 上是无扩展名的 sh 脚本，
// Windows 版包里只有 hvigorw.bat / ohpm.bat（Windows 既无 sh，也不能把 .bat 当可执行文件
// 直接 CreateProcess）。解析必须按平台给出「本机真能 spawn 的入口」，而不是固定拼 bin/<name>。
const CLT_TOOL_EXTENSIONS = Object.freeze({
  win32: [".bat", ".cmd", ""],
  posix: [""],
});

function toolExtensions(platform) {
  return CLT_TOOL_EXTENSIONS[platform] ?? CLT_TOOL_EXTENSIONS.posix;
}

export function cltToolCandidateNames(name, platform = process.platform) {
  return toolExtensions(platform).map((extension) => `${name}${extension}`);
}

// 以 bin/ 下的工具入口为锚点定位 CLT 根；找不到返回 null，由调用方给出各自的设置指引。
export function resolveCltTool(cltRoot, name, platform = process.platform) {
  if (!cltRoot) return null;
  for (const candidate of cltToolCandidateNames(name, platform)) {
    const toolPath = join(cltRoot, "bin", candidate);
    if (existsSync(toolPath)) return toolPath;
  }
  return null;
}

// hdc 不在 bin/：POSIX 是 toolchains/hdc，Windows 是 toolchains/hdc.exe。
export function resolveCltHdc(cltRoot, platform = process.platform) {
  if (!cltRoot) return null;
  const toolchains = join(cltRoot, "sdk", "default", "openharmony", "toolchains");
  for (const name of platform === "win32" ? ["hdc.exe"] : ["hdc"]) {
    const hdcPath = join(toolchains, name);
    if (existsSync(hdcPath)) return hdcPath;
  }
  return null;
}

// Windows 没有 sh：PATH 反查改用 where.exe（同样的 command -v 语义，遵守 PATHEXT），
// 否则原实现里的 `sh -c` 会直接 ENOENT，导致「装了 CLT 却报找不到」。
function captureCommand(command, platform = process.platform) {
  const result =
    platform === "win32"
      ? spawnSync("where.exe", [command], { encoding: "utf8" })
      : spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  if (result.status !== 0) return "";
  return (
    (result.stdout ?? "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

// CLT 根候选链（与 tesslo scripts/ohos-common.ts 的 commandLineToolCandidates 同策略）：
// 1. DEVECO_CLI_CLT_PATH（devecocli 标准变量；真实环境变量或 .env/.env.local 显式声明）
// 2. PATH 反推：hvigorw 位于 <clt>/bin，hdc 位于 <clt>/sdk/default/openharmony/toolchains
// 两条都落空时由 ohos-clt.mjs 接管（项目缓存 → 首次自动下载），所以这里不做机器路径猜测。
// 变更原因：原 OHOS_COMMAND_LINE_TOOLS_ROOT 自有变量与 devecocli/tesslo 生态不互通。
export function commandLineToolCandidates(env = process.env, platform = process.platform) {
  const candidates = [];
  if (env.DEVECO_CLI_CLT_PATH) {
    candidates.push(env.DEVECO_CLI_CLT_PATH);
  }
  const hvigorw = captureCommand("hvigorw", platform);
  if (hvigorw) candidates.push(resolve(dirname(hvigorw), ".."));
  const hdc = captureCommand("hdc", platform);
  if (hdc) candidates.push(resolve(dirname(hdc), "..", "..", "..", ".."));
  return candidates;
}

// 每个候选都经存在性校验，显式声明的 DEVECO_CLI_CLT_PATH 无效时按 tesslo 语义顺延
// 后续候选而非报错。锚点同时接受 POSIX 的 hvigorw 与 Windows 的 hvigorw.bat。
export function resolveCommandLineToolsRoot(env = process.env, platform = process.platform) {
  return (
    commandLineToolCandidates(env, platform).find((candidate) =>
      Boolean(resolveCltTool(candidate, "hvigorw", platform)),
    ) ?? null
  );
}

const WINDOWS_BATCH_PATTERN = /\.(?:bat|cmd)$/iu;

function quoteWindowsArgument(value) {
  return /\s/u.test(value) ? `"${value}"` : value;
}

// Windows 的 .bat/.cmd 必须经 cmd.exe 执行；命令与参数都可能有空格（CLT 常被解压到
// C:\Program Files 之类的目录），所以逐个加引号，再用 /s 让 cmd 剥掉最外层引号原样执行。
// POSIX 下 hvigorw/ohpm 是带 shebang 的可执行脚本，保持直接 spawn，行为不变。
export function spawnCltTool(commandPath, args = [], options = {}, platform = process.platform) {
  if (platform !== "win32" || !WINDOWS_BATCH_PATTERN.test(commandPath)) {
    return spawnSync(commandPath, args, options);
  }

  const commandLine = [commandPath, ...args].map(quoteWindowsArgument).join(" ");
  return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${commandLine}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}
