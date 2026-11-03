import { createRequire } from "node:module";
import { isOhosRuntime } from "./runtimeEnv.js";
import { loadNodeSqlite } from "./nodeSqliteCompat.js";

// OHOS Node 20 兼容接管（spec 09 §4.1）：node:sqlite 与 Promise.withResolvers 在
// main/host/storage/Agent Worker 入口安装；非 OHOS 为 no-op。
let installed = false;

type WithResolversResult<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};
type WithResolversFn = <T>() => WithResolversResult<T>;

function installPromiseWithResolversPolyfill(): void {
  const promiseConstructor = Promise as unknown as { withResolvers?: WithResolversFn };
  if (typeof promiseConstructor.withResolvers === "function") {
    return;
  }
  promiseConstructor.withResolvers = function <T>(): WithResolversResult<T> {
    const out = {} as WithResolversResult<T>;
    out.promise = new Promise<T>((resolve, reject) => {
      out.resolve = resolve;
      out.reject = reject;
    });
    return out;
  };
}

interface HookableModule {
  _load?: (this: HookableModule, request: string, parent: unknown, isMain: boolean) => unknown;
}

function compatRequire(specifier: string): unknown {
  // 与 nodeSqliteCompat.nodeRequire 相同的 CJS/ESM 双态取基址：tsup ESM 产物里
  // import.meta 可用；esbuild CJS 产物里 import.meta 为空对象，只能走 __filename。
  const base: string | URL =
    typeof __filename === "string"
      ? __filename
      : typeof import.meta.url === "string" && import.meta.url.startsWith("file:")
        ? import.meta.url
        : ".";
  return createRequire(base)(specifier);
}

type OhosHookedLoad = NonNullable<HookableModule["_load"]> & { __zcodeOhosSqliteHook?: boolean };

function installNodeSqliteModuleLoadHook(): void {
  const nodeModule = compatRequire("node:module") as HookableModule;
  const originalLoad = nodeModule._load as OhosHookedLoad | undefined;
  // Module._load 在 worker_threads 里每线程一份；幂等标记防止 main 引导 + shim
  // 副作用等重复安装造成无谓的层层转发。
  if (!originalLoad || originalLoad.__zcodeOhosSqliteHook) {
    return;
  }
  const hookedLoad = function ohosNodeSqliteModuleLoad(
    this: HookableModule,
    request: string,
    parent: unknown,
    isMain: boolean,
  ) {
    if (request === "node:sqlite") {
      return loadNodeSqlite();
    }
    return originalLoad.call(this, request, parent, isMain);
  } as OhosHookedLoad;
  hookedLoad.__zcodeOhosSqliteHook = true;
  nodeModule._load = hookedLoad;
}

// 进程级一次性安装：OHOS 之外为 no-op。幂等，可多处调用。
export function installOhosNodeRuntimeCompat(): void {
  if (installed || !isOhosRuntime()) {
    return;
  }
  installed = true;
  installPromiseWithResolversPolyfill();
  installNodeSqliteModuleLoadHook();
}
