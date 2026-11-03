import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";

// OHOS 工具链变量的 .env 支持：构建/开发脚本解析工具链前调用 applyOhosDotEnv()
// （真实环境变量 > .env.local > .env，语义与 load-endpoint-env.mjs 一致）。
// 只回写白名单键——.env 其余键（如 ZCODE_ENV 会翻转产品身份）不得经此通道进构建。
const OHOS_DOTENV_KEYS = [
  "DEVECO_CLI_CLT_PATH",
  "ZCODE_OHOS_ELECTRON_URL",
  "ZCODE_OHOS_ELECTRON_AUTOFETCH",
];

export async function applyOhosDotEnv({
  root = resolve(import.meta.dirname, "..", "..", ".."),
} = {}) {
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

// CLT 根候选链（与 tesslo scripts/ohos-common.ts 的 commandLineToolCandidates 同策略，
// 但不含其 .toolchain/command-line-tools 落点候选——那是 tesslo 自动下载的安装目标，
// 本仓库不做 CLT 自动下载，没有生产者的落点只会误导）：
// 1. DEVECO_CLI_CLT_PATH（devecocli 标准变量；真实环境变量或 .env/.env.local 显式声明）
// 2. PATH 反推：hvigorw 位于 <clt>/bin，hdc 位于 <clt>/sdk/default/openharmony/toolchains
// 变更原因：原 OHOS_COMMAND_LINE_TOOLS_ROOT 自有变量与 devecocli/tesslo 生态不互通，
// 且 ~/command-line-tools 探测属于机器路径猜测；统一改用 devecocli 标准变量。
function captureCommand(command) {
  const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function commandLineToolCandidates() {
  const candidates = [];
  if (process.env.DEVECO_CLI_CLT_PATH) {
    candidates.push(process.env.DEVECO_CLI_CLT_PATH);
  }
  const hvigorw = captureCommand("command -v hvigorw");
  if (hvigorw) candidates.push(resolve(dirname(hvigorw), ".."));
  const hdc = captureCommand("command -v hdc");
  if (hdc) candidates.push(resolve(dirname(hdc), "..", "..", "..", ".."));
  return candidates;
}

// 以 bin/hvigorw 为锚点取第一个命中的 CLT 根；每个候选都经存在性校验，
// 显式声明的 DEVECO_CLI_CLT_PATH 无效时按 tesslo 语义顺延后续候选而非报错。
// 找不到返回 null，由调用方给出各自的设置指引。
export function resolveCommandLineToolsRoot() {
  return (
    commandLineToolCandidates().find((candidate) =>
      existsSync(join(candidate, "bin", "hvigorw")),
    ) ?? null
  );
}
