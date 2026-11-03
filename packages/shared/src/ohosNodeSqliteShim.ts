import { loadNodeSqlite } from "./nodeSqliteCompat.js";
import { installOhosNodeRuntimeCompat } from "./ohosNodeRuntimeCompat.js";

// node:sqlite 构建期重写出口（spec 09 §4.1.1）：首次取值时惰性加载 OHOS 后端。
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
