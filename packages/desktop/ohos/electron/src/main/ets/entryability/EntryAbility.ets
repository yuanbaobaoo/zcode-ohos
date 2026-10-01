// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import window from '@ohos.window';
import Want from '@ohos.app.ability.Want';
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import { Configuration } from '@ohos.app.ability.Configuration';
import { BusinessError } from '@ohos.base';
import { abilityAccessCtrl, bundleManager, common, Permissions } from '@kit.AbilityKit';
import { UIContext } from '@ohos.arkui.UIContext';
import { image } from '@kit.ImageKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

import { WebAbility } from 'web_engine';
import { statusBarManager } from '@kit.DeskTopExtensionKit';

const TAG: string = 'EntryAbility';

// 用户目录读写（2in1/PC 受限权限）：requestPermissionsFromUser 会弹系统授权
// 弹窗/跳转设置里的「允许读取用户全部数据」开关。Electron 主进程启动前的
// 探针（mkdir ~/.zcode）依赖此授权，因此必须在 super.onWindowStageCreate
// （触发 RunBrowser/主进程加载）之前完成申请。
const USER_FILE_PERMISSIONS: Array<Permissions> = ['ohos.permission.READ_WRITE_USER_FILE'];
// 用户全盘访问（manual_settings）：requestPermissionsFromUser 对它无效（不弹窗），
// 只能检测状态 + 跳转设置页让用户手动打开（对应设置里「访问全盘文件」开关）。
const FULL_DISK_PERMISSION: Permissions = 'ohos.permission.ACCESS_USER_FULL_DISK';

function addToStatusBar(context: Context): void {
  try {
    const iconBuf: Uint8Array = context.resourceManager.getMediaContentSync($r('app.media.app_icon'));
    const imageSource: image.ImageSource = image.createImageSource(iconBuf.buffer as ArrayBuffer);
    const pixelMap: image.PixelMap = imageSource.createPixelMapSync();

    const statusBarItem: statusBarManager.StatusBarItem = {
      icons: {
        white: pixelMap,
        black: pixelMap,
      },
      quickOperation: {
        title: 'ZCode',
        height: 400,
        abilityName: 'StatusBarEntryAbility',
        moduleName: 'electron',
      },
      statusBarGroupMenu: [[
        {
          title: '打开 ZCode',
          menuAction: {
            abilityName: 'EntryAbility',
            moduleName: 'electron',
          },
        },
      ]],
      hoverTips: 'ZCode',
    };
    statusBarManager.addToStatusBar(context, statusBarItem);
    hilog.info(0x0000, TAG, 'Status bar icon added');
  } catch (err) {
    hilog.error(0x0000, TAG, 'Failed to add status bar icon: %{public}s',
      (err as BusinessError)?.message ?? JSON.stringify(err));
  }
}

export default class EntryAbility extends WebAbility {
  onConfigurationUpdate(config: Configuration) {
    super.onConfigurationUpdate(config);
  }

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam) {
    super.onCreate(want, launchParam);
  }

  async onPrepareToTerminateAsync(): Promise<boolean> {
    return await super.onPrepareToTerminateAsync();
  }

  async onDestroy(): Promise<void> {
    await super.onDestroy();
  }

  onWindowStageCreate(windowStage: window.WindowStage) {
    // 窗口先创建（说明弹窗需要挂在 window 上），再走授权流：
    // ① 应用内说明弹窗（解释为什么需要）→ 用户点「去开启」→ ② requestPermissionOnSetting
    // 系统授权面板 → 用户打开「访问全盘文件」。授权后新起进程立即生效（exec 权限
    // 即时性），Electron 主进程照常加载，无需重启。
    super.onWindowStageCreate(windowStage);
    windowStage.getMainWindow().then(async (win: window.Window): Promise<void> => {
      win.resizeAsync(1935, 1290);
      // 碰一碰投送注册在主页面加载后进行（EntryAbility 时机过早会注册无效）。
      await this.ensureFullDiskPermission(win);
      addToStatusBar(this.context);
    });
  }

  private async ensureFullDiskPermission(win: window.Window): Promise<void> {
    try {
      const atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
      // 用户目录读写（system_grant）：声明即授予，静默确认状态。
      const result = await atManager.requestPermissionsFromUser(this.context, USER_FILE_PERMISSIONS);
      hilog.info(0x0000, TAG, 'READ_WRITE_USER_FILE result: %{public}s', JSON.stringify(result));

      const bundleInfo: bundleManager.BundleInfo =
        await bundleManager.getBundleInfoForSelf(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
      const tokenId: number = bundleInfo.appInfo.accessTokenId;
      const fullDiskStatus: abilityAccessCtrl.GrantStatus =
        await atManager.checkAccessToken(tokenId, FULL_DISK_PERMISSION);
      hilog.info(0x0000, TAG, 'ACCESS_USER_FULL_DISK token grantStatus: %{public}d', fullDiskStatus);
      if (fullDiskStatus === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
        return;
      }

      // 第一步：应用内说明弹窗（先解释用途，用户同意才进系统授权面板）。
      const uiContext: UIContext = win.getUIContext();
      await new Promise<void>((resolve: (value: void | PromiseLike<void>) => void) => {
        uiContext.showAlertDialog({
          title: '权限申请',
          message: 'ZCode 需要「访问全盘文件」权限。您也可以稍后在 系统设置 → 应用 → ZCode 中开启。',
          autoCancel: false,
          primaryButton: {
            value: '暂不',
            action: (): void => resolve(),
          },
          secondaryButton: {
            value: '去开启',
            action: (): void => {
              // 第二步：系统授权面板（manual_settings 权限的官方弹窗入口）。
              atManager.requestPermissionOnSetting(this.context, [FULL_DISK_PERMISSION])
                .then((settingResults: Array<abilityAccessCtrl.GrantStatus>): void => {
                  hilog.info(0x0000, TAG, 'ACCESS_USER_FULL_DISK settingResults: %{public}s',
                    JSON.stringify(settingResults));
                })
                .catch((err: BusinessError): void => {
                  // API 失败时兜底：直接跳应用信息设置页。
                  hilog.warn(0x0000, TAG, 'requestPermissionOnSetting failed: %{public}d', err.code);
                  this.context.startAbility({
                    bundleName: 'com.huawei.hmos.settings',
                    abilityName: 'com.huawei.hmos.settings.MainAbility',
                    uri: 'application_info_entry',
                    parameters: { pushParams: 'ai.ohpc.zcode' },
                  }).catch((settingsErr: BusinessError): void => {
                    hilog.error(0x0000, TAG, 'jump to app settings failed: %{public}s',
                      JSON.stringify(settingsErr));
                  });
                })
                .finally((): void => resolve());
            },
          },
        });
      });
    } catch (err) {
      hilog.error(0x0000, TAG, 'ensureFullDiskPermission failed: %{public}s',
        (err as BusinessError)?.message ?? JSON.stringify(err));
    }
  }

  onWindowStageDestroy() {
    super.onWindowStageDestroy();
  }

  onForeground() {
    super.onForeground();
  }

  onBackground() {
    super.onBackground();
  }
};
