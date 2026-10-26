#!/usr/bin/env node
// 构建期二进制补丁：禁用 libelectron.so 内嵌 libuv 的 io_uring（HarmonyOS 7 seccomp 白名单
// 不含 syscall 425，首次异步 IO 即 SIGSYS；NodeService 不继承 env，只能构建期改字节）。
// 纯 Node、幂等。用法：node ohos-patch-libelectron.mjs [libelectron.so]。
//
// 定位方式（2026-10 改为动态锚定）：旧版硬编码了 getenv("UV_USE_IO_URING") xref 的
// adrp/add 指令字节，该编码随字符串地址漂移，换构建即失配。现改为：
//   1. 找到 "UV_USE_IO_URING" 字符串的虚拟地址；
//   2. 反查所有 adrp x0,page(str) + add x0,x0,#pageoff 的代码引用（两个：init 与
//      is_using_io_uring）；
//   3. 在引用后的固定窗口内找目标指令。
// 已在 34.5.4-20250918.1 与 2026-10 新构建（npm electron-ohos-runtime 1.0.0）上验证，
// 两处补丁点相对引用的偏移在两版间一致（A: +0x28，B: +0x2c）。

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_PATH = resolve(import.meta.dirname, "../ohos/entry/libs/arm64-v8a/libelectron.so");

const NEEDLE = Buffer.from("UV_USE_IO_URING\0", "binary");

// 小端 uint32 指令编码（与原 python 版 struct.pack("<I") 逐字节一致）
function instruction(word) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(word >>> 0);
  return buffer;
}
// A：io_uring 初始化分支——b.lt +0x20c（条件跳过 init）→ b +0x20c（无条件跳过）
const PATCH_A_OLD = instruction(0x5400106b);
const PATCH_A_NEW = instruction(0x14000083);
// B：is_using_io_uring 的返回值——cset w0, gt → mov w0, wzr（恒返回 false）
const PATCH_B_OLD = instruction(0x1a9fd7e0);
const PATCH_B_NEW = instruction(0x2a1f03e0);

// PT_LOAD 段表：vaddr ↔ fileoff
function loadSegments(data) {
  const ePhoff = Number(data.readBigUInt64LE(0x20));
  const ePhentsize = data.readUInt16LE(0x36);
  const ePhnum = data.readUInt16LE(0x38);
  const segs = [];
  for (let i = 0; i < ePhnum; i++) {
    const off = ePhoff + i * ePhentsize;
    const pType = data.readUInt32LE(off);
    if (pType !== 1) continue;
    segs.push({
      offset: Number(data.readBigUInt64LE(off + 0x08)),
      vaddr: Number(data.readBigUInt64LE(off + 0x10)),
      filesz: Number(data.readBigUInt64LE(off + 0x20)),
      exec: (data.readUInt32LE(off + 0x04) & 1) !== 0,
    });
  }
  return segs;
}

function offToVaddr(segs, off) {
  for (const s of segs) {
    if (s.offset <= off && off < s.offset + s.filesz) return s.vaddr + (off - s.offset);
  }
  return null;
}

function vaddrToOff(segs, va) {
  for (const s of segs) {
    if (s.vaddr <= va && va < s.vaddr + s.filesz) return s.offset + (va - s.vaddr);
  }
  return null;
}

// 找全部 adrp x0,page(needle) + add x0,x0,#pageoff 引用，按地址升序
function findStringXrefs(data, segs, needleVa) {
  const targetPage = needleVa & ~0xfff;
  const pageoff = needleVa & 0xfff;
  const refs = [];
  for (const s of segs) {
    if (!s.exec) continue;
    for (let o = s.offset; o < s.offset + s.filesz - 8; o += 4) {
      const w = data.readUInt32LE(o);
      // JS 位运算结果是 32 位有符号数，与字面量比较前必须 >>> 0 归一为无符号
      if ((w & 0x9f000000) >>> 0 !== 0x90000000) continue; // adrp
      const rd = w & 31;
      if (rd !== 0) continue;
      const immlo = (w >>> 29) & 3;
      const immhi = (w >>> 5) & 0x7ffff;
      let imm = (immhi << 2) | immlo;
      if (imm & (1 << 20)) imm -= 1 << 21;
      const pc = s.vaddr + (o - s.offset);
      // 注意用乘法而非 << 12：JS 位移是 32 位有符号运算，高位立即数会溢出
      if (Math.floor(pc / 0x1000) * 0x1000 + imm * 0x1000 !== targetPage) continue;
      const w2 = data.readUInt32LE(o + 4);
      if ((w2 & 0x7f000000) >>> 0 !== 0x11000000) continue; // add (imm) 64
      if (((w2 >>> 5) & 31) !== 0 || (w2 & 31) !== 0) continue;
      if (((w2 >>> 10) & 0xfff) !== pageoff) continue;
      refs.push(pc);
    }
  }
  return refs.sort((a, b) => a - b);
}

// 在 [startVa, startVa+span) 窗口内找 oldInstr；找不到时幂等检查 newInstr
function patchAt(data, segs, startVa, span, oldInstr, newInstr, label) {
  const start = vaddrToOff(segs, startVa);
  if (start === null) throw new Error(`${label}: vaddr 0x${startVa.toString(16)} 不可映射`);
  const window = data.subarray(start, start + span);
  const idxNew = window.indexOf(newInstr);
  if (idxNew !== -1) {
    console.log(
      `[io-uring-patch] ${label}: 已是补丁后指令 @fileoff 0x${(start + idxNew).toString(16)}，跳过`,
    );
    return false;
  }
  const idx = window.indexOf(oldInstr);
  if (idx === -1) {
    throw new Error(`${label}: 目标指令未在锚点窗口内找到（libelectron 版本结构变更）`);
  }
  newInstr.copy(data, start + idx);
  console.log(`[io-uring-patch] ${label}: patched @fileoff 0x${(start + idx).toString(16)}`);
  return true;
}

function main() {
  const path = process.argv[2] ?? DEFAULT_PATH;
  const data = readFileSync(path);
  const segs = loadSegments(data);

  const strOff = data.indexOf(NEEDLE);
  if (strOff < 0) {
    // Node 24 内嵌 libuv 已整体移除 io_uring（上游安全决策），v40 基线起没有该功能
    // 也没有 seccomp SIGSYS 风险——补丁按跳过处理，不算版本失配。
    console.log(
      `[io-uring-patch] ${path.split("/").pop()}: UV_USE_IO_URING 不存在（Node 24+ libuv 已移除 io_uring），无需补丁，跳过`,
    );
    return;
  }
  const strVa = offToVaddr(segs, strOff);
  if (strVa === null) throw new Error("字符串地址无法映射到 LOAD 段");

  const refs = findStringXrefs(data, segs, strVa);
  if (refs.length < 2) {
    throw new Error(
      `getenv(UV_USE_IO_URING) xref 不足（找到 ${refs.length} 处）— libelectron 版本结构变更`,
    );
  }
  const first = refs[0]; // is_using_io_uring（cset w0,gt 返回值）
  const last = refs[refs.length - 1]; // init（b.lt 跳过初始化）

  const patchedB = patchAt(
    data,
    segs,
    first,
    0x60,
    PATCH_B_OLD,
    PATCH_B_NEW,
    "B(is_using_io_uring)",
  );
  const patchedA = patchAt(data, segs, last, 0x80, PATCH_A_OLD, PATCH_A_NEW, "A(io_uring init)");
  if (!patchedA && !patchedB) {
    console.log(`[io-uring-patch] ${path.split("/").pop()}: already patched, skipping`);
    return;
  }
  writeFileSync(path, data);
}

main();
