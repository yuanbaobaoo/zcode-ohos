import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { loadNodeSqlite } from "../src/nodeSqliteCompat.js";

// 覆盖 node:sqlite 兼容层的三条后端（真实 node:sqlite / zcode_sqlite.node /
// ohos_sqlite_adapter.node）必须一致的语义：命名参数（裸名与前缀）、数组整参、
// changes/lastInsertRowid、exec、事务内 get 后的语句自动 reset、errcode 附着。
// 设备实机（process.platform=openharmony）自动走 OHOS 后端；macOS 开发态可设
// ZCODE_SQLITE_TEST_MODULE=/path/to/zcode_sqlite.node 直测自有绑定本体
// （本地 clang 编译 darwin 版即可，不需要设备）。
const moduleUnderTest = process.env.ZCODE_SQLITE_TEST_MODULE
  ? createRequire(import.meta.url)(process.env.ZCODE_SQLITE_TEST_MODULE)
  : loadNodeSqlite();

test("nodeSqliteCompat: 建表 / 命名与位置参数写读 / changes / 事务 / errcode", async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), "zcode-sqlite-compat-"));
  t.after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });
  const db = new moduleUnderTest.DatabaseSync(join(workDir, "compat-test.db"));

  try {
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER)");

    // 写语句 + 对象命名参数
    const insert = db.prepare("INSERT INTO t (name, n) VALUES (@name, @n)");
    const r1 = insert.run({ name: "alpha", n: 1 });
    assert.equal(Number(r1.changes), 1);
    assert.ok(Number(r1.lastInsertRowid) > 0);

    // 写语句 + 位置参数（varargs，与仓库调用点一致；数组整参是 OHOS wrapper
    // 专属的归一化形状，裸 node:sqlite 不支持，不进跨后端契约）
    const r2 = db.prepare("INSERT INTO t (name, n) VALUES (?, ?)").run("beta", 2);
    assert.equal(Number(r2.changes), 1);

    // 读语句 + 对象命名参数（裸名，不带前缀）
    const rows = db
      .prepare("SELECT id, name, n FROM t WHERE n >= @min ORDER BY id")
      .all({ min: 1 });
    assert.deepEqual(
      rows.map((row: { name: string }) => row.name),
      ["alpha", "beta"],
    );

    // get + 位置参数
    const one = db.prepare("SELECT name FROM t WHERE id = ?").get(2);
    assert.equal((one as { name: string } | undefined)?.name, "beta");

    // UPDATE / DELETE 写路径
    const up = db.prepare("UPDATE t SET n = @n WHERE name = @name").run({ n: 42, name: "alpha" });
    assert.equal(Number(up.changes), 1);
    const del = db.prepare("DELETE FROM t WHERE id = ?").run(2);
    assert.equal(Number(del.changes), 1);
    const finalCount = db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number };
    assert.equal(Number(finalCount.c), 1);

    // 回归：事务内 get() 命中行后语句必须自动 reset，否则 COMMIT 报
    // "SQL statements in progress"（真机 session storage 迁移账本读路径踩中）。
    db.exec("begin immediate");
    const hit = db.prepare("SELECT id FROM t LIMIT 1").get() as { id: number } | undefined;
    assert.equal(typeof hit?.id, "number");
    db.exec("commit");

    // isTransaction 语义与 node:sqlite 一致；errcode 必须附着（分类/busy 判定依赖）。
    assert.equal(db.isTransaction, false);
    assert.throws(
      () => db.prepare("SELECT * FROM no_such_table_compat").get(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(typeof (error as { errcode?: number }).errcode, "number");
        return true;
      },
    );
  } finally {
    db.close();
  }
});
