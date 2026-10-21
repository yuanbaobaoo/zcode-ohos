#!/bin/sh
# 交叉编译 OHOS 终端原生子进程：
#   libzcode_pty.so          子进程宿主库（appspawn dlopen，HAP libs/arm64）
#   zcode_ohos_process.node  主进程 NAPI 启动桥（resfile app 根）
# 用法：packages/desktop/native/ohos-zcode-pty/build.sh
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
  NODE_INCLUDE="$(node -p 'require("path").dirname(process.execPath) + "/../include/node"' 2>/dev/null || true)"
fi

if [ ! -x "$SDK_CLANG" ]; then
  echo "OHOS SDK clang not found (set SDK_CLANG or OHOS_COMMAND_LINE_TOOLS_ROOT)" >&2
  exit 1
fi
if [ ! -f "$NODE_INCLUDE/node_api.h" ]; then
  echo "node headers not found at $NODE_INCLUDE (set NODE_INCLUDE)" >&2
  exit 1
fi

# 子进程 lib 不依赖 C++ 标准库（appspawn dlopen 不带 libc++_shared）。
"$SDK_CLANG" -target aarch64-linux-ohos -shared -fPIC -O2 \
  "$HERE/zcode_pty_child.cpp" \
  -o "$HERE/libzcode_pty.so"

"$SDK_CLANG" -target aarch64-linux-ohos -shared -fPIC -O2 \
  -DNAPI_VERSION=8 \
  -I"$NODE_INCLUDE" \
  "$HERE/zcode_pty_bridge.cpp" \
  -o "$HERE/zcode_ohos_process.node"

echo "built: $HERE/libzcode_pty.so $HERE/zcode_ohos_process.node"
