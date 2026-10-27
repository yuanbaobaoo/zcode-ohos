// OHOS agent 命令无缝化：内核按 shebang 执行脚本时，缺失的解释器路径（/usr/bin/env 等）
// 在内核阶段就 ENOENT。本 shim 由 LD_PRELOAD 注入，在 exec 出口把这类脚本改写为
// /bin/env <命令> <脚本>，交给 PATH 解析（brew/npm 命令因此可见）。机制见 specs/ohos-port/03。
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define INTERP_MAX 256
#define ARGS_MAX 32
#define CACHE_MAX 16
#define PATH_BUF 4096

extern char **environ;

typedef int (*execve_fn)(const char *, char *const[], char *const[]);
typedef int (*execv_fn)(const char *, char *const[]);
typedef int (*execvp_fn)(const char *, char *const[]);
typedef int (*execvpe_fn)(const char *, char *const[], char *const[]);
typedef int (*spawn_fn)(pid_t *, const char *, const posix_spawn_file_actions_t *,
                        const posix_spawnattr_t *, char *const[], char *const[]);

static execve_fn real_execve;
static execv_fn real_execv;
static execvp_fn real_execvp;
static execvpe_fn real_execvpe;
static spawn_fn real_posix_spawn;
static spawn_fn real_posix_spawnp;

static void init_real(void) {
  if (!real_execve) real_execve = (execve_fn)dlsym(RTLD_NEXT, "execve");
  if (!real_execv) real_execv = (execv_fn)dlsym(RTLD_NEXT, "execv");
  if (!real_execvp) real_execvp = (execvp_fn)dlsym(RTLD_NEXT, "execvp");
  if (!real_execvpe) real_execvpe = (execvpe_fn)dlsym(RTLD_NEXT, "execvpe");
  if (!real_posix_spawn) real_posix_spawn = (spawn_fn)dlsym(RTLD_NEXT, "posix_spawn");
  if (!real_posix_spawnp) real_posix_spawnp = (spawn_fn)dlsym(RTLD_NEXT, "posix_spawnp");
}

static int file_exists(const char *path) { return access(path, F_OK) == 0; }

static const char *path_value(char *const envp[]) {
  if (!envp) return NULL;
  for (size_t i = 0; envp[i]; i++) {
    if (strncmp(envp[i], "PATH=", 5) == 0) return envp[i] + 5;
  }
  return NULL;
}

// PATH 查找（execvp/posix_spawnp 语义），命中写入 out 并返回 out，否则 NULL。
static char *resolve_in_path(const char *file, char *const envp[], char out[PATH_BUF]) {
  if (strchr(file, '/')) {
    if (!file_exists(file)) return NULL;
    strncpy(out, file, PATH_BUF - 1);
    out[PATH_BUF - 1] = 0;
    return out;
  }
  const char *path = path_value(envp);
  if (!path) return NULL;
  const char *seg = path;
  while (*seg) {
    const char *colon = strchr(seg, ':');
    size_t segLen = colon ? (size_t)(colon - seg) : strlen(seg);
    const char *dir = segLen ? seg : ".";
    size_t dirLen = segLen ? segLen : 1;
    if (dirLen + 1 + strlen(file) < PATH_BUF) {
      memcpy(out, dir, dirLen);
      out[dirLen] = '/';
      strcpy(out + dirLen + 1, file);
      if (file_exists(out)) return out;
    }
    if (!colon) break;
    seg = colon + 1;
  }
  return NULL;
}

typedef struct {
  char path[INTERP_MAX];
  int rewrite; // 1=改写为 /bin/env，0=顺其自然
} interp_cache_t;

static interp_cache_t g_cache[CACHE_MAX];
static int g_cache_len;

static int cached_decision(const char *interp, int *found) {
  for (int i = 0; i < g_cache_len; i++) {
    if (strcmp(g_cache[i].path, interp) == 0) {
      *found = 1;
      return g_cache[i].rewrite;
    }
  }
  *found = 0;
  return 0;
}

static void cache_decision(const char *interp, int rewrite) {
  if (g_cache_len >= CACHE_MAX) return;
  strncpy(g_cache[g_cache_len].path, interp, INTERP_MAX - 1);
  g_cache[g_cache_len].path[INTERP_MAX - 1] = 0;
  g_cache[g_cache_len].rewrite = rewrite;
  g_cache_len++;
}

// 读脚本头解析 shebang；interp=解释器路径，args=解释器参数（env 风格时为命令及其参数）。
static int parse_shebang(const char *path, char interp[INTERP_MAX], char *args[ARGS_MAX],
                         int *argc) {
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  char head[INTERP_MAX];
  ssize_t n = read(fd, head, sizeof(head) - 1);
  close(fd);
  if (n < 3 || head[0] != '#' || head[1] != '!') return 0;
  head[n] = 0;
  char *nl = strchr(head, '\n');
  if (nl) *nl = 0;
  char *save = NULL;
  char *tok = strtok_r(head + 2, " \t", &save);
  if (!tok) return 0;
  strncpy(interp, tok, INTERP_MAX - 1);
  interp[INTERP_MAX - 1] = 0;
  *argc = 0;
  while ((tok = strtok_r(NULL, " \t", &save)) != NULL && *argc < ARGS_MAX) {
    args[(*argc)++] = tok;
  }
  return 1;
}

static const char *basename_of(const char *path) {
  const char *slash = strrchr(path, '/');
  return slash ? slash + 1 : path;
}

// 需要改写时构造 ["/bin/env", 命令..., 脚本, 原 argv[1..]]；返回 1 表示已准备。
static int prepare_rewrite(const char *path, char *const argv[], const char **out_path,
                           char ***out_argv) {
  if (!path) return 0;
  if (!file_exists("/bin/env")) return 0;
  char interp[INTERP_MAX];
  char *sargs[ARGS_MAX];
  int sargc = 0;
  if (!parse_shebang(path, interp, sargs, &sargc)) return 0;
  if (!interp[0] || !sargs[0]) return 0;

  int found = 0;
  int rewrite = cached_decision(interp, &found);
  if (!found) {
    // 解释器缺失才改写；存在则保持内核原始语义（/usr/bin 正常时 shim 完全透明）。
    rewrite = file_exists(interp) ? 0 : 1;
    cache_decision(interp, rewrite);
  }
  if (!rewrite) return 0;

  int tail = 0;
  if (argv) {
    while (argv[1 + tail]) tail++;
  }
  size_t total = 2 + (size_t)sargc + (size_t)tail; // /bin/env + 命令/参数 + 脚本 + 尾部
  char **na = (char **)malloc((total + 1) * sizeof(char *));
  if (!na) return 0;
  size_t i = 0;
  na[i++] = (char *)"/bin/env";
  int env_style = strcmp(interp, "/usr/bin/env") == 0 || strcmp(interp, "/bin/env") == 0;
  if (env_style) {
    for (int k = 0; k < sargc; k++) na[i++] = sargs[k];
  } else {
    na[i++] = (char *)basename_of(interp);
  }
  na[i++] = (char *)path;
  for (int k = 1; k <= tail; k++) na[i++] = argv[k];
  na[i] = NULL;
  *out_path = "/bin/env";
  *out_argv = na;
  return 1;
}

int execve(const char *path, char *const argv[], char *const envp[]) {
  init_real();
  const char *np = NULL;
  char **na = NULL;
  if (prepare_rewrite(path, argv, &np, &na)) return real_execve(np, na, envp);
  return real_execve(path, argv, envp);
}

int execv(const char *path, char *const argv[]) {
  init_real();
  const char *np = NULL;
  char **na = NULL;
  if (prepare_rewrite(path, argv, &np, &na)) return real_execve(np, na, environ);
  return real_execv(path, argv);
}

static int execv_like(const char *file, char *const argv[], char *const envp[]) {
  init_real();
  char resolved[PATH_BUF];
  if (resolve_in_path(file, envp, resolved)) {
    const char *np = NULL;
    char **na = NULL;
    if (prepare_rewrite(resolved, argv, &np, &na)) return real_execve(np, na, envp);
  }
  return -1;
}

int execvp(const char *file, char *const argv[]) {
  int rc = execv_like(file, argv, environ);
  if (rc == -1) {
    init_real();
    return real_execvp(file, argv);
  }
  return rc;
}

int execvpe(const char *file, char *const argv[], char *const envp[]) {
  int rc = execv_like(file, argv, envp);
  if (rc == -1) {
    init_real();
    return real_execvpe(file, argv, envp);
  }
  return rc;
}

int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *fa,
                const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  init_real();
  const char *np = NULL;
  char **na = NULL;
  if (prepare_rewrite(path, argv, &np, &na)) return real_posix_spawn(pid, np, fa, attr, na, envp);
  return real_posix_spawn(pid, path, fa, attr, argv, envp);
}

int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *fa,
                 const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  init_real();
  char resolved[PATH_BUF];
  if (resolve_in_path(file, envp, resolved)) {
    const char *np = NULL;
    char **na = NULL;
    if (prepare_rewrite(resolved, argv, &np, &na))
      return real_posix_spawn(pid, np, fa, attr, na, envp);
  }
  return real_posix_spawnp(pid, file, fa, attr, argv, envp);
}