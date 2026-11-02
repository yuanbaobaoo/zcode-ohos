import { describe, expect, it, vi } from "vitest";

import {
  OHOS_HDC_TOOL_NAME,
  createOhosHdcHandler,
} from "../src/capabilities/ohos-device/hdc-direct.js";
import { buildOhosDeviceContextSection } from "../src/capabilities/ohos-device/context-section.js";
import {
  isOhosDeviceBridgeEnabled,
  ohosDeviceTools,
} from "../src/capabilities/ohos-device/index.js";

/** 构造假会话：记录调用并返回固定输出。 */
function createFakeSession(overrides: { shellStr?: (command: string) => Promise<string> } = {}) {
  const calls: string[] = [];
  const session = {
    calls,
    shell: vi.fn(async (command: string) => Buffer.from(command)),
    shellStr: vi.fn(async (command: string) => {
      calls.push(command);
      return overrides.shellStr ? overrides.shellStr(command) : `out:${command}`;
    }),
    fileSend: vi.fn(async (localPath: string, remotePath: string) => {
      calls.push(`file_send ${localPath} -> ${remotePath}`);
      return `FileTransfer finish, Size:1`;
    }),
    fileRecv: vi.fn(async (remotePath: string, localPath: string) => {
      calls.push(`file_recv ${remotePath} -> ${localPath}`);
      return `FileTransfer finish, Size:1`;
    }),
    close: vi.fn(),
  };
  return session;
}

/** 构造假 hdc-direct 模块：返回固定端口与会话。 */
function createFakeModule(session = createFakeSession()) {
  return {
    session,
    module: {
      HdcSession: { connect: vi.fn(async () => session) },
      localHdcPort: () => 46273,
      loadTargets: () => ["192.168.1.10:46273"],
      splitTarget: (target: string) => {
        const [host, port] = target.split(":");
        return { host, port: Number(port) };
      },
    },
  };
}

describe("ohos_hdc handler", () => {
  it("list_targets 合并状态文件与本机端口", async () => {
    const { module } = createFakeModule();
    const handler = createOhosHdcHandler({ loadModule: async () => module, env: {} });
    const output = await handler({ action: "list_targets" }, {} as never);
    expect(output).toMatchObject({
      action: "list_targets",
      targets: ["192.168.1.10:46273", "127.0.0.1:46273"],
      exitCode: 0,
    });
  });

  it("shell 使用默认端口并在结束后关闭会话", async () => {
    const { module, session } = createFakeModule();
    const handler = createOhosHdcHandler({ loadModule: async () => module, env: {} });
    const output = await handler({ action: "shell", command: "id" }, {} as never);
    expect(session.shellStr).toHaveBeenCalledWith("id");
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(output).toMatchObject({ action: "shell", target: "127.0.0.1:46273", exitCode: 0 });
  });

  it("target 参数优先于环境变量与端口探测", async () => {
    const { module, session } = createFakeModule();
    const handler = createOhosHdcHandler({
      loadModule: async () => module,
      env: { HDC_DIRECT_PORT: "5000" },
    });
    const output = await handler(
      { action: "shell", command: "id", target: "10.0.0.2:1234" },
      {} as never,
    );
    expect(module.HdcSession.connect).toHaveBeenCalledWith("10.0.0.2", 1234, expect.anything());
    expect(output).toMatchObject({ target: "10.0.0.2:1234" });
    expect(session.close).toHaveBeenCalled();
  });

  it("file_send 返回 daemon 的传输总结", async () => {
    const { module } = createFakeModule();
    const handler = createOhosHdcHandler({ loadModule: async () => module, env: {} });
    const output = await handler(
      { action: "file_send", localPath: "/tmp/a.hap", remotePath: "/data/local/tmp/a.hap" },
      {} as never,
    );
    expect(output).toMatchObject({ action: "file_send", exitCode: 0 });
    expect(String(output.output)).toContain("FileTransfer finish");
  });

  it("file_recv 拉回设备文件", async () => {
    const { module, session } = createFakeModule();
    const handler = createOhosHdcHandler({ loadModule: async () => module, env: {} });
    const output = await handler(
      { action: "file_recv", remotePath: "/data/local/tmp/a.txt", localPath: "/tmp/a.txt" },
      {} as never,
    );
    expect(session.fileRecv).toHaveBeenCalledWith("/data/local/tmp/a.txt", "/tmp/a.txt");
    expect(output).toMatchObject({ action: "file_recv", exitCode: 0 });
  });

  it("screenshot 一条链路完成截屏、回传与设备清理", async () => {
    const { module, session } = createFakeModule();
    const handler = createOhosHdcHandler({ loadModule: async () => module, env: {} });
    const output = await handler(
      { action: "screenshot", localPath: "/tmp/shot.jpeg" },
      {} as never,
    );
    // 设备端截屏命令带显式 display 与类型，避免默认行为差异
    expect(session.shellStr).toHaveBeenCalledWith(expect.stringContaining("snapshot_display -i 0 -f"));
    expect(session.shellStr).toHaveBeenCalledWith(expect.stringContaining("-t jpeg"));
    expect(session.fileRecv).toHaveBeenCalledWith(expect.stringContaining("/data/local/tmp/zcode-screenshot-"), "/tmp/shot.jpeg");
    // 设备中转文件应被清理
    expect(session.shellStr).toHaveBeenCalledWith(expect.stringContaining("rm -f"));
    expect(output).toMatchObject({ action: "screenshot", exitCode: 0 });
    expect(String(output.output)).toContain("/tmp/shot.jpeg");
  });

  it("install 上传后执行 bm install 并可选拉起", async () => {
    const session = createFakeSession({
      shellStr: async (command) =>
        command.startsWith("bm install") ? "install bundle successfully." : "start ability successfully.",
    });
    const { module } = createFakeModule(session);
    const handler = createOhosHdcHandler({ loadModule: async () => module, env: {} });
    const output = await handler(
      { action: "install", hapPath: "/tmp/app.hap", bundleName: "com.example.app" },
      {} as never,
    );
    expect(session.fileSend).toHaveBeenCalledWith("/tmp/app.hap", "/data/local/tmp/app.hap");
    expect(output.exitCode).toBe(0);
    expect(String(output.output)).toContain("install bundle successfully.");
    expect(String(output.output)).toContain("start ability successfully.");
  });

  it("install 失败时返回非零退出码", async () => {
    const session = createFakeSession({ shellStr: async () => "error: failed to install bundle." });
    const { module } = createFakeModule(session);
    const handler = createOhosHdcHandler({ loadModule: async () => module, env: {} });
    const output = await handler({ action: "install", hapPath: "/tmp/app.hap" }, {} as never);
    expect(output.exitCode).toBe(1);
  });

  it("资产加载失败时给出可执行的错误提示", async () => {
    const handler = createOhosHdcHandler({
      loadModule: async () => {
        throw new Error("module not found");
      },
      env: {},
    });
    await expect(handler({ action: "list_targets" }, {} as never)).rejects.toThrow(
      /ohos_hdc 执行失败/,
    );
  });

  it("无法确定端口时报配置错误", async () => {
    const module = {
      HdcSession: { connect: vi.fn() },
      localHdcPort: () => null,
      loadTargets: () => [],
      splitTarget: () => ({ host: "127.0.0.1", port: 0 }),
    };
    const handler = createOhosHdcHandler({ loadModule: async () => module, env: {} });
    await expect(handler({ action: "shell", command: "id" }, {} as never)).rejects.toThrow(
      /无线调试/,
    );
  });

  it("工具名与 OHOS 前缀保持一致", () => {
    expect(OHOS_HDC_TOOL_NAME).toBe("ohos_hdc");
  });
});

describe("ohos device capability switch", () => {
  it("鸿蒙平台默认启用", () => {
    expect(isOhosDeviceBridgeEnabled({}, "ohos")).toBe(true);
    expect(ohosDeviceTools({}, "ohos")).toHaveLength(1);
  });

  it("非鸿蒙平台不提供工具", () => {
    expect(isOhosDeviceBridgeEnabled({}, "darwin")).toBe(false);
    expect(ohosDeviceTools({}, "linux")).toEqual([]);
  });

  it("ZCODE_OHOS_HDC_BRIDGE 关闭后让位给系统实现", () => {
    expect(isOhosDeviceBridgeEnabled({ ZCODE_OHOS_HDC_BRIDGE: "0" }, "ohos")).toBe(false);
    expect(isOhosDeviceBridgeEnabled({ ZCODE_OHOS_HDC_BRIDGE: "native" }, "ohos")).toBe(false);
    expect(ohosDeviceTools({ ZCODE_OHOS_HDC_BRIDGE: "off" }, "ohos")).toEqual([]);
  });
});

describe("ohos device context section", () => {
  it("OHOS 平台产出系统提示词段，含 devecocli 必败事实与 ohos_hdc 路线", () => {
    const section = buildOhosDeviceContextSection({}, "ohos");
    expect(section).not.toBeNull();
    expect(section?.injectionTarget).toBe("system");
    expect(section?.source).toBe("ohos_device_context");
    expect(section?.content).toContain("devecocli run");
    expect(section?.content).toContain("ohos_hdc");
    expect(section?.content).toContain("do not spend turns investigating");
  });

  it("同一开关：ZCODE_OHOS_HDC_BRIDGE 关闭后提示词段消失", () => {
    expect(buildOhosDeviceContextSection({ ZCODE_OHOS_HDC_BRIDGE: "0" }, "ohos")).toBeNull();
    expect(buildOhosDeviceContextSection({ ZCODE_OHOS_HDC_BRIDGE: "native" }, "openharmony")).toBeNull();
  });

  it("非 OHOS 平台不产出提示词段", () => {
    expect(buildOhosDeviceContextSection({}, "darwin")).toBeNull();
    expect(buildOhosDeviceContextSection({}, "linux")).toBeNull();
  });
});
