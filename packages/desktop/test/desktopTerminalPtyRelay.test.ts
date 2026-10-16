import { afterEach, describe, expect, it } from "vitest";
import type { MessagePortMain } from "electron";
import {
  attachTerminalPtyRelay,
  probeShellExecutable,
  shouldTryNodePtyOnOhos,
} from "../src/main/desktopTerminalPtyRelay.js";

interface FakePort {
  listeners: Map<string, (event: { data: unknown }) => void>;
  posted: unknown[];
  port: MessagePortMain;
}

function createFakePort(): FakePort {
  const listeners = new Map<string, (event: { data: unknown }) => void>();
  const posted: unknown[] = [];
  const port = {
    on: (event: string, listener: (event: { data: unknown }) => void) =>
      listeners.set(event, listener),
    postMessage: (message: unknown) => {
      posted.push(message);
    },
    start: () => undefined,
  } as unknown as MessagePortMain;
  return { listeners, posted, port };
}

async function waitForMessage(
  posted: unknown[],
  type: string,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = posted.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as Record<string, unknown>).type === type,
    );
    if (hit) return hit as Record<string, unknown>;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${type}; posted=${JSON.stringify(posted)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const SPAWN_MESSAGE = {
  type: "ohos-pty/spawn",
  requestId: "r1",
  shell: "/bin/sh",
  cols: 80,
  rows: 24,
  cwd: "/tmp",
  env: {},
  name: "xterm-256color",
} as const;

describe("desktopTerminalPtyRelay", () => {
  afterEach(() => {
    delete process.env.ZCODE_OHOS_NODE_PTY;
  });

  it("默认跳过 node-pty，直接走管道降级", async () => {
    const fake = createFakePort();
    let loadNodePtyCalled = false;
    attachTerminalPtyRelay(fake.port, {
      loadNodePty: async () => {
        loadNodePtyCalled = true;
        throw new Error("must not be called by default");
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    fake.listeners.get("message")?.({ data: { ...SPAWN_MESSAGE } });
    const spawned = await waitForMessage(fake.posted, "ohos-pty/spawned");
    expect(spawned.requestId).toBe("r1");
    expect(loadNodePtyCalled).toBe(false);

    // 清理管道 shell，避免测试进程挂住（交互 sh 忽略 SIGTERM，写 exit 退出）。
    const sessionId = spawned.sessionId as string;
    fake.listeners.get("message")?.({
      data: { type: "ohos-pty/write", sessionId, data: "exit\n" },
    });
    await waitForMessage(fake.posted, "ohos-pty/exit");
  });

  it("ZCODE_OHOS_NODE_PTY=1 时保留 node-pty 探针，失败后仍降级管道", async () => {
    process.env.ZCODE_OHOS_NODE_PTY = "1";
    const fake = createFakePort();
    let loadNodePtyCalled = false;
    const warnings: string[] = [];
    attachTerminalPtyRelay(fake.port, {
      loadNodePty: async () => {
        loadNodePtyCalled = true;
        return {} as typeof import("node-pty");
      },
      logger: {
        info: () => {},
        warn: (msg: unknown) => warnings.push(String(msg)),
        error: () => {},
      },
    });

    fake.listeners.get("message")?.({ data: { ...SPAWN_MESSAGE } });
    const spawned = await waitForMessage(fake.posted, "ohos-pty/spawned");
    expect(loadNodePtyCalled).toBe(true);
    // node-pty.spawn 被 stub 成非函数而抛 TypeError，降级管道后仍应 spawn 成功。
    expect(warnings.some((line) => line.includes("falling back to pipe shell"))).toBe(true);

    const sessionId = spawned.sessionId as string;
    fake.listeners.get("message")?.({
      data: { type: "ohos-pty/write", sessionId, data: "exit\n" },
    });
    await waitForMessage(fake.posted, "ohos-pty/exit");
  });

  it("shouldTryNodePtyOnOhos 只在显式开启时为真", () => {
    expect(shouldTryNodePtyOnOhos()).toBe(false);
    process.env.ZCODE_OHOS_NODE_PTY = "1";
    expect(shouldTryNodePtyOnOhos()).toBe(true);
    process.env.ZCODE_OHOS_NODE_PTY = "true";
    expect(shouldTryNodePtyOnOhos()).toBe(true);
    process.env.ZCODE_OHOS_NODE_PTY = "0";
    expect(shouldTryNodePtyOnOhos()).toBe(false);
  });

  it("probeShellExecutable 区分可用与不可用 shell", async () => {
    await expect(probeShellExecutable("/bin/sh")).resolves.toBe(true);
    await expect(probeShellExecutable("/nonexistent/definitely-not-a-shell")).resolves.toBe(false);
  });
});
