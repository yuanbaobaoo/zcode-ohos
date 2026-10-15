import { useOnboardingTelemetry } from "@/onboarding/useOnboardingTelemetry.js";
import { getOccupationStepKeys, OnboardingHeader } from "@/onboarding/OnboardingHeader.js";
import { OccupationOnboardingVisual } from "@/onboarding/OccupationOnboardingVisual.js";
import { occupations, type OccupationValue } from "@/onboarding/occupationOptions.js";
import { OnboardingModeSelector } from "@/onboarding/OnboardingModeSelector.js";
import { OnboardingOccupationGrid } from "@/onboarding/OnboardingOccupationGrid.js";
import { OnboardingOsPermissionStep } from "@/onboarding/OnboardingOsPermissionStep.js";
import { OnboardingActionFooter } from "@/onboarding/OnboardingActionFooter.js";
import { useOhosFullDiskAccessStatus } from "@/hooks/useOhosFullDiskAccessStatus.js";
import { useOnboardingTrigger } from "@/onboarding/useOnboardingTrigger.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSettings } from "@/hooks/useSettingService.js";
import { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useEffectiveShortcutBindings } from "@/shortcuts/useShortcutBindings.js";
import { matchesShortcutBinding } from "@/shortcuts/bindings.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import type { InterfaceMode } from "@/lib/interfaceMode.js";
import { logger } from "@/logger.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import type { OnboardingRecordEntry } from "@zcode/shared";

/** 追加本地引导记录（userId 由 host 补全）；channel 缺失挂起时 5 秒超时按写失败处理。 */
async function appendOnboardingRecord(
  service: NonNullable<ReturnType<typeof useOnboardingRecordService>>,
  deviceMid: string,
  entry: Parameters<typeof service.appendRecord>[1],
): Promise<void> {
  await Promise.race([
    service.appendRecord(deviceMid, entry),
    new Promise((_, reject) => setTimeout(() => reject(new Error("appendRecord timeout")), 5000)),
  ]);
}

export function OccupationOnboarding({
  children,
  showWindowControls = false,
  showChildrenWhileLoading = false,
  isMacDesktop,
  isWindowsDesktop,
}: {
  children: ReactNode;
  /** Windows/Linux 自绘窗控：引导全屏覆盖主界面（含标题栏），需在此补最小化/最大化/关闭。 */
  showWindowControls?: boolean;
  /** 独立设置页不依赖引导设置加载，避免应用级引导外层遮住设置内容。 */
  showChildrenWhileLoading?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}) {
  const { settings, update } = useSettings();
  const platform = usePlatform();
  const onboardingRecord = useOnboardingRecordService();
  const shortcutBindings = useEffectiveShortcutBindings();
  const requested = useZCodeStore((state) => state.newUserOnboardingOpen);
  const setRequested = useZCodeStore((state) => state.setNewUserOnboardingOpen);
  // 登录态变化（useRootOAuthEffects 登录成功后 setUser）时按 userId 重新判定是否触发引导。
  const userId = useZCodeStore((state) => state.user?.id) ?? null;
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `occupationOnboarding.${key}` });
  const [occupation, setOccupation] = useState<OccupationValue | null>("developer");
  const savedInterfaceMode = useZCodeStore((state) => state.interfaceMode);
  const setInterfaceMode = useZCodeStore((state) => state.setInterfaceMode);
  // mode 为 null 表示模式页被"跳过"（跳过是显式答案，记录里保留 null 而非兜底值）。
  const [mode, setMode] = useState<InterfaceMode | null>(savedInterfaceMode);
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const preferences = step === 2;
  // 鸿蒙第 4 步「系统权限」（spec 08）：能力合同驱动显隐，非 OHOS 完全无此步。
  const ohosFullDiskAccess = useOhosFullDiskAccessStatus(platform);
  const showOsStep = Boolean(ohosFullDiskAccess?.supported && platform.requestOhosFullDiskAccess);
  const requestOnboardingDialog = useZCodeStore((state) => state.requestOnboardingDialog);
  const [migration, setMigration] = useState(false);
  const [memory, setMemory] = useState(savedInterfaceMode === "office");
  const [suggestions, setSuggestions] = useState(savedInterfaceMode === "office");
  const suggestionsEditedRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const loadDeviceMid = useCallback(() => platform.getDeviceId(), [platform]);
  const [needsOnboarding, markOnboarded] = useOnboardingTrigger({
    onboardingRecord,
    userId,
    hasStoredOccupation: Boolean(settings?.onboardingOccupation),
    loadDeviceMid,
    update,
  });
  const onboardingVisible = requested || (needsOnboarding === true && !dismissed);
  const captureEnd = useOnboardingTelemetry({
    platform,
    visible:
      Boolean(settings) &&
      onboardingVisible &&
      (requested || needsOnboarding !== null || Boolean(settings?.onboardingOccupation)),
    step,
    occupation,
    mode,
    memory,
    suggestions,
    migration,
  });
  const closeOnboarding = useCallback(() => {
    if (savingRef.current) return;
    captureEnd("close", intl.formatMessage({ id: "occupationOnboarding.close" }))();
    setStep(0);
    setDismissed(true);
    setRequested(false);
    if (onboardingRecord) {
      void onboardingRecord.dismissOnboarding(platform.getDeviceId()).catch((cause: unknown) => {
        logger.warn("[occupation-onboarding] 写入关闭决策失败", { error: String(cause) });
      });
    }
  }, [captureEnd, intl, onboardingRecord, platform, setRequested]);
  // 各步标题/描述的 i18n key（鸿蒙第 4 步见 spec 08）。
  const { titleKey: stepTitleKey, descriptionKey: stepDescriptionKey } =
    getOccupationStepKeys(step);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        shortcutBindings.toggleInterfaceMode.some((binding) =>
          matchesShortcutBinding(event, binding),
        )
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (saving) return;
        const nextMode = savedInterfaceMode === "office" ? "coding" : "office";
        setInterfaceMode(nextMode);
        setMode(nextMode);
        if (nextMode !== mode) {
          setMemory(nextMode === "office");
          if (nextMode === "office" && !suggestionsEditedRef.current) setSuggestions(true);
        }
        return;
      }
      if (event.key === "Escape" && onboardingVisible && !saving) {
        // 直接退出不改偏好；首次引导会持久化 dismissed，避免下次启动重复展示。
        event.preventDefault();
        event.stopImmediatePropagation();
        closeOnboarding();
        return;
      }
      if (
        !shortcutBindings.openOnboarding.some((binding) => matchesShortcutBinding(event, binding))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (saving) return;
      // 关闭调试引导不保存偏好，也不把首次引导标记为已完成。
      if (onboardingVisible) {
        closeOnboarding();
      } else {
        setRequested(true);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    closeOnboarding,
    shortcutBindings,
    setRequested,
    onboardingVisible,
    saving,
    savedInterfaceMode,
    setInterfaceMode,
    mode,
  ]);
  // 引导再次打开（换账号触发 / 快捷键手动打开）时，用该用户在 record 里的最近作答预填，
  // 而不是每次都从写死的默认选项开始；跳过页记 null 的字段落默认值。
  const [latestEntry, setLatestEntry] = useState<OnboardingRecordEntry | null>(null);
  // 预填异步后到时不得覆盖用户已经做出的选择。
  const userEditedRef = useRef(false);
  // 偏好页「跳过」后仍要走鸿蒙页（spec 08）：记住跳过语义，末页完成时按跳过保存。
  const preferencesSkippedRef = useRef(false);
  useEffect(() => {
    if (!onboardingRecord) return;
    let cancelled = false;
    onboardingRecord.getLatestEntry().then(
      (entry) => {
        if (!cancelled) setLatestEntry(entry);
      },
      (cause) => {
        logger.warn("[occupation-onboarding] 读取预填作答失败", { error: String(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [onboardingRecord, userId]);
  const markUserEdited = () => {
    userEditedRef.current = true;
    // 用户任何主动编辑都取消「偏好按跳过记录」的语义（spec 08）。
    preferencesSkippedRef.current = false;
  };

  const applyLatestEntry = () => {
    const entry = latestEntry;
    setStep(0);
    setOccupation(
      entry?.occupation && (occupations as readonly string[]).includes(entry.occupation)
        ? (entry.occupation as OccupationValue)
        : "developer",
    );
    const initialMode = entry?.interfaceMode ?? savedInterfaceMode;
    setMode(initialMode);
    // 编程模式默认关闭主动工作记忆；办公模式才恢复该用户之前的勾选。
    setMemory(initialMode === "office" && (entry?.memoryEnabled ?? true));
    setSuggestions(entry?.proactiveSuggestionsEnabled ?? initialMode === "office");
    setMigration(false);
    setError(false);
  };
  useEffect(() => {
    if (!requested) return;
    userEditedRef.current = false;
    suggestionsEditedRef.current = false;
    preferencesSkippedRef.current = false;
    applyLatestEntry();
    // latestEntry 异步到达时若引导已打开，重新预填一次（用户未交互前覆盖默认值）。
  }, [requested]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!onboardingVisible || userEditedRef.current) return;
    applyLatestEntry();
    // eslint-disable-line react-hooks/exhaustive-deps
  }, [latestEntry]);
  if (!settings) return showChildrenWhileLoading ? <>{children}</> : null;
  // 判定进行中先不渲染，避免引导闪现后立即消失（判定为需引导）或先闪引导再进主界面。
  // 只有疑似首跑（settings 里也没有职业）才等待记录判定；存量用户（已有
  // onboardingOccupation）不等 RPC 直接进主界面，杜绝黑屏。
  if (!requested && needsOnboarding === null && !settings.onboardingOccupation) return null;
  if (!onboardingVisible) return <>{children}</>;
  const save = async (skip = false) => {
    if (savingRef.current) return;
    savingRef.current = true;
    const reportEnd = captureEnd(skip ? "skip" : "start", t(skip ? "skip" : "start"));
    setSaving(true);
    setError(false);
    try {
      if (mode) setInterfaceMode(mode);
      logger.info("[occupation-onboarding] 保存偏好", { interfaceMode: mode });
      await update({
        // settings 侧保持既有语义：跳过落保守默认值（职业 other / 偏好关），
        // "跳过也算答案"的区分度只体现在 onboarding-record.json 里。
        onboardingOccupation: occupation ?? "other",
        memoryEnabled: skip ? false : memory,
        proactiveSuggestionsEnabled: !skip && mode === "office" && suggestions,
      });
      reportEnd();
      // 保存成功就是本次引导的终点；本地记录失败不应留下可再次上报的引导页面。
      setStep(0);
      setDismissed(true);
      setRequested(false);
      if (!skip && migration) requestOnboardingDialog("migration");
      logger.info("[occupation-onboarding] 偏好保存完成", { interfaceMode: mode });
      if (onboardingRecord) {
        try {
          // 追加本地引导记录（userId 由 host 按登录态补全），后续上传服务器。
          // appendRecord 走 RPC，channel 缺失时会挂起导致保存按钮永远转圈，加超时保护。
          // 跳过是显式答案：该页被跳过时记 null（occupation 在第 1 步跳过时已是 null，
          // mode 在第 2 步跳过时置 null，偏好页整体跳过时两个布尔记 null）。
          await appendOnboardingRecord(onboardingRecord, platform.getDeviceId(), {
            occupation,
            interfaceMode: mode,
            memoryEnabled: skip ? null : memory,
            proactiveSuggestionsEnabled: skip ? null : mode === "office" && suggestions,
            completedAt: new Date().toISOString(),
          });
          markOnboarded();
        } catch (cause) {
          // 偏好已保存成功，记录写失败只留 warn 日志，不打断用户；下次启动按记录会再次触发引导。
          logger.warn("[occupation-onboarding] 写入引导记录失败", { error: String(cause) });
        }
      }
    } catch (cause) {
      logger.warn("[occupation-onboarding] 保存偏好失败", { error: String(cause) });
      setError(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <main
      aria-label={t("title")}
      data-testid="onboarding-page"
      className="relative flex h-dvh w-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-12 [app-region:drag]" />
      {/* 与 Settings 相同，计入 Workspace 的 4px 外层留白、1px 边框和 8px 内边距。 */}
      {showWindowControls ? (
        <div className="absolute right-1 top-1 z-30 mt-px mr-px flex h-12 items-center px-2">
          <DesktopWindowControls />
        </div>
      ) : null}
      <div className="relative grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-2 lg:gap-1 lg:p-1">
        <div className="flex min-h-0 flex-col pt-12 [@media(max-height:740px)]:pt-10">
          <OnboardingHeader
            step={step}
            saving={saving}
            t={t}
            showOsStep={showOsStep}
            onBack={() => setStep(step === 3 ? 2 : step === 2 ? 1 : 0)}
            onClose={closeOnboarding}
          />
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-4 sm:px-10">
            {/* 自动外边距让短内容居中，长内容从顶部正常滚动，不影响固定导航。 */}
            <div className="mx-auto my-auto w-full max-w-lg shrink-0">
              <section className="flex w-full flex-col">
                <div className="w-full">
                  <h1 className="text-ui-xl font-semibold tracking-tight text-center">
                    {t(stepTitleKey)}
                  </h1>
                  <p className="mx-auto mt-3 max-w-md text-center text-ui-base leading-relaxed text-foreground-subtle">
                    {t(stepDescriptionKey)}
                  </p>
                  {step === 3 ? (
                    <OnboardingOsPermissionStep
                      status={ohosFullDiskAccess}
                      saving={saving}
                      // 触发授权引导链路；面板 API 失败自动落到系统设置页，
                      // 返回后状态经轮询回流刷新（spec 08）。
                      onRequest={() => platform.requestOhosFullDiskAccess?.()}
                    />
                  ) : step === 1 ? (
                    <OnboardingModeSelector
                      mode={mode}
                      saving={saving}
                      onSelect={(value) => {
                        markUserEdited();
                        // 重选当前编程模式也应清除旧记录带来的默认勾选。
                        setMemory(value === "office");
                        if (value !== mode) {
                          if (value === "office" && !suggestionsEditedRef.current)
                            setSuggestions(true);
                        }
                        setMode(value);
                      }}
                      label={t("modeTitle")}
                      formatLabel={(key) => t(key)}
                    />
                  ) : preferences ? (
                    <div className="mt-8 space-y-3">
                      {(["suggestions", "memory", "migration"] as const)
                        .filter((key) => key !== "suggestions" || mode === "office")
                        .map((key) => (
                          <label
                            key={key}
                            className="grid cursor-pointer grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 rounded-xl border border-card-border bg-card dark:bg-surface/40 p-5 text-ui-base transition-colors hover:bg-surface-hover"
                          >
                            <Checkbox
                              checked={
                                key === "migration"
                                  ? migration
                                  : key === "memory"
                                    ? memory
                                    : suggestions
                              }
                              disabled={saving}
                              onCheckedChange={(checked) => {
                                markUserEdited();
                                if (key === "migration") setMigration(checked === true);
                                else if (key === "memory") setMemory(checked === true);
                                else {
                                  suggestionsEditedRef.current = true;
                                  setSuggestions(checked === true);
                                }
                              }}
                            />
                            <span className="font-medium">{t(key)}</span>
                            <span className="col-start-2 text-ui-sm font-normal text-foreground-subtle">
                              {t(`${key}Description`)}
                            </span>
                          </label>
                        ))}
                    </div>
                  ) : (
                    <OnboardingOccupationGrid
                      occupation={occupation}
                      saving={saving}
                      onSelect={(value) => {
                        markUserEdited();
                        setOccupation(value);
                      }}
                      label={t("title")}
                      formatLabel={(value) => t(value)}
                    />
                  )}
                  {error ? (
                    <p role="alert" className="mt-4 text-ui-sm text-destructive">
                      {t("error")}
                    </p>
                  ) : null}
                </div>
                <OnboardingActionFooter
                  saving={saving}
                  // 只有 OHOS 鸿蒙页作为末页时不显示「跳过」（spec 08）；非 OHOS 偏好页
                  // 仍是末页，跳过按钮保持原「按未选择保存」语义，不能一并隐藏。
                  showSkip={!showOsStep || step < 3}
                  skipLabel={t("skip")}
                  primaryLabel={t(
                    saving ? "saving" : step === (showOsStep ? 3 : 2) ? "start" : "continue",
                  )}
                  primaryDisabled={saving || (step === 0 && !occupation)}
                  onSkip={() => {
                    markUserEdited();
                    if (step === 2 && showOsStep) {
                      // 偏好页跳过仍要继续走鸿蒙页，末页完成时按跳过语义保存（spec 08）。
                      preferencesSkippedRef.current = true;
                      setStep(3);
                    } else if (preferences) void save(true);
                    else {
                      if (step === 0) setOccupation(null);
                      else setMode(null);
                      setStep(step === 0 ? 1 : 2);
                    }
                  }}
                  onPrimary={() => {
                    // 鸿蒙设备偏好页后还有系统权限页（spec 08），末步才保存；
                    // 偏好页跳过后从鸿蒙页完成时按跳过语义记录偏好。
                    const lastStep = showOsStep ? 3 : 2;
                    if (step < lastStep) setStep(step === 0 ? 1 : step === 1 ? 2 : 3);
                    else void save(showOsStep ? preferencesSkippedRef.current : false);
                  }}
                />
              </section>
            </div>
          </div>
        </div>
        <OccupationOnboardingVisual
          isMacDesktop={isMacDesktop}
          isWindowsDesktop={isWindowsDesktop}
        />
      </div>
    </main>
  );
}
