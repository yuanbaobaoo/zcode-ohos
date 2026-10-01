/*
 * libhmdfs_link_shim.so —— HMDFS link() 垫层：用户存储禁止硬链接（EPERM），而
 * pnpm hoisted 布局依赖硬链接去重。安装期间 LD_PRELOAD 本库把 link()/linkat()
 * 降级为 symlink()（Node 解析器跟随软链，语义等价）。
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
