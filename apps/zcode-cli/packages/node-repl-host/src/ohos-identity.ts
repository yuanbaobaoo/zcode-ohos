// OHOS 平台身份（specs/ohos-port/15）。
//
// 为什么不在本包直接引 @zcode/shared/runtimeEnv：node_repl 的 bundle 边界只允许引入
// @zcode/shared/node-repl-browser-broker 这一个 shared 模块（test/bundle-boundary.test.ts
// 硬性校验），否则会把 shared 的整张 schema 图拖进 node_repl。因此这里自持一份同义判定，
// 语义与 shared 的 isOhosRuntime 保持一致：
//   权威信号 ZCODE_OHOS_RUNTIME=1（host 引导注入、随 env 继承）∨ 平台名。
export const ZCODE_OHOS_RUNTIME_ENV_KEY = "ZCODE_OHOS_RUNTIME";
// OHOS Computer Use 运行时标记（非敏感）：broker socket 键会被 MCP 子进程 env 清洗剔除，
// 不能作为启用信号。
export const ZCODE_OHOS_CUA_RUNTIME_ENV_KEY = "ZCODE_OHOS_CUA_RUNTIME";

export function isOhosPlatformIdentity(
  platform: NodeJS.Platform | string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env[ZCODE_OHOS_RUNTIME_ENV_KEY]?.trim() === "1") return true;
  return platform === "ohos" || platform === "openharmony" || platform === "harmonyos";
}

export function isOhosCuaRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ZCODE_OHOS_CUA_RUNTIME_ENV_KEY]?.trim() === "1";
}
