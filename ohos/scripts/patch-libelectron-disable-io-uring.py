#!/usr/bin/env python3
"""构建期二进制补丁：禁用 libelectron.so 内嵌 libuv 的 io_uring。

背景（2026-09-29 真机实证）：
  HarmonyOS 7 的 seccomp 白名单不含 io_uring（syscall 425 = io_uring_setup）。
  libelectron（Node 20.18）的 libuv 在首次符合条件的异步文件 IO 时按需初始化
  io_uring，任何线程触发即被 SIGSYS 击杀整进程（NodeService 崩溃链：sendText →
  transcript/queue 写 → io_uring_setup → SIGSYS）。

  libuv 读取 UV_USE_IO_URING 的时机在 native 层（uv__node_patch_is_using_io_uring /
  uv__iou 初始化），NodeService 由 appspawn 直接拉起、不继承 main 的 process.env
  （实测 env-at-entry 全 undefined），JS 侧无任何注入通道。

补丁（4 字节 × 2，全部按内容定位 + 断言，不匹配即失败退出）：
  A) uv loop 初始化路径的 io_uring 分支（0x983e258 附近，b.lt → b 无条件跳过）
  B) uv__node_patch_is_using_io_uring 返回值（cset w0,gt → mov w0,wzr 恒 0）

用法：python3 ohos/scripts/patch-libelectron-disable-io-uring.py [libelectron.so 路径]
     （默认 ohos/electron/libs/arm64-v8a/libelectron.so；重复执行幂等）

注意：libelectron.so 不入库（>100MB），从旧仓 git-lfs 取回后执行本补丁再组装 HAP。
"""

import struct
import sys
from pathlib import Path

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "electron/libs/arm64-v8a/libelectron.so"

# .text 段 vaddr = fileoff + 0x1000（该 .so 的 exec LOAD 段映射，ELF 头解析可验证）
TEXT_VADDR_DELTA = 0x1000

# 补丁 A：io_uring 初始化分支。定位锚：adrp x23→flag 页 后的 str/cmp/b.lt 序列。
# 直接按「指令内容」在 init 函数（含 getenv(UV_USE_IO_URING) 的第二 xref）附近找。
# 两处 xref 共同前缀：adrp x0,<str页>; add x0,#0xcd8（bl getenv 的偏移随位置不同，不进锚）
ANCHOR_A = bytes.fromhex("60cbfbf000603391")
PATCH_A_OLD = struct.pack("<I", 0x5400106B)            # b.lt +0x20c（跳过 io_uring init）
PATCH_A_NEW = struct.pack("<I", 0x14000083)            # b    +0x20c（无条件跳过）

# 补丁 B：uv__node_patch_is_using_io_uring 的返回值
PATCH_B_OLD = struct.pack("<I", 0x1A9FD7E0)            # cset w0, gt
PATCH_B_NEW = struct.pack("<I", 0x2A1F03E0)            # mov  w0, wzr


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PATH
    data = bytearray(path.read_bytes())

    # 锚点定位（先于幂等判断，二者共用）
    anchor = -1
    pos = 0
    while True:
        idx = data.find(ANCHOR_A, pos)
        if idx < 0:
            break
        anchor = idx
        pos = idx + 1
    assert anchor >= 0, "getenv(UV_USE_IO_URING) anchor not found — libelectron version mismatch"

    window_start = anchor + 0x14
    window = bytes(data[window_start : window_start + 0x80])
    # 幂等：目标位置已是新指令则退出（b 与 mov 编码常见，须在锚点窗口内判定）。
    if PATCH_A_NEW in window:
        print(f"[io-uring-patch] {path.name}: already patched, skipping")
        return 0

    idx_a = data.find(PATCH_A_OLD, window_start, window_start + 0x80)
    assert idx_a >= 0, "patch-A site (b.lt after flag cmp) not found"
    data[idx_a : idx_a + 4] = PATCH_A_NEW

    # B 的锚：同一 adrp 常量出现在 is_using_io_uring 函数（更早的 xref），cset 在其后。
    # 全文找第二处 cset w0,gt 且前面 0x60 字节内含同串 adrp。
    pos = 0
    found_b = -1
    while True:
        idx = data.find(PATCH_B_OLD, pos)
        if idx < 0:
            break
        ctx = data[max(0, idx - 0x60) : idx]
        if ANCHOR_A in ctx:
            found_b = idx
            break
        pos = idx + 4
    assert found_b >= 0, "patch-B site (cset w0,gt after adrp) not found"
    data[found_b : found_b + 4] = PATCH_B_NEW

    path.write_bytes(bytes(data))
    print(f"[io-uring-patch] {path.name}: patched A@fileoff 0x{idx_a:x}, B@fileoff 0x{found_b:x}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
