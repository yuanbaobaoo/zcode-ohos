/*
 * OHOS「访问全盘文件」一次性引导提示（spec 08）。
 * 挂载于 App 内即已进入主页面（登录页 WelcomeScreen 期间 App 不挂载），兼容
 * API Key 模式（无 user 对象）。未授权时右下角弹一次，弹出即持久化已展示标记，
 * 之后任何启动/会话都不再弹。常驻入口在设置 → 常规 → 数据存储路径 下方的开关。
 * 状态唯一事实是系统授权，桥文件/IPC 只是它的投影；「已展示」是 UI 局部状态。
 *
 * 上游 v3.16.1 删除了 Toast 的 bottom-right 位置栈（specs/ohos-port/09 §4.3.1）；
 * 本组件改为自包含固定定位卡片：视觉沿用 info Toast 的卡片样式，不依赖
 * ToastHost 的位置渲染，右下角行为与一次性语义保持 spec 08 原样。
 */

import { useEffect, useState, type ReactNode } from "react";
import { Info, X } from "lucide-react";
import type { IPlatformService } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const SHOWN_STORAGE_KEY = "zcode:ohos-full-disk-prompt-shown:v1";

export function shouldShowOhosFullDiskPrompt(input: {
  supported: boolean;
  granted: boolean;
  alreadyShown: boolean;
}): boolean {
  return input.supported && !input.granted && !input.alreadyShown;
}

export function OhosFullDiskAccessPrompt(props: { platform: IPlatformService }): ReactNode {
  const { intl } = useZCodeIntl();
  const { platform } = props;
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [shouldRender, setShouldRender] = useState(false);
  const request = platform.requestOhosFullDiskAccess;
  useEffect(() => {
    const query = platform.getOhosFullDiskAccessStatus;
    // 非 Desktop-OHOS：接口缺席即不出现（spec 08）。
    if (!query || !request) {
      setShouldRender(false);
      return;
    }
    let cancelled = false;
    void query()
      .then((status) => {
        if (cancelled) return;
        const alreadyShown = window.localStorage.getItem(SHOWN_STORAGE_KEY) !== null;
        // 弹出即持久化标记：授权与否都不重弹（结果由设置页开关与引导第 4 步跟进）。
        if (!shouldShowOhosFullDiskPrompt({ ...status, alreadyShown })) return;
        window.localStorage.setItem(SHOWN_STORAGE_KEY, new Date().toISOString());
        if (!cancelled) setShouldRender(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [platform, request]);

  // 触发进入动画（shouldRender 只由未展示→展示翻转一次）；常驻展示，
  // 仅用户点 × / 去授权才退出。
  useEffect(() => {
    if (!shouldRender) {
      return undefined;
    }
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [shouldRender]);

  if (!shouldRender || dismissed || !request) {
    return null;
  }

  return (
    <div
      className={cn(
        "fixed right-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[9999] flex flex-col items-end",
      )}
      role="status"
    >
      <div
        className={cn(
          "flex w-[min(536px,calc(100vw-2rem))] items-start gap-3 rounded-2xl border border-border bg-toast/60 px-4 py-3 text-ui-base text-foreground shadow-lg backdrop-blur-xl transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.77,0,0.175,1)] motion-reduce:transform-none motion-reduce:transition-opacity",
          visible ? "translate-y-0 scale-100 opacity-100" : "translate-y-1 scale-[0.98] opacity-0",
        )}
      >
        <Info className="mt-0.5 size-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
        <div className="min-w-0 flex-1 whitespace-pre-line break-words leading-5">
          {intl.formatMessage({ id: "ohos.fullDiskAccess.prompt" })}
        </div>
        <button
          type="button"
          onClick={request}
          className="h-8 shrink-0 whitespace-nowrap rounded-md bg-primary px-3 text-ui-base font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {intl.formatMessage({ id: "ohos.fullDiskAccess.promptAction" })}
        </button>
        <button
          type="button"
          aria-label={intl.formatMessage({ id: "common.close" })}
          onClick={() => setDismissed(true)}
          className="shrink-0 rounded-md p-1 text-foreground-subtle transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
