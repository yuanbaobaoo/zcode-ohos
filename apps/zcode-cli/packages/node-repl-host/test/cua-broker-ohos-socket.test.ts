// spec：specs/ohos-port/15-单控制通道与平台适配治理.md —— CUA broker 的 socket 目录
// 背景：OHOS 真实 home 拦截 AF_UNIX 路径型 bind（spec 03 平台事实），socket 必须落 host
// 下发的 ZCODE_OHOS_SOCKET_DIR（el2 tmp）。曾经固定用 tmpdir()：bind 失败但 js cell 仍拿到
// 一个不存在的 socketPath，SDK 只能报 "runtime bridge unavailable"（真机实证）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ComputerUseRuntime } from "@zcode/zcode-cua";
import { createNodeReplCuaBroker } from "../src/cua-broker.js";
import { createNodeReplCallLedger } from "../src/call-ledger/contract.js";

const runtime: ComputerUseRuntime = {
  async execute() {
    return { content: [] };
  },
  async closeSession() {},
  async dispose() {},
};

const SAVED_ENV = {
  dir: process.env.ZCODE_OHOS_SOCKET_DIR,
  ohos: process.env.ZCODE_OHOS_RUNTIME,
};

function restoreEnv(): void {
  for (const [key, value] of [
    ["ZCODE_OHOS_SOCKET_DIR", SAVED_ENV.dir],
    ["ZCODE_OHOS_RUNTIME", SAVED_ENV.ohos],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// Windows 的 net.Server.listen 只接受命名管道，无路径型 UDS 分支（同 cua-bridge.test.ts 的说明）。
const posixOnly = process.platform === "win32" ? describe.skip : describe;

posixOnly("node_repl CUA broker 的 socket 目录", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    restoreEnv();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("OHOS 身份下 socket 落在 ZCODE_OHOS_SOCKET_DIR", async () => {
    // 用 /tmp 而非 os.tmpdir()：macOS 的 /var/folders 前缀会让 UDS 路径超过 104 字节
    // （sun_path 上限，EINVAL），与产品行为无关；设备上的 socket 目录是 el2 短路径。
    tempDir = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "zn-"));
    process.env.ZCODE_OHOS_SOCKET_DIR = tempDir;
    // 权威信号：MCP 子进程的 platform 报 linux，身份由 host 注入的标记继承（spec 15）。
    process.env.ZCODE_OHOS_RUNTIME = "1";

    const broker = createNodeReplCuaBroker({
      runtime,
      ledger: createNodeReplCallLedger(),
      platform: "linux",
    });
    await broker.ready;
    try {
      expect(dirname(broker.connection.socketPath)).toBe(tempDir);
      expect(broker.connection.socketPath).toMatch(/znrc-.*\.sock$/u);
    } finally {
      await broker.close();
    }
  });

  it("非 OHOS 仍走 tmpdir（行为与改动前一致）", async () => {
    delete process.env.ZCODE_OHOS_RUNTIME;
    delete process.env.ZCODE_OHOS_SOCKET_DIR;

    const broker = createNodeReplCuaBroker({
      runtime,
      ledger: createNodeReplCallLedger(),
      platform: process.platform === "win32" ? "linux" : process.platform,
    });
    await broker.ready;
    try {
      expect(dirname(broker.connection.socketPath)).toBe(tmpdir());
    } finally {
      await broker.close();
    }
  });
});
