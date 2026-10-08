import assert from "node:assert/strict";
import test from "node:test";
import {
  compareOhosReleaseTags,
  compareOhosReleaseVersions,
  mapGithubReleaseToUpdateInfo,
  ohosVersionCodeFromTag,
  parseOhosReleaseAtomFeed,
  parseOhosReleaseVersion,
  pickLatestOhosTagFromGitRefAdvertisement,
} from "../src/ohosReleaseVersion.js";

test("parseOhosReleaseVersion: 识别既有 tag 形态", () => {
  assert.deepEqual(parseOhosReleaseVersion("v3.14.3"), {
    major: 3,
    minor: 14,
    patch: 3,
    kind: "base",
    seq: 0,
  });
  assert.deepEqual(parseOhosReleaseVersion("3.14.3"), {
    major: 3,
    minor: 14,
    patch: 3,
    kind: "base",
    seq: 0,
  });
  assert.deepEqual(parseOhosReleaseVersion("v3.14.3-ohos-patch7"), {
    major: 3,
    minor: 14,
    patch: 3,
    kind: "patch",
    seq: 7,
  });
  assert.deepEqual(parseOhosReleaseVersion("v3.14.3-ohos-fix2"), {
    major: 3,
    minor: 14,
    patch: 3,
    kind: "fix",
    seq: 2,
  });
  // 未识别后缀按基线参与排序（kind=dev）
  const dev = parseOhosReleaseVersion("v3.14.3-dev");
  assert.equal(dev?.kind, "dev");
  assert.equal(parseOhosReleaseVersion("ohos-tools"), null);
  assert.equal(parseOhosReleaseVersion("v3.14"), null);
});

test("compareOhosReleaseVersions: 排序与发版时序一致", () => {
  // dev 与 base 同级（见下方断言），不参与严格递增序列
  const ordered = [
    "v3.14.3",
    "v3.14.3-ohos-fix2",
    "v3.14.3-ohos-fix10",
    "v3.14.3-ohos-patch1",
    "v3.14.3-ohos-patch7",
    "v3.14.3-ohos-patch10",
    "v3.14.4",
  ];
  for (let i = 0; i + 1 < ordered.length; i += 1) {
    const diff = compareOhosReleaseTags(ordered[i + 1]!, ordered[i]);
    assert.ok(diff !== null && diff > 0, `${ordered[i + 1]} 应大于 ${ordered[i]}`);
    const same = compareOhosReleaseTags(ordered[i]!, ordered[i]!);
    assert.equal(same, 0);
  }

  // dev 与 base 同级：互不提示更新
  assert.equal(compareOhosReleaseTags("v3.14.3-dev", "v3.14.3"), 0);
  // 跨基线恒增
  assert.ok(compareOhosReleaseTags("v4.0.0", "v3.14.3-ohos-patch99")! > 0);
  // 无法解析返回 null
  assert.equal(compareOhosReleaseTags("garbage", "v3.14.3"), null);
});

test("compareOhosReleaseVersions: 结构化入参直接比较", () => {
  const a = parseOhosReleaseVersion("v3.14.3-ohos-patch10")!;
  const b = parseOhosReleaseVersion("v3.14.3-ohos-patch7")!;
  // 回归点：patch10 > patch7（纯字典序会得到相反结果）
  assert.ok(compareOhosReleaseVersions(a, b) > 0);
});

test("ohosVersionCodeFromTag: 跨基线单调且在 int32 内", () => {
  assert.equal(ohosVersionCodeFromTag("v3.14.3"), 31_403_000);
  assert.equal(ohosVersionCodeFromTag("v3.14.3-ohos-fix2"), 31_403_002);
  assert.equal(ohosVersionCodeFromTag("v3.14.3-ohos-patch1"), 31_403_501);
  assert.equal(ohosVersionCodeFromTag("v3.14.3-ohos-patch7"), 31_403_507);
  // 同基线内 patch7 < patch10 < 3.14.4 裸基线
  assert.ok(
    ohosVersionCodeFromTag("v3.14.3-ohos-patch7") < ohosVersionCodeFromTag("v3.14.3-ohos-patch10"),
  );
  assert.ok(ohosVersionCodeFromTag("v3.14.3-ohos-patch10") < ohosVersionCodeFromTag("v3.14.4"));
  assert.ok(ohosVersionCodeFromTag("v3.14.3-ohos-patch7") < 2 ** 31 - 1);

  assert.throws(() => ohosVersionCodeFromTag("ohos-tools"));
  assert.throws(() => ohosVersionCodeFromTag("v3.100.3"));
  assert.throws(() => ohosVersionCodeFromTag("v3.14.3-ohos-patch500"));
});

test("mapGithubReleaseToUpdateInfo: latest 响应字段映射", () => {
  const mapped = mapGithubReleaseToUpdateInfo({
    tag_name: "v3.14.3-ohos-patch7",
    html_url: "https://github.com/yuanbaobaoo/zcode-ohos/releases/tag/v3.14.3-ohos-patch7",
    body: "## v3.14.3-ohos-patch7\n\n- 修复某问题",
    published_at: "2026-10-01T00:00:00Z",
  });
  assert.deepEqual(mapped, {
    version: "3.14.3-ohos-patch7",
    title: "v3.14.3-ohos-patch7",
    markdown: "## v3.14.3-ohos-patch7\n\n- 修复某问题",
    releaseDate: "2026-10-01T00:00:00Z",
    htmlUrl: "https://github.com/yuanbaobaoo/zcode-ohos/releases/tag/v3.14.3-ohos-patch7",
  });

  // body/published_at 可缺省
  const minimal = mapGithubReleaseToUpdateInfo({
    tag_name: "v3.15.0",
    html_url: "https://github.com/yuanbaobaoo/zcode-ohos/releases/tag/v3.15.0",
    body: null,
  });
  assert.equal(minimal?.markdown, null);
  assert.equal(minimal?.releaseDate, undefined);

  assert.equal(mapGithubReleaseToUpdateInfo({ tag_name: "v1" }), null);
  assert.equal(mapGithubReleaseToUpdateInfo(null), null);
});

test("parseOhosReleaseAtomFeed: 首个 entry 作为最新版本（降级数据源）", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Releases · yuanbaobaoo/zcode-ohos</title>
  <entry>
    <title>v3.14.3-ohos-patch7</title>
    <updated>2026-10-08T05:04:17Z</updated>
    <content type="html">&lt;h2&gt;v3.14.3-ohos-patch7&lt;/h2&gt;</content>
  </entry>
  <entry>
    <title>v3.14.3-ohos-patch6</title>
    <updated>2026-10-07T05:04:17Z</updated>
  </entry>
</feed>`;
  const mapped = parseOhosReleaseAtomFeed(xml);
  assert.equal(mapped?.version, "3.14.3-ohos-patch7");
  assert.equal(mapped?.title, "v3.14.3-ohos-patch7");
  assert.equal(mapped?.markdown, null);
  assert.equal(mapped?.releaseDate, "2026-10-08T05:04:17Z");
  assert.equal(
    mapped?.htmlUrl,
    "https://github.com/yuanbaobaoo/zcode-ohos/releases/tag/v3.14.3-ohos-patch7",
  );

  // 无 entry / 无 title 返回 null；title 中的 XML 实体需反转义
  assert.equal(parseOhosReleaseAtomFeed("<feed></feed>"), null);
  assert.equal(parseOhosReleaseAtomFeed("<entry><updated>x</updated></entry>"), null);
  const escaped = parseOhosReleaseAtomFeed("<entry><title>v1.0.0 &amp; stable</title></entry>");
  assert.equal(escaped?.title, "v1.0.0 & stable");
});

test("pickLatestOhosTagFromGitRefAdvertisement: gitcode 镜像 refs 探测降级源", () => {
  // 真实抓取的 git smart-http 公告片段（含 pkt-line 前缀、peeled 行、非版本 tag）
  const body = [
    "001e# service=git-upload-pack",
    "0000",
    "015058108299704fa676bd052f576739ac90186f7611 HEAD multi_ack thin-pack",
    "003d58108299704fa676bd052f576739ac90186f7611 refs/heads/main",
    "0042bc12856c3676f7cbfe1b19ee1a570cd3d8d6b793 refs/tags/ohos-tools",
    "00494cb8c5b72745d60effcf32f872dea042ad35be67 refs/tags/v3.14.3-ohos-fix2",
    "004cff9103f13994ccf398f983d4f68a2691a7cac483 refs/tags/v3.14.3-ohos-fix2^{}",
    "004b5ede9189cc7236614c2f8303cc6ce61d89adf43d refs/tags/v3.14.3-ohos-patch5",
    "004e01c6ec88cb11076261451cb24015b533d2c24b68 refs/tags/v3.14.3-ohos-patch5^{}",
    "004bbf559315d4aba5d9b52bd9751fadeae3e68d61b5 refs/tags/v3.14.3-ohos-patch7",
    "004e036d9f76e23d41ecd446b389c58da6d668f8df26 refs/tags/v3.14.3-ohos-patch7^{}",
  ].join("\n");

  const mapped = pickLatestOhosTagFromGitRefAdvertisement(body);
  assert.equal(mapped?.version, "3.14.3-ohos-patch7");
  assert.equal(mapped?.title, "v3.14.3-ohos-patch7");
  assert.equal(mapped?.markdown, null);
  assert.equal(mapped?.releaseDate, undefined);
  // 镜像仅探测：跳转地址仍指向 GitHub release 页
  assert.equal(
    mapped?.htmlUrl,
    "https://github.com/yuanbaobaoo/zcode-ohos/releases/tag/v3.14.3-ohos-patch7",
  );

  // 跨基线：refs 无序时仍取最大
  const unordered = [
    "0000refs/tags/v3.15.0",
    "0000refs/tags/v3.14.9-ohos-patch99",
    "0000refs/tags/v3.14.3-ohos-patch7",
  ].join("\n");
  assert.equal(pickLatestOhosTagFromGitRefAdvertisement(unordered)?.version, "3.15.0");

  assert.equal(pickLatestOhosTagFromGitRefAdvertisement("001e# service"), null);
  assert.equal(pickLatestOhosTagFromGitRefAdvertisement("0000refs/tags/ohos-tools"), null);
});
