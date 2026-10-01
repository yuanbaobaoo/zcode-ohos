import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isOhosRuntime } from "./runtimeEnv.js";

/**
 * node:sqlite 兼容加载器：OHOS Electron 内嵌 Node 20.18 无 node:sqlite（Node 22.5+ 才有），
 * 而 host/main/agent 三端都依赖 SQLite。优先用真实 node:sqlite，OHOS 上按优先级加载
 * 随包 NAPI 绑定（见下方候选注释）。不要动态 import("node:sqlite")——esbuild 会
 * 错误改写成 import("sqlite")，必须走 require。
 */

type NodeSqliteModule = typeof import("node:sqlite");

let cachedModule: NodeSqliteModule | null = null;

function nodeRequire(specifier: string): unknown {
  // esbuild 会把裸 require 替换成抛错的 shim，只能走 createRequire（CJS 用 __filename，ESM 用 import.meta.url）。
  const base: string | URL = typeof __filename === "string" ? __filename : import.meta.url;
  return createRequire(base)(specifier);
}

// OHOS 后端候选按优先级：自有 zcode_sqlite.node（语义正确）→ 发行包 ohos_sqlite_adapter.node
// （有 run() 空转/命名参数绑 NULL 两缺陷，经 OhosDatabaseSync 包装绕过）。
// 候选路径必须惰性求值：CJS 产物里 import.meta 是 esbuild 置入的空对象，
// 加载期求值会抛错导致 agent CLI 启动即崩。
const OHOS_SQLITE_CANDIDATES = [
  "/data/storage/el1/bundle/electron/resources/resfile/resources/app/zcode_sqlite.node",
  "/data/storage/el1/bundle/electron/libs/arm64-v8a/zcode_sqlite.node",
] as const;
const OHOS_ADAPTER_CANDIDATES = [
  "/data/storage/el1/bundle/electron/libs/arm64-v8a/ohos_sqlite_adapter.node",
  "/data/storage/el1/bundle/libs/arm64/ohos_sqlite_adapter.node",
] as const;

function devRepoCandidates(relative: string): string[] {
  // 与 nodeRequire 相同的 CJS/ESM 双态取基址，仅 file: 协议有效。
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
  // 加载期真实读写自检，不合格后端在此暴露并自动落到下一候选；宽参数用例
  // 覆盖 OHOS 间接 Local ABI 的参数展开路径（数字只走 cb_info 位置通道）。
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
  // 候选逐一自检（缺失/dlopen 被拒/语义不符），失败自动落下一个。
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
      // 包装后自检（数组/对象参数展开也是自检的一部分）。
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
      // 模块初始化会 prctl(SET_JITFORT) 放开本进程 JIT（OHOS 默认禁 RWX，否则 V8 保留
      // CodeRange 直接 OOM），且被此后 spawn 的子进程继承。
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
 * OHOS V8 为间接 Local ABI：数字（Smi）经 napi_get_element/get_property 进入 native
 * 会被当槽位地址二次解引用直接 SEGV（真机实证），只有 cb_info 位置参数通道安全。
 * 因此数组展开为位置参数、对象按命名顺序映射，数字永不走属性/元素取值路径。
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

// 语句包装：绑定参数经 toPositionalArgs 展开后再调原生（Smi 只能走 cb_info 位置通道），
// 其余成员透传。
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
      // 读语句参数同样经位置展开（adapter 与 zcode 后端同病），其余透传。
      return wrapStatementPositional(stmt, paramNames);
    }
  }

  // OHOS 绑定无 backup()，用 VACUUM INTO 产出等价的只读快照副本。
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
