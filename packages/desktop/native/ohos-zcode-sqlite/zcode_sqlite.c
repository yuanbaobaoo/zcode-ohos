/*
 * zcode_sqlite.node —— 自有 SQLite NAPI 绑定（C，无 C++ 运行时）。
 * 不用发行包 ohos_sqlite_adapter.node 的原因：签名域管控使其只能从 el1 bundle
 * 加载（宿主/开发态无法自测），且有写语句 run() 空转、命名参数绑 NULL 两个实证
 * 缺陷。本模块用户域可随处加载，实现 node:sqlite 子集（语义与上游一致，命名参数
 * 兼容裸名与 @/$/: 前缀）。
 * 构建：ohos/native/zcode-sqlite/build.sh（aarch64-linux-ohos，NAPI_VERSION=8）。
 */

#include <node_api.h>
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  sqlite3 *db;
  int read_bigints;
} zcode_database_t;

typedef struct {
  zcode_database_t *owner;
  sqlite3_stmt *stmt;
} zcode_statement_t;

/* prepare() 从这里取 StatementSync 构造器。必须用 per-env instance data：
 * worker_threads 会按 isolate 重新跑模块初始化，若用进程级 C 全局 ref，
 * 后初始化的 isolate 会覆盖前者的引用，另一 isolate 里 prepare() 取到
 * 跨 env 的悬空 ref，napi_new_instance 产出无方法的对象（真机实测：
 * host 主线程报 prepare(...).get is not a function，worker 内反而正常）。 */
typedef struct {
  napi_ref statement_ctor_ref;
} zcode_module_data_t;

static void zcode_module_data_finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  zcode_module_data_t *mod = (zcode_module_data_t *)data;
  if (mod && mod->statement_ctor_ref) napi_delete_reference(env, mod->statement_ctor_ref);
  free(mod);
}

static void zcode_database_destroy(napi_env env, void *data, void *hint);

/* napi_unwrap 会解除关联（并取消 finalizer），读取后立即回包以保持 GC 回收路径。 */
static void *zcode_unwrap_keep(napi_env env, napi_value this_arg, napi_finalize finalizer) {
  void *data = NULL;
  if (napi_unwrap(env, this_arg, &data) == napi_ok && data) {
    napi_wrap(env, this_arg, data, finalizer, NULL, NULL);
  }
  return data;
}

static void zcode_throw_sqlite(napi_env env, sqlite3 *db, const char *prefix) {
  char buf[256];
  const char *msg = db ? sqlite3_errmsg(db) : "sqlite error";
  int err = db ? (sqlite3_extended_errcode(db) ? (int)sqlite3_extended_errcode(db)
                                               : sqlite3_errcode(db))
               : SQLITE_ERROR;
  snprintf(buf, sizeof(buf), "%s: %s", prefix, msg ? msg : "unknown");
  // node:sqlite 的错误带 errcode 数字属性（业务侧 busy 判定与 classify 都读它）；
  // 裸 napi_throw_error 会让所有原生错误伪装成无码 JS 错误，迁移失败无从分类。
  napi_value error, code_val, msg_val;
  napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &msg_val);
  napi_create_error(env, NULL, msg_val, &error);
  napi_create_int32(env, err, &code_val);
  napi_set_named_property(env, error, "errcode", code_val);
  napi_set_named_property(env, error, "code", code_val);
  napi_throw(env, error);
}

static int zcode_bind_one(napi_env env, sqlite3_stmt *stmt, int index, napi_value value) {
  napi_valuetype vt;
  if (napi_typeof(env, value, &vt) != napi_ok) return SQLITE_ERROR;
  if (vt == napi_undefined || vt == napi_null) {
    return sqlite3_bind_null(stmt, index);
  }
  if (vt == napi_number) {
    double d;
    napi_get_value_double(env, value, &d);
    return sqlite3_bind_double(stmt, index, d);
  }
  if (vt == napi_bigint) {
    int64_t v64;
    bool lossless;
    napi_get_value_bigint_int64(env, value, &v64, &lossless);
    return sqlite3_bind_int64(stmt, index, v64);
  }
  if (vt == napi_boolean) {
    bool b;
    napi_get_value_bool(env, value, &b);
    return sqlite3_bind_int(stmt, index, b ? 1 : 0);
  }
  bool is_typed = false;
  napi_is_typedarray(env, value, &is_typed);
  if (is_typed) {
    napi_typedarray_type tat;
    size_t len = 0;
    void *data = NULL;
    napi_get_typedarray_info(env, value, &tat, &len, &data, NULL, NULL);
    return sqlite3_bind_blob(stmt, index, data, (int)len, SQLITE_TRANSIENT);
  }
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &len) != napi_ok) return SQLITE_ERROR;
  char *buf = (char *)malloc(len + 1);
  if (!buf) return SQLITE_NOMEM;
  napi_get_value_string_utf8(env, value, buf, len + 1, &len);
  int rc = sqlite3_bind_text(stmt, index, buf, (int)len, SQLITE_TRANSIENT);
  free(buf);
  return rc;
}

/* 单个 plain object → 命名参数（裸名与 @/$/: 前缀都接受）；否则按位置参数处理。 */
static int zcode_bind_params(napi_env env, sqlite3_stmt *stmt, size_t argc, napi_value *argv) {
  if (argc == 1) {
    napi_valuetype type;
    if (napi_typeof(env, argv[0], &type) != napi_ok) return SQLITE_ERROR;
    if (type == napi_undefined || type == napi_null) return SQLITE_OK;
    bool is_array = false;
    napi_is_array(env, argv[0], &is_array);
    if (type == napi_object && !is_array) {
      napi_value names;
      if (napi_get_property_names(env, argv[0], &names) != napi_ok) return SQLITE_ERROR;
      uint32_t count = 0;
      napi_get_array_length(env, names, &count);
      for (uint32_t i = 0; i < count; i++) {
        napi_value key;
        napi_get_element(env, names, i, &key);
        char key_buf[160];
        size_t key_len = 0;
        if (napi_get_value_string_utf8(env, key, key_buf, sizeof(key_buf), &key_len) != napi_ok) {
          continue;
        }
        int index = sqlite3_bind_parameter_index(stmt, key_buf);
        if (index == 0 && key_buf[0] != '@' && key_buf[0] != '$' && key_buf[0] != ':') {
          char prefixed[164];
          snprintf(prefixed, sizeof(prefixed), "@%s", key_buf);
          index = sqlite3_bind_parameter_index(stmt, prefixed);
        }
        if (index == 0) continue; /* 与 node:sqlite 一致：忽略 SQL 中不存在的名字 */
        napi_value value = NULL;
        // Proxy/getter 抛出时 napi_get_property 返回非 ok 且不写 value——不检查
        // 状态就把 NULL 传给 zcode_bind_one 的 napi_typeof，直接 SEGV（真机实证：
        // sendText 路径 v8::Value::IsNumber NULL 解引用）。失败按绑定错误上抛。
        if (napi_get_property(env, argv[0], key, &value) != napi_ok || value == NULL) {
          return SQLITE_ERROR;
        }
        int rc = zcode_bind_one(env, stmt, index, value);
        if (rc != SQLITE_OK) return rc;
      }
      return SQLITE_OK;
    }
  }
  /* 位置参数：单数组或逐个参数 */
  size_t bind_count = argc;
  bool single_array = false;
  if (argc == 1) {
    napi_valuetype type;
    napi_typeof(env, argv[0], &type);
    if (type == napi_object) {
      napi_is_array(env, argv[0], &single_array);
      if (single_array) {
        uint32_t len = 0;
        napi_get_array_length(env, argv[0], &len);
        bind_count = len;
      }
    }
  }
  for (size_t i = 0; i < bind_count; i++) {
    napi_value value = NULL;
    if (single_array) {
      // Proxy/稀疏数组上 napi_get_element 可能失败且不写 value（同 get_property 路径，
      // 真机 sendText 链路二次实证），未检查状态的 NULL 传入 zcode_bind_one 即 SEGV。
      if (napi_get_element(env, argv[0], (uint32_t)i, &value) != napi_ok || value == NULL) {
        return SQLITE_ERROR;
      }
    } else {
      value = argv[i];
      if (value == NULL) {
        /* 装机实证（OHOS sendText 链路）：get_cb_info 成功后 argv[i] 仍可能为 NULL
           （V8 侧 null 句柄），裸传 bind_one 即 SEGV。按绑定错误拒绝。 */
        return SQLITE_ERROR;
      }
    }
    int rc = zcode_bind_one(env, stmt, (int)i + 1, value);
    if (rc != SQLITE_OK) return rc;
  }
  return SQLITE_OK;
}

static napi_value zcode_column_value(napi_env env, sqlite3_stmt *stmt, int i, int read_bigints) {
  napi_value value = NULL;
  switch (sqlite3_column_type(stmt, i)) {
    case SQLITE_INTEGER: {
      sqlite3_int64 v = sqlite3_column_int64(stmt, i);
      if (read_bigints || v > 9007199254740991LL || v < -9007199254740991LL) {
        napi_create_bigint_int64(env, v, &value);
      } else {
        napi_create_double(env, (double)v, &value);
      }
      break;
    }
    case SQLITE_FLOAT:
      napi_create_double(env, sqlite3_column_double(stmt, i), &value);
      break;
    case SQLITE_NULL:
      napi_get_undefined(env, &value);
      break;
    case SQLITE_BLOB: {
      const void *data = sqlite3_column_blob(stmt, i);
      int len = sqlite3_column_bytes(stmt, i);
      void *copy = malloc((size_t)(len > 0 ? len : 1));
      if (copy && len > 0 && data) {
        memcpy(copy, data, (size_t)len);
      }
      napi_value arraybuffer;
      napi_create_external_arraybuffer(env, copy, (size_t)(len > 0 ? len : 0), NULL, NULL, &arraybuffer);
      napi_create_typedarray(env, napi_uint8_array, (size_t)(len > 0 ? len : 0), arraybuffer, 0, &value);
      break;
    }
    default: {
      const unsigned char *text = sqlite3_column_text(stmt, i);
      int len = sqlite3_column_bytes(stmt, i);
      napi_create_string_utf8(env, text ? (const char *)text : "", len, &value);
      break;
    }
  }
  return value;
}

static napi_value zcode_row_to_object(napi_env env, sqlite3_stmt *stmt, int read_bigints) {
  napi_value row;
  napi_create_object(env, &row);
  int columns = sqlite3_column_count(stmt);
  for (int i = 0; i < columns; i++) {
    const char *name = sqlite3_column_name(stmt, i);
    napi_value key;
    napi_create_string_utf8(env, name ? name : "", NAPI_AUTO_LENGTH, &key);
    napi_value value = zcode_column_value(env, stmt, i, read_bigints);
    if (value) {
      napi_set_property(env, row, key, value);
    }
  }
  return row;
}

/* ── StatementSync ── */

static void zcode_statement_finalize(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  zcode_statement_t *st = (zcode_statement_t *)data;
  if (st) {
    if (st->stmt) {
      sqlite3_finalize(st->stmt);
    }
    free(st);
  }
}

static zcode_statement_t *zcode_get_statement(napi_env env, napi_callback_info info) {
  napi_value this_arg = NULL;
  napi_get_cb_info(env, info, NULL, NULL, &this_arg, NULL);
  if (!this_arg) return NULL;
  return (zcode_statement_t *)zcode_unwrap_keep(env, this_arg, zcode_statement_finalize);
}

/* cb_info 的 argv 槽位是 OHOS libelectron 下唯一安全的参数通道（含 Smi）；
   JS 兼容层把数组/对象参数全部展开成位置参数传入，参数个数不再固定，
   argv 按实际 argc 动态分配。上限是防御性封顶，超出按容量截断。
   失败路径（pending exception 等）返回 argc=0，与"语句已关闭"语义一致。 */
#define ZCODE_MAX_ARGS 256

static napi_value *zcode_get_argv(napi_env env, napi_callback_info info, size_t *argc_out) {
  size_t argc = 0;
  *argc_out = 0;
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok || argc == 0) {
    return NULL;
  }
  size_t capacity = argc > ZCODE_MAX_ARGS ? ZCODE_MAX_ARGS : argc;
  napi_value *argv = (napi_value *)calloc(capacity, sizeof(napi_value));
  if (!argv) return NULL;
  if (napi_get_cb_info(env, info, &capacity, argv, NULL, NULL) != napi_ok) {
    free(argv);
    return NULL;
  }
  *argc_out = capacity;
  return argv;
}

static napi_value zcode_statement_run(napi_env env, napi_callback_info info) {
  zcode_statement_t *st = zcode_get_statement(env, info);
  if (!st || !st->stmt) {
    napi_throw_error(env, NULL, "statement is closed");
    return NULL;
  }
  size_t argc = 0;
  napi_value *argv = zcode_get_argv(env, info, &argc);
  sqlite3_reset(st->stmt);
  sqlite3_clear_bindings(st->stmt);
  int rc = zcode_bind_params(env, st->stmt, argc, argv);
  free(argv); /* bind 全量拷贝（SQLITE_TRANSIENT），argv 用完即释 */
  if (rc != SQLITE_OK) {
    zcode_throw_sqlite(env, st->owner ? st->owner->db : NULL, "bind failed");
    return NULL;
  }
  rc = sqlite3_step(st->stmt);
  if (rc != SQLITE_DONE && rc != SQLITE_ROW) {
    zcode_throw_sqlite(env, st->owner ? st->owner->db : NULL, "step failed");
    return NULL;
  }
  // run() 同样在执行后 reset（见 get 注释）；changes/rowid 在 reset 前读取。
  napi_value result;
  napi_create_object(env, &result);
  napi_value changes;
  sqlite3 *db = st->owner ? st->owner->db : NULL;
  napi_create_int64(env, db ? sqlite3_changes64(db) : 0, &changes);
  napi_set_named_property(env, result, "changes", changes);
  napi_value rowid;
  napi_create_int64(env, db ? sqlite3_last_insert_rowid(db) : 0, &rowid);
  napi_set_named_property(env, result, "lastInsertRowid", rowid);
  sqlite3_reset(st->stmt);
  sqlite3_clear_bindings(st->stmt);
  return result;
}

static napi_value zcode_statement_get(napi_env env, napi_callback_info info) {
  zcode_statement_t *st = zcode_get_statement(env, info);
  if (!st || !st->stmt) {
    napi_throw_error(env, NULL, "statement is closed");
    return NULL;
  }
  size_t argc = 0;
  napi_value *argv = zcode_get_argv(env, info, &argc);
  sqlite3_reset(st->stmt);
  int rc = zcode_bind_params(env, st->stmt, argc, argv);
  free(argv);
  if (rc != SQLITE_OK) {
    zcode_throw_sqlite(env, st->owner ? st->owner->db : NULL, "bind failed");
    return NULL;
  }
  rc = sqlite3_step(st->stmt);
  if (rc == SQLITE_ROW) {
    // node:sqlite 语义：get() 执行后语句自动 reset。取到 SQLITE_ROW 的语句若不
    // reset 会保持 busy 状态，事务内 COMMIT 会报 "SQL statements in progress"
    // （行数据必须先完整拷出再 reset）。
    napi_value row = zcode_row_to_object(env, st->stmt, st->owner ? st->owner->read_bigints : 0);
    sqlite3_reset(st->stmt);
    return row;
  }
  if (rc != SQLITE_DONE) {
    zcode_throw_sqlite(env, st->owner ? st->owner->db : NULL, "step failed");
    return NULL;
  }
  sqlite3_reset(st->stmt);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value zcode_statement_all(napi_env env, napi_callback_info info) {
  zcode_statement_t *st = zcode_get_statement(env, info);
  if (!st || !st->stmt) {
    napi_throw_error(env, NULL, "statement is closed");
    return NULL;
  }
  size_t argc = 0;
  napi_value *argv = zcode_get_argv(env, info, &argc);
  napi_value rows;
  napi_create_array(env, &rows);
  sqlite3_reset(st->stmt);
  int rc = zcode_bind_params(env, st->stmt, argc, argv);
  free(argv);
  if (rc != SQLITE_OK) {
    zcode_throw_sqlite(env, st->owner ? st->owner->db : NULL, "bind failed");
    return NULL;
  }
  uint32_t index = 0;
  while ((rc = sqlite3_step(st->stmt)) == SQLITE_ROW) {
    napi_value row = zcode_row_to_object(env, st->stmt, st->owner ? st->owner->read_bigints : 0);
    napi_set_element(env, rows, index++, row);
  }
  if (rc != SQLITE_DONE) {
    zcode_throw_sqlite(env, st->owner ? st->owner->db : NULL, "step failed");
    return NULL;
  }
  // 循环步进到 DONE 的语句不 busy，但仍按 node:sqlite 语义补 reset（见 get 注释）。
  sqlite3_reset(st->stmt);
  return rows;
}

static napi_value zcode_statement_set_read_bigints(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  zcode_statement_t *st = zcode_get_statement(env, info);
  if (st) {
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  }
  if (st && st->owner && argc >= 1) {
    bool enabled = false;
    napi_get_value_bool(env, argv[0], &enabled);
    st->owner->read_bigints = enabled ? 1 : 0;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value zcode_statement_finalize_method(napi_env env, napi_callback_info info) {
  zcode_statement_t *st = zcode_get_statement(env, info);
  if (st && st->stmt) {
    sqlite3_finalize(st->stmt);
    st->stmt = NULL;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

/* ── DatabaseSync ── */

static napi_value zcode_database_constructor(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_value this_arg;
  napi_get_cb_info(env, info, &argc, argv, &this_arg, NULL);
  if (argc < 1) {
    napi_throw_error(env, NULL, "DatabaseSync requires a path");
    return NULL;
  }
  char path[1024];
  size_t path_len = 0;
  if (napi_get_value_string_utf8(env, argv[0], path, sizeof(path), &path_len) != napi_ok) {
    napi_throw_error(env, NULL, "DatabaseSync path must be a string");
    return NULL;
  }
  int flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX;
  if (argc >= 2) {
    napi_valuetype type;
    napi_typeof(env, argv[1], &type);
    if (type == napi_object) {
      napi_value read_only;
      bool has = false;
      napi_has_named_property(env, argv[1], "readOnly", &has);
      if (has) {
        napi_get_named_property(env, argv[1], "readOnly", &read_only);
        bool b = false;
        napi_get_value_bool(env, read_only, &b);
        if (b) {
          flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX;
        }
      }
    }
  }
  sqlite3 *db = NULL;
  int rc = sqlite3_open_v2(path, &db, flags, NULL);
  if (rc != SQLITE_OK) {
    zcode_throw_sqlite(env, db, "open failed");
    if (db) sqlite3_close(db);
    return NULL;
  }
  sqlite3_busy_timeout(db, 5000);
  sqlite3_enable_load_extension(db, 0);
  zcode_database_t *data = (zcode_database_t *)malloc(sizeof(zcode_database_t));
  data->db = db;
  data->read_bigints = 0;
  napi_wrap(env, this_arg, data, zcode_database_destroy, NULL, NULL);
  return this_arg;
}

static void zcode_database_destroy(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  zcode_database_t *db_data = (zcode_database_t *)data;
  if (db_data) {
    if (db_data->db) {
      sqlite3_close_v2(db_data->db);
    }
    free(db_data);
  }
}

static napi_value zcode_database_is_transaction(napi_env env, napi_callback_info info) {
  napi_value this_arg = NULL;
  napi_get_cb_info(env, info, NULL, NULL, &this_arg, NULL);
  zcode_database_t *data =
    this_arg ? (zcode_database_t *)zcode_unwrap_keep(env, this_arg, zcode_database_destroy) : NULL;
  napi_value result;
  napi_get_boolean(env, data && data->db && sqlite3_get_autocommit(data->db) == 0, &result);
  return result;
}

static napi_value zcode_database_exec(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value this_arg = NULL;
  napi_get_cb_info(env, info, &argc, argv, &this_arg, NULL);
  zcode_database_t *data =
    this_arg ? (zcode_database_t *)zcode_unwrap_keep(env, this_arg, zcode_database_destroy) : NULL;
  if (argc < 1 || !data || !data->db) {
    napi_throw_error(env, NULL, "exec requires sql");
    return NULL;
  }
  char *sql = NULL;
  size_t sql_len = 0;
  napi_get_value_string_utf8(env, argv[0], NULL, 0, &sql_len);
  sql = (char *)malloc(sql_len + 1);
  napi_get_value_string_utf8(env, argv[0], sql, sql_len + 1, &sql_len);
  char *errmsg = NULL;
  int rc = sqlite3_exec(data->db, sql, NULL, NULL, &errmsg);
  free(sql);
  if (rc != SQLITE_OK) {
    char buf[256];
    snprintf(buf, sizeof(buf), "exec failed: %s", errmsg ? errmsg : "unknown");
    sqlite3_free(errmsg);
    napi_throw_error(env, NULL, buf);
    return NULL;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value zcode_database_prepare(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_value this_arg = NULL;
  napi_get_cb_info(env, info, &argc, argv, &this_arg, NULL);
  zcode_database_t *data =
    this_arg ? (zcode_database_t *)zcode_unwrap_keep(env, this_arg, zcode_database_destroy) : NULL;
  if (argc < 1 || !data || !data->db) {
    napi_throw_error(env, NULL, "prepare requires sql");
    return NULL;
  }
  char *sql = NULL;
  size_t sql_len = 0;
  napi_get_value_string_utf8(env, argv[0], NULL, 0, &sql_len);
  sql = (char *)malloc(sql_len + 1);
  napi_get_value_string_utf8(env, argv[0], sql, sql_len + 1, &sql_len);
  sqlite3_stmt *stmt = NULL;
  int rc = sqlite3_prepare_v2(data->db, sql, (int)sql_len, &stmt, NULL);
  free(sql);
  if (rc != SQLITE_OK) {
    zcode_throw_sqlite(env, data->db, "prepare failed");
    return NULL;
  }
  zcode_module_data_t *mod = NULL;
  if (napi_get_instance_data(env, (void **)&mod) != napi_ok || !mod || !mod->statement_ctor_ref) {
    napi_throw_error(env, NULL, "prepare failed: module instance data missing");
    return NULL;
  }
  napi_value st_instance = NULL, statement_ctor = NULL;
  napi_get_reference_value(env, mod->statement_ctor_ref, &statement_ctor);
  if (napi_new_instance(env, statement_ctor, 0, NULL, &st_instance) != napi_ok ||
      st_instance == NULL) {
    zcode_throw_sqlite(env, data->db, "prepare failed: cannot create statement");
    return NULL;
  }
  zcode_statement_t *st_data = (zcode_statement_t *)malloc(sizeof(zcode_statement_t));
  st_data->owner = data;
  st_data->stmt = stmt;
  napi_wrap(env, st_instance, st_data, zcode_statement_finalize, NULL, NULL);
  return st_instance;
}

static napi_value zcode_database_close(napi_env env, napi_callback_info info) {
  napi_value this_arg = NULL;
  napi_get_cb_info(env, info, NULL, &this_arg, NULL, NULL);
  zcode_database_t *data =
    this_arg ? (zcode_database_t *)zcode_unwrap_keep(env, this_arg, zcode_database_destroy) : NULL;
  if (data && data->db) {
    sqlite3_close_v2(data->db);
    data->db = NULL;
  }
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  return undefined;
}

static napi_value zcode_statement_constructor(napi_env env, napi_callback_info info) {
  napi_value this_arg;
  napi_get_cb_info(env, info, NULL, NULL, &this_arg, NULL);
  return this_arg;
}

NAPI_MODULE_INIT() {
  napi_value database_ctor;
  napi_define_class(env, "DatabaseSync", NAPI_AUTO_LENGTH, zcode_database_constructor, NULL, 0, NULL, &database_ctor);
  napi_value database_proto;
  napi_get_named_property(env, database_ctor, "prototype", &database_proto);
  napi_property_descriptor database_methods[] = {
    {"exec", NULL, zcode_database_exec, NULL, NULL, NULL, napi_default, NULL},
    {"prepare", NULL, zcode_database_prepare, NULL, NULL, NULL, napi_default, NULL},
    {"close", NULL, zcode_database_close, NULL, NULL, NULL, napi_default, NULL},
    // node:sqlite 语义：事务激活（autocommit 关闭）时为 true；迁移失败路径靠它决定 rollback。
    {"isTransaction", NULL, NULL, zcode_database_is_transaction, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, database_proto, sizeof(database_methods) / sizeof(database_methods[0]), database_methods);

  napi_value statement_ctor;
  napi_define_class(env, "StatementSync", NAPI_AUTO_LENGTH, zcode_statement_constructor, NULL, 0, NULL, &statement_ctor);
  napi_value statement_proto;
  napi_get_named_property(env, statement_ctor, "prototype", &statement_proto);
  napi_property_descriptor statement_methods[] = {
    {"run", NULL, zcode_statement_run, NULL, NULL, NULL, napi_default, NULL},
    {"get", NULL, zcode_statement_get, NULL, NULL, NULL, napi_default, NULL},
    {"all", NULL, zcode_statement_all, NULL, NULL, NULL, napi_default, NULL},
    {"setReadBigInts", NULL, zcode_statement_set_read_bigints, NULL, NULL, NULL, napi_default, NULL},
    {"finalize", NULL, zcode_statement_finalize_method, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, statement_proto, sizeof(statement_methods) / sizeof(statement_methods[0]), statement_methods);

  /* StatementSync 构造器存 per-env instance data（跨 isolate 安全，见结构体注释）。 */
  zcode_module_data_t *mod = (zcode_module_data_t *)malloc(sizeof(zcode_module_data_t));
  mod->statement_ctor_ref = NULL;
  napi_create_reference(env, statement_ctor, 1, &mod->statement_ctor_ref);
  napi_set_instance_data(env, mod, zcode_module_data_finalize, NULL);

  napi_set_named_property(env, exports, "DatabaseSync", database_ctor);
  napi_set_named_property(env, exports, "StatementSync", statement_ctor);
  napi_value version;
  napi_create_string_utf8(env, SQLITE_VERSION, NAPI_AUTO_LENGTH, &version);
  napi_set_named_property(env, exports, "version", version);
  return exports;
}
