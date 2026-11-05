// spec：specs/ohos-port/15-单控制通道与平台适配治理.md（M4）
// 桥原语的最小契约：原子写、坏文件 fail-closed、请求文件文本写。
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonSync, writeJsonAtomic, writeTextAtomic } from "../src/main/ohos/fileBridge.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ohos-bridge-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("ohos 文件桥原语", () => {
  it("原子写后可读回，且不残留临时文件", () => {
    const dir = tempDir();
    const path = join(dir, "status.json");
    writeJsonAtomic(path, { permission: "granted" });

    expect(readJsonSync<{ permission: string }>(path)).toEqual({ permission: "granted" });
    expect(readdirSync(dir)).toEqual(["status.json"]);
  });

  it("坏 JSON / 缺文件返回 undefined（fail-closed，不抛）", () => {
    const dir = tempDir();
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json", "utf8");

    expect(readJsonSync(broken)).toBeUndefined();
    expect(readJsonSync(join(dir, "missing.json"))).toBeUndefined();
  });

  it("文本原子写用于请求文件（有即是请求）", () => {
    const dir = tempDir();
    const path = join(dir, "permission.request");
    writeTextAtomic(path, "1700000000000\n");

    expect(readFileSync(path, "utf8")).toBe("1700000000000\n");
  });
});
