import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isOhosRuntime } from "./runtimeEnv.js";

/**
 * node:sqlite 兼容加载器。
 *
 * 背景：鸿蒙 Electron（libelectron.so）内嵌 Node 20.18.1，没有 node:sqlite
 * （Node 22.5+ 才有）；host（task-index 等 repo）、desktop main（chrome cookie
 * 导入）与 agent CLI（session store）三端都需要 SQLite。
 *
 * 策略：
 * 1. 优先使用运行时真实的 node:sqlite（Linux/macOS/Windows 与 Node ≥22.5 的
 *    开发环境，行为与上游完全一致）；
 * 2. OHOS 上加载随包分发的 ohos_sqlite_adapter.node（OHOS sqlite NAPI 绑定，
 *    实现同一 API 面）。该绑定有两个已实证的缺陷（写入语句 run() 空转、裸命名
 *    参数绑定 NULL），在 OhosDatabaseSync 里绕过：写语句内联参数走 exec()，
 *    读语句命名参数改写为位置参数。绕过逻辑与 ohos-linux-zcode 项目装机验证
 *    过的 sqlite-adapter 垫片等价，这里收编为源码。
 *
 * 注意：不要用动态 import("node:sqlite")——tsup/esbuild 会把它错误改写成
 * import("sqlite")（见 chromeCookieManager.ts 的历史注释），必须走 require。
 */

type NodeSqliteModule = typeof import("node:sqlite");

let cachedModule: NodeSqliteModule | null = null;

function nodeRequire(specifier: string): unknown {
  // esbuild 在 ESM 产物里会把裸 require 标识符替换成"一调用就抛 Dynamic require
  // not supported"的 shim（typeof 探测被骗过，装机已实证）。唯一稳妥解：只用
  // createRequire——ESM（HAP 内 out/main 等分片）用 import.meta.url；
  // CJS（zcode.cjs 打包产物）__filename 可用。
  const base: string | URL = typeof __filename === "string" ? __filename : import.meta.url;
  return createRequire(base)(specifier);
}

// OHOS SQLite 后端候选，按优先级：
// 1. zcode_sqlite.node——本仓库自有 NAPI 绑定（packages/desktop/native/ohos-zcode-sqlite
//    用 OHOS SDK clang 交叉编译，语义正确、无签名域限制，宿主与 OHOS Electron 均可加载）；
// 2. ohos_sqlite_adapter.node——OHOS Electron 发行包的绑定，仅在 el1 bundle 可见，
//    且有两个实证缺陷（走 OhosDatabaseSync 绕过包装）。
// 打包态绝对路径可直接常量；仓库相对候选服务开发态（HiShell 下直接从 checkout 跑），
// 必须惰性求值——CJS 打包产物（agent 的 zcode.cjs）里 import.meta 是 esbuild 置入的
// 空对象，fileURLToPath(undefined) 会在模块加载期抛 ERR_INVALID_ARG_TYPE，
// 曾导致 agent CLI（桌面与 OHOS 同病）启动即崩。
const OHOS_SQLITE_CANDIDATES = [
  "/data/storage/el1/bundle/electron/resources/resfile/resources/app/zcode_sqlite.node",
  "/data/storage/el1/bundle/electron/libs/arm64-v8a/zcode_sqlite.node",
] as const;
const OHOS_ADAPTER_CANDIDATES = [
  "/data/storage/el1/bundle/electron/libs/arm64-v8a/ohos_sqlite_adapter.node",
  "/data/storage/el1/bundle/libs/arm64/ohos_sqlite_adapter.node",
] as const;

function devRepoCandidates(relative: string): string[] {
  // 与 nodeRequire 相同的 CJS/ESM 双态取基址：CJS 有 __filename；
  // ESM 用 import.meta.url（仅 file: 协议有效，其余返回空候选不参与探测）。
  const base: string | undefined =
    typeof __filename === "string"
      ? __filename
      : typeof import.meta.url === "string" && import.meta.url.startsWith("file:")
        ? fileURLToPath(import.meta.url)
        : undefined;
  if (!base) return [];
  return [join(dirname(base), "../../..", relative)];
}

/** 自检用的宽松语句/连接面：OHOS 包装后端按 CLI 真实调用形状收参（数组整参、命名对象），超出官方 node:sqlite 类型。 */
interface SqliteSelfTestStmt {
  run(...args: unknown[]): unknown;
  get(...args: unknown[]): Record<string, unknown> | undefined;
  all(...args: unknown[]): unknown[];
}
interface SqliteSelfTestDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteSelfTestStmt;
  close?(): void;
}

function backendSelfTest(mod: NodeSqliteModule): void {
  // 真实读写自检：prepare().get() 是 host/agent 全部 DB 路径的基础操作，
  // 加载时验证语义（不合法的后端在此暴露，自动跳到下一个候选）。
  // 数组/对象/宽参数用例覆盖 OHOS 间接 Local ABI 的参数展开路径（见
  // toPositionalArgs 注释）——数字参数只在 cb_info 位置通道上出现。
  const db = new (mod.DatabaseSync as unknown as new (path: string) => SqliteSelfTestDb)(
    ":memory:",
  );
  try {
    const row = db.prepare("SELECT 1 AS x, ? AS y").get(7);
    if (!row || row.x !== 1 || row.y !== 7) {
      throw new Error(`self-test row mismatch: ${JSON.stringify(row)}`);
    }
    db.exec("CREATE TABLE _probe(a INTEGER, b TEXT, c REAL, d BLOB)");
    const ins = db.prepare("INSERT INTO _probe VALUES(?,?,?,?)");
    ins.run([9, "ten", 11.5, new Uint8Array([1, 2])]);
    ins.run({ b: "obj", a: 12 });
    // 宽参数（12 个匿名占位符）：验证 argv 按实际个数动态分配。
    const wide = db.prepare(
      "INSERT INTO _probe SELECT ?,?,?,? UNION ALL SELECT ?,?,?,? UNION ALL SELECT ?,?,?,?",
    );
    wide.run([1, "a", 1.5, null, 2, "b", 2.5, null, 3, "c", 3.5, null]);
    const found = db.prepare("SELECT b FROM _probe WHERE a = ?").get([9]);
    if (!found || found.b !== "ten") {
      throw new Error(`self-test array-bind mismatch: ${JSON.stringify(found)}`);
    }
    const named = db.prepare("SELECT @a AS a, :b AS b").get({ a: 7, b: "x" });
    if (!named || named.a !== 7 || named.b !== "x") {
      throw new Error(`self-test named-bind mismatch: ${JSON.stringify(named)}`);
    }
    const count = db.prepare("SELECT COUNT(*) AS c FROM _probe").get();
    if (!count || count.c !== 5) {
      throw new Error(`self-test wide-bind mismatch: ${JSON.stringify(count)}`);
    }
  } finally {
    db.close?.();
  }
}

function loadOhosBackend(): NodeSqliteModule {
  // 优先加载自有 zcode_sqlite.node（语义正确，直接透传）；候选逐一自检，
  // 失败（文件缺失/dlopen 被拒/语义不符）自动落下一个。
  const failures: string[] = [];
  for (const candidate of [
    ...OHOS_SQLITE_CANDIDATES,
    ...devRepoCandidates("packages/desktop/native/ohos-zcode-sqlite/zcode_sqlite.node"),
  ]) {
    if (!existsSync(candidate)) continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const native = nodeRequire(candidate) as any;
      if (typeof native.DatabaseSync !== "function") {
        throw new Error("module does not export DatabaseSync");
      }
      // 包装后再自检：数组/对象参数展开路径是自检的一部分（OHOS ABI 见
      // toPositionalArgs 注释）。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wrapped = createZcodeSqliteModule(native);
      backendSelfTest(wrapped);
      console.log(`[ohos-sqlite] backend loaded: zcode_sqlite (${candidate})`);
      return wrapped;
    } catch (error) {
      failures.push(
        `zcode_sqlite(${candidate}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    const adapterModule = loadOhosAdapter();
    backendSelfTest(adapterModule);
    console.log("[ohos-sqlite] backend loaded: ohos_sqlite_adapter (with workaround wrapper)");
    return adapterModule;
  } catch (error) {
    failures.push(`ohos_sqlite_adapter: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`node:sqlite unavailable, all OHOS backends failed: ${failures.join("; ")}`);
}

function loadOhosAdapter(): NodeSqliteModule {
  let lastError: unknown = null;
  for (const candidate of [
    ...OHOS_ADAPTER_CANDIDATES,
    ...devRepoCandidates("packages/desktop/ohos/electron/libs/arm64-v8a/ohos_sqlite_adapter.node"),
  ]) {
    if (!existsSync(candidate)) continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const native = nodeRequire(candidate) as any;
      // 模块初始化会 prctl(PRCTL_SET_JITFORT) 为当前进程放开 JIT——OHOS 沙箱
      // 默认禁止 RWX 映射，不调用的话 V8 保留 CodeRange 直接 OOM 崩溃；且该
      // prctl 按进程生效并被此后 spawn 的子进程继承。
      try {
        native.enableJIT();
      } catch {
        /* 旧版本绑定可能没有该入口 */
      }
      return createOhosSqliteModule(native);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `node:sqlite is unavailable and no OHOS sqlite adapter loaded (${
      lastError instanceof Error ? lastError.message : String(lastError)
    })`,
  );
}

const NAMED_PARAM_RE = /([@:$])([A-Za-z_][A-Za-z0-9_]*)/g;
const WRITE_SQL_RE =
  /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|REINDEX|ATTACH|DETACH)/i;

function quoteSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString("hex")}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function isBareValuesObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date)
  );
}

/**
 * 把调用方参数规整为"位置参数列表"。
 *
 * OHOS libelectron 的 V8 是间接 Local ABI，但 Object::Get 的 Smi 快路径返回裸
 * tagged 值：napi_get_element / napi_get_property 拿到数字（Smi）绑定参数时，
 * native 侧（napi_typeof → v8::Value::IsNumber 的 ldr [x0]）会把它当槽位地址
 * 二次解引用直接 SEGV（真机 sendText 链路实证：参数 9 → 0x12 崩溃，字符串等
 * 堆对象走慢路径返回槽位地址不受影响）。cb_info 的位置参数通道始终安全。
 * 因此数组参数在此展开为位置参数、对象参数按命名顺序映射为位置参数，
 * 数字/布尔/BigInt 永远只走 cb_info 通道（native 侧 argv 按实际个数动态分配）。
 */
function toPositionalArgs(args: unknown[], paramNames: string[]): unknown[] {
  if (args.length !== 1) return args;
  const first = args[0];
  if (first === null || first === undefined) return [];
  if (Array.isArray(first)) return first;
  if (isBareValuesObject(first)) {
    const obj = first as Record<string, unknown>;
    if (paramNames.length === 0) return [];
    return paramNames.map((name) => {
      if (Object.prototype.hasOwnProperty.call(obj, name)) return obj[name];
      for (const prefix of ["@", "$", ":"] as const) {
        if (Object.prototype.hasOwnProperty.call(obj, prefix + name)) {
          return obj[prefix + name];
        }
      }
      return null;
    });
  }
  return [first];
}

// 写语句：绑定值内联进 SQL 文本后走 exec()（native 的 run() 对写语句是空操作）。
// 假设 SQL 模板的字符串字面量里不含 @/$/:/?（本仓库全部语句满足）。
function inlineWriteParams(sql: string, args: unknown[]): string {
  if (args.length === 0) return sql;
  if (args.length === 1 && isBareValuesObject(args[0])) {
    const obj = args[0] as Record<string, unknown>;
    return sql.replace(NAMED_PARAM_RE, (_match, prefix: string, name: string) => {
      if (Object.prototype.hasOwnProperty.call(obj, name)) {
        return quoteSqlLiteral(obj[name]);
      }
      if (Object.prototype.hasOwnProperty.call(obj, prefix + name)) {
        return quoteSqlLiteral(obj[prefix + name]);
      }
      return "NULL";
    });
  }
  let index = 0;
  return sql.replace(/\?/g, () => (index < args.length ? quoteSqlLiteral(args[index++]) : "NULL"));
}

interface OhosNativeModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DatabaseSync: new (path: string, ...rest: unknown[]) => any;
  version?: string;
  enableJIT?: () => void;
}

// 语句包装：run/get/all/iterate 的绑定参数经 toPositionalArgs 展开后调用原生
// （见该函数注释：Smi 只能走 cb_info 位置通道）。paramNames 来自 SQL 命名参数
// 改写（与 adapter 后端同一 NAMED_PARAM_RE 机制），其余成员透传原生 statement。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapStatementPositional(stmt: any, paramNames: string[]): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Proxy(stmt, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get(target: any, prop: string | symbol) {
      const value = target[prop];
      if (typeof value !== "function") return value;
      if (prop === "get" || prop === "all" || prop === "run" || prop === "iterate") {
        return (...args: unknown[]) => value.apply(target, toPositionalArgs(args, paramNames));
      }
      return value.bind(target);
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createZcodeSqliteModule(native: any): NodeSqliteModule {
  const NativeDatabaseSync = native.DatabaseSync;

  class ZcodeDatabaseSync extends NativeDatabaseSync {
    prepare(sql: string, ...rest: unknown[]) {
      const stmt = NativeDatabaseSync.prototype.prepare.call(this, sql, ...rest);
      // 命名参数在 JS 侧改写为位置参数（对象取值顺序 = SQL 出现顺序），值永不过
      // napi_get_property；原生 prepare 收到的 SQL 不含命名参数。
      const paramNames: string[] = [];
      const positionalSql = sql.replace(NAMED_PARAM_RE, (_match, _prefix: string, name: string) => {
        paramNames.push(name);
        return "?";
      });
      if (paramNames.length === 0) return wrapStatementPositional(stmt, paramNames);
      const positionalStmt = NativeDatabaseSync.prototype.prepare.call(
        this,
        positionalSql,
        ...rest,
      );
      return wrapStatementPositional(positionalStmt, paramNames);
    }
  }

  // zcode 原生绑定没有 backup 入口（此前透传时同样为 undefined，行为不变）。
  return {
    DatabaseSync: ZcodeDatabaseSync,
    version: native.version,
  } as unknown as NodeSqliteModule;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createOhosSqliteModule(native: any): NodeSqliteModule {
  const NativeDatabaseSync: OhosNativeModule["DatabaseSync"] = native.DatabaseSync;

  class OhosDatabaseSync extends NativeDatabaseSync {
    prepare(sql: string, ...rest: unknown[]) {
      if (WRITE_SQL_RE.test(sql)) {
        const stmt = NativeDatabaseSync.prototype.prepare.call(this, sql, ...rest);
        // 写语句：run() 内联参数走 exec()（native 对写语句的 run() 是空操作），
        // 返回值用 changes()/last_insert_rowid() 补齐；其余成员透传原生 statement。
        const runWrite = (
          ...args: unknown[]
        ): {
          changes: number | bigint;
          lastInsertRowid: number | bigint;
        } => {
          this.exec(inlineWriteParams(sql, args));
          try {
            const row = NativeDatabaseSync.prototype.prepare
              .call(this, "SELECT changes() AS c, last_insert_rowid() AS r")
              .get();
            return { changes: row?.c ?? 0, lastInsertRowid: row?.r ?? 0 };
          } catch {
            return { changes: 0, lastInsertRowid: 0 };
          }
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return new Proxy(
          { run: runWrite },
          {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            get(target: any, prop: string | symbol) {
              if (prop === "run") return target.run;
              const value = stmt[prop];
              return typeof value === "function" ? value.bind(stmt) : value;
            },
          },
        );
      }

      const paramNames: string[] = [];
      const positionalSql = sql.replace(NAMED_PARAM_RE, (_match, _prefix: string, name: string) => {
        paramNames.push(name);
        return "?";
      });
      const stmt = NativeDatabaseSync.prototype.prepare.call(this, positionalSql, ...rest);
      if (paramNames.length === 0) return stmt;
      // 读语句参数同样经位置展开（adapter 的数组参数含 Smi 时同样命中裸 tagged
      // 快路径，与 zcode 后端同病），其余成员透传原生 statement。
      return wrapStatementPositional(stmt, paramNames);
    }
  }

  // node:sqlite 的 backup(source, destination) 在 OHOS 绑定上没有对应实现；
  // 用 VACUUM INTO 产出目标快照（调用方只用它做 Chrome cookie 库的只读快照，
  // 语义等价：生成一份可独立打开的库文件副本）。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function ohosBackup(source: any, destination: string): Promise<void> {
    source.exec(`VACUUM INTO ${quoteSqlLiteral(destination)}`);
  }

  return {
    DatabaseSync: OhosDatabaseSync,
    backup: ohosBackup,
    version: native.version,
  } as unknown as NodeSqliteModule;
}

export function loadNodeSqlite(): NodeSqliteModule {
  if (cachedModule) return cachedModule;

  if (!isOhosRuntime()) {
    const real = nodeRequire("node:sqlite") as NodeSqliteModule;
    cachedModule = real;
    return cachedModule;
  }

  cachedModule = loadOhosBackend();
  return cachedModule;
}
