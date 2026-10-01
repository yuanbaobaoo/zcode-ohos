import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

// OHOS 工具链变量的 .env 支持：构建/开发脚本解析工具链前调用 applyOhosDotEnv()
// （真实环境变量 > .env.local > .env，语义与 load-endpoint-env.mjs 一致）。
// 只回写白名单键——.env 其余键（如 ZCODE_ENV 会翻转产品身份）不得经此通道进构建。
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
