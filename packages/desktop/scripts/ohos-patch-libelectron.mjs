#!/usr/bin/env node
// 构建期二进制补丁：禁用 libelectron.so 内嵌 libuv 的 io_uring。
//
// 背景（2026-09-29 真机实证）：
//   HarmonyOS 7 的 seccomp 白名单不含 io_uring（syscall 425 = io_uring_setup）。
//   libelectron（Node 20.18）的 libuv 在首次符合条件的异步文件 IO 时按需初始化
//   io_uring，任何线程触发即被 SIGSYS 击杀整进程（NodeService 崩溃链：sendText →
//   transcript/queue 写 → io_uring_setup → SIGSYS）。
//
//   libuv 读取 UV_USE_IO_URING 的时机在 native 层（uv__node_patch_is_using_io_uring /
//   uv__iou 初始化），NodeService 由 appspawn 直接拉起、不继承 main 的 process.env
//   （实测 env-at-entry 全 undefined），JS 侧无任何注入通道。
//
// 补丁（4 字节 × 2，全部按内容定位 + 断言，不匹配即失败退出）：
//   A) uv loop 初始化路径的 io_uring 分支（0x983e258 附近，b.lt → b 无条件跳过）
//   B) uv__node_patch_is_using_io_uring 返回值（cset w0,gt → mov w0,wzr 恒 0）
//
// 纯 Node 实现（原为 python3 脚本）：仓库工具链已强制 Node，字节级搜索/改写用
// Buffer 即可，不再为单个构建步骤引入额外解释器依赖。
//
// 用法：node packages/desktop/scripts/ohos-patch-libelectron.mjs [libelectron.so 路径]
//      （默认 packages/desktop/ohos/electron/libs/arm64-v8a/libelectron.so；重复执行幂等）
//
// 注意：libelectron.so 不入库（>100MB），由 fetch-ohos-libelectron.mjs 从镜像取回后执行本补丁再组装 HAP。

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_PATH = resolve(import.meta.dirname, "../ohos/electron/libs/arm64-v8a/libelectron.so");

// 补丁 A：io_uring 初始化分支。定位锚：adrp x23→flag 页 后的 str/cmp/b.lt 序列。
// 直接按「指令内容」在 init 函数（含 getenv(UV_USE_IO_URING) 的第二 xref）附近找。
// 两处 xref 共同前缀：adrp x0,<str页>; add x0,#0xcd8（bl getenv 的偏移随位置不同，不进锚）
const ANCHOR_A = Buffer.from("60cbfbf000603391", "hex");

// 小端 uint32 指令编码的搜索/替换对（与原 python 版 struct.pack("<I") 逐字节一致）
function instruction(word) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(word, 0);
  return buffer;
}
const PATCH_A_OLD = instruction(0x5400106b); // b.lt +0x20c（跳过 io_uring init）
const PATCH_A_NEW = instruction(0x14000083); // b    +0x20c（无条件跳过）
const PATCH_B_OLD = instruction(0x1a9fd7e0); // cset w0, gt
const PATCH_B_NEW = instruction(0x2a1f03e0); // mov  w0, wzr

function main() {
  const path = process.argv[2] ?? DEFAULT_PATH;
  const data = readFileSync(path);

  // 锚点定位（先于幂等判断，二者共用）：取最后一处出现（getenv 的第二 xref）。
  let anchor = -1;
  for (let pos = 0; ; ) {
    const idx = data.indexOf(ANCHOR_A, pos);
    if (idx < 0) break;
    anchor = idx;
    pos = idx + 1;
  }
  if (anchor < 0) {
    throw new Error("getenv(UV_USE_IO_URING) anchor not found — libelectron version mismatch");
  }

  const windowStart = anchor + 0x14;
  const windowEnd = windowStart + 0x80;
  // 幂等：目标位置已是新指令则退出（b 与 mov 编码常见，须在锚点窗口内判定）。
  const patchedA = data.indexOf(PATCH_A_NEW, windowStart);
  if (patchedA !== -1 && patchedA < windowEnd) {
    console.log(`[io-uring-patch] ${path.split("/").pop()}: already patched, skipping`);
    return;
  }

  const idxA = data.indexOf(PATCH_A_OLD, windowStart);
  if (idxA === -1 || idxA >= windowEnd) {
    throw new Error("patch-A site (b.lt after flag cmp) not found");
  }
  PATCH_A_NEW.copy(data, idxA);

  // B 的锚：同一 adrp 常量出现在 is_using_io_uring 函数（更早的 xref），cset 在其后。
  // 全文找第二处 cset w0,gt 且前面 0x60 字节内含同串 adrp。
  let foundB = -1;
  for (let pos = 0; foundB === -1; ) {
    const idx = data.indexOf(PATCH_B_OLD, pos);
    if (idx < 0) break;
    const context = data.subarray(Math.max(0, idx - 0x60), idx);
    if (context.includes(ANCHOR_A)) {
      foundB = idx;
      break;
    }
    pos = idx + 4;
  }
  if (foundB === -1) {
    throw new Error("patch-B site (cset w0,gt after adrp) not found");
  }
  PATCH_B_NEW.copy(data, foundB);

  writeFileSync(path, data);
  console.log(
    `[io-uring-patch] ${path.split("/").pop()}: patched A@fileoff 0x${idxA.toString(16)}, B@fileoff 0x${foundB.toString(16)}`,
  );
}

main();
