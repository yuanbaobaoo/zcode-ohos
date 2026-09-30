#!/bin/sh
# VM 内一键：同步源码 → 重建（跳过 agent）→ 把 app 产物回写宿主仓库 resfile
set -e
SHARE=/mnt/linux_share/storage/Users/currentUser/codes/personal/ZCode-ohos
export PATH="$HOME/node-v24.14.0-linux-arm64/bin:$PATH"

# OHOS 工程已并入 packages/desktop/ohos：整树打包 packages 时排除运行时大文件
# （electron/web_engine 的 .so 与产物、hnp 构建缓存），其余（src/scripts/native/
# app-assets/hvigor 配置）增量同步。
cd "$SHARE" && tar cf - --exclude=node_modules --exclude='packages/desktop/ohos/electron' --exclude='packages/desktop/ohos/web_engine' --exclude='packages/desktop/ohos/hnp' --exclude='packages/desktop/ohos/oh_modules' --exclude='packages/desktop/dist' --exclude='packages/desktop/out' packages apps/zcode-cli pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc | (cd ~/zcode && tar xf -)
cd ~/zcode
node packages/desktop/scripts/build-ohos.mjs --skip-agent > ~/build4.log 2>&1 || { echo BUILD_FAILED >> ~/build4.log; tail -5 ~/build4.log; exit 1; }

RESFILE=packages/desktop/ohos/web_engine/src/main/resources/resfile/resources
cd ~/zcode/$RESFILE
mkdir -p "$SHARE/$RESFILE"
# 先清空宿主 app 目录再回写：tar 只覆盖不删除，残留的旧 chunk 会被运行时误加载
rm -rf "$SHARE/$RESFILE/app"
tar cf - app config glm | (cd "$SHARE/$RESFILE" && tar xf -)
# sqlite 模块同时进 HAP libs（host 进程 .node require 重定向到 bundle libs）
cp ~/zcode/packages/desktop/native/ohos-zcode-sqlite/zcode_sqlite.node "$SHARE/packages/desktop/ohos/electron/libs/arm64-v8a/zcode_sqlite.node" 2>/dev/null || cp "$SHARE/packages/desktop/native/ohos-zcode-sqlite/zcode_sqlite.node" "$SHARE/packages/desktop/ohos/electron/libs/arm64-v8a/zcode_sqlite.node"
echo SYNC_DONE > ~/resync.status
