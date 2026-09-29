/*
 * libhmdfs_link_shim.so —— HMDFS link() 兼容垫层。
 *
 * 背景：HarmonyOS 用户存储（HMDFS）禁止硬链接（link(2) 返回 EPERM），但允许
 * 符号链接。pnpm 的 hoisted 布局在嵌套 node_modules 之间用硬链接去重，导致
 * `pnpm install` 在鸿蒙本机必然失败（ERR_PNPM_EPERM）。
 *
 * 用法：仅在安装命令期间预加载，把进程内的 link() 等价降级为 symlink()——
 * 对 node_modules 的解析语义完全一致（Node 解析器跟随软链）：
 *   LD_PRELOAD=/path/to/libhmdfs_link_shim.so pnpm install ...
 *
 * 构建：ohos/native/hmdfs-link-shim/build.sh（OHOS SDK clang）。
 */

#include <unistd.h>

int link(const char *oldpath, const char *newpath) {
  return symlink(oldpath, newpath);
}

int linkat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, int flags) {
  (void)olddirfd;
  (void)newdirfd;
  (void)flags;
  return symlink(oldpath, newpath);
}
