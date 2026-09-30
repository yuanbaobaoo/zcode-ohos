#!/bin/sh
# 鸿蒙本机安装仓库依赖（HMDFS 禁硬链接，pnpm hoisted 嵌套链接会 EPERM）。
# 通过 LD_PRELOAD 把进程内 link() 降级为 symlink()（HMDFS 支持软链，Node 解析
# 语义一致），仅作用于本命令，不改变系统行为。
#
# 用法：sh packages/desktop/ohos/scripts/host-install.sh   （在仓库根目录执行）
set -e
REPO_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
SHIM="$REPO_ROOT/packages/desktop/native/ohos-hmdfs-link-shim/libhmdfs_link_shim.so"

if [ ! -f "$SHIM" ]; then
  echo "building hmdfs link shim..." >&2
  sh "$REPO_ROOT/packages/desktop/native/ohos-hmdfs-link-shim/build.sh" >&2
  chmod 770 "$SHIM"
fi

cd "$REPO_ROOT"
export PATH="$HOME/.harmonybrew/bin:$PATH"
exec env \
  ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
  PUPPETEER_SKIP_DOWNLOAD=1 \
  npm_config_package_import_method=copy \
  LD_PRELOAD="$SHIM" \
  pnpm install --ignore-scripts "$@"
