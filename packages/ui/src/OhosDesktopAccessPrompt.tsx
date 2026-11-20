// OHOS Desktop 目录按需授权提示（spec 18）：Desktop 不被全盘权限覆盖，
// 缺授权时只给一个按钮，点击才触发系统弹窗；Documents/Download 由全盘权限覆盖。

import { useState, type ReactNode } from "react";
import { Info, X } from "lucide-react";
import type { IPlatformService, OhosDesktopAccessStatus } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOhosDesktopAccessStatus } from "@/hooks/useOhosDesktopAccessStatus.js";

export function shouldShowOhosDesktopPrompt(
  status: OhosDesktopAccessStatus | undefined,
): boolean {
  return status?.supported === true && !status.granted;
}

export function OhosDesktopAccessPrompt(props: { platform: IPlatformService }): ReactNode {
  const { intl } = useZCodeIntl();
  const { platform } = props;
  const status = useOhosDesktopAccessStatus(platform);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || !shouldShowOhosDesktopPrompt(status) || !platform.requestOhosDesktopAccess) {
    return null;
  }
  return (
    <div
      className="fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[9999] flex flex-col items-end"
      role="status"
    >
      <div
        className={cn(
          "flex w-[min(536px,calc(100vw-2rem))] items-start gap-3 rounded-2xl border border-border bg-toast/60 px-4 py-3 text-ui-base text-foreground shadow-lg backdrop-blur-xl",
        )}
      >
        <Info className="mt-0.5 size-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
        <div className="min-w-0 flex-1 whitespace-pre-line break-words leading-5">
          {intl.formatMessage({ id: "ohos.desktopAccess.prompt" })}
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md p-1 text-foreground-subtle hover:text-foreground"
          aria-label={intl.formatMessage({ id: "ohos.desktopAccess.dismiss" })}
          onClick={() => setDismissed(true)}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="shrink-0 rounded-lg border border-border bg-background/40 px-3 py-1.5 text-ui-sm hover:bg-background/70"
          onClick={() => platform.requestOhosDesktopAccess?.()}
        >
          {intl.formatMessage({ id: "ohos.desktopAccess.action" })}
        </button>
      </div>
    </div>
  );
}
