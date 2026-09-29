#!/bin/sh
# 交叉编译 HMDFS link() 垫层（OHOS aarch64）。
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SDK_CLANG="$HOME/.harmonybrew/opt/ohos-sdk/native/llvm/bin/aarch64-unknown-linux-ohos-clang"

"$SDK_CLANG" -target aarch64-linux-ohos -shared -fPIC -O2 \
  "$HERE/hmdfs_link_shim.c" -o "$HERE/libhmdfs_link_shim.so"

echo "built: $HERE/libhmdfs_link_shim.so"
