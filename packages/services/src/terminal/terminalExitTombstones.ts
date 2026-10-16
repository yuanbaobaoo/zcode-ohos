import type { Event } from "@zcode/rpc";

// 终端在 create 返回后、订阅到达前退出是合法竞态（OHOS 管道 shell 秒退实证）。
// 退出后保留退出码做短期墓碑：晚到的订阅仍能拿到 exit，而不是抛错拖死 Host。
export class TerminalExitTombstones {
  #exited = new Map<string, number>();
  readonly #cap: number;

  constructor(cap = 32) {
    this.#cap = cap;
  }

  record(id: string, exitCode: number): void {
    if (this.#exited.size >= this.#cap && !this.#exited.has(id)) {
      const oldest = this.#exited.keys().next().value;
      if (oldest !== undefined) this.#exited.delete(oldest);
    }
    this.#exited.set(id, exitCode);
  }

  has(id: string): boolean {
    return this.#exited.has(id);
  }

  get(id: string): number | undefined {
    return this.#exited.get(id);
  }

  remove(id: string): void {
    this.#exited.delete(id);
  }

  clear(): void {
    this.#exited.clear();
  }
}

/** 订阅晚于退出时的补发事件：异步触发退出码，避免同步回调击穿订阅方。 */
export function exitedEvent(exitCode: number): Event<number> {
  return (listener) => {
    const timer = setTimeout(() => listener(exitCode), 0);
    return { dispose: () => clearTimeout(timer) };
  };
}
