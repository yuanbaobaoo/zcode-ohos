/*
 * OHOS「访问全盘文件」一次性引导 toast（spec 08）。
 * 挂载于 App 内即已进入主页面（登录页 WelcomeScreen 期间 App 不挂载），兼容
 * API Key 模式（无 user 对象）。未授权时右下角弹一次，弹出即持久化已展示标记，
 * 之后任何启动/会话都不再弹。常驻入口在设置 → 常规 → 数据存储路径 下方的开关。
 * 状态唯一事实是系统授权，桥文件/IPC 只是它的投影；「已展示」是 UI 局部状态。
 */

import { useEffect } from "react";
import type { IPlatformService } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const SHOWN_STORAGE_KEY = "zcode:ohos-full-disk-prompt-shown:v1";

export function shouldShowOhosFullDiskPrompt(input: {
  supported: boolean;
  granted: boolean;
  alreadyShown: boolean;
}): boolean {
  return input.supported && !input.granted && !input.alreadyShown;
}

export function OhosFullDiskAccessPrompt(props: { platform: IPlatformService }): null {
  const { intl } = useZCodeIntl();
  const { platform } = props;

  useEffect(() => {
    const query = platform.getOhosFullDiskAccessStatus;
    const request = platform.requestOhosFullDiskAccess;
    // 非 Desktop-OHOS：接口缺席即不出现（spec 08）。
    if (!query || !request) return;
    let cancelled = false;
    void query()
      .then((status) => {
        if (cancelled) return;
        const alreadyShown = window.localStorage.getItem(SHOWN_STORAGE_KEY) !== null;
        if (!shouldShowOhosFullDiskPrompt({ ...status, alreadyShown })) return;
        window.localStorage.setItem(SHOWN_STORAGE_KEY, new Date().toISOString());
        toast(intl.formatMessage({ id: "ohos.fullDiskAccess.prompt" }), {
          position: "bottom-right",
          variant: "info",
          // 常驻：仅用户点 × 关闭才消失（durationMs<=0 不设自动关闭定时器）。
          durationMs: 0,
          dismissible: true,
          dedupeKey: "ohos-full-disk-access",
          actionLabel: intl.formatMessage({ id: "ohos.fullDiskAccess.promptAction" }),
          onAction: () => request(),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [platform, intl]);

  return null;
}
