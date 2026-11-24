// spec：specs/ohos-port/15-平台适配治理与不变量 · 浏览器控制桥的 socket 目录
// 背景：OHOS 真实 home 拦截 AF_UNIX 路径型 bind（spec 03 平台事实），socket 必须落 host
// 下发的 ZCODE_OHOS_SOCKET_DIR（el2 tmp）。曾经固定用 tmpdir()：bind 失败但内核仍拿到
// 不存在的 socketPath，浏览器控制只能报“连接套接字不存在”（真机实证）。
// 规则与 cua-broker（znrc）和 bootstrap 的 browser broker（znr）保持一致。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNodeReplBrowserBrokerProxy,
  createNodeReplCallLedger,
} from "../src/call-ledger/contract.js";

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

// Windows 的 net.Server.listen 只接受命名管道，无路径型 UDS 分支（同 cua-broker-ohos-socket.test.ts）。
const posixOnly = process.platform === "win32" ? describe.skip : describe;

posixOnly("node_repl 浏览器 broker 代理的 socket 目录", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    restoreEnv();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("OHOS 身份下 socket 落在 ZCODE_OHOS_SOCKET_DIR", async () => {
    tempDir = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "znb-"));
    process.env.ZCODE_OHOS_SOCKET_DIR = tempDir;
    // 权威信号：MCP 子进程的 platform 报 linux，身份由 host 注入的标记继承（spec 15）。
    process.env.ZCODE_OHOS_RUNTIME = "1";

    const proxy = createNodeReplBrowserBrokerProxy({
      ledger: createNodeReplCallLedger(),
      platform: "linux",
    });
    await proxy.ready;
    try {
      expect(dirname(proxy.connection.socketPath)).toBe(tempDir);
      expect(proxy.connection.socketPath).toMatch(/znrb-.*\.sock$/u);
    } finally {
      await proxy.close();
    }
  });

  it("非 OHOS 仍走 tmpdir（行为与改动前一致）", async () => {
    delete process.env.ZCODE_OHOS_RUNTIME;
    delete process.env.ZCODE_OHOS_SOCKET_DIR;

    const proxy = createNodeReplBrowserBrokerProxy({
      ledger: createNodeReplCallLedger(),
      platform: process.platform === "win32" ? "linux" : process.platform,
    });
    await proxy.ready;
    try {
      expect(dirname(proxy.connection.socketPath)).toBe(tmpdir());
    } finally {
      await proxy.close();
    }
  });
});
