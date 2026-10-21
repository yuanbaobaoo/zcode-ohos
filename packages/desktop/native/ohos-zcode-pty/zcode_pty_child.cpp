// OHOS 原生子进程终端宿主（spec 09 §12.7）。
// appspawn 拉起本进程并调用 Main：连接父进程的 unix socket，接管 0/1/2 后 exec 成 shell。
// entryParams 行式协议：socketPath / shell / cwd / argv...
// 注意：appspawn 按名 dlopen 时不带 libc++_shared，这里禁用 C++ 标准库以消除运行时依赖。

#include <AbilityKit/native_child_process.h>

#include <cerrno>
#include <cstdlib>
#include <cstdio>
#include <cstring>

#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

namespace {

constexpr int kMaxArgs = 32;
constexpr int kMaxLine = 4096;

// 就地按 \n 切分 entryParams（可写缓冲），返回行数。
int splitLines(char *text, char **lines, int capacity) {
  int count = 0;
  lines[count++] = text;
  for (char *p = text; *p != '\0'; ++p) {
    if (*p == '\n') {
      *p = '\0';
      if (count < capacity) {
        lines[count++] = p + 1;
      } else {
        break;
      }
    }
  }
  return count;
}

int connectWithRetry(const char *socketPath) {
  // 父进程先 listen 再拉起本进程，正常首连即成功；短暂重试覆盖调度竞态。
  for (int attempt = 0; attempt < 100; ++attempt) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
      return -1;
    }
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, socketPath, sizeof(addr.sun_path) - 1);
    if (connect(fd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) == 0) {
      return fd;
    }
    close(fd);
    usleep(50 * 1000);
  }
  return -1;
}

}  // namespace

extern "C" __attribute__((visibility("default"))) void Main(NativeChildProcess_Args args) {
  if (args.entryParams == nullptr) {
    dprintf(STDERR_FILENO, "zcode-pty: missing entryParams\n");
    return;
  }
  char buffer[kMaxLine * kMaxArgs];
  std::strncpy(buffer, args.entryParams, sizeof(buffer) - 1);
  buffer[sizeof(buffer) - 1] = '\0';
  char *lines[kMaxArgs] = {nullptr};
  const int lineCount = splitLines(buffer, lines, kMaxArgs);
  if (lineCount < 3) {
    dprintf(STDERR_FILENO, "zcode-pty: malformed entryParams\n");
    return;
  }

  const char *socketPath = lines[0];
  const char *shell = lines[1];
  const char *cwd = lines[2];

  const int fd = connectWithRetry(socketPath);
  if (fd < 0) {
    dprintf(STDERR_FILENO, "zcode-pty: connect %s failed: %s\n", socketPath, std::strerror(errno));
    return;
  }
  dup2(fd, STDIN_FILENO);
  dup2(fd, STDOUT_FILENO);
  dup2(fd, STDERR_FILENO);
  if (fd > STDERR_FILENO) {
    close(fd);
  }
  if (cwd[0] != '\0' && chdir(cwd) != 0) {
    dprintf(STDERR_FILENO, "zcode-pty: chdir %s failed: %s\n", cwd, std::strerror(errno));
  }

  // 随包 zsh 的 ncursesw/tinfo 在同级 lib/；父进程 env 不带该路径，需显式补上。
  char libDir[1024];
  std::strncpy(libDir, shell, sizeof(libDir) - 1);
  libDir[sizeof(libDir) - 1] = '\0';
  char *slash = std::strrchr(libDir, '/');
  if (slash != nullptr) {
    *slash = '\0';
    char libPath[1200];
    std::snprintf(libPath, sizeof(libPath), "%s/lib", libDir);
    const char *existing = getenv("LD_LIBRARY_PATH");
    if (existing != nullptr && existing[0] != '\0') {
      char combined[2400];
      std::snprintf(combined, sizeof(combined), "%s:%s", libPath, existing);
      setenv("LD_LIBRARY_PATH", combined, 1);
    } else {
      setenv("LD_LIBRARY_PATH", libPath, 1);
    }
  }
  if (getenv("TERM") == nullptr) {
    setenv("TERM", "xterm-256color", 1);
  }

  char *argv[kMaxArgs + 1] = {nullptr};
  argv[0] = const_cast<char *>(shell);
  int argCount = 1;
  for (int i = 3; i < lineCount && argCount < kMaxArgs; ++i) {
    argv[argCount++] = lines[i];
  }

  execv(shell, argv);
  dprintf(STDERR_FILENO, "zcode-pty: exec %s failed: %s\n", shell, std::strerror(errno));

  // 随包 zsh 在 resfile（el1 noexec）无法 exec（spec 02）；HAP libs 可执行，
  // 打包时把同一二进制镜像为 libzsh.so 作为首选回退，最后退回系统 sh。
  argv[0] = const_cast<char *>("/data/storage/el1/bundle/libs/arm64/libzsh.so");
  execv(argv[0], argv);
  argv[0] = const_cast<char *>("/bin/sh");
  execv(argv[0], argv);
  dprintf(STDERR_FILENO, "zcode-pty: fallback shells unavailable: %s\n", std::strerror(errno));
}
