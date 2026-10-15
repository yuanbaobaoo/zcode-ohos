import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ArrowLeft, X } from "lucide-react";

/** 各步标题/描述的 i18n key（鸿蒙第 4 步见 spec 08）。 */
export function getOccupationStepKeys(step: 0 | 1 | 2 | 3): {
  titleKey: string;
  descriptionKey: string;
} {
  switch (step) {
    case 3:
      return { titleKey: "osTitle", descriptionKey: "osDescription" };
    case 2:
      return { titleKey: "preferences", descriptionKey: "preferencesDescription" };
    case 1:
      return { titleKey: "modeTitle", descriptionKey: "modeDescription" };
    default:
      return { titleKey: "title", descriptionKey: "description" };
  }
}

export function OnboardingHeader({
  step,
  saving,
  t,
  onBack,
  onClose,
  showOsStep = false,
}: {
  step: 0 | 1 | 2 | 3;
  saving: boolean;
  t: (key: string) => string;
  onBack: () => void;
  onClose: () => void;
  /** 鸿蒙设备追加第 4 步「系统权限」（spec：specs/ohos-port/08）。 */
  showOsStep?: boolean;
}) {
  const stepKeys = showOsStep
    ? ["stepRole", "stepMode", "stepPreferences", "stepOs"]
    : ["stepRole", "stepMode", "stepPreferences"];
  return (
    <header className="relative grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] [@media(max-height:740px)]:h-10 items-center px-6 sm:px-10">
      {step > 0 ? (
        <Button
          variant="ghost"
          disabled={saving}
          className="col-start-1 row-start-1 justify-self-start h-9 rounded-xl px-2 text-ui-sm text-foreground-subtle"
          onClick={onBack}
        >
          <ArrowLeft className="size-4" />
          {t("back")}
        </Button>
      ) : null}
      <ol
        aria-label={t("preferences")}
        className={cn(
          "col-start-2 row-start-1 flex items-center gap-2",
          showOsStep ? "w-36" : "w-28",
        )}
      >
        {stepKeys.map((key, index) => (
          <li
            key={key}
            aria-current={step === index ? "step" : undefined}
            className="min-w-0 flex-1"
          >
            <div
              aria-hidden="true"
              className={cn(
                "h-1 rounded-full transition-colors",
                index <= step ? "bg-primary" : "bg-border",
              )}
            />
            <span className="sr-only">
              {index + 1}. {t(key)}
            </span>
          </li>
        ))}
      </ol>
      <Button
        variant="ghost"
        size="icon"
        disabled={saving}
        aria-label={t("close")}
        title={t("close")}
        className="col-start-3 row-start-1 justify-self-end size-9 rounded-xl text-foreground-subtle"
        onClick={onClose}
      >
        <X className="size-4" />
      </Button>
    </header>
  );
}
