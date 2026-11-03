#!/bin/sh
# 交叉编译 OHOS exec shim（LD_PRELOAD 注入，改写缺失解释器的 shebang 脚本）。
# 产物：libzcode_exec_shim.so（HAP libs/arm64，规格见 specs/ohos-port/03）。
# 用法：packages/desktop/native/ohos-exec-shim/build.sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd)

# clang 探测与主构建同策略（ohos-env.mjs 候选链）：harmonybrew（设备端构建的唯一来源）
# > DEVECO_CLI_CLT_PATH（devecocli 标准变量；CLT 经 PATH 发现时由 build-ohos.mjs 传入）；
# 不做 ~/command-line-tools 等机器路径猜测。
if [ -z "$SDK_CLANG" ]; then
  for candidate in \
    "$HOME/.harmonybrew/opt/ohos-sdk/native/llvm/bin/aarch64-unknown-linux-ohos-clang" \
    "$DEVECO_CLI_CLT_PATH/sdk/default/openharmony/native/llvm/bin/aarch64-unknown-linux-ohos-clang"
  do
    if [ -x "$candidate" ]; then
      SDK_CLANG="$candidate"
      break
    fi
  done
fi

if [ ! -x "$SDK_CLANG" ]; then
  echo "OHOS SDK clang not found (set SDK_CLANG or DEVECO_CLI_CLT_PATH)" >&2
  exit 1
fi

"$SDK_CLANG" -target aarch64-linux-ohos -shared -fPIC -O2 \
  "$HERE/exec_shim.c" \
  -o "$HERE/libzcode_exec_shim.so"