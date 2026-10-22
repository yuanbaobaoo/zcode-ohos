import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessagePortMain } from "electron";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/zcode-terminal-relay-test" },
}));
vi.mock("../src/main/ohosNativeChildProcess.js", () => ({
  loadNativeProcessBridge: () => undefined,
  describeNativeProcessBridgeError: () => "not loaded in test",
}));

import {
  attachTerminalPtyRelay,
  shouldAttachTerminalPtyRelay,
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
  timeoutMs = 2000,
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

afterEach(() => {
  delete process.env.ZCODE_OHOS_TERMINAL_RELAY;
});

describe("shouldAttachTerminalPtyRelay", () => {
  it("非 OHOS 不启用中继", () => {
    expect(shouldAttachTerminalPtyRelay()).toBe(false);
  });

  it("OHOS 默认启用，ZCODE_OHOS_TERMINAL_RELAY=0 可禁用", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "ohos", configurable: true });
    try {
      expect(shouldAttachTerminalPtyRelay()).toBe(true);
      process.env.ZCODE_OHOS_TERMINAL_RELAY = "0";
      expect(shouldAttachTerminalPtyRelay()).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(process, "platform", descriptor);
    }
  });
});

describe("attachTerminalPtyRelay", () => {
  it("原生子进程桥不可用时回 spawn-failed，不再走主进程 spawn", async () => {
    const fake = createFakePort();
    attachTerminalPtyRelay(fake.port, {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    fake.listeners.get("message")?.({ data: { ...SPAWN_MESSAGE } });
    const failed = await waitForMessage(fake.posted, "ohos-pty/spawn-failed");

    expect(failed.requestId).toBe("r1");
    expect(String(failed.message)).toContain("native child bridge unavailable");
  });
});
