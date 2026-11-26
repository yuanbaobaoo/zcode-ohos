// OHOS 版本号：唯一来源是仓库根 package.json —— version（zcode core，随上游同步）+
// ohos.patch（OHOS 补丁序号）。构建不读 git tag；tag 只作为发布标签，由 CI 做一致性断言
// （specs/ohos-port/04）。脚本无法 import TS，编码规则镜像 shared/ohosReleaseVersion.ts。

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const OHOS_TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-ohos-(patch|fix)(\d+))?$/;
const LOOSE_TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-.+)?$/;
const CORE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

// versionCode 编码上限：补丁序号 +500 不能越过 999，core 的 minor/patch 各 ≤ 99。
export const OHOS_MAX_PATCH = 499;
// dev 装机版本固定大数：恒大于任何 release 编码，且不随 patch 变化 —— 已在装的 dev 包
// 不会因为补丁序号回退被判成降级。
export const OHOS_DEV_VERSION_CODE = 1_000_000_000;

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

/**
 * 从 package.json 派生发版身份，是 versionName / versionCode / 产物名 / 发版 tag 的唯一拼接点。
 * - `version` = core（随上游同步），`ohos.patch` = 当前已发版的补丁序号（0 = 基线，不带补丁号）；
 * - 产物名把 `-ohos-` 落到 `-`（`4.0.0-patch4`），沿用既有资产命名，与 tag 书写顺序解耦；
 * - versionCode 复用 tag 编码（ohosVersionCodeFromTag），与历史版本保持同一套单调性。
 */
export function resolveOhosReleaseIdentity(packageJson) {
  const core = String(packageJson?.version ?? "").trim();
  const match = CORE_VERSION_PATTERN.exec(core);
  if (!match) {
    throw new Error(`package.json 的 version 需要 X.Y.Z（当前：${core || "(空)"}）`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const corePatch = Number(match[3]);
  // 归一前导零：返回的身份与 versionCode 编码、tag 解析必须同一个字符串。
  const coreVersion = `${major}.${minor}.${corePatch}`;
  if (minor > 99 || corePatch > 99) {
    throw new Error(`versionCode 编码不支持 minor/patch > 99（当前 ${coreVersion}）：请先升 major`);
  }

  const patch = packageJson?.ohos?.patch;
  if (!Number.isInteger(patch) || patch < 0) {
    throw new Error(
      `package.json 缺少整数 ohos.patch（0..${OHOS_MAX_PATCH}），当前：${JSON.stringify(patch)}`,
    );
  }
  if (patch > OHOS_MAX_PATCH) {
    throw new Error(
      `ohos.patch 不能超过 ${OHOS_MAX_PATCH}（versionCode 编码上限），当前 ${patch}：` +
        "先升 package.json 的 version",
    );
  }

  const versionName = patch === 0 ? coreVersion : `${coreVersion}-ohos-patch${patch}`;
  const releaseTag = `v${versionName}`;
  return {
    coreVersion,
    patch,
    versionName,
    devVersionName: `${versionName}-dev`,
    artifactVersion: patch === 0 ? coreVersion : `${coreVersion}-patch${patch}`,
    releaseTag,
    versionCode: ohosVersionCodeFromTag(releaseTag),
  };
}

/** 读取仓库根 package.json 并派生身份；构建与 dev 都走这一条。 */
export function readOhosReleaseIdentity(root) {
  return resolveOhosReleaseIdentity(JSON.parse(readFileSync(join(root, "package.json"), "utf-8")));
}

/**
 * 发版 tag 一致性断言（CI 用）：只比较，不参与版本推导。
 * 不一致会让 Release 标签与 HAP 版本错位，客户端会永远认为"有新版本"。
 */
export function assertOhosReleaseTag(identity, tag) {
  const normalized = String(tag ?? "").trim();
  if (normalized !== identity.releaseTag) {
    throw new Error(
      `tag 与 package.json 不一致：tag=${normalized || "(空)"}，` +
        `期望 ${identity.releaseTag}（version ${identity.coreVersion} + ohos.patch ${identity.patch}）`,
    );
  }
  return true;
}

/**
 * 读取 AppScope/app.template.json5 的 bundleName，作为脚本侧唯一来源。
 * 模板保持 JSON5（含 // 注释），这里按行跳过注释行后取字面量：避免为一次读取引入
 * json5 依赖，也避免 dev-ohos.mjs 的 hdc 命令再抄一份包名。
 */
export function readOhosBundleName(ohosRoot) {
  const templatePath = join(ohosRoot, "AppScope/app.template.json5");
  for (const line of readFileSync(templatePath, "utf-8").split(/\r?\n/)) {
    if (line.trim().startsWith("//")) continue;
    const match = /bundleName:\s*"([^"]+)"/.exec(line);
    if (match) return match[1];
  }
  throw new Error(`AppScope/app.template.json5 未找到 bundleName: ${templatePath}`);
}

/**
 * 从 AppScope/app.template.json5 生成 AppScope/app.json5（占位符替换，模板保持合法 JSON5）。
 * 版本由调用方给：`ohos:bundle` 传 package.json 派生身份，`ohos:run` 传同源的 `-dev` 版本，
 * 本函数不猜版本（历史上"拿不到 tag 就写 0.0.0-dev"让本地正式包的版本与文件名对不上）。
 */
export function ensureOhosAppJson5(ohosRoot, { versionName, versionCode, log } = {}) {
  if (!versionName || !Number.isInteger(versionCode)) {
    throw new Error(
      "ensureOhosAppJson5 需要 versionName 与整数 versionCode（见 resolveOhosReleaseIdentity）",
    );
  }
  const templatePath = join(ohosRoot, "AppScope/app.template.json5");
  const outputPath = join(ohosRoot, "AppScope/app.json5");

  const generated = readFileSync(templatePath, "utf-8")
    .replace('"__OHOS_VERSION_NAME__"', JSON.stringify(versionName))
    .replace('"__OHOS_VERSION_CODE__"', String(versionCode));
  writeFileSync(outputPath, generated, "utf-8");
  log?.(`AppScope/app.json5 versionName=${versionName} versionCode=${versionCode}`);
  return { versionName, versionCode };
}

function formatIdentity(identity) {
  return [
    `core          ${identity.coreVersion}`,
    `ohos.patch    ${identity.patch}`,
    `versionName   ${identity.versionName}`,
    `versionCode   ${identity.versionCode}`,
    `tag           ${identity.releaseTag}`,
    `产物版本段    ${identity.artifactVersion}`,
    `dev 版本      ${identity.devVersionName}（versionCode ${OHOS_DEV_VERSION_CODE}）`,
  ].join("\n");
}

function parseIdentityArgv(argv) {
  const index = argv.indexOf("--assert-tag");
  return { assertTag: index === -1 ? null : (argv[index + 1] ?? "") };
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  try {
    const identity = readOhosReleaseIdentity(resolve(import.meta.dirname, "..", "..", ".."));
    const { assertTag } = parseIdentityArgv(process.argv.slice(2));
    if (assertTag !== null) {
      assertOhosReleaseTag(identity, assertTag);
      console.log(`[ohos-version] ${assertTag} 与 package.json 一致`);
    } else {
      console.log(formatIdentity(identity));
    }
  } catch (error) {
    console.error(`[ohos-version] ERROR: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
