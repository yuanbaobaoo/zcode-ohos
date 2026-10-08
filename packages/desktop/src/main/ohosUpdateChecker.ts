// 鸿蒙更新检查：三级数据源降级（GitHub API → atom → gitcode 镜像），规则见 spec 04。
// 解析与排序在 @zcode/shared 的 ohosReleaseVersion.ts；网络收口镜像 forceUpdateGuard.ts。

import {
  mapGithubReleaseToUpdateInfo,
  parseOhosReleaseAtomFeed,
  pickLatestOhosTagFromGitRefAdvertisement,
  type OhosGithubReleaseInfo,
} from "@zcode/shared";
import type { Session } from "electron";

export const OHOS_GITHUB_LATEST_RELEASE_API_URL =
  "https://api.github.com/repos/yuanbaobaoo/zcode-ohos/releases/latest";
export const OHOS_GITHUB_RELEASES_ATOM_URL =
  "https://github.com/yuanbaobaoo/zcode-ohos/releases.atom";
export const OHOS_GITCODE_INFO_REFS_URL =
  "https://gitcode.com/yuanbaobaoo/zcode-ohos.git/info/refs?service=git-upload-pack";

const OHOS_UPDATE_REQUEST_TIMEOUT_MS = 10_000;
const OHOS_UPDATE_MAX_RESPONSE_BYTES = 1024 * 1024;

export async function fetchLatestOhosRelease(options: {
  apiUrl?: string;
  atomUrl?: string;
  gitcodeRefsUrl?: string;
  fetchImpl?: () => Promise<unknown>;
}): Promise<OhosGithubReleaseInfo> {
  if (options.fetchImpl) {
    const release = await options.fetchImpl();
    const mapped = mapGithubReleaseToUpdateInfo(release);
    if (!mapped) {
      throw new Error("ohos update check response missing tag_name/html_url");
    }
    return mapped;
  }

  try {
    const release = await requestGithubResource(
      options.apiUrl ?? OHOS_GITHUB_LATEST_RELEASE_API_URL,
    );
    const mapped = mapGithubReleaseToUpdateInfo(release);
    if (!mapped) {
      throw new Error("ohos update check response missing tag_name/html_url");
    }
    return mapped;
  } catch (apiError) {
    // 配额超限（403/429）是共享出口 IP 的常态；其他失败（断网、5xx）也一并降级。
    try {
      const xml = await requestGithubResourceText(options.atomUrl ?? OHOS_GITHUB_RELEASES_ATOM_URL);
      const mapped = parseOhosReleaseAtomFeed(xml);
      if (mapped) {
        return mapped;
      }
    } catch {
      // 继续尝试镜像
    }

    // 国内镜像兜底：git smart-http refs 公告，纯 git 协议无限流，仅探测 tag。
    const refs = await requestGithubResourceText(
      options.gitcodeRefsUrl ?? OHOS_GITCODE_INFO_REFS_URL,
    );
    const mapped = pickLatestOhosTagFromGitRefAdvertisement(refs);
    if (!mapped) {
      throw apiError;
    }
    return mapped;
  }
}

// 直连 session：绕开 main 进程被注入的代理环境变量（经代理访问 GitHub 被拒，spec 04）。
let ohosDirectSession: Session | null = null;

async function ensureOhosDirectSession() {
  if (!ohosDirectSession) {
    const { session } = await import("electron");
    ohosDirectSession = session.fromPartition("ohos-update-direct");
  }
  await ohosDirectSession.setProxy({ mode: "direct" });
  return ohosDirectSession;
}

async function requestGithubResource(url: string): Promise<unknown> {
  return JSON.parse(await requestGithubResourceText(url));
}

async function requestGithubResourceText(url: string): Promise<string> {
  const [{ net }, directSession] = await Promise.all([
    import("electron"),
    ensureOhosDirectSession(),
  ]);
  return new Promise<string>((resolve, reject) => {
    let request: ReturnType<typeof net.request>;
    let timer: ReturnType<typeof setTimeout>;
    let data = "";
    let receivedBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      request?.abort();
      reject(error);
    };

    const finish = (value: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    timer = setTimeout(() => {
      fail(new Error("ohos update check request timeout"));
    }, OHOS_UPDATE_REQUEST_TIMEOUT_MS);
    timer.unref?.();

    // net.request 仅支持单参 options 形式，双参会触发 TypeError（spec 04）。
    request = net.request({
      url,
      session: directSession,
      headers: {
        // GitHub API 强制要求 User-Agent；vnd.github+json 固定返回稳定 JSON 结构。
        "User-Agent": "zcode-ohos-updater",
        Accept: "application/vnd.github+json, application/atom+xml, text/html, */*",
      },
    });
    request.on("response", (response) => {
      const statusCode = response.statusCode ?? 0;
      const isOkStatus = statusCode >= 200 && statusCode < 300;
      response.on("data", (chunk) => {
        receivedBytes += Buffer.byteLength(chunk);
        if (receivedBytes > OHOS_UPDATE_MAX_RESPONSE_BYTES) {
          fail(new Error("ohos update check response too large"));
          return;
        }
        // 非 2xx 时保留少量响应体做诊断：区分 GitHub 本体（JSON message）与中间层应答。
        if (!isOkStatus && data.length > 2048) {
          return;
        }
        data += chunk.toString();
      });
      response.on("end", () => {
        if (!isOkStatus) {
          fail(
            new Error(
              `ohos update check request failed with status ${statusCode}: ${data.slice(0, 200)}`,
            ),
          );
          return;
        }
        finish(data);
      });
      response.on("error", (error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
    request.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    request.end();
  });
}
