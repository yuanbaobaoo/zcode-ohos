#!/bin/sh
# 交叉编译 HMDFS link() 垫层（OHOS aarch64，规格见 specs/ohos-port/03）。
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

if [ ! -x "$SDK_CLANG" ]; then
  echo "OHOS SDK clang not found (set SDK_CLANG or OHOS_COMMAND_LINE_TOOLS_ROOT)" >&2
  exit 1
fi

"$SDK_CLANG" -target aarch64-linux-ohos -shared -fPIC -O2 \
  "$HERE/hmdfs_link_shim.c" -o "$HERE/libhmdfs_link_shim.so"

echo "built: $HERE/libhmdfs_link_shim.so"
