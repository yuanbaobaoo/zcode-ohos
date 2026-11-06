// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import window from '@ohos.window';
import Want from '@ohos.app.ability.Want';
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import { Configuration } from '@ohos.app.ability.Configuration';
import { BusinessError } from '@ohos.base';
import { abilityAccessCtrl, bundleManager, Permissions } from '@kit.AbilityKit';
import notificationManager from '@ohos.notificationManager';
import { image } from '@kit.ImageKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import fs from '@ohos.file.fs';
import ConfigurationConstant from '@ohos.app.ability.ConfigurationConstant';

import { WebAbility } from 'web_engine';
import { statusBarManager } from '@kit.DeskTopExtensionKit';
import { ComputerControlService } from '../computerControl/ComputerControlService';

const TAG: string = 'EntryAbility';

// 用户目录读写：装机即授（spec 03），这里只是静默确认状态。
const USER_FILE_PERMISSIONS: Array<Permissions> = ['ohos.permission.READ_WRITE_USER_FILE'];
// 用户全盘访问只能检测状态 + 拉起系统面板，启动路径不主动弹窗；入口见 spec 08。
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

const WINDOW_THEME_CLOSE_WRITE_EVENT: number = 0x8;

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
    hilog.info(0x0000, TAG, 'apply window theme: %{public}s, colorMode: %{public}d',
      bridge.theme, colorMode);
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
  private windowThemeWatcher: fs.Watcher | undefined = undefined;
  private atManager: abilityAccessCtrl.AtManager = abilityAccessCtrl.createAtManager();
  private fullDiskTokenId: number = -1;
  // undefined=尚未探测：首查也落盘（冷启动即写初始状态）。
  private lastFullDiskGranted: boolean | undefined = undefined;

  onConfigurationUpdate(config: Configuration) {
    super.onConfigurationUpdate(config);
  }

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam) {
    super.onCreate(want, launchParam);
    this.startWindowThemeWatcher();
    applyWindowThemeFromBridge(this.context);
    // Computer Use 桥（spec 13）：token 签发与状态快照必须在 agent 首次调用前就绪。
    ComputerControlService.getInstance().init(this.context);
    // 自检钩子（spec 15 M3 排查）：`aa start ... --ps zcode.selftest capture|launch:<bundle>`。
    // 无该参数时零副作用；有它时把"取屏 / 拉起"的每一步打到 hilog，供宿主侧免模型取证。
    this.runSelfTestIfRequested(want);
  }

  private runSelfTestIfRequested(want: Want): void {
    const raw = want.parameters?.['zcode.selftest'];
    if (typeof raw !== 'string' || raw.length === 0) {
      return;
    }
    const service = ComputerControlService.getInstance();
    hilog.info(0x0000, TAG, 'selftest requested: %{public}s', raw);
    if (raw === 'perm') {
      // onCreate 阶段 ability 尚未前台，user_grant 弹窗会被系统忽略；延迟到窗口就绪后再请求。
      setTimeout((): void => {
        service.runPermissionSelfTest().catch((err: Error) => {
          hilog.error(0x0000, TAG, 'selftest perm threw: %{public}s', err.message ?? String(err));
        });
      }, 4000);
      return;
    }
    if (raw === 'control') {
      setTimeout((): void => {
        service.runControlPermissionSelfTest().catch((err: Error) => {
          hilog.error(0x0000, TAG, 'selftest control threw: %{public}s', err.message ?? String(err));
        });
      }, 4000);
      return;
    }
    if (raw === 'record') {
      service.runRecordSelfTest().catch((err: Error) => {
        hilog.error(0x0000, TAG, 'selftest record threw: %{public}s', err.message ?? String(err));
      });
      return;
    }
    if (raw === 'screenshot') {
      service.runScreenshotSelfTest().catch((err: Error) => {
        hilog.error(0x0000, TAG, 'selftest screenshot threw: %{public}s', err.message ?? String(err));
      });
      return;
    }
    if (raw.startsWith('launch:')) {
      const bundleName = raw.slice('launch:'.length);
      service.runLaunchSelfTest(bundleName).catch((err: Error) => {
        hilog.error(0x0000, TAG, 'selftest launch threw: %{public}s', err.message ?? String(err));
      });
      return;
    }
    hilog.warn(0x0000, TAG, 'unknown selftest kind: %{public}s', raw);
  }

  async onDestroy(): Promise<void> {
    ComputerControlService.getInstance().dispose();
    this.stopWindowThemeWatcher();
    await this.cancelAppNotificationsOnQuit();
    await super.onDestroy();
  }

  // Electron 的 will-quit 在 OHOS 不执行（关窗后进程由系统直接终结，process exit 钩子
  // 不跑，2026-11-06 实证）；任务通知归系统通知服务所有、不随进程消亡，滞留的顶部栏
  // 图标点击还会复活应用。onDestroy 是系统保证的清理挂点（spec 02）。
  private async cancelAppNotificationsOnQuit(): Promise<void> {
    try {
      await notificationManager.cancelAll();
    } catch (err) {
      hilog.warn(0x0000, TAG, 'cancel notifications on destroy failed: %{public}s', JSON.stringify(err));
    }
  }

  private startWindowThemeWatcher(): void {
    try {
      // 运行期主题只经桥文件通知 ArkTS；写入关闭后再读取，避免消费半截 JSON。
      this.windowThemeWatcher = fs.createWatcher(`${this.context.filesDir}/window-theme.json`,
        WINDOW_THEME_CLOSE_WRITE_EVENT, () => applyWindowThemeFromBridge(this.context));
      this.windowThemeWatcher.start();
    } catch (err) {
      hilog.warn(0x0000, TAG, 'watch window-theme bridge failed: %{public}s', JSON.stringify(err));
    }
  }

  private stopWindowThemeWatcher(): void {
    const watcher = this.windowThemeWatcher;
    this.windowThemeWatcher = undefined;
    try {
      watcher?.stop();
    } catch (err) {
      hilog.warn(0x0000, TAG, 'stop window-theme watcher failed: %{public}s', JSON.stringify(err));
    }
  }

  // 与厂商 v40 参考工程对齐（web_engine 源码不消费该方法，疑为厂商占位防御）。
  protected isAppEntry(): boolean {
    return true;
  }

  onWindowStageCreate(windowStage: window.WindowStage) {
    super.onWindowStageCreate(windowStage);
    windowStage.getMainWindow().then(async (): Promise<void> => {
      // v40 启动期 resizeAsync 会让 XComponent 黑屏，先停用；碰一碰注册需在主页加载后。
      await this.confirmUserFilePermission();
      this.refreshFullDiskGrantState();
      addToStatusBar(this.context);
      // 截屏权限状态（spec 15 M3+）：只在启动日志记录；缺权限时由首次截屏的 201 分支
      // 打开系统设置（PC 上 requestPermissionsFromUser 会秒拒，真机实证）。
      ComputerControlService.getInstance().checkScreenCapturePermission();
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
    // manual_settings 权限的正确入口是 openPermissionOnSetting（API 22+，直接打开该权限的
    // 系统设置页）。requestPermissionOnSetting 只接受 user_grant 且被撤销的权限，传
    // manual_settings 必报 12100014（SDK @ohos.abilityAccessCtrl.d.ts），不能用它。
    const fallback = (reason: string): void => {
      hilog.warn(0x0000, TAG, 'openPermissionOnSetting unavailable: %{public}s', reason);
      this.context.startAbility({
        bundleName: 'com.huawei.hmos.settings',
        abilityName: 'com.huawei.hmos.settings.MainAbility',
        uri: 'application_info_entry',
        parameters: { pushParams: 'ai.ohpc.zcode' },
      }).catch((settingsErr: BusinessError): void => {
        hilog.error(0x0000, TAG, 'jump to app settings failed: %{public}s',
          JSON.stringify(settingsErr));
      });
    };
    try {
      this.atManager.openPermissionOnSetting(this.context, FULL_DISK_PERMISSION)
        .then((result: abilityAccessCtrl.SelectedResult): void => {
          hilog.info(0x0000, TAG, 'ACCESS_USER_FULL_DISK setting result: %{public}s',
            JSON.stringify(result));
          this.refreshFullDiskGrantState();
        })
        .catch((err: BusinessError): void => {
          fallback(`code=${err.code}`);
        });
    } catch (err) {
      fallback(JSON.stringify(err));
    }
  }

  onWindowStageDestroy() {
    this.stopFullDiskRequestPoll();
    super.onWindowStageDestroy();
  }
};
