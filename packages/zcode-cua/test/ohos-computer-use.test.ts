import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createComputerUseRuntime } from "../index.js";
import {
  OHOS_COMPUTER_CONTROL_BRIDGE_DIR,
  createOhosComputerUseRuntime,
} from "../ohos-computer-use.js";

const FAKE_TOKEN = "fake-token";
const CONTEXT = {
  sessionId: "test",
  runtimeScope: "main",
  workspaceKey: "test",
} as const;

interface RecordedCommand {
  id: string;
  type: string;
  args: Record<string, unknown>;
}

// 模拟 ArkTS 侧：轮询 cmd-*，校验 token，执行 handler 并写 ack。
function createFakeArkTS(dir: string, handler: (command: RecordedCommand) => unknown) {
  const commands: RecordedCommand[] = [];
  const timer = setInterval(() => {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("cmd-") || !name.endsWith(".json")) continue;
      const path = join(dir, name);
      const command = JSON.parse(readFileSync(path, "utf8")) as RecordedCommand & { token: string };
      if (command.token !== FAKE_TOKEN) {
        rmSync(path, { force: true });
        continue;
      }
      commands.push(command);
      let payload: Record<string, unknown>;
      try {
        payload = { id: command.id, ok: true, data: (handler(command) ?? {}) as object };
      } catch (error) {
        payload = {
          id: command.id,
          ok: false,
          error: {
            message: error instanceof Error ? error.message : String(error),
            code: (error as { code?: string }).code,
          },
        };
      }
      writeFileSync(join(dir, `ack-${command.id}.json`), JSON.stringify(payload), "utf8");
      rmSync(path, { force: true });
    }
  }, 10);
  return {
    commands,
    stop: () => clearInterval(timer),
  };
}

function setupBridgeDir(): string {
  const dir = join(tmpdir(), `zcode-cua-ohos-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "token.json"), JSON.stringify({ token: FAKE_TOKEN }), "utf8");
  return dir;
}

const dirs: string[] = [];
const bridges: Array<{ stop: () => void }> = [];

function createRuntime(dir: string, handler: (command: RecordedCommand) => unknown = () => ({})) {
  dirs.push(dir);
  const bridge = createFakeArkTS(dir, handler);
  bridges.push(bridge);
  return {
    runtime: createOhosComputerUseRuntime({ bridgeDir: dir, platform: "ohos" }),
    commands: bridge.commands,
  };
}

afterEach(() => {
  for (const bridge of bridges) bridge.stop();
  bridges.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

async function execute(
  runtime: ReturnType<typeof createOhosComputerUseRuntime>,
  toolName: string,
  args: Record<string, unknown>,
) {
  return await runtime.execute({ toolName, arguments: args, context: CONTEXT });
}

describe("ohos computer use runtime", () => {
  it("left_click 编排 move + button 序列并返回成功", async () => {
    const { runtime, commands } = createRuntime(join(setupBridgeDir(), ""));
    const result = await execute(runtime, "left_click", {
      target: { type: "coordinate", x: 225, y: 2020 },
      click_count: 2,
      mouse_button: "right",
      modifiers: "ctrl",
    });
    expect(result.isError).toBeFalsy();
    const ops = commands[0]?.args.ops as Array<Record<string, unknown>>;
    expect(ops[0]).toMatchObject({ op: "move", x: 225, y: 2020 });
    // 修饰键先按下、点击后释放；右键 button=2；双击两次 press/release
    expect(ops.filter((op) => op.op === "key_down")).toEqual([{ op: "key_down", key: "ctrl_left" }]);
    expect(ops.filter((op) => op.op === "button_down")).toHaveLength(2);
    expect(ops.find((op) => op.op === "button_down")).toMatchObject({ button: 2 });
    expect(ops.at(-1)).toMatchObject({ op: "key_up", key: "ctrl_left" });
  });

  it("type strategy=event 时逐字符编排 shift 组合（大写与标点）", async () => {
    const { runtime, commands } = createRuntime(join(setupBridgeDir(), ""));
    const result = await execute(runtime, "type", { text: "A!", strategy: "event" });
    expect(result.isError).toBeFalsy();
    const ops = commands[0]?.args.ops as Array<Record<string, unknown>>;
    // A = shift+a；! = shift+1
    expect(ops).toEqual([
      { op: "key_down", key: "shift_left" },
      { op: "key_down", key: "a" },
      { op: "key_up", key: "a" },
      { op: "key_up", key: "shift_left" },
      { op: "key_down", key: "shift_left" },
      { op: "key_down", key: "1" },
      { op: "key_up", key: "1" },
      { op: "key_up", key: "shift_left" },
    ]);
  });

  it("type strategy=event 拒绝非 ASCII 并指引 paste", async () => {
    const { runtime } = createRuntime(join(setupBridgeDir(), ""));
    const result = await execute(runtime, "type", { text: "你好", strategy: "event" });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.code).toBe("invalid_request");
    expect(parsed.message).toContain("paste");
  });

  it("paste 只发一个 paste op（文本进剪贴板 + ctrl+v 由 ArkTS 执行）", async () => {
    const { runtime, commands } = createRuntime(join(setupBridgeDir(), ""));
    const result = await execute(runtime, "paste", { text: "你好鸿蒙" });
    expect(result.isError).toBeFalsy();
    expect(commands[0]?.args.ops).toEqual([{ op: "paste", text: "你好鸿蒙" }]);
  });

  it("key 组合键解析修饰与命名键别名，repeat 生效", async () => {
    const { runtime, commands } = createRuntime(join(setupBridgeDir(), ""));
    const result = await execute(runtime, "key", { text: "cmd+shift+t", repeat: 2 });
    expect(result.isError).toBeFalsy();
    const ops = commands[0]?.args.ops as Array<Record<string, unknown>>;
    // cmd→meta_left；两次 repeat 各一组 down/up
    expect(ops.filter((op) => op.op === "key_down" && op.key === "meta_left")).toHaveLength(2);
    expect(ops.filter((op) => op.op === "key_down" && op.key === "t")).toHaveLength(2);
    expect(ops.filter((op) => op.op === "key_up")).toHaveLength(6);
  });

  it("element target 报 element_unavailable 并指引坐标", async () => {
    const { runtime } = createRuntime(join(setupBridgeDir(), ""));
    const result = await execute(runtime, "left_click", { target: { type: "element", index: 3 } });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.code).toBe("element_unavailable");
    expect(parsed.message).toContain("coordinate");
  });

  it("AX 三件套按契约错误码降级", async () => {
    const { runtime } = createRuntime(join(setupBridgeDir(), ""));
    for (const [tool, code] of [
      ["perform_action", "action_unavailable"],
      ["set_value", "not_settable"],
      ["select_text", "not_selectable"],
    ] as const) {
      const result = await execute(runtime, tool, {});
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text).code).toBe(code);
    }
  });

  it("request_access 从 status.json 聚合并按上游字段命名", async () => {
    const dir = setupBridgeDir();
    writeFileSync(
      join(dir, "status.json"),
      JSON.stringify({
        apiAvailable: true,
        permission: "granted",
        bridgeAlive: true,
        capture: "needs-consent",
      }),
      "utf8",
    );
    const { runtime } = createRuntime(dir);
    const result = await execute(runtime, "request_access", {});
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.accessibility).toBe("granted");
    expect(parsed.screen_recording).toBe("unknown");
    expect(parsed.api_available).toBe(true);
  });

  it("list_apps 不冒充真实枚举：伪桌面 + 可拉起候选（spec 13）", async () => {
    const dir = setupBridgeDir();
    const { runtime, commands } = createRuntime(dir, (command) => {
      expect(command.type).toBe("list_apps");
      return { apps: [], enumeration: "unsupported", reason: "no public API" };
    });
    const apps = await execute(runtime, "list_apps", {});
    const parsed = JSON.parse((apps.content as Array<{ text: string }>)[0].text);
    const ids = parsed.apps.map((app: { bundle_id: string }) => app.bundle_id);
    expect(ids).toContain("ohos.desktop");
    expect(ids).toContain("com.huawei.hmos.browser");
    expect(parsed.note).toContain("not the full installed set");
    expect(commands.map((command) => command.type)).toContain("list_apps");
  });

  it("list_apps 桥失败时仍返回候选并注明原因", async () => {
    const dir = setupBridgeDir();
    const { runtime } = createRuntime(dir, () => {
      throw new Error("bundleManager unavailable");
    });
    const apps = await execute(runtime, "list_apps", {});
    const parsed = JSON.parse((apps.content as Array<{ text: string }>)[0].text);
    expect(parsed.apps[0]).toMatchObject({ bundle_id: "ohos.desktop", running: true });
    expect(parsed.note).toContain("unavailable");
  });

  it("list_windows 返回整屏窗口模型", async () => {
    const { runtime } = createRuntime(setupBridgeDir());
    const windows = await execute(runtime, "list_windows", {});
    const parsed = JSON.parse((windows.content as Array<{ text: string }>)[0].text);
    expect(parsed.windows).toHaveLength(1);
    expect(parsed.windows[0]).toMatchObject({ window_id: 0, focused: true });
  });

  it("get_app_state(app) 先按 bundle 拉起，再经 ArkTS 截屏返回图像", async () => {
    const dir = setupBridgeDir();
    const shotPath = join(dir, "shot.jpeg");
    writeFileSync(shotPath, Buffer.from([1, 2, 3]));
    const { runtime, commands } = createRuntime(dir, (command) => {
      if (command.type === "screenshot") {
        return { path: shotPath, bytes: 3, width: 3120, height: 2080, provider: "arkts-screenshot" };
      }
      return {};
    });
    const result = await execute(runtime, "get_app_state", {
      app: { bundle_id: "com.tencent.mqq" },
      include_screenshot: true,
    });
    const launch = commands.find((command) => command.type === "launch");
    expect(launch?.args).toMatchObject({ bundleName: "com.tencent.mqq" });
    const payload = JSON.parse((result.content as Array<{ text?: string }>)[0].text as string);
    expect(payload.app).toMatchObject({ bundle_id: "com.tencent.mqq", running: true });
    // ack 内容由 ArkTS 决定；这里只验证拉起结果被回传给模型，没有丢。
    expect(payload.launched).toBeDefined();
    expect(result.content.some((block) => block.type === "image")).toBe(true);
  });

  it("get_app_state 拉起失败时把错误交给模型（不静默截图）", async () => {
    const dir = setupBridgeDir();
    const { runtime } = createRuntime(dir, (command) => {
      if (command.type === "launch") {
        const error = new Error("bundle not found") as Error & { code: string };
        error.code = "invalid_request";
        throw error;
      }
      return {};
    });
    const result = await execute(runtime, "get_app_state", { app: { bundle_id: "missing.app" } });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.code).toBe("invalid_request");
    expect(parsed.message).toContain("bundle not found");
  });

  it("桥错误码透传（not_authorized → SDK 可映射）", async () => {
    const dir = setupBridgeDir();
    const { runtime } = createRuntime(dir, () => {
      const error = new Error("permission denied by system") as Error & { code: string };
      error.code = "not_authorized";
      throw error;
    });
    const result = await execute(runtime, "left_click", { target: { type: "coordinate", x: 1, y: 2 } });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text).code).toBe("not_authorized");
  });

  it("桥超时报错且 action_sent=true（可能已发出，不重试语义）", async () => {
    const dir = setupBridgeDir();
    dirs.push(dir);
    // 不建 fake ArkTS：命令永远没有 ack；缩短超时让用例快速落定
    const runtime = createOhosComputerUseRuntime({
      bridgeDir: dir,
      platform: "ohos",
      bridgeTimeoutMs: 300,
    });
    const started = Date.now();
    const result = await runtime.execute({
      toolName: "left_click",
      arguments: { target: { type: "coordinate", x: 1, y: 2 } },
      context: CONTEXT,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.code).toBe("timeout");
    expect(parsed.action_sent).toBe(true);
  }, 5_000);

  it("截图优先走 ArkTS 截屏 API（bridge screenshot），不再写 shots 请求", async () => {
    const dir = setupBridgeDir();
    const shotsDir = join(dir, "shots");
    mkdirSync(shotsDir, { recursive: true });
    const shotPath = join(shotsDir, "shot-arkts.jpeg");
    writeFileSync(shotPath, Buffer.from([9, 9, 9, 9]));
    const { runtime, commands } = createRuntime(dir, (command) => {
      if (command.type === "screenshot") {
        return { path: shotPath, bytes: 4, width: 3120, height: 2080, provider: "arkts-screenshot" };
      }
      return {};
    });

    const result = await execute(runtime, "get_app_state", { include_screenshot: true });

    expect(result.isError).toBeFalsy();
    const items = result.content as Array<{ type: string; text?: string }>;
    expect(items[0]?.text).toContain('"provider":"arkts-screenshot"');
    expect(items[1]?.type).toBe("image");
    // ArkTS 成功时不应再产生 shots 协议的 req 文件。
    expect(readdirSync(shotsDir).filter((name) => name.startsWith("req-"))).toEqual([]);
    expect(commands.map((command) => command.type)).toContain("screenshot");
  });

  it("截屏失败时 get_app_state 降级为文本且 capture 记为 denied", async () => {
    const dir = setupBridgeDir();
    dirs.push(dir);
    const runtime = createOhosComputerUseRuntime({
      bridgeDir: dir,
      platform: "ohos",
      bridgeTimeoutMs: 250,
    });
    const result = await runtime.execute({
      toolName: "get_app_state",
      arguments: { include_screenshot: true },
      context: CONTEXT,
    });
    const blocks = result.content as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(1);
    expect(String(blocks[0].text)).toContain("unavailable");
    const access = await runtime.execute({
      toolName: "request_access",
      arguments: {},
      context: CONTEXT,
    });
    const parsed = JSON.parse((access.content as Array<{ text: string }>)[0].text);
    expect(parsed.screen_recording).toBe("denied");
  }, 5_000);

  it("token 缺失时 fail-closed 报 helper_unavailable", async () => {
    const dir = join(tmpdir(), `zcode-cua-ohos-test-empty-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const runtime = createOhosComputerUseRuntime({ bridgeDir: dir, platform: "ohos" });
    // list_apps 是纯伪模型不走桥；注入类动作才触桥暴露 token 缺失
    const result = await runtime.execute({
      toolName: "left_click",
      arguments: { target: { type: "coordinate", x: 1, y: 2 } },
      context: CONTEXT,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text).code).toBe(
      "helper_unavailable",
    );
  });
});

describe("ohos 工具面适配（P0/P1）", () => {
  it("app_ref 触发拉起，并把窗口矩形作为视觉参照返回", async () => {
    const { runtime, commands } = createRuntime(join(setupBridgeDir(), ""), (command) => {
      if (command.type === "window_layout") {
        return {
          ownWindowRect: { left: 0, top: 0, width: 100, height: 100 },
          windows: [
            { left: 10, top: 20, width: 300, height: 200 },
            { left: 50, top: 60, width: 800, height: 600 },
          ],
        };
      }
      return { launched: true };
    });
    const result = await execute(runtime, "get_app_state", {
      app_ref: { bundle_id: "com.huawei.hmos.browser" },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(payload.launched).toEqual({ launched: true });
    expect(payload.target_window_rect).toEqual({ left: 50, top: 60, width: 800, height: 600 });
    expect(payload.coordinate_space).toBe("display");
    expect(payload.elements).toEqual([]);
    expect(payload.window).toMatchObject({ window_id: 1, display_id: 0 });
    const launch = commands.find((command) => command.type === "launch");
    expect(launch?.args.bundleName).toBe("com.huawei.hmos.browser");
  });

  it("显示名别名解析到默认浏览器 bundle", async () => {
    const { runtime, commands } = createRuntime(join(setupBridgeDir(), ""), () => ({ launched: true }));
    const result = await execute(runtime, "get_app_state", {
      app_ref: { name: "default browser" },
    });
    expect(result.isError).toBeFalsy();
    expect(commands.find((command) => command.type === "launch")?.args.bundleName).toBe(
      "com.huawei.hmos.browser",
    );
  });

  it("HarmonyOS Desktop 解析为伪桌面且不触发拉起", async () => {
    const { runtime, commands } = createRuntime(join(setupBridgeDir(), ""), () => ({}));
    const result = await execute(runtime, "get_app_state", {
      app_ref: { name: "HarmonyOS Desktop" },
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(payload.app.bundle_id).toBe("ohos.desktop");
    expect(commands.some((command) => command.type === "launch")).toBe(false);
  });

  it("list_apps 返回伪桌面 + 可拉起候选", async () => {
    const { runtime } = createRuntime(join(setupBridgeDir(), ""), () => ({ apps: [], enumeration: "unsupported" }));
    const result = await execute(runtime, "list_apps", {});
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    const ids = payload.apps.map((app: { bundle_id: string }) => app.bundle_id);
    expect(ids).toContain("ohos.desktop");
    expect(ids).toContain("com.huawei.hmos.browser");
    expect(String(payload.note)).toContain("not the full installed set");
  });

  it("type 默认走剪贴板 paste，显式 strategy=event 才发 KeyCode", async () => {
    const pasteRun = createRuntime(join(setupBridgeDir(), ""), () => ({}));
    await execute(pasteRun.runtime, "type", { text: "www.baidu.com" });
    expect(pasteRun.commands[0]?.args.ops).toEqual([{ op: "paste", text: "www.baidu.com" }]);

    const eventRun = createRuntime(join(setupBridgeDir(), ""), () => ({}));
    await execute(eventRun.runtime, "type", { text: "A", strategy: "event" });
    const ops = eventRun.commands[0]?.args.ops as Array<Record<string, unknown>>;
    expect(ops.map((op) => op.op)).toEqual(["key_down", "key_down", "key_up", "key_up"]);
    expect(ops[0]).toMatchObject({ key: "shift_left" });
  });

  it("key 接受 mac 风格键名 Control_L+Shift_L+a", async () => {
    const { runtime, commands } = createRuntime(join(setupBridgeDir(), ""), () => ({}));
    const result = await execute(runtime, "key", { text: "Control_L+Shift_L+a" });
    expect(result.isError).toBeFalsy();
    const ops = commands[0]?.args.ops as Array<Record<string, unknown>>;
    expect(ops.slice(0, 3).map((op) => op.key)).toEqual(["ctrl_left", "shift_left", "a"]);
    expect(ops.at(-1)).toMatchObject({ op: "key_up", key: "ctrl_left" });
  });

  it("status.json 缺失但 token 存在时 request_access 仍报 bridge 存活", async () => {
    const { runtime } = createRuntime(join(setupBridgeDir(), ""), () => ({}));
    const result = await execute(runtime, "request_access", {});
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(payload.bridge_alive).toBe(true);
  });
});

describe("createComputerUseRuntime 平台分支", () => {
  it("ohos 平台返回可用 runtime，桥目录常量与 ArkTS 侧约定一致", () => {
    const runtime = createComputerUseRuntime({ platform: "ohos" });
    expect(typeof runtime.execute).toBe("function");
    expect(OHOS_COMPUTER_CONTROL_BRIDGE_DIR).toBe(
      "/data/storage/el2/base/haps/electron/files/computer-control",
    );
  });

  it("非 ohos 平台保持占位 fail-closed", async () => {
    const runtime = createComputerUseRuntime({ platform: "darwin" });
    const result = await runtime.execute({
      toolName: "list_apps",
      arguments: {},
      context: CONTEXT,
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain("not available");
  });
});
