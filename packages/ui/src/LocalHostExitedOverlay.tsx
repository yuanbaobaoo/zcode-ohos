import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

// 本地 Host 意外退出后窗口内 workspace RPC 全部无人应答（历史症状：任务/插件列表永久转圈）。
// main 把退出事件推给 renderer（desktopHostProcess），这里给可操作的恢复入口而不是无限等待。
export function LocalHostExitedOverlay() {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [exitPayload, setExitPayload] = useState<{ code: number | null } | null>(null);

  useEffect(() => {
    if (!platform.onLocalHostExited) return;
    return platform.onLocalHostExited((payload) => {
      logger.error("[local-host] 本地 Host 进程意外退出", { code: payload.code });
      setExitPayload(payload);
    });
  }, [platform]);

  if (!exitPayload) return null;
  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{intl.formatMessage({ id: "localHostExited.title" })}</AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "localHostExited.description" })}
            {exitPayload.code !== null ? ` (code: ${exitPayload.code})` : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={() => window.location.reload()}>
            {intl.formatMessage({ id: "localHostExited.reload" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
