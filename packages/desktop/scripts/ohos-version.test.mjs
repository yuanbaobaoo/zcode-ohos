import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

import { readOhosBundleName } from "./ohos-version.mjs";

const ohosRoot = resolve(import.meta.dirname, "../ohos");

const fixtures = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeOhosRoot(template) {
  const root = await mkdtemp(join(tmpdir(), "ohos-bundle-name-"));
  fixtures.push(root);
  await mkdir(join(root, "AppScope"), { recursive: true });
  await writeFile(join(root, "AppScope/app.template.json5"), template, "utf-8");
  return root;
}

it("从真实模板读出 bundleName", () => {
  expect(readOhosBundleName(ohosRoot)).toMatch(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u);
});

it("跳过 // 注释行，不把注释里提到的旧包名当成配置", async () => {
  const root = await makeOhosRoot(
    `{\n  app: {\n    // bundleName: "old.package.name"\n    bundleName: "io.github.example.app",\n  },\n}\n`,
  );
  expect(readOhosBundleName(root)).toBe("io.github.example.app");
});

it("支持花括号内联写法", async () => {
  const root = await makeOhosRoot(`{ app: { bundleName: "io.github.example.app" } }\n`);
  expect(readOhosBundleName(root)).toBe("io.github.example.app");
});

it("缺少 bundleName 时快速失败", async () => {
  const root = await makeOhosRoot(`{\n  app: {\n    vendor: "glm",\n  },\n}\n`);
  expect(() => readOhosBundleName(root)).toThrow(/bundleName/u);
});

it("shortcuts_config 的 wants.bundleName 与模板一致", async () => {
  const shortcutsPath = join(
    ohosRoot,
    "entry/src/main/resources/base/profile/shortcuts_config.json",
  );
  const shortcuts = JSON.parse(await readFile(shortcutsPath, "utf-8"));
  expect(shortcuts.shortcuts[0].wants[0].bundleName).toBe(readOhosBundleName(ohosRoot));
});
