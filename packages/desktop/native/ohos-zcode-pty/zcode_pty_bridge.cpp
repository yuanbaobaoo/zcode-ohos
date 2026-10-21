// 主进程 NAPI 桥：调用 OH_Ability_StartNativeChildProcess 拉起 libzcode_pty.so 子进程。
// v40 沙箱禁止应用进程直接 fork/spawn（spec 09 §12.6），这是官方原生子进程通道。
// 系统库用 dlopen 延迟解析：直接 -lchild_process 会让 addon 在 OHOS 加载时静默失败。

#include <AbilityKit/native_child_process.h>
#include <dlfcn.h>
#include <node_api.h>

#include <cstring>

#include <unistd.h>

#include <cstdio>

namespace {

using StartNativeChildProcessFn = Ability_NativeChildProcess_ErrCode (*)(
    const char*, NativeChildProcess_Args, NativeChildProcess_Options, int32_t*);

StartNativeChildProcessFn resolveStartFunction() {
  static StartNativeChildProcessFn cached = nullptr;
  static bool resolved = false;
  if (resolved) {
    return cached;
  }
  resolved = true;
  void* handle = dlopen("libchild_process.so", RTLD_NOW | RTLD_LOCAL);
  if (handle == nullptr) {
    dprintf(STDERR_FILENO, "zcode-pty: dlopen libchild_process.so failed: %s\n", dlerror());
    return nullptr;
  }
  cached = reinterpret_cast<StartNativeChildProcessFn>(dlsym(handle, "OH_Ability_StartNativeChildProcess"));
  if (cached == nullptr) {
    dprintf(STDERR_FILENO, "zcode-pty: OH_Ability_StartNativeChildProcess missing\n");
  }
  return cached;
}

napi_value StartNativeProcess(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  char entryParams[8192] = {0};
  size_t length = 0;
  if (argc < 1 || napi_get_value_string_utf8(env, argv[0], entryParams, sizeof(entryParams), &length) !=
                      napi_ok) {
    napi_throw_type_error(env, nullptr, "entryParams string required");
    return nullptr;
  }

  const StartNativeChildProcessFn start = resolveStartFunction();
  int32_t pid = -1;
  Ability_NativeChildProcess_ErrCode code = NCP_ERR_NOT_SUPPORTED;
  if (start != nullptr) {
    NativeChildProcess_Args args{};
    args.entryParams = entryParams;
    NativeChildProcess_Options options{};
    options.isolationMode = NCP_ISOLATION_MODE_NORMAL;
    code = start("libzcode_pty.so:Main", args, options, &pid);
  }

  napi_value result;
  napi_create_int32(env, code == NCP_NO_ERROR ? pid : -static_cast<int32_t>(code), &result);
  return result;
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "startNativeProcess", NAPI_AUTO_LENGTH, StartNativeProcess, nullptr, &fn);
  napi_set_named_property(env, exports, "startNativeProcess", fn);
  return exports;
}
