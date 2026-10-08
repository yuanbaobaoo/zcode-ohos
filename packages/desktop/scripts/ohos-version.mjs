// OHOS 发版 tag → HAP versionName/versionCode 的构建期实现。
// 脚本无法 import TS，按 desktop-product-identity.mjs 先例镜像 shared/ohosReleaseVersion.ts
//（规则与测试以 shared 为准，详见 specs/ohos-port/04）。

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSION_TAG_PATTERN = /^v\d+\.\d+\.\d+/;
const OHOS_TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-ohos-(patch|fix)(\d+))?$/;
const LOOSE_TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-.+)?$/;

function looksLikeVersionTag(value) {
  return typeof value === "string" && VERSION_TAG_PATTERN.test(value.trim());
}

/**
 * 解析发版 tag：GITHUB_REF_NAME（CI tag 构建）> git describe 精确命中 > null（开发态）。
 * 只接受 vX.Y.Z 开头的值，避免把分支名等误当版本。
 */
export function resolveOhosReleaseVersion(env = process.env, cwd) {
  if (looksLikeVersionTag(env.GITHUB_REF_NAME)) {
    return env.GITHUB_REF_NAME.trim();
  }

  try {
    const described = execSync("git describe --tags --exact-match --match 'v*'", {
      cwd: cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (looksLikeVersionTag(described)) {
      return described;
    }
  } catch {
    // 不在任何 tag 上（常态开发分支）
  }

  return null;
}

function parseOhosTag(tag) {
  const value = tag.trim();
  const strict = OHOS_TAG_PATTERN.exec(value);
  if (strict?.[4] !== undefined && strict[5] !== undefined) {
    return {
      major: Number(strict[1]),
      minor: Number(strict[2]),
      patch: Number(strict[3]),
      kind: strict[4] === "patch" ? "patch" : "fix",
      seq: Number(strict[5]),
    };
  }

  const loose = LOOSE_TAG_PATTERN.exec(value);
  if (loose) {
    return {
      major: Number(loose[1]),
      minor: Number(loose[2]),
      patch: Number(loose[3]),
      kind: value.includes("-") ? "dev" : "base",
      seq: 0,
    };
  }

  return null;
}

// (major*10000 + minor*100 + patch) * 1000 + seq；约束与单调性证明见 spec 04。
export function ohosVersionCodeFromTag(tag) {
  const parsed = parseOhosTag(tag);
  if (!parsed) {
    throw new Error(`无法从 tag 推导 versionCode: ${tag}`);
  }
  if (parsed.minor > 99 || parsed.patch > 99) {
    throw new Error(`versionCode 编码不支持 minor/patch > 99: ${tag}`);
  }

  let seq = 0;
  if (parsed.kind === "fix") {
    seq = parsed.seq;
  } else if (parsed.kind === "patch") {
    seq = 500 + parsed.seq;
  }
  if (seq > 999) {
    throw new Error(`versionCode 编码不支持 fix/patch 序号 > 499: ${tag}`);
  }

  return (parsed.major * 10_000 + parsed.minor * 100 + parsed.patch) * 1_000 + seq;
}

// 开发态占位：versionCode 恒大于任何 release 编码，保证 dev 装机始终是"升级"。
const DEV_VERSION_NAME = "0.0.0-dev";
const DEV_VERSION_CODE = 1_000_000_000;

/**
 * 从 AppScope/app.template.json5 生成 AppScope/app.json5（占位符替换，模板保持合法 JSON5）。
 * versionName 优先 build-meta 的 ohosReleaseVersion（CI tag 构建）；开发态回退 0.0.0-dev。
 */
export function ensureOhosAppJson5(ohosRoot, { buildMetadata, log } = {}) {
  const templatePath = join(ohosRoot, "AppScope/app.template.json5");
  const outputPath = join(ohosRoot, "AppScope/app.json5");
  const releaseVersion = buildMetadata?.ohosReleaseVersion ?? null;

  let versionName;
  let versionCode;
  if (releaseVersion) {
    versionName = releaseVersion.startsWith("v") ? releaseVersion.slice(1) : releaseVersion;
    versionCode = ohosVersionCodeFromTag(releaseVersion);
  } else {
    versionName = DEV_VERSION_NAME;
    versionCode = DEV_VERSION_CODE;
  }

  const generated = readFileSync(templatePath, "utf-8")
    .replace('"__OHOS_VERSION_NAME__"', JSON.stringify(versionName))
    .replace('"__OHOS_VERSION_CODE__"', String(versionCode));
  writeFileSync(outputPath, generated, "utf-8");
  log?.(`AppScope/app.json5 versionName=${versionName} versionCode=${versionCode}`);
  return { versionName, versionCode };
}
