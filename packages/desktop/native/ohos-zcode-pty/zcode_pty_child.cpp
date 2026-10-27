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

constexpr int kMaxArgs = 64;
// 行容量要覆盖整段 env（PATH/快照键数量随用户 rc 增长），不能按 argv 上限算。
constexpr int kMaxLines = 512;
constexpr size_t kMaxEntryBytes = 256 * 1024;

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

void prependLibraryPath(const char *dir) {
  if (dir == nullptr || dir[0] == '\0') {
    return;
  }
  const char *existing = getenv("LD_LIBRARY_PATH");
  if (existing != nullptr && existing[0] != '\0') {
    char combined[2400];
    std::snprintf(combined, sizeof(combined), "%s:%s", dir, existing);
    setenv("LD_LIBRARY_PATH", combined, 1);
  } else {
    setenv("LD_LIBRARY_PATH", dir, 1);
  }
}

// <shell 所在目录>/lib（随包 zsh 的依赖库布局）。返回静态缓冲，供紧随的 exec 使用。
const char *siblingLibDir(const char *shell) {
  static char out[1300];
  char dir[1024];
  std::strncpy(dir, shell, sizeof(dir) - 1);
  dir[sizeof(dir) - 1] = '\0';
  char *slash = std::strrchr(dir, '/');
  if (slash == nullptr) {
    out[0] = '\0';
    return out;
  }
  *slash = '\0';
  std::snprintf(out, sizeof(out), "%s/lib", dir);
  return out;
}

void execAttempt(const char *path, char **argv, const char *libDir) {
  prependLibraryPath(libDir);
  argv[0] = const_cast<char *>(path);
  execv(path, argv);
  dprintf(STDERR_FILENO, "zcode-pty: exec %s failed: %s\n", path, std::strerror(errno));
}

}  // namespace

extern "C" __attribute__((visibility("default"))) void Main(NativeChildProcess_Args args) {
  if (args.entryParams == nullptr) {
    dprintf(STDERR_FILENO, "zcode-pty: missing entryParams\n");
    return;
  }
  static char buffer[kMaxEntryBytes];
  std::strncpy(buffer, args.entryParams, sizeof(buffer) - 1);
  buffer[sizeof(buffer) - 1] = '\0';
  char *lines[kMaxLines] = {nullptr};
  const int lineCount = splitLines(buffer, lines, kMaxLines);
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

  // env 段：marker 之后每行 K=V，由 relay 下发 host 的终端 env（PATH/LD_PRELOAD/
  // HOMEBREW_* 等）。本进程不继承 host env（appspawn env 隔离），必须在 exec 前应用。
  static const char kEnvMarker[] = "@@ZCODE_ENV@@";
  int argvEnd = lineCount;
  for (int i = 3; i < lineCount; ++i) {
    if (std::strcmp(lines[i], kEnvMarker) != 0) {
      continue;
    }
    argvEnd = i;
    for (int j = i + 1; j < lineCount; ++j) {
      char *entry = lines[j];
      char *eq = std::strchr(entry, '=');
      if (eq == nullptr || eq == entry) {
        continue;
      }
      *eq = '\0';
      setenv(entry, eq + 1, 1);
    }
    break;
  }

  if (getenv("PATH") == nullptr || getenv("PATH")[0] == '\0') {
    setenv("PATH", "/usr/local/bin:/bin:/usr/bin", 1);
  }
  if (getenv("TERM") == nullptr) {
    setenv("TERM", "xterm-256color", 1);
  }
  setenv("SHELL", shell, 1);

  char *argv[kMaxArgs + 1] = {nullptr};
  int argCount = 0;
  for (int i = 3; i < argvEnd && argCount < kMaxArgs; ++i) {
    argv[argCount++] = lines[i];
  }

  // 每次尝试前把 lib 目录前置到 LD_LIBRARY_PATH：随包 zsh 的 ncursesw/tinfo 在同级
  // lib/，主进程视图的提示路径在子进程内可能不可 exec，回退 shell 需要自己的 lib 目录。
  execAttempt(shell, argv, siblingLibDir(shell));
  const char *fallbackShell = getenv("ZCODE_OHOS_FALLBACK_SHELL");
  if (fallbackShell != nullptr && fallbackShell[0] != '\0' &&
      std::strcmp(fallbackShell, shell) != 0) {
    execAttempt(fallbackShell, argv, getenv("ZCODE_OHOS_FALLBACK_SHELL_LIB"));
  }
  execAttempt("/bin/sh", argv, nullptr);
  dprintf(STDERR_FILENO, "zcode-pty: fallback shells unavailable: %s\n", std::strerror(errno));
}
