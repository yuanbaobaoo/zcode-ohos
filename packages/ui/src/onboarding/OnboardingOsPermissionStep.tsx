import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import type { OhosFullDiskAccessStatus } from "@zcode/shared";

/** 职业引导第 4 步「鸿蒙系统」（spec 08）：全盘权限说明 + 实时状态 + 跳转开启。 */
export function OnboardingOsPermissionStep(props: {
  status: OhosFullDiskAccessStatus | undefined;
  saving: boolean;
  onRequest: () => void;
}) {
  const { intl } = useZCodeIntl();
  const granted = props.status?.granted ?? false;
  return (
    <div className="mt-8 space-y-3">
      <div className="rounded-xl border border-card-border bg-card p-5 dark:bg-surface/40">
        <div className="flex items-center justify-between gap-4">
          <span className="text-ui-base font-medium">
            {intl.formatMessage({ id: "occupationOnboarding.osFullDiskTitle" })}
          </span>
          <span
            className={
              granted ? "text-ui-base text-success" : "text-ui-base text-foreground-subtle"
            }
          >
            {intl.formatMessage({
              id: granted
                ? "occupationOnboarding.osStatusGranted"
                : "occupationOnboarding.osStatusDenied",
            })}
          </span>
        </div>
        <p className="mt-2 text-ui-sm leading-relaxed text-foreground-subtle">
          {intl.formatMessage({ id: "occupationOnboarding.osFullDiskBody" })}
        </p>
        <Button
          type="button"
          variant="outline"
          className="mt-4 h-10 rounded-xl px-5 text-ui-base"
          disabled={props.saving || granted}
          onClick={props.onRequest}
        >
          {intl.formatMessage({ id: "occupationOnboarding.osJump" })}
        </Button>
      </div>
    </div>
  );
}
