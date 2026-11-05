/*
 * OHOS 沙箱文件桥原语（specs/ohos-port/15 M4）。
 *
 * 背景：窗口主题、全盘访问、辅助操作权限、Computer Use 截图四条链路各自手写了
 * `watch + 轮询 + 单飞行 + 清理`，超时/去重语义互不相同，新增第 5 条只能再复制一份。
 * 这里把四件事收敛成原语，通道只声明差异（文件名 / 前缀 / 轮询粒度 / 处理函数）：
 *
 *   readJsonSync     读 JSON（坏文件返回 undefined，调用方按 fail-closed 处理）
 *   writeJsonAtomic  原子写 JSON（临时文件 + rename，避免 ArkTS 读到半截）
 *   writeTextAtomic  原子写文本（请求文件这类"有即是请求"的信号）
 *   watchJsonValue   目录 watch + 值变化去重（跨进程 watch 事件不可靠，调用方仍需轮询兜底）
 *
 * 不改协议形态：仍是 el2 文件 + 轮询，不引入 socket/IPC（沙箱禁 UDS bind，spec 03）。
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export function readJsonSync<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, `${JSON.stringify(value)}\n`);
}

export function writeTextAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, text, "utf-8");
  try {
    renameSync(temp, path);
  } catch (error) {
    // rename 失败（跨设备/并发删除）时清掉临时文件再抛，避免残留。
    rmSync(temp, { force: true });
    throw error;
  }
}

export interface WatchJsonValueOptions<T> {
  /** 被观察的 JSON 文件绝对路径；目录与文件名由原语内部拆出（watch 目录、过滤文件名）。 */
  path: string;
  parse: (raw: unknown) => T | undefined;
  equals: (left: T, right: T) => boolean;
  onChange: (value: T) => void;
  logger: { warn: (...args: unknown[]) => void };
  /** 建立 watch 后先读一次并回调（默认 false，保持"由调用方主动查询首值"的既有语义）。 */
  emitInitial?: boolean;
}

/**
 * 目录 watch + 值变化去重。返回 disposer。
 * watch 失败只失去自动推送（调用方仍可主动查询），不抛。
 */
export function watchJsonValue<T>(options: WatchJsonValueOptions<T>): () => void {
  const dir = dirname(options.path);
  const filename = basename(options.path);
  let watcher: FSWatcher | undefined;
  let last: T | undefined;
  const emitIfChanged = (): void => {
    const parsed = options.parse(readJsonSync<unknown>(options.path));
    if (parsed === undefined) return;
    if (last !== undefined && options.equals(last, parsed)) return;
    last = parsed;
    options.onChange(parsed);
  };
  try {
    mkdirSync(dir, { recursive: true });
    watcher = watch(dir, (_event, changed) => {
      if (changed === filename) emitIfChanged();
    });
    if (options.emitInitial) emitIfChanged();
  } catch (error) {
    options.logger.warn("[ohos-bridge] watch failed:", error);
  }
  return () => watcher?.close();
}
