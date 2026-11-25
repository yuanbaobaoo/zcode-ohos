#!/bin/sh
# 交叉编译 ohos_asset_keyring.node（OHOS aarch64）的 POSIX / CI 入口：Asset Store 主密钥存取
# （spec 16）。编译参数在 packages/desktop/scripts/build-ohos-native.mjs 内单点维护，
# Windows 下由该脚本直调 clang.exe（本脚本不参与 Windows 构建）。
# 用法：packages/desktop/native/ohos-asset-keyring/build.sh
set -e
HERE=$(cd "$(dirname "$0")" && pwd)

exec node "$HERE/../../scripts/build-ohos-native.mjs" --target asset-keyring
