// 实机验证 nodeSqliteCompat：宿主 brew node 的 platform 就是 openharmony，
// loadNodeSqlite() 会走 OHOS 适配路径加载真实 ohos_sqlite_adapter.node。
// 覆盖：建表/写（命名参数+位置参数）/读（裸命名参数）/changes 返回值/exec。
// macOS 开发态回归：ZCODE_SQLITE_TEST_MODULE=/path/to/zcode_sqlite.node 直接测绑定本体
// （本地 clang 编译 darwin 版即可，不需要设备）。
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const dbPath = new URL("./compat-test.db", import.meta.url).pathname
  ? `${process.env.HOME}/.zcode-compat-test/compat-test.db`
  : null;
rmSync(dbPath, { force: true });
mkdirSync(dirname(dbPath), { recursive: true });

// 直测绑定时不需要 workspace dist，避免 ESM 链接期就要求构建产物存在。
const { loadNodeSqlite } = process.env.ZCODE_SQLITE_TEST_MODULE
  ? {}
  : await import("../packages/shared/dist/nodeSqliteCompat.js");
const { DatabaseSync } = process.env.ZCODE_SQLITE_TEST_MODULE
  ? createRequire(import.meta.url)(process.env.ZCODE_SQLITE_TEST_MODULE)
  : loadNodeSqlite();
const db = new DatabaseSync(dbPath);

db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER)");

// 写语句 + 裸命名参数（native 缺陷路径：内联进 exec）
const insert = db.prepare("INSERT INTO t (name, n) VALUES (@name, @n)");
const r1 = insert.run({ name: "alpha", n: 1 });
console.log("insert#1 changes:", r1.changes, "rowid:", Number(r1.lastInsertRowid));
if (Number(r1.changes) !== 1) throw new Error("insert#1 changes mismatch");

// 写语句 + 位置参数
const insertPos = db.prepare("INSERT INTO t (name, n) VALUES (?, ?)");
const r2 = insertPos.run(["beta", 2]);
console.log("insert#2 changes:", r2.changes);
if (Number(r2.changes) !== 1) throw new Error("insert#2 changes mismatch");

// 读语句 + 裸命名参数（native 缺陷路径：改写位置参数）
const select = db.prepare("SELECT id, name, n FROM t WHERE n >= @min ORDER BY id");
const rows = select.all({ min: 1 });
console.log("select rows:", JSON.stringify(rows));
if (rows.length !== 2 || rows[0].name !== "alpha" || rows[1].n !== 2) {
  throw new Error("select result mismatch");
}

// get + 位置参数
const one = db.prepare("SELECT name FROM t WHERE id = ?").get([2]);
console.log("get:", JSON.stringify(one));
if (one?.name !== "beta") throw new Error("get mismatch");

// UPDATE + DELETE（写路径回归）
const up = db.prepare("UPDATE t SET n = @n WHERE name = @name").run({ n: 42, name: "alpha" });
console.log("update changes:", up.changes);
if (Number(up.changes) !== 1) throw new Error("update changes mismatch");
const del = db.prepare("DELETE FROM t WHERE id = ?").run([2]);
console.log("delete changes:", del.changes);
if (Number(del.changes) !== 1) throw new Error("delete changes mismatch");

const finalRows = db.prepare("SELECT COUNT(*) AS c FROM t").get();
console.log("final count:", JSON.stringify(finalRows));
if (Number(finalRows.c) !== 1) throw new Error("final count mismatch");

// 回归：事务内 get() 命中行后语句必须自动 reset，否则 COMMIT 报
// "SQL statements in progress"（真机 session storage 迁移账本读路径踩中）。
db.exec("begin immediate");
const hit = db.prepare("SELECT id FROM t LIMIT 1").get();
if (!hit || typeof hit.id !== "number") throw new Error("in-txn get mismatch");
db.exec("commit");
console.log("in-txn commit after row-get: OK");

// 回归：errcode 必须附着（分类/busy 判定依赖），isTransaction 语义与 node:sqlite 一致。
if (db.isTransaction !== false) throw new Error("isTransaction should be false outside txn");
try {
  db.prepare("SELECT * FROM no_such_table_compat").get();
  throw new Error("expected prepare failure");
} catch (e) {
  if (typeof e.errcode !== "number") throw new Error(`errcode missing on sqlite error: ${e.message}`);
  console.log("errcode attached:", e.errcode);
}

db.close();
rmSync(dbPath, { force: true });
console.log("COMPAT_OK");
