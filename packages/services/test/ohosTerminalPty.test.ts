import { describe, expect, it, vi } from "vitest";
import {
  createOhosPtyRelayClient,
  type OhosPtyMainToHostMessage,
  type OhosPtyRelayPort,
} from "../src/terminal/ohosTerminalPty.js";

function createFakeRelayPort() {
  let listener: ((message: OhosPtyMainToHostMessage) => void) | undefined;
  const posted: unknown[] = [];
  const port: OhosPtyRelayPort = {
    postMessage: (message) => {
      posted.push(message);
    },
    on: (_event, l) => {
      listener = l;
      return undefined;
    },
    start: () => undefined,
  };
  return {
    posted,
    port,
    emit: (message: OhosPtyMainToHostMessage) => listener?.(message),
  };
}

describe("createOhosPtyRelayClient", () => {
  it("退出事件早于订阅到达时闩住并在订阅时补发", async () => {
    const fake = createFakeRelayPort();
    const client = createOhosPtyRelayClient(fake.port);

    const spawnPromise = client.spawn({
      shell: "/bin/sh",
      cols: 80,
      rows: 24,
      cwd: "/tmp",
      env: {},
      name: "xterm-256color",
    });
    fake.emit({ type: "ohos-pty/spawned", requestId: "ohos-pty-1", sessionId: "s1", pid: 123 });
    const pty = await spawnPromise;

    // 订阅前退出（管道 shell 秒退竞态）。
    fake.emit({ type: "ohos-pty/exit", sessionId: "s1", exitCode: 2 });

    const exitCode = await new Promise<number>((resolve) => {
      pty.onExit((event) => resolve(event.exitCode));
    });
    expect(exitCode).toBe(2);
  });

  it("正常顺序下退出事件即时分发，write 在退出后不再下行", async () => {
    const fake = createFakeRelayPort();
    const client = createOhosPtyRelayClient(fake.port);

    const spawnPromise = client.spawn({
      shell: "/bin/sh",
      cols: 80,
      rows: 24,
      cwd: "/tmp",
      env: {},
      name: "xterm-256color",
    });
    fake.emit({ type: "ohos-pty/spawned", requestId: "ohos-pty-1", sessionId: "s1", pid: 123 });
    const pty = await spawnPromise;

    const onData = vi.fn();
    const onExit = vi.fn();
    pty.onData(onData);
    pty.onExit(onExit);
    fake.emit({ type: "ohos-pty/data", sessionId: "s1", data: "hello" });
    expect(onData).toHaveBeenCalledWith("hello");

    fake.emit({ type: "ohos-pty/exit", sessionId: "s1", exitCode: 0 });
    expect(onExit).toHaveBeenCalledWith({ exitCode: 0 });

    pty.write("ls\n");
    const writes = fake.posted.filter(
      (message) => (message as { type?: string }).type === "ohos-pty/write",
    );
    expect(writes).toHaveLength(0);
  });
});
