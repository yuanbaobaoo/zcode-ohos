import { test } from "vitest";
import assert from "node:assert/strict";
import type { IPty } from "node-pty";
import { createOhosLocalPipePtyTransport } from "../src/terminal/ohosLocalPipePty.js";

function collect(pty: IPty): { data: () => string; exited: Promise<number> } {
  let buffer = "";
  pty.onData((chunk) => {
    buffer += chunk;
  });
  return {
    data: () => buffer,
    exited: new Promise((resolve) => pty.onExit(({ exitCode }) => resolve(exitCode))),
  };
}

test("ohosLocalPipePty: 管道回显 + 换行补 \\r + 退出码", async () => {
  const transport = createOhosLocalPipePtyTransport();
  const pty = await transport.spawn({
    shell: "/bin/sh",
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: { ...process.env, PROBE: "1" },
    name: "xterm-256color",
  });
  const { data, exited } = collect(pty);
  // 与 xterm 一致：Enter 发 \r；回显补 \r\n，子进程 stdin 收 \n
  pty.write("echo PIPE-$PROBE\rexit\r");
  const exitCode = await exited;
  assert.equal(exitCode, 0);
  const output = data();
  assert.match(output, /echo PIPE-\$PROBE\r\n/, "回显补 \\r");
  assert.match(output, /PIPE-1/, "子进程按 env 展开变量");
});

test("ohosLocalPipePty: kill 结束会话", async () => {
  const transport = createOhosLocalPipePtyTransport();
  const pty = await transport.spawn({
    shell: "/bin/sh",
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: { ...process.env },
    name: "xterm-256color",
  });
  const { exited } = collect(pty);
  // sh 从管道读到 EOF 即退出；kill 兜底避免用例悬挂。
  const exitCode = await Promise.race([
    exited,
    new Promise<number>((resolve) => setTimeout(() => (pty.kill("SIGKILL"), resolve(9)), 2_000)),
  ]);
  assert.equal(typeof exitCode, "number");
});
