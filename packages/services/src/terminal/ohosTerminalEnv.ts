import { isOhosRuntime } from "@zcode/shared";

// GUI 进程的 PATH 只有 /data/app/bin:/data/service/hnp/bin；系统目录放末尾，保留用户优先级。
const OHOS_SYSTEM_PATH_ENTRIES = ["/usr/local/bin", "/bin", "/usr/bin"] as const;

export function applyOhosTerminalEnv(
  nextEnv: NodeJS.ProcessEnv,
  env: NodeJS.ProcessEnv,
  shell: string | undefined,
  deps: {
    mergePathEntries: (entries: readonly (string | undefined)[]) => string;
    isExecutable: (command: string) => boolean;
  },
): void {
  if (!isOhosRuntime()) return;
  nextEnv.PATH = deps.mergePathEntries([env.PATH, ...OHOS_SYSTEM_PATH_ENTRIES]);
  // spawn 已显式指定 shell；SHELL 供嵌套 shell 与工具识别，不覆盖用户显式配置。
  if (shell && (!nextEnv.SHELL || (nextEnv.SHELL !== shell && !deps.isExecutable(nextEnv.SHELL)))) {
    nextEnv.SHELL = shell;
  }
}
