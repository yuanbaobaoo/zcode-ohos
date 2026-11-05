// spec：specs/ohos-port/15-单控制通道与平台适配治理.md（聚合门禁）
// 权限丢失后的状态回收：ZCode 启动（或运行中权限被撤销）时，若「电脑控制」插件仍处于启用态
// 但三权限不全，则把它关掉——开关必须反映真实权限，而不是"灰着但显示开启"。
// 只在权限恢复时不自动重新开启：要不要开由用户决定。
import { useEffect, useRef } from "react";
import { isRemoteWorkspaceIdentity, ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useOhosComputerControlStatus } from "@/hooks/useOhosComputerControlStatus.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  isOhosComputerControlPermissionGranted,
  shouldDisableOhosCua,
} from "@/settings/computerUseAvailability.js";
import { logger } from "@/logger.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";

export interface OhosCuaPermissionReconcileInput {
  workspacePath: string;
  workspaceIdentity?: string | null;
}

export function useOhosCuaPermissionReconcile({
  workspacePath,
  workspaceIdentity,
}: OhosCuaPermissionReconcileInput): void {
  const platform = usePlatform();
  const services = useServices();
  const { intl } = useZCodeIntl();
  const status = useOhosComputerControlStatus(platform);
  const plugins = usePluginManagementStore((state) => state.plugins);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const setEnabled = usePluginManagementStore((state) => state.setEnabled);

  const isLocalOhos =
    platform.isOhos === true &&
    Boolean(workspacePath) &&
    !(workspaceIdentity?.trim() && isRemoteWorkspaceIdentity(workspaceIdentity.trim()));

  // 插件启用态是判断前提：启动时加载（与设置页同一路径，store 内部按 workspaceKey 去重）。
  // 启动早期 host 可能未就绪导致首次加载失败，因此按次数重试（最多 3 次），避免"权限丢了
  // 但插件态没加载到"从而漏掉回收。
  const initAttemptsRef = useRef(0);
  useEffect(() => {
    const pluginService = services.pluginManagementService;
    if (!isLocalOhos || !pluginService) return;
    if (plugins.length > 0 || initAttemptsRef.current >= 3) return;
    const delay = initAttemptsRef.current === 0 ? 0 : 2_000;
    const timer = setTimeout(() => {
      initAttemptsRef.current += 1;
      void initializePlugins({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        pluginService,
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [
    initializePlugins,
    isLocalOhos,
    plugins.length,
    services.pluginManagementService,
    workspaceIdentity,
    workspacePath,
  ]);

  const cuaPlugin = plugins.find((plugin) => plugin.id === ZCODE_CUA_OFFICIAL_PLUGIN_ID);
  const granted = isOhosComputerControlPermissionGranted(status);
  // 同一状态只回收一次：避免 status 快照更新（main 每次推送都是新对象）导致重复写库。
  const reconciledRef = useRef(false);

  useEffect(() => {
    if (!isLocalOhos || !status?.supported) return;
    if (granted) {
      // 权限恢复后允许下一轮撤销再次回收。
      reconciledRef.current = false;
      return;
    }
    if (reconciledRef.current) return;
    if (
      !shouldDisableOhosCua({
        status,
        pluginEnabled: cuaPlugin?.enabled === true,
        toggling: togglingPluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID,
      })
    )
      return;
    const pluginService = services.pluginManagementService;
    if (!pluginService) return;

    logger.info("[cua] ohos permissions revoked; disabling computer use", {
      permissions: status?.permissions,
    });
    reconciledRef.current = true;
    void setEnabled(ZCODE_CUA_OFFICIAL_PLUGIN_ID, false, pluginService).catch(() => {
      // 失败时允许下次状态推送重试；错误提示由插件 store 统一处理。
      reconciledRef.current = false;
    });
    toast(intl.formatMessage({ id: "settings.computerUse.permissionRevokedToast" }));
  }, [
    cuaPlugin?.enabled,
    granted,
    intl,
    isLocalOhos,
    services.pluginManagementService,
    setEnabled,
    status?.supported,
    togglingPluginId,
  ]);
}
