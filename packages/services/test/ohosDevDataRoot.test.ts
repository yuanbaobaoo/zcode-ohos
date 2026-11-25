import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyOhosDevDataRootEnv, hasOhosDevIdentity } from "../src/ohos/ohosDevDataRoot.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeAppDir(): { appDir: string; marker: string } {
  const appDir = mkdtempSync(join(tmpdir(), "zcode-ohos-dev-identity-"));
  roots.push(appDir);
  return { appDir, marker: join(appDir, "dev-identity.json") };
}

describe("ohos dev data root", () => {
  it("无标记：不是 dev 身份，不改 env", () => {
    const { appDir } = makeAppDir();
    const marker = join(appDir, "missing.json");
    const env: NodeJS.ProcessEnv = { ZCODE_DATA_BASE_DIR: "/storage/Users/currentUser" };
    expect(hasOhosDevIdentity(marker)).toBe(false);
    expect(applyOhosDevDataRootEnv("/storage/Users/currentUser", env, marker)).toBeNull();
    expect(env).toEqual({ ZCODE_DATA_BASE_DIR: "/storage/Users/currentUser" });
  });

  it("有标记：数据根与会话库指向 .zcode-dev，base dir 不变", () => {
    const { appDir, marker } = makeAppDir();
    writeFileSync(marker, JSON.stringify({ identity: "dev" }), "utf-8");
    const env: NodeJS.ProcessEnv = { ZCODE_DATA_BASE_DIR: "/storage/Users/currentUser" };
    expect(hasOhosDevIdentity(marker)).toBe(true);
    expect(applyOhosDevDataRootEnv("/storage/Users/currentUser", env, marker)).toBe(
      "/storage/Users/currentUser/.zcode-dev",
    );
    expect(env.ZCODE_DATA_ROOT_DIR).toBe("/storage/Users/currentUser/.zcode-dev");
    expect(env.ZCODE_HOME).toBe("/storage/Users/currentUser/.zcode-dev");
    expect(env.ZCODE_SESSION_DB_PATH).toBe(
      "/storage/Users/currentUser/.zcode-dev/cli/db/db.sqlite",
    );
    expect(env.ZCODE_DATA_BASE_DIR).toBe("/storage/Users/currentUser");
  });
});
