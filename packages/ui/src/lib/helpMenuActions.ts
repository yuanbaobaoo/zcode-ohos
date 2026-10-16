import type { IPlatformService } from "@zcode/shared";
import { OHOS_GITHUB_ISSUES_URL } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";
import { ZCODE_PRODUCT_DOCS_URL } from "@/lib/productDocs.js";

export interface HelpMenuActionHandlers {
  openIssueReport: () => void;
  openProductDocs: () => void;
  exportLogs: () => void;
}

export function createHelpMenuActionHandlers({
  platform,
  intl,
}: {
  platform: Pick<IPlatformService, "captureWindowScreenshot" | "exportLogs" | "openExternal">;
  intl: IntlInstance;
}): HelpMenuActionHandlers {
  return {
    // 问题上报不再走站内反馈表单：zcode-ohos 的问题追踪统一收口到 GitHub issues，
    // 经 openExternal 用系统默认浏览器打开（与 OAuth 登录拉起浏览器同一链路）。
    openIssueReport: () => {
      platform.openExternal(OHOS_GITHUB_ISSUES_URL);
    },
    openProductDocs: () => {
      platform.openExternal(ZCODE_PRODUCT_DOCS_URL);
    },
    exportLogs: () => {
      void runExportLogsAction(platform, intl);
    },
  };
}
