/*
  * libhmdfs_link_shim.so —— HMDFS 禁硬链接（EPERM）而 pnpm hoisted 依赖 link() 去重；
  * LD_PRELOAD 本库把 link()/linkat() 降级为 symlink()（Node 解析器跟随软链，语义等价）。
  * 构建：同目录 build.sh（OHOS SDK clang）。
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
