import { loadNodeSqlite } from "./nodeSqliteCompat.js";
import { installOhosNodeRuntimeCompat } from "./ohosNodeRuntimeCompat.js";

/**
 * `node:sqlite` 的构建期重写出口（specs/ohos-port/09 §4.1.1）。
 *
 * 上游 v3.16.1 起新增的业务文件直接 `import { DatabaseSync } from "node:sqlite"`，
 * OHOS Electron（Node 20.18.1）没有该 builtin，且 ESM bundle 的静态 import 无法在
 * 运行期拦截。桌面 main/host/scheduler（tsup）通过 esbuild 插件把 `node:sqlite`
 * 重写到本模块；重写后首个被求值的 node:sqlite 消费模块会顺带装好运行期兼容
 * （polyfill + require 钩子），覆盖 createRequire 路由的迟到取值。
 *
 * 导出保持惰性：dlopen 失败不在进程启动期直接击杀（沿用 main 侧 try/catch 语义），
 * 首次真正使用时才加载并抛出。
 */

type NodeSqliteModule = ReturnType<typeof loadNodeSqlite>;

let backend: NodeSqliteModule | null = null;

function resolveBackend(): NodeSqliteModule {
  if (!backend) {
    backend = loadNodeSqlite();
  }
  return backend;
}

export const DatabaseSync: typeof import("node:sqlite").DatabaseSync = new Proxy(
  // Proxy 目标只提供函数形态；真实构造经 construct 陷阱转发到兼容后端，
  // prototype/静态成员访问同样转发，保证 instanceof 与 extends 语义。
  function ohosNodeSqliteDatabaseSync() {} as unknown as typeof import("node:sqlite").DatabaseSync,
  {
    apply() {
      throw new Error("node:sqlite DatabaseSync 必须以 new 调用");
    },
    construct(_target, args) {
      return Reflect.construct(resolveBackend().DatabaseSync, args);
    },
    get(_target, property, receiver) {
      return Reflect.get(resolveBackend().DatabaseSync, property, receiver);
    },
    set(_target, property, value, receiver) {
      return Reflect.set(resolveBackend().DatabaseSync, property, value, receiver);
    },
    has(_target, property) {
      return property in resolveBackend().DatabaseSync;
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(resolveBackend().DatabaseSync);
    },
  },
);

export const backup: typeof import("node:sqlite").backup = (source, destination) => {
  const backendBackup = resolveBackend().backup;
  if (!backendBackup) {
    throw new Error("当前 OHOS sqlite 兼容后端不支持 backup()");
  }
  return backendBackup(source, destination);
};

// 模块求值即安装运行期兼容（OHOS no-op 守卫在 install 内部）：
// tsup 重写后本模块随首个 node:sqlite 消费链在 bundle 加载期执行。
installOhosNodeRuntimeCompat();
