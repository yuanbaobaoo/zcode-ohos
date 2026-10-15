import { Button } from "@/components/ui/button.js";

/** 职业引导各步底部操作区；是否显示「跳过」由调用方决定（OHOS 鸿蒙末页隐藏，spec 08）。 */
export function OnboardingActionFooter(props: {
  saving: boolean;
  showSkip: boolean;
  skipLabel: string;
  primaryLabel: string;
  primaryDisabled: boolean;
  onSkip: () => void;
  onPrimary: () => void;
}) {
  return (
    <footer className="mt-6 flex flex-col gap-3 [@media(max-height:740px)]:mt-4 [@media(max-height:740px)]:gap-1">
      {props.showSkip ? (
        <Button
          variant="link"
          disabled={props.saving}
          className="order-2 h-9 self-center rounded-xl px-3 text-ui-base text-foreground-subtle"
          onClick={props.onSkip}
        >
          {props.skipLabel}
        </Button>
      ) : null}
      <div className="flex w-full gap-3">
        <Button
          disabled={props.primaryDisabled}
          className="h-11 flex-1 rounded-xl px-5 text-ui-base"
          onClick={props.onPrimary}
        >
          {props.primaryLabel}
        </Button>
      </div>
    </footer>
  );
}
