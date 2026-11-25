#!/bin/sh
# 交叉编译 zcode_sqlite.node（OHOS aarch64）的 POSIX / CI 入口。
# 编译逻辑与参数已收敛到 packages/desktop/scripts/build-ohos-native.mjs：Windows 直调
# clang.exe、POSIX 用 CLT 目标包装器，两边共用同一份参数，避免各自漂移。
# 用法：packages/desktop/native/ohos-zcode-sqlite/build.sh [sqlite3.c 所在目录]
#
# 构建环境：SDK clang 自动探测（harmonybrew 本机 / DEVECO_CLI_CLT_PATH / PATH 反推）；
# Node 头文件与 sqlite 融合源由 ohos-native-deps.mjs 取到 packages/desktop/.cache/，
# 也可用位置参数显式指定融合源；无需 DevEco Studio。
set -e
HERE=$(cd "$(dirname "$0")" && pwd)

if [ -n "$1" ]; then
  exec node "$HERE/../../scripts/build-ohos-native.mjs" --target sqlite --sqlite-src "$1"
fi
exec node "$HERE/../../scripts/build-ohos-native.mjs" --target sqlite
