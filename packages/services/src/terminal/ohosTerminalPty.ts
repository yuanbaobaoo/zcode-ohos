import type { IPty } from "node-pty";

// OHOS 终端 pty 中继协议（Host ↔ Main 专用 MessagePort）。
// utility 进程（Host）在 OHOS 沙箱内不允许 fork（forkpty 返回 -1），伪终端必须在
// Main 进程创建（specs/ohos-port/README.md）；Host 侧 terminalService 经本客户端把
// spawn/write/resize/kill 转发给 Main，Main 侧由 desktopTerminalPtyRelay 执行。

export type OhosPtySpawnRequest = {
  type: "ohos-pty/spawn";
  requestId: string;
  shell: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string | undefined>;
  name: string;
};

export type OhosPtyWriteRequest = {
  type: "ohos-pty/write";
  sessionId: string;
  data: string;
};

export type OhosPtyResizeRequest = {
  type: "ohos-pty/resize";
  sessionId: string;
  cols: number;
  rows: number;
};

export type OhosPtyKillRequest = {
  type: "ohos-pty/kill";
  sessionId: string;
};

export type OhosPtyHostToMainMessage =
  | OhosPtySpawnRequest
  | OhosPtyWriteRequest
  | OhosPtyResizeRequest
  | OhosPtyKillRequest;

export type OhosPtySpawnResponse = {
  type: "ohos-pty/spawned";
  requestId: string;
  sessionId: string;
  pid: number;
};

export type OhosPtySpawnFailedResponse = {
  type: "ohos-pty/spawn-failed";
  requestId: string;
  message: string;
};

export type OhosPtyDataEvent = {
  type: "ohos-pty/data";
  sessionId: string;
  data: string;
};

export type OhosPtyExitEvent = {
  type: "ohos-pty/exit";
  sessionId: string;
  exitCode: number;
};

export type OhosPtyMainToHostMessage =
  | OhosPtySpawnResponse
  | OhosPtySpawnFailedResponse
  | OhosPtyDataEvent
  | OhosPtyExitEvent;

/** Host 侧最小 MessagePort 面（Electron utility 进程里即 node:worker_threads 的 MessagePort）。 */
export interface OhosPtyRelayPort {
  postMessage(message: OhosPtyHostToMainMessage): void;
  on(event: "message", listener: (message: OhosPtyMainToHostMessage) => void): unknown;
  start?(): void;
}

/** IPty 的中继实现：真实 pty 住在 Main 进程，本对象只转发控制面与数据面。 */
class OhosRelayPty implements IPty {
  readonly pid: number;
  // 中继面不承载尺寸/进程名状态（Main 侧持有）；给 node-pty 接口的兼容读数。
  readonly cols = 0;
  readonly rows = 0;
  readonly process = "";
  // node-pty 接口面：流控开关由构造方决定；中继实现不启用（xterm 自带流控）。
  readonly handleFlowControl = false;
  #listeners: {
    data?: (data: string) => unknown;
    exit?: (event: { exitCode: number }) => unknown;
  } = {};
  #alive = true;

  constructor(
    readonly sessionId: string,
    pid: number,
    private readonly port: OhosPtyRelayPort,
    private readonly unregister: () => void,
  ) {
    this.pid = pid;
  }

  /** 仅供中继客户端派发；业务代码不应直接调用。 */
  handleEvent(event: OhosPtyDataEvent | OhosPtyExitEvent): void {
    if (event.type === "ohos-pty/data") {
      this.#listeners.data?.(event.data);
      return;
    }
    this.#alive = false;
    this.#listeners.exit?.({ exitCode: event.exitCode });
    this.unregister();
  }

  write(data: string | Buffer): void {
    if (!this.#alive) return;
    if (typeof data !== "string") data = data.toString("utf8");
    this.port.postMessage({ type: "ohos-pty/write", sessionId: this.sessionId, data });
  }

  resize(cols: number, rows: number): void {
    if (!this.#alive) return;
    this.port.postMessage({ type: "ohos-pty/resize", sessionId: this.sessionId, cols, rows });
  }

  clear(): void {
    /* pty 数据面由 Main 侧持有；清屏属渲染层职责，无远端动作。 */
  }

  pause(): void {
    /* 流控由 Main 侧 pty 与端口缓冲承担，中继面无暂停语义。 */
  }

  resume(): void {
    /* 见 pause()。 */
  }

  kill(signal?: string): void {
    if (!this.#alive && !signal) return;
    this.#alive = false;
    this.port.postMessage({ type: "ohos-pty/kill", sessionId: this.sessionId });
    this.unregister();
  }

  // node-pty 的 IEvent 面：onData/onExit 是函数值属性，注册返回 disposable。
  readonly onData = (listener: (data: string) => unknown): { dispose(): void } => {
    this.#listeners.data = listener;
    return {
      dispose: () => {
        if (this.#listeners.data === listener) this.#listeners.data = undefined;
      },
    };
  };

  readonly onExit = (listener: (event: { exitCode: number }) => unknown): { dispose(): void } => {
    this.#listeners.exit = listener;
    return {
      dispose: () => {
        if (this.#listeners.exit === listener) this.#listeners.exit = undefined;
      },
    };
  };
}

export interface OhosPtyTransport {
  spawn(params: {
    shell: string;
    cols: number;
    rows: number;
    cwd: string;
    env: NodeJS.ProcessEnv;
    name: string;
  }): Promise<IPty>;
}

export function createOhosPtyRelayClient(port: OhosPtyRelayPort): OhosPtyTransport {
  const sessions = new Map<string, OhosRelayPty>();
  const pendingSpawn = new Map<
    string,
    { resolve: (pty: IPty) => void; reject: (error: Error) => void }
  >();
  let nextRequestId = 0;

  port.on("message", (rawMessage: unknown) => {
    // Electron utility 进程的 MessagePort 事件回调收到 {data, ports} 包装（与
    // worker_threads 传裸值不同，装机实证）；解包后按协议分发。
    const asRecord = rawMessage as Record<string, unknown> | null | undefined;
    const message = (
      asRecord &&
      typeof asRecord === "object" &&
      asRecord.data &&
      typeof asRecord.data === "object" &&
      "type" in (asRecord.data as Record<string, unknown>)
        ? (asRecord.data as OhosPtyMainToHostMessage)
        : (rawMessage as OhosPtyMainToHostMessage)
    ) as OhosPtyMainToHostMessage;
    if (message.type === "ohos-pty/data" || message.type === "ohos-pty/exit") {
      sessions.get(message.sessionId)?.handleEvent(message);
      return;
    }
    const pending = pendingSpawn.get(message.requestId);
    if (!pending) return;
    pendingSpawn.delete(message.requestId);
    if (message.type === "ohos-pty/spawned") {
      const pty = new OhosRelayPty(message.sessionId, message.pid, port, () =>
        sessions.delete(message.sessionId),
      );
      sessions.set(message.sessionId, pty);
      pending.resolve(pty);
    } else {
      pending.reject(new Error(message.message));
    }
  });
  port.start?.();

  return {
    spawn: (params) =>
      new Promise<IPty>((resolve, reject) => {
        const requestId = `ohos-pty-${++nextRequestId}`;
        pendingSpawn.set(requestId, { resolve, reject });
        port.postMessage({
          type: "ohos-pty/spawn",
          requestId,
          shell: params.shell,
          cols: params.cols,
          rows: params.rows,
          cwd: params.cwd,
          env: params.env,
          name: params.name,
        });
      }),
  };
}
