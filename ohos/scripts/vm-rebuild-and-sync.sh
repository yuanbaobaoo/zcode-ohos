#!/bin/sh
# VM 内一键：同步源码 → 重建（跳过 agent）→ 把 app 产物回写宿主仓库 resfile
set -e
SHARE=/mnt/linux_share/storage/Users/currentUser/codes/personal/ZCode-ohos
export PATH="$HOME/node-v24.14.0-linux-arm64/bin:$PATH"

cd "$SHARE" && tar cf - --exclude=node_modules packages apps/zcode-cli packages/desktop/src scripts ohos/native ohos/app-assets pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc | (cd ~/zcode && tar xf -)
cd ~/zcode
node scripts/build-ohos.mjs --skip-agent > ~/build4.log 2>&1 || { echo BUILD_FAILED >> ~/build4.log; tail -5 ~/build4.log; exit 1; }

cd ~/zcode/ohos/web_engine/src/main/resources/resfile/resources
mkdir -p "$SHARE/ohos/web_engine/src/main/resources/resfile/resources"
# 先清空宿主 app 目录再回写：tar 只覆盖不删除，残留的旧 chunk 会被运行时误加载
rm -rf "$SHARE/ohos/web_engine/src/main/resources/resfile/resources/app"
tar cf - app config glm | (cd "$SHARE/ohos/web_engine/src/main/resources/resfile/resources" && tar xf -)
# sqlite 模块同时进 HAP libs（host 进程 .node require 重定向到 bundle libs）
cp ~/zcode/ohos/native/zcode-sqlite/zcode_sqlite.node "$SHARE/ohos/electron/libs/arm64-v8a/zcode_sqlite.node" 2>/dev/null || cp "$SHARE/ohos/native/zcode-sqlite/zcode_sqlite.node" "$SHARE/ohos/electron/libs/arm64-v8a/zcode_sqlite.node"
echo SYNC_DONE > ~/resync.status
