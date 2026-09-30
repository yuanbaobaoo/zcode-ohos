import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

// OHOS 工具链变量的 .env 支持：pnpm bundle:desktop:ohos / pnpm dev:ohos /
// fetch-ohos-libelectron.mjs 在解析工具链前调用 applyOhosDotEnv()，使这三个变量
// 可以写进仓库根的 .env / .env.local（语义与 scripts/load-endpoint-env.mjs 及
// vite loadEnv 一致：真实环境变量 > .env.local > .env）。
// 只回写白名单键——.env 里其余键不得经此通道影响构建（如 ZCODE_ENV 会翻转产品
// 身份，vite 侧也仅合并进局部对象而非 process.env）。
const OHOS_DOTENV_KEYS = [
  "OHOS_COMMAND_LINE_TOOLS_ROOT",
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
