#!/bin/sh
# 交叉编译 zcode_sqlite.node（OHOS aarch64）。
# 产物为用户域二进制：宿主（brew node）与 OHOS Electron（Node 20）均可加载。
# 用法：packages/desktop/native/ohos-zcode-sqlite/build.sh [sqlite3.c 所在目录]
#
# 构建环境：SDK clang 自动探测（harmonybrew 本机 / OHOS_COMMAND_LINE_TOOLS_ROOT / ~/command-line-tools*），
# 无需 DevEco Studio；Node 头文件 NAPI 跨主版本稳定，宿主任意 node include 即可（NODE_INCLUDE 可覆盖）。
set -e
HERE=$(cd "$(dirname "$0")" && pwd)

if [ -z "$SDK_CLANG" ]; then
  for candidate in \
    "$HOME/.harmonybrew/opt/ohos-sdk/native/llvm/bin/aarch64-unknown-linux-ohos-clang" \
    "$OHOS_COMMAND_LINE_TOOLS_ROOT/sdk/default/openharmony/native/llvm/bin/aarch64-unknown-linux-ohos-clang" \
    "$HOME"/command-line-tools*/sdk/default/openharmony/native/llvm/bin/aarch64-unknown-linux-ohos-clang
  do
    if [ -x "$candidate" ]; then
      SDK_CLANG="$candidate"
      break
    fi
  done
fi

if [ -z "$NODE_INCLUDE" ]; then
  NODE_INCLUDE="$(node -p process.env.NODE_INCLUDE || true)"
  if [ -z "$NODE_INCLUDE" ] || [ ! -f "$NODE_INCLUDE/node_api.h" ]; then
    NODE_INCLUDE="$(node -p 'require("path").dirname(process.execPath) + "/../include/node"' 2>/dev/null || true)"
  fi
fi

SQLITE_SRC_DIR="${1:-$HOME/sqlite-src/sqlite-amalgamation-3530400}"

if [ ! -x "$SDK_CLANG" ]; then
  echo "OHOS SDK clang not found (set SDK_CLANG or OHOS_COMMAND_LINE_TOOLS_ROOT)" >&2
  exit 1
fi
if [ ! -f "$NODE_INCLUDE/node_api.h" ]; then
  echo "node headers not found at $NODE_INCLUDE (set NODE_INCLUDE)" >&2
  exit 1
fi

if [ ! -f "$SQLITE_SRC_DIR/sqlite3.c" ]; then
  echo "sqlite3.c not found at $SQLITE_SRC_DIR (pass dir as \$1)" >&2
  exit 1
fi

# 源目录即本目录（融合源已在位，build-ohos.mjs 自动编译路径）时跳过自拷贝。
if [ "$(cd "$SQLITE_SRC_DIR" && pwd)" != "$HERE" ]; then
  cp "$SQLITE_SRC_DIR/sqlite3.c" "$SQLITE_SRC_DIR/sqlite3.h" "$HERE/"
fi

"$SDK_CLANG" \
  -target aarch64-linux-ohos \
  -shared -fPIC -O2 \
  -DNAPI_VERSION=8 \
  -DSQLITE_ENABLE_COLUMN_METADATA=1 \
  -DSQLITE_THREADSAFE=1 \
  -DSQLITE_DEFAULT_journal_mode=1 \
  -I"$NODE_INCLUDE" \
  -I"$HERE" \
  "$HERE/zcode_sqlite.c" "$HERE/sqlite3.c" \
  -o "$HERE/zcode_sqlite.node"

echo "built: $HERE/zcode_sqlite.node"
