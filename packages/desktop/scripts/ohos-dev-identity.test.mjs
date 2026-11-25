import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyDevWindowTitle,
  buildDevTargetBlock,
  devBundleNameFrom,
  devSigningProblem,
  findMatchingBracket,
  isDevBundleName,
  mergeDevIdentityIntoBuildProfile,
  readDebugProfile,
  withAppBundleName,
  writeDevIdentityMarker,
} from "./ohos-dev-identity.mjs";

const fixtures = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "ohos-dev-identity-"));
  fixtures.push(root);
  return root;
}

const RELEASE = "io.github.example.app";
const DEV = `${RELEASE}.dev`;

// 精简但结构真实的 build-profile（含注释、单/双引号混用），覆盖 products/modules 两个数组。
const PROFILE = `{
  app: {
    products: [
      {
        name: 'default',
        compatibleSdkVersion: '6.0.2(22)',
      },
    ],
    buildModeSet: [
      { name: 'debug' },
    ],
  },
  modules: [
    {
      name: 'electron',
      srcPath: './entry',
      targets: [
        {
          name: 'default',
          applyToProducts: [
            'default',
            'dev',
          ],
        },
      ],
    },
  ],
}
`;

describe("dev 身份派生", () => {
  it("包名后缀是点号分段（bundleName 不允许连字符）", () => {
    expect(devBundleNameFrom(RELEASE)).toBe(DEV);
    expect(isDevBundleName(DEV, RELEASE)).toBe(true);
    expect(isDevBundleName(RELEASE, RELEASE)).toBe(false);
    expect(isDevBundleName(`${RELEASE}.dev2`, RELEASE)).toBe(false);
  });
});

describe("build-profile 合并", () => {
  it("补齐 dev product/target，并把 dev 从 default target 移除", () => {
    const { text, changed } = mergeDevIdentityIntoBuildProfile(PROFILE, { bundleName: DEV });
    expect(changed).toEqual(["dev product", "entry 的 dev target", "从 default target 移除 dev"]);
    expect(text).toContain(`bundleName: '${DEV}'`);
    expect(text).toContain("$string:app_name_dev");
    const products = text.slice(text.indexOf("products:"), text.indexOf("buildModeSet:"));
    expect(products).toContain("name: 'dev'");
    const targets = text.slice(text.indexOf("targets:"));
    // default target 只剩 default；dev target 单独一条。
    expect(targets).toContain("name: 'dev'");
    const defaultBlock = targets.slice(0, targets.indexOf("name: 'dev'"));
    expect(defaultBlock).not.toContain("'dev'");
  });

  it("幂等：已含 dev product/target 时不再改写", () => {
    const first = mergeDevIdentityIntoBuildProfile(PROFILE, { bundleName: DEV }).text;
    const second = mergeDevIdentityIntoBuildProfile(first, { bundleName: DEV });
    expect(second.changed).toEqual([]);
    expect(second.text).toBe(first);
  });

  it("注释与字符串里的括号不影响结构定位", () => {
    const noisy = `{
  // 模板说明：中文注释里的 products: [] 不是结构
  // products: [] 只是注释
  app: {
    products: [
      { name: 'default', note: "含 ] 和 } 的字符串" },
    ],
  },
  modules: [
    { name: 'electron', srcPath: './entry', targets: [ { name: 'default', applyToProducts: ['default'] } ] },
  ],
}
`;
    expect(findMatchingBracket(noisy, noisy.indexOf("["))).toBeGreaterThan(0);
    const { changed, text } = mergeDevIdentityIntoBuildProfile(noisy, { bundleName: DEV });
    expect(changed).toEqual(["dev product", "entry 的 dev target"]);
    // 注释原样保留，dev product 追加到真正的 products 数组里。
    expect(text).toContain("// products: [] 只是注释");
    const products = text.slice(text.indexOf("app:"), text.indexOf("modules:"));
    expect(products).toContain(`bundleName: '${DEV}'`);
    expect(products).toContain("name: 'dev'");
  });

  it("真实模板已含 dev 条目，合并是幂等的（注释/中文不影响定位）", async () => {
    const templatePath = new URL("../ohos/build-profile.template.json5", import.meta.url);
    const template = await readFile(templatePath, "utf-8");
    const { changed, text } = mergeDevIdentityIntoBuildProfile(template, { bundleName: DEV });
    expect(changed).toEqual([]);
    expect(text).toBe(template);
  });

  it("dev target 文本块只有 applyToProducts", () => {
    expect(buildDevTargetBlock()).toContain("applyToProducts");
    expect(buildDevTargetBlock()).not.toContain("bundleName");
  });
});

describe("profile 解析", () => {
  it("从 .p7b 内嵌 JSON 读出包名/失效时间/设备", async () => {
    const root = await makeRoot();
    const file = join(root, "dev_ohos_x=.p7b");
    const payload = JSON.stringify({
      "bundle-info": { "bundle-name": DEV },
      validity: { "not-after": 2_000_000_000 },
      "debug-info": { "device-ids": ["a".repeat(64)] },
    });
    await writeFile(file, Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(payload, "latin1")]));
    expect(readDebugProfile(file)).toEqual({
      bundleName: DEV,
      notAfter: 2_000_000_000,
      deviceIds: ["A".repeat(64)],
    });
  });

  it("无法解析时返回 null", async () => {
    const root = await makeRoot();
    const file = join(root, "bad.p7b");
    await writeFile(file, "not a profile");
    expect(readDebugProfile(file)).toBeNull();
    expect(readDebugProfile(join(root, "missing.p7b"))).toBeNull();
  });
});

describe("dev 签名可用性", () => {
  async function writeProfile(dir, name, payload) {
    await writeFile(join(dir, name), Buffer.from(`x${JSON.stringify(payload)}`, "latin1"));
  }

  const udid = "A".repeat(64);

  it("目录为空、包名不符、过期、缺设备分别给出原因", async () => {
    const root = await makeRoot();
    expect(devSigningProblem({ materialsDir: root, bundleName: DEV, udids: [] })).toMatch(
      /dev 签名材料/u,
    );

    // 正式 product 的材料不参与 dev 判定（正式 HAP 不签名）。
    await writeProfile(root, "default_ohos_x=.p7b", {
      "bundle-info": { "bundle-name": RELEASE },
      validity: { "not-after": 2_000_000_000 },
      "debug-info": { "device-ids": [] },
    });
    expect(devSigningProblem({ materialsDir: root, bundleName: DEV, udids: [] })).toMatch(
      /dev 签名材料/u,
    );

    await writeProfile(root, "dev_ohos_x=.p7b", {
      "bundle-info": { "bundle-name": RELEASE },
      validity: { "not-after": 2_000_000_000 },
      "debug-info": { "device-ids": [] },
    });
    expect(devSigningProblem({ materialsDir: root, bundleName: DEV, udids: [] })).toMatch(
      /没有绑定/u,
    );

    await writeProfile(root, "dev_ohos_x=.p7b", {
      "bundle-info": { "bundle-name": DEV },
      validity: { "not-after": 1 },
      "debug-info": { "device-ids": [udid] },
    });
    expect(devSigningProblem({ materialsDir: root, bundleName: DEV, udids: [] })).toMatch(/过期/u);

    await writeProfile(root, "dev_ohos_x=.p7b", {
      "bundle-info": { "bundle-name": DEV },
      validity: { "not-after": 2_000_000_000 },
      "debug-info": { "device-ids": [] },
    });
    expect(
      devSigningProblem({ materialsDir: root, bundleName: DEV, udids: ["B".repeat(64)] }),
    ).toMatch(/未覆盖设备/u);
  });

  it("绑定开发包名且覆盖设备时可用", async () => {
    const root = await makeRoot();
    await writeProfile(root, "dev_ohos_x=.p7b", {
      "bundle-info": { "bundle-name": DEV },
      validity: { "not-after": 2_000_000_000 },
      "debug-info": { "device-ids": [udid] },
    });
    expect(
      devSigningProblem({ materialsDir: root, bundleName: DEV, udids: [udid.toLowerCase()] }),
    ).toBeNull();
  });
});

describe("app.json5 临时改写", () => {
  async function makeOhosRoot() {
    const root = await makeRoot();
    await mkdir(join(root, "AppScope"), { recursive: true });
    await writeFile(
      join(root, "AppScope/app.template.json5"),
      `{\n  app: {\n    bundleName: "${RELEASE}",\n  },\n}\n`,
    );
    await writeFile(
      join(root, "AppScope/app.json5"),
      `{\n  app: {\n    bundleName: "${RELEASE}",\n    versionName: "0.0.0-dev",\n  },\n}\n`,
    );
    return { root };
  }

  it("执行期间是开发包名，结束后还原", async () => {
    const { root } = await makeOhosRoot();
    const appJson = join(root, "AppScope/app.json5");
    withAppBundleName(root, DEV, () => {
      expect(readFileSync(appJson, "utf-8")).toContain(`bundleName: "${DEV}"`);
    });
    expect(await readFile(appJson, "utf-8")).toContain(`bundleName: "${RELEASE}"`);
  });

  it("action 抛错也会还原", async () => {
    const { root } = await makeOhosRoot();
    expect(() =>
      withAppBundleName(root, DEV, () => {
        throw new Error("boom");
      }),
    ).toThrow(/boom/u);
    expect(await readFile(join(root, "AppScope/app.json5"), "utf-8")).toContain(
      `bundleName: "${RELEASE}"`,
    );
  });
});

describe("dev 窗口标题", () => {
  async function makeStaged(appHtml) {
    const root = await makeRoot();
    const renderer = join(root, "out/renderer");
    await mkdir(renderer, { recursive: true });
    if (appHtml !== null) await writeFile(join(renderer, "index.html"), appHtml);
    return root;
  }

  it("把 <title> 改成 -dev，且幂等", async () => {
    const root = await makeStaged("<!doctype html><html><head><title>ZCode</title></head></html>");
    expect(applyDevWindowTitle(root)).toBe(true);
    expect(await readFile(join(root, "out/renderer/index.html"), "utf-8")).toContain(
      "<title>ZCode-dev</title>",
    );
    expect(applyDevWindowTitle(root)).toBe(false);
  });

  it("缺文件或没有 title 时跳过，不改写", async () => {
    const missing = await makeStaged(null);
    expect(applyDevWindowTitle(missing)).toBe(false);
    const noTitle = await makeStaged("<html><head></head></html>");
    expect(applyDevWindowTitle(noTitle)).toBe(false);
  });
});

describe("dev 身份标记", () => {
  it("写 config/dev-identity.json，只标识身份", async () => {
    const root = await makeRoot();
    expect(writeDevIdentityMarker(root)).toBe(true);
    const marker = JSON.parse(await readFile(join(root, "config/dev-identity.json"), "utf-8"));
    expect(marker).toEqual({ identity: "dev" });
  });
});
