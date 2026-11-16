#!/bin/sh
# 交叉编译 ohos_asset_keyring.node（OHOS aarch64）：Asset Store 主密钥存取（spec 16）。
# 用法：packages/desktop/native/ohos-asset-keyring/build.sh
#
# 构建环境与 ohos-zcode-sqlite 相同：SDK clang 自动探测（harmonybrew / DEVECO_CLI_CLT_PATH），
# Node 头文件 NAPI 跨主版本稳定（NODE_INCLUDE 可覆盖）。
set -e
HERE=$(cd "$(dirname "$0")" && pwd)

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

if [ -z "$NODE_INCLUDE" ]; then
  NODE_INCLUDE="$(node -p process.env.NODE_INCLUDE || true)"
  if [ -z "$NODE_INCLUDE" ] || [ ! -f "$NODE_INCLUDE/node_api.h" ]; then
    NODE_INCLUDE="$(node -p 'require("path").dirname(process.execPath) + "/../include/node"' 2>/dev/null || true)"
  fi
fi

if [ ! -x "$SDK_CLANG" ]; then
  echo "OHOS SDK clang not found (set SDK_CLANG or DEVECO_CLI_CLT_PATH)" >&2
  exit 1
fi
if [ ! -f "$NODE_INCLUDE/node_api.h" ]; then
  echo "node headers not found at $NODE_INCLUDE (set NODE_INCLUDE)" >&2
  exit 1
fi

"$SDK_CLANG" \
  -target aarch64-linux-ohos \
  -shared -fPIC -O2 \
  -DNAPI_VERSION=8 \
  -I"$NODE_INCLUDE" \
  "$HERE/asset_keyring.c" \
  -lasset_ndk.z \
  -o "$HERE/ohos_asset_keyring.node"

echo "built: $HERE/ohos_asset_keyring.node"
