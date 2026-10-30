import { describe, expect, it, vi } from "vitest";

// 只覆盖平台判定：其余 shared 导出保持真实值。
vi.mock("@zcode/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/shared")>()),
  isOhosRuntime: () => true,
}));

const { createTerminalService } = await import("../src/terminal/terminalService.js");

describe("OHOS 没有 main 域中继时的终端创建", () => {
  it("给出可读错误，而不是把 node-pty 加载栈抛给用户", async () => {
    const service = createTerminalService({
      settingService: {
        get: vi.fn().mockResolvedValue({ terminalInheritSystemProfile: true }),
        update: vi.fn(),
        updateDataBaseDir: vi.fn(),
      } as never,
    });

    await expect(service.create({ cols: 80, rows: 24 })).rejects.toThrow(
      "当前环境不支持终端：鸿蒙模拟器禁止应用创建子进程，请在真机上使用终端",
    );
  });
});
