// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import window from '@ohos.window';
import Want from '@ohos.app.ability.Want';
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import { Configuration } from '@ohos.app.ability.Configuration';
import { BusinessError } from '@ohos.base';
import { abilityAccessCtrl, bundleManager, Permissions } from '@kit.AbilityKit';
import { image } from '@kit.ImageKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import fs from '@ohos.file.fs';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';

import { WebAbility } from 'web_engine';
import { statusBarManager } from '@kit.DeskTopExtensionKit';

const TAG: string = 'EntryAbility';

// 用户目录读写：装机即授（spec 03），这里只是静默确认状态。
const USER_FILE_PERMISSIONS: Array<Permissions> = ['ohos.permission.READ_WRITE_USER_FILE'];
// 用户全盘访问（manual_settings）：requestPermissionsFromUser 对它无效（不弹窗），只能
// 检测状态 + 拉起系统授权面板。不守护核心功能（brew/HiShell 环境依赖 CUSTOM_SANDBOX 与
// READ_WRITE_USER_FILE，见排障 #15），故启动路径不主动弹窗；引导入口为首次进主页的
// 一次性 toast + 设置页开关（spec 08）。
const FULL_DISK_PERMISSION: Permissions = 'ohos.permission.ACCESS_USER_FULL_DISK';
// 授权状态桥文件：main 经 haps 沙箱路径读取并 fs.watch（目录约定见 desktopOhosWindowTheme）。
const FULL_DISK_STATE_FILENAME: string = 'full-disk-access.json';
// 「去开启」请求文件：iframe/window.open 自定义 scheme 在 OHOS Electron 静默失败
// （真机实证，不进外部协议分发），改由 main 落此文件、本 ability 前台轮询消费（spec 08）。
const FULL_DISK_REQUEST_FILENAME: string = 'full-disk-access.request';
// 前台轮询间隔：请求文件消费延迟上限，肉眼近似即时。
const FULL_DISK_POLL_INTERVAL_MS: number = 1000;

// main 进程写入的主题桥文件结构（desktopOhosWindowTheme.ts，spec 07）。
interface WindowThemeBridge {
  theme?: string;
}

// 授权状态桥文件结构：main 读取并 watch（spec 08）。ArkTS 要求对象字面量有显式类型。
interface FullDiskGrantState {
  granted: boolean;
  updatedAt: number;
}

// 启动时按应用主题声明系统栏深浅（读取 main 经沙箱桥写入的文件，spec 07）。
function applyWindowThemeFromBridge(context: Context): void {
  try {
    const bridgePath = `${context.filesDir}/window-theme.json`;
    if (!fs.accessSync(bridgePath)) {
      return;
    }
    const bridge: WindowThemeBridge = JSON.parse(fs.readTextSync(bridgePath));
    const colorMode = bridge.theme === 'dark'
      ? ConfigurationConstant.ColorMode.COLOR_MODE_DARK
      : bridge.theme === 'light'
        ? ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT
        : ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
    context.getApplicationContext().setColorMode(colorMode);
  } catch (err) {
    hilog.warn(0x0000, TAG, 'read window-theme bridge failed: %{public}s', JSON.stringify(err));
  }
}

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
  private fullDiskRequestTimer: number = -1;
  private atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
  private fullDiskTokenId: number = -1;
  // undefined=尚未探测：首查也落盘（冷启动即写初始状态）。
  private lastFullDiskGranted: boolean | undefined = undefined;

  onConfigurationUpdate(config: Configuration) {
    super.onConfigurationUpdate(config);
  }

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam) {
    super.onCreate(want, launchParam);
    // 系统栏深浅跟随应用主题：main 经沙箱文件桥写入（spec 07），setColorMode
    // 一旦设置不可再改（真机实证），必须在窗口创建前于 onCreate 一次性声明。
    applyWindowThemeFromBridge(this.context);
  }

  async onPrepareToTerminateAsync(): Promise<boolean> {
    return await super.onPrepareToTerminateAsync();
  }

  async onDestroy(): Promise<void> {
    await super.onDestroy();
  }

  onWindowStageCreate(windowStage: window.WindowStage) {
    super.onWindowStageCreate(windowStage);
    windowStage.getMainWindow().then(async (win: window.Window): Promise<void> => {
      win.resizeAsync(1935, 1290);
      // 碰一碰投送注册在主页面加载后进行（EntryAbility 时机过早会注册无效）。
      await this.confirmUserFilePermission();
      this.refreshFullDiskGrantState();
      addToStatusBar(this.context);
    });
    this.startFullDiskRequestPoll();
  }

  onForeground() {
    super.onForeground();
    // PC 上该回调不保证触发（窗口覆盖不走生命周期），状态回流主要靠轮询；这里兜底一次。
    this.refreshFullDiskGrantState();
    this.startFullDiskRequestPoll();
  }

  onBackground() {
    this.stopFullDiskRequestPoll();
    super.onBackground();
  }

  private async confirmUserFilePermission(): Promise<void> {
    try {
      const atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
      const result = await atManager.requestPermissionsFromUser(this.context, USER_FILE_PERMISSIONS);
      hilog.info(0x0000, TAG, 'READ_WRITE_USER_FILE result: %{public}s', JSON.stringify(result));
    } catch (err) {
      hilog.warn(0x0000, TAG, 'READ_WRITE_USER_FILE request failed: %{public}s',
        (err as BusinessError)?.message ?? JSON.stringify(err));
    }
  }

  // PC 上窗口覆盖/切回不触发 onForeground/onBackground（真机实证），授权变化只能靠
  // 轮询发现：1s tick 同步查状态，值变化才写桥文件（main watch → renderer 刷新）。
  private queryFullDiskGrantedSync(): boolean {
    try {
      if (this.fullDiskTokenId === -1) {
        const bundleInfo: bundleManager.BundleInfo =
          bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
        this.fullDiskTokenId = bundleInfo.appInfo.accessTokenId;
      }
      const status: abilityAccessCtrl.GrantStatus =
        this.atManager.checkAccessTokenSync(this.fullDiskTokenId, FULL_DISK_PERMISSION);
      return status === abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED;
    } catch (err) {
      hilog.warn(0x0000, TAG, 'query full-disk state failed: %{public}s',
        (err as BusinessError)?.message ?? JSON.stringify(err));
      return false;
    }
  }

  private writeFullDiskGrantState(granted: boolean): void {
    try {
      const state: FullDiskGrantState = {
        granted: granted,
        updatedAt: Date.now(),
      };
      // @ohos.file.fs 无 writeTextSync（读有 readTextSync，写必须 fd）。
      const stateFile: fs.File = fs.openSync(`${this.context.filesDir}/${FULL_DISK_STATE_FILENAME}`,
        fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(stateFile.fd, JSON.stringify(state));
      fs.closeSync(stateFile);
      this.lastFullDiskGranted = granted;
    } catch (err) {
      hilog.warn(0x0000, TAG, 'write full-disk state failed: %{public}s',
        (err as BusinessError)?.message ?? JSON.stringify(err));
    }
  }

  private startFullDiskRequestPoll(): void {
    if (this.fullDiskRequestTimer !== -1) {
      return;
    }
    this.fullDiskRequestTimer = setInterval((): void => {
      this.refreshFullDiskGrantState();
      this.consumeFullDiskAccessRequest();
    }, FULL_DISK_POLL_INTERVAL_MS);
  }

  private stopFullDiskRequestPoll(): void {
    if (this.fullDiskRequestTimer !== -1) {
      clearInterval(this.fullDiskRequestTimer);
      this.fullDiskRequestTimer = -1;
    }
  }

  private refreshFullDiskGrantState(): void {
    const granted: boolean = this.queryFullDiskGrantedSync();
    if (granted !== this.lastFullDiskGranted) {
      this.writeFullDiskGrantState(granted);
    }
  }

  private consumeFullDiskAccessRequest(): void {
    try {
      const reqPath = `${this.context.filesDir}/${FULL_DISK_REQUEST_FILENAME}`;
      if (!fs.accessSync(reqPath)) {
        return;
      }
      fs.unlinkSync(reqPath);
      this.openFullDiskAccessPanel();
    } catch (err) {
      hilog.warn(0x0000, TAG, 'consume full-disk request failed: %{public}s',
        (err as BusinessError)?.message ?? JSON.stringify(err));
    }
  }

  private openFullDiskAccessPanel(): void {
    // manual_settings 权限的官方弹窗入口；面板交互完成后轮询会带回最新状态。
    this.atManager.requestPermissionOnSetting(this.context, [FULL_DISK_PERMISSION])
      .then((settingResults: Array<abilityAccessCtrl.GrantStatus>): void => {
        hilog.info(0x0000, TAG, 'ACCESS_USER_FULL_DISK settingResults: %{public}s',
          JSON.stringify(settingResults));
        this.refreshFullDiskGrantState();
      })
      .catch((err: BusinessError): void => {
        // 本运行时该 API 对 manual_settings 恒失败（12100014，真机实证）：
        // 兜底跳应用信息设置页，用户手动开关后由轮询回流状态。
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
      });
  }

  onWindowStageDestroy() {
    this.stopFullDiskRequestPoll();
    super.onWindowStageDestroy();
  }
};
