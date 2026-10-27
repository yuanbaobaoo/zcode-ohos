import { describe, expect, it } from "vitest";
import type { MessagePortMain } from "electron";

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

describe("shouldAttachTerminalPtyRelay", () => {
  it("非 OHOS 不启用中继", () => {
    expect(shouldAttachTerminalPtyRelay()).toBe(false);
  });

  it("OHOS 恒启用中继", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "ohos", configurable: true });
    try {
      expect(shouldAttachTerminalPtyRelay()).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(process, "platform", descriptor);
    }
  });
});

describe("attachTerminalPtyRelay", () => {
  it("spawn 由 main 域托管 shell，并回传 sessionId/pid", async () => {
    const fake = createFakePort();
    attachTerminalPtyRelay(fake.port, {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    fake.listeners.get("message")?.({ data: { ...SPAWN_MESSAGE } });
    const spawned = await waitForMessage(fake.posted, "ohos-pty/spawned");

    expect(spawned.requestId).toBe("r1");
    expect(Number(spawned.pid)).toBeGreaterThan(0);
    expect(String(spawned.sessionId)).not.toBe("");

    fake.listeners.get("message")?.({
      data: { type: "ohos-pty/kill", sessionId: spawned.sessionId },
    });
  });
});
