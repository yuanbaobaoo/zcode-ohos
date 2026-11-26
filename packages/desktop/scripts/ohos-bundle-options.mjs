#!/usr/bin/env node
// ohos:bundle 的命令行参数解析（纯函数，供 bundle-ohos.mjs 与工程用例共用）。
// 版本不在这里：唯一来源是仓库根 package.json（version + ohos.patch，见 ohos-version.mjs）。
// 默认后端环境也不在这里：写在 package.json 的 `ohos:bundle` 脚本里（`--env production`），
// 本模块只解析命令行显式给出的 `--env`（临时切测试后端）与 build-ohos 的透传开关。

export const OHOS_BUNDLE_ENVS = Object.freeze(["test", "production"]);

const VALUE_FLAGS = new Map([["--env", "env"]]);

const BOOLEAN_FLAGS = new Map([
  ["--dry-run", "dryRun"],
  ["--skip-build", "skipBuild"],
  ["--skip-agent", "skipAgent"],
  ["-h", "help"],
  ["--help", "help"],
]);

export function normalizeOhosBundleEnv(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!OHOS_BUNDLE_ENVS.includes(normalized)) {
    throw new Error(`--env 只支持 ${OHOS_BUNDLE_ENVS.join(" / ")}，收到: ${value || "(空)"}`);
  }
  return normalized;
}

// 值既支持 `--env production` 也支持 `--env=production`。缺值时直接报错并给示例：
// 静默忽略会让 `pnpm ohos:bundle --env` 打出一个"看起来成功"的包。
export function parseOhosBundleOptions(argv = []) {
  const options = {
    dryRun: false,
    skipBuild: false,
    skipAgent: false,
    env: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;

    const booleanKey = BOOLEAN_FLAGS.get(arg);
    if (booleanKey) {
      options[booleanKey] = true;
      continue;
    }

    const separator = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    const key = VALUE_FLAGS.get(flag);
    if (!key) {
      throw new Error(
        `不支持的参数: ${arg}` +
          "（可用：--env <test|production>、--dry-run、--skip-build、--skip-agent）",
      );
    }

    const rawValue = separator === -1 ? argv[index + 1] : arg.slice(separator + 1);
    if (separator === -1) index += 1;
    const value = String(rawValue ?? "").trim();
    if (!value || value.startsWith("-")) {
      throw new Error(`${flag} 需要一个值，例如 ${flag} test`);
    }
    options.env = normalizeOhosBundleEnv(value);
  }

  return options;
}

export function printOhosBundleHelp(log = console.log) {
  log(`OHOS HAP 打包：build-ohos → hvigor assembleHap → packages/desktop/dist/

版本来自仓库根 package.json 的 version + ohos.patch，不需要也不能用参数指定。

用法：
  pnpm ohos:bundle [选项]

选项：
  --env <test|production>   覆盖 package.json 里 ohos:bundle 脚本的默认环境（临时切测试后端）
  --dry-run                 只打印将要执行的步骤
  --skip-build              透传 build-ohos.mjs：跳过 JS 产物重建
  --skip-agent              透传 build-ohos.mjs：跳过 Agent bundle
  -h, --help                查看帮助`);
}
