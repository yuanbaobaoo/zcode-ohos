// 鸿蒙发版 tag 的解析、排序与 HAP versionCode 推导（specs/ohos-port/04-版本与更新.md）。
// 排序必须与发版时序一致：v3.14.3-dev → v3.14.3 → v3.14.3-ohos-fix2 → v3.14.3-ohos-patch1..N。

export type OhosReleaseVersionKind = "base" | "dev" | "fix" | "patch";

export interface OhosReleaseVersion {
  major: number;
  minor: number;
  patch: number;
  kind: OhosReleaseVersionKind;
  // fix/patch 的序号；base/dev 恒为 0。
  seq: number;
}

const OHOS_TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-ohos-(patch|fix)(\d+))?$/;
const LOOSE_TAG_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-.+)?$/;

// 解析 tag；未识别后缀（如 -dev）按基线处理（kind="dev"），完全不成形返回 null。
export function parseOhosReleaseVersion(tag: string): OhosReleaseVersion | null {
  const value = tag.trim();
  const strict = OHOS_TAG_PATTERN.exec(value);
  // 后缀是可选捕获组：裸基线也能命中 strict，必须以第 4 组存在才认定 fix/patch。
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

function kindRank(kind: OhosReleaseVersionKind): number {
  // base 与 dev 同级：v3.14.3-dev 与 v3.14.3 之间不提示更新（dev 是基线发布前的产物）。
  switch (kind) {
    case "fix":
      return 1;
    case "patch":
      return 2;
    default:
      return 0;
  }
}

// a > b 返回正数、相等 0、a < b 负数。任一侧无法解析时返回 null，由调用方决定降级策略。
export function compareOhosReleaseVersions(a: OhosReleaseVersion, b: OhosReleaseVersion): number {
  const baseDiff = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (baseDiff !== 0) {
    return baseDiff;
  }

  const rankDiff = kindRank(a.kind) - kindRank(b.kind);
  if (rankDiff !== 0) {
    return rankDiff;
  }

  return a.seq - b.seq;
}

// 便捷封装：比较两个 tag 字符串；任一无法解析返回 null。
export function compareOhosReleaseTags(a: string, b: string): number | null {
  const left = parseOhosReleaseVersion(a);
  const right = parseOhosReleaseVersion(b);
  if (!left || !right) {
    return null;
  }
  return compareOhosReleaseVersions(left, right);
}

/**
 * HAP versionCode：`(major*10000 + minor*100 + patch) * 1000 + seq`。
 * seq：base/dev=0、fix=N(1-499)、patch=500+N(501-999)。
 * 约束 minor/patch ≤ 99、fix/patch 序号 ≤ 499（保证 int32 且跨基线单调，
 * 如 3.14.3-ohos-patch7=31,403,507 < 3.14.4=31,404,000）。构建期越界直接抛错。
 */
export function ohosVersionCodeFromTag(tag: string): number {
  const parsed = parseOhosReleaseVersion(tag);
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

export interface OhosGithubReleaseInfo {
  // 去 v 前缀的 tag 版本（如 3.14.3-ohos-patch7），作为 UpdateStatePayload.version。
  version: string;
  title: string;
  markdown: string | null;
  releaseDate?: string;
  // release 页面地址，「前往下载」按钮用浏览器打开的目标。
  htmlUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

// GitHub `GET /repos/:owner/:repo/releases/latest` 响应 → 更新弹窗所需信息；字段缺失返回 null。
export function mapGithubReleaseToUpdateInfo(release: unknown): OhosGithubReleaseInfo | null {
  if (!isRecord(release)) {
    return null;
  }

  const tagName = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
  const htmlUrl = typeof release.html_url === "string" ? release.html_url.trim() : "";
  if (!tagName || !htmlUrl) {
    return null;
  }

  const markdown =
    typeof release.body === "string" && release.body.trim() !== "" ? release.body.trim() : null;
  const releaseDate =
    typeof release.published_at === "string" && release.published_at.trim() !== ""
      ? release.published_at.trim()
      : undefined;

  return {
    version: tagName.startsWith("v") ? tagName.slice(1) : tagName,
    title: tagName,
    markdown,
    ...(releaseDate ? { releaseDate } : {}),
    htmlUrl,
  };
}

const HTML_ENTITY_UNESCAPES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function unescapeXmlEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (entity) => {
    return HTML_ENTITY_UNESCAPES[entity] ?? entity;
  });
}

/**
 * 解析 `releases.atom` 网页端点（无 API 限额）：取首个 entry 作为最新版本，
 * 不带更新日志正文。降级背景与 prerelease 语义差异见 specs/ohos-port/04。
 */
export function parseOhosReleaseAtomFeed(xml: string): OhosGithubReleaseInfo | null {
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml);
  if (!entry) {
    return null;
  }

  const title = /<title>([\s\S]*?)<\/title>/.exec(entry[1] ?? "");
  const tagName = title ? unescapeXmlEntities(title[1] ?? "").trim() : "";
  if (!tagName) {
    return null;
  }

  const updated = /<updated>([\s\S]*?)<\/updated>/.exec(entry[1] ?? "");
  const releaseDate = updated ? (updated[1] ?? "").trim() : undefined;

  return {
    version: tagName.startsWith("v") ? tagName.slice(1) : tagName,
    title: tagName,
    markdown: null,
    ...(releaseDate ? { releaseDate } : {}),
    htmlUrl: `https://github.com/yuanbaobaoo/zcode-ohos/releases/tag/${encodeURIComponent(tagName)}`,
  };
}

/**
 * 解析 git smart-http refs 公告（`/info/refs?service=git-upload-pack`），取可解析的最大
 * tag。用于 GitCode 镜像版本探测（无限流，无 release 内容）；跳转地址仍指向 GitHub
 * release 页。端点选型依据见 specs/ohos-port/04。
 */
export function pickLatestOhosTagFromGitRefAdvertisement(
  body: string,
): OhosGithubReleaseInfo | null {
  let latest: OhosReleaseVersion | null = null;
  let latestTag = "";
  for (const line of body.split("\n")) {
    // 注解 tag 会紧跟一行 `refs/tags/x^{}`（peeled 到 commit），跳过避免同 tag 重复。
    if (line.includes("^{}")) {
      continue;
    }
    const match = /refs\/tags\/(\S+)/.exec(line);
    if (!match?.[1]) {
      continue;
    }
    const tagName = match[1];
    const parsed = parseOhosReleaseVersion(tagName);
    if (!parsed) {
      continue;
    }
    if (!latest || compareOhosReleaseVersions(parsed, latest) > 0) {
      latest = parsed;
      latestTag = tagName;
    }
  }

  if (!latest || !latestTag) {
    return null;
  }

  return {
    version: latestTag.startsWith("v") ? latestTag.slice(1) : latestTag,
    title: latestTag,
    markdown: null,
    htmlUrl: `https://github.com/yuanbaobaoo/zcode-ohos/releases/tag/${encodeURIComponent(latestTag)}`,
  };
}
