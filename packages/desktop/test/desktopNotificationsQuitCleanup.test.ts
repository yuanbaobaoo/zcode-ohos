// spec：specs/ohos-port/02（Electron Notification 落为 OHOS 系统通知，生命周期长于应用）
// 验证退出清理与逐出清理都会对持有的通知调用 close()（映射 notificationManager.cancel）。
import { beforeEach, describe, expect, it, vi } from "vitest";

const created: FakeNotification[] = [];

class FakeNotification {
  closed = false;
  shown = false;
  private listeners = new Map<string, Array<() => void>>();

  constructor(_options: unknown) {
    created.push(this);
  }

  static isSupported() {
    return true;
  }

  show() {
    this.shown = true;
  }

  close() {
    this.closed = true;
    for (const callback of this.listeners.get("close") ?? []) callback();
  }

  once(event: string, callback: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]);
  }

  on(_event: string, _callback: () => void) {}
}

vi.mock("electron", () => ({
  Notification: FakeNotification,
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: () => ({ isDestroyed: () => false }),
  },
  app: { isPackaged: false, getPath: vi.fn((name: string) => `/mock/${name}`) },
}));

const {
  dispatchTaskNotification,
  closeAllTaskNotifications,
  getActiveTaskNotificationCountForTest,
  resetActiveTaskNotificationsForTest,
  MAX_ACTIVE_TASK_NOTIFICATIONS,
} = await import("../src/main/desktopNotifications.js");

function makeEvent() {
  return { sender: { send: vi.fn() } };
}

function makePayload(taskId: string) {
  return { taskId, status: "completed" as const, title: "任务完成", body: "xxx 已完成" };
}

describe("任务通知退出清理（OHOS 系统通知生命周期长于应用）", () => {
  beforeEach(() => {
    resetActiveTaskNotificationsForTest();
    created.length = 0;
  });

  it("closeAllTaskNotifications 对全部活跃通知调用 close 并清空持有集", () => {
    expect(
      dispatchTaskNotification({ event: makeEvent(), payload: makePayload("t1"), logger: vi.fn() }),
    ).toBe(true);
    expect(
      dispatchTaskNotification({ event: makeEvent(), payload: makePayload("t2"), logger: vi.fn() }),
    ).toBe(true);
    expect(getActiveTaskNotificationCountForTest()).toBe(2);

    closeAllTaskNotifications();

    expect(created.map((n) => n.closed)).toEqual([true, true]);
    expect(getActiveTaskNotificationCountForTest()).toBe(0);
  });

  it("超过持有上限逐出最旧通知时同步 close，不再只删引用", () => {
    const total = MAX_ACTIVE_TASK_NOTIFICATIONS + 1;
    for (let index = 0; index < total; index += 1) {
      expect(
        dispatchTaskNotification({
          event: makeEvent(),
          payload: makePayload(`task-${index}`),
          logger: vi.fn(),
        }),
      ).toBe(true);
    }
    // 最旧一条被逐出且已 close；其余仍活跃；closeAll 再跑一次幂等不抛（重复 close 被吞）。
    expect(created[0]?.closed).toBe(true);
    expect(created[1]?.closed).toBe(false);
    expect(getActiveTaskNotificationCountForTest()).toBe(MAX_ACTIVE_TASK_NOTIFICATIONS);
    expect(() => closeAllTaskNotifications()).not.toThrow();
    expect(getActiveTaskNotificationCountForTest()).toBe(0);
  });
});
