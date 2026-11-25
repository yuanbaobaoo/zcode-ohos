#!/bin/sh
# 交叉编译 OHOS exec shim（LD_PRELOAD 注入，改写缺失解释器的 shebang 脚本）的 POSIX / CI 入口。
# 产物：libzcode_exec_shim.so（HAP libs/arm64，规格见 specs/ohos-port/03）。
# 编译参数在 packages/desktop/scripts/build-ohos-native.mjs 内单点维护。
# 用法：packages/desktop/native/ohos-exec-shim/build.sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd)

exec node "$HERE/../../scripts/build-ohos-native.mjs" --target exec-shim
