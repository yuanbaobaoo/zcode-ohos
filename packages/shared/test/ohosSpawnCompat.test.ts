import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startPluginHostWorker } from "../src/ohosSpawnCompat.js";

function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("waitFor timeout"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe("ohosSpawnCompat plugin host worker", () => {
  it("bridges argv/env/stdout/stderr/stdin and propagates the exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ohos-spawn-"));
    const serverPath = join(dir, "server.cjs");
    const entry = join(dir, "entry.cjs");
    writeFileSync(serverPath, "");
    writeFileSync(
      entry,
      `
      const serverArg = process.argv[process.argv.length - 1];
      console.log("argv-ok:" + serverArg.endsWith("server.cjs") + ":env:" + process.env.OHOS_TEST_ENV);
      console.error("stderr-ok");
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line === "exit7") {
            process.exit(7);
          }
          process.stdout.write("echo:" + line + "\\n");
        }
      });
      `,
    );

    const child = startPluginHostWorker(
      [process.execPath, entry, "__zcode-plugin-host", serverPath],
      { env: { OHOS_TEST_ENV: "1" } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exitCode = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const spawned = new Promise<void>((resolve) => child.once("spawn", resolve));

    await spawned;
    await waitFor(() => stdout.includes("argv-ok:true:env:1") && stderr.includes("stderr-ok"));
    child.stdin.write("ping\n");
    await waitFor(() => stdout.includes("echo:ping"));
    child.stdin.write("exit7\n");

    await expect(exitCode).resolves.toBe(7);
  }, 15_000);
});
