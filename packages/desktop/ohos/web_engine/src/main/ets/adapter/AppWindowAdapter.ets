// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import bundleManager from '@ohos.bundle.bundleManager';
import { inject, injectable } from 'inversify';
import { BusinessError } from '@ohos.base';
import common from '@ohos.app.ability.common';
import { display, NodeContent, window } from '@kit.ArkUI';
import { deviceInfo } from '@kit.BasicServicesKit';
import { image } from '@kit.ImageKit';
import Want from '@ohos.app.ability.Want';
import { BaseAdapter } from '../common/BaseAdapter';
import LogUtil from '../utils/LogUtil';
import { AbilityManager } from '../common/AbilityManager';
import LogMethod from '../common/LogDecorator';
import { contextConstant, StartOptions } from '@kit.AbilityKit';
import { NewWindowParam, PointCoordinate, WindowBound, kAbilityMap,
  AbilityType, NotificationAdapterImage } from '../interface/CommonInterface';
import LaunchHelper from '../utils/LaunchHelper';
import { ContextAdapter } from './ContextAdapter';
import { DeviceInfoAdapter } from "../adapter/DeviceInfoAdapter";
import { NativeThemeAdapter } from './NativeThemeAdapter';
import { NodeHandleManager } from '../common/NodeHandleManager';
import { kTitleBarHeightVP } from '../common/Constants';
import { WindowStyle } from '../common/WindowStyle';
import CheckEmptyUtils from '../utils/CheckEmptyUtils';

const TAG: string = 'AppWindow';

@injectable()
export class AppWindowAdapter extends BaseAdapter {
  private abilityManager: AbilityManager;
  private bundleName: string = 'com.huawei.ohos_chromium';
  private bundleFlags = bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION |
                        bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_METADATA;
  private queryWindowNum: number = 10;                      
  private ctxAdapter: ContextAdapter;
  private deviceInfoAdapter: DeviceInfoAdapter;
  private themeAdapter: NativeThemeAdapter;
  private nodeHandleManager: NodeHandleManager;
  private windowButtonVisibility: Map<number, boolean> = new Map<number, boolean>();
  private hiddenByElectron: Set<number> = new Set<number>();

  constructor(
    @inject(AbilityManager) abilityManager: AbilityManager,
    @inject(ContextAdapter) ctxAdapter: ContextAdapter,
    @inject(DeviceInfoAdapter) deviceInfoAdapter: DeviceInfoAdapter,
    @inject(NativeThemeAdapter) themeAdapter: NativeThemeAdapter,
    @inject(NodeHandleManager) nodeHandleManager: NodeHandleManager
  ) {
    super();
    this.abilityManager = abilityManager;
    this.ctxAdapter = ctxAdapter;
    this.deviceInfoAdapter = deviceInfoAdapter;
    this.themeAdapter = themeAdapter;
    this.nodeHandleManager = nodeHandleManager;

    try {
      bundleManager.getBundleInfoForSelf(this.bundleFlags).then((data) => {
        this.bundleName = data?.name;
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, `getBundleInfoForSelf failed. Cause: ${err.message}`);
      });
    } catch (err) {
      let message = (err as BusinessError).message;
      LogUtil.error(TAG, `getBundleInfoForSelf failed.: ${message}`);
    }
  }

  private getWindow(id: number): window.Window | undefined {
    return this.abilityManager.getProxy(id)?.getWindow();
  }

  isHiddenWindow(id: number): boolean {
    return this.hiddenByElectron.has(id);
  }

  private applyShadow(windowClass: window.Window, id: number, hasShadow: boolean): void {
    if (deviceInfo.sdkApiVersion < 20) {
      LogUtil.warn(TAG, `[shadow] setWindowShadowEnabled requires API 20, current API is ${deviceInfo.sdkApiVersion}`);
      return;
    }
    try {
      windowClass.setWindowShadowEnabled(hasShadow).then(() => {
        LogUtil.info(TAG, `[shadow] setWindowShadowEnabled succeeded, id: ${id}, enabled: ${hasShadow}`);
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, `[shadow] setWindowShadowEnabled failed, id: ${id}: ${JSON.stringify(err)}`);
      });
    } catch (err) {
      LogUtil.warn(TAG, `[shadow] setWindowShadowEnabled unavailable, id: ${id}: ${JSON.stringify(err)}`);
    }
  }

  private backgroundColor(useDarkMode: boolean): string {
    if (useDarkMode || this.themeAdapter.isDarkMode()) {
      return NativeThemeAdapter.DARK_BACKGROUND_COLOR;
    }
    return NativeThemeAdapter.LIGHT_BACKGROUND_COLOR;
  }

  @LogMethod
  createWindow(param: NewWindowParam) {
    LogUtil.info(TAG, `[ohoswindow] in AppWindowAdapter createWindow, param is ${JSON.stringify(param)}`);
    let abilityName: string = kAbilityMap.get(param.ability_type) ?? 'EntryAbility';
    const want: Want = {
      bundleName: this.bundleName,
      abilityName: abilityName,
      parameters: {
        'xcomponentId': param.window_id,
        'hideTitleBar': param.hide_title_bar,
        'useDarkMode': param.use_dark_mode,
        'titleButtonVisible': param.caption_button_visible,
        'focusable': param.focusable,
        instanceKey: param.window_id,
        'electronManagedWindow': true,
        'webappWindow': param.app_id,
        'initStatus': param.status
      }
    };

    let windowClass = this.ctxAdapter.getActiveProxy().getWindow();
    const windowProp = windowClass?.getWindowProperties();
    let xComTop: number = 0;
    let uiContext = windowClass?.getUIContext();

    if (this.nativeContext.IsSupportNodeHandleFeature() &&
      !CheckEmptyUtils.isWindowBoundsEmpty(param.bounds) &&
      !param.hide_title_bar) {
      // Keep the bounds saved in Chromium consistent with the bounds in windowRectChange,
      // otherwise the window will shift downwards the next time it is created.
      xComTop = uiContext ? uiContext.vp2px(kTitleBarHeightVP.kDefault) : xComTop;
    }

    let options: StartOptions = {
      // BrowserWindow UIAbilities must be attached to the status bar item for
      // UIAbilityContext.hideAbility()/showAbility() to hide their Dock task
      // without terminating the Electron process (as in Electron 132/138).
      processMode: contextConstant.ProcessMode.ATTACH_TO_STATUS_BAR_ITEM,
      startupVisibility: contextConstant.StartupVisibility.STARTUP_SHOW,
      windowLeft: param.bounds.left,
      windowTop: param.bounds.top - xComTop,
      windowWidth: param.bounds.width,
      windowHeight: param.bounds.height + xComTop,
      minWindowWidth: uiContext ?
        uiContext.px2vp(param.window_limit.min_width === 0 ? 0 :
          param.window_limit.min_width) : 0,
      minWindowHeight: uiContext ?
        uiContext.px2vp(param.window_limit.min_height === 0 ? 0 :
          param.window_limit.min_height + xComTop) : 0,
      maxWindowWidth: uiContext ?
        uiContext.px2vp(param.window_limit.max_width === 0 ? 0 :
          param.window_limit.max_width) : 0,
      maxWindowHeight: uiContext ?
        uiContext.px2vp(param.window_limit.max_height === 0 ? 0 :
          param.window_limit.max_height + xComTop) : 0,
      startWindowBackgroundColor: this.backgroundColor(param.use_dark_mode),
    }
    if (param.display_id !== 0) {
      options.displayId = param.display_id;
    }
    LaunchHelper.LaunchWithOptions(this.ctxAdapter.getActiveContext(), want, options, true);
  }

  @LogMethod
  closeWindow(id: number) {
    this.hiddenByElectron.delete(id);
    this.windowButtonVisibility.delete(id);
    let proxy = this.abilityManager.getProxy(id);
    proxy?.closeWindow();
  }

  @LogMethod
  hideWindow(id: number) {
    const proxy = this.abilityManager.getProxy(id);
    if (!proxy) {
      LogUtil.error(TAG, 'Failed to find and hide the window, id: ' + id);
      return;
    }
    this.hiddenByElectron.add(id);
    const context = proxy.getWindowContext() as common.UIAbilityContext;
    context.hideAbility()
      .then(() => LogUtil.info(TAG, 'hideAbility success, id: ' + id))
      .catch((err: BusinessError) => {
        // Without a status bar item the platform rejects hideAbility(16000067).
        // A main Window has no hideWindow API; minimize it as a compatibility fallback.
        LogUtil.warn(TAG, 'hideAbility failed, falling back to minimize, id: ' + id +
          ', cause: ' + JSON.stringify(err));
        proxy.getWindow()?.minimize().catch((hideErr: BusinessError) => {
          this.hiddenByElectron.delete(id);
          LogUtil.error(TAG, 'minimize failed, id: ' + id + ', cause: ' + JSON.stringify(hideErr));
        });
      });
  }

  @LogMethod
  getWindowId(id: number): number {
    const windowId = this.getWindow(id)?.getWindowProperties().id;
    if (windowId === undefined) {
      LogUtil.error(TAG, 'getWindowId failed, return -1.');
      return -1;
    }
    return windowId;
  }

  @LogMethod
  showWindow(id: number) {
    LogUtil.info(TAG, `[ohoswindow] in AppWindowAdapter showWindow, id is ${id}`);
    const proxy = this.abilityManager.getProxy(id);
    if (!proxy) {
      LogUtil.error(TAG, '[ohoswindow] Failed to find and show the window, id: ' + id);
      return;
    }
    this.hiddenByElectron.delete(id);
    const context = proxy.getWindowContext() as common.UIAbilityContext;
    context.showAbility()
      .then(() => LogUtil.info(TAG, 'showAbility success, id: ' + id))
      .catch((err: BusinessError) => {
        LogUtil.warn(TAG, 'showAbility failed, falling back to restore, id: ' + id +
          ', cause: ' + JSON.stringify(err));
        proxy.getWindow()?.restore().catch((showErr: BusinessError) =>
          LogUtil.error(TAG, 'restore failed, id: ' + id + ', cause: ' + JSON.stringify(showErr)));
      });
  }

  @LogMethod
  activateWindow(id: number) {
    LogUtil.info(TAG, `[ohoswindow] in AppWindowAdapter activateWindow, id is ${id}`);
    this.showWindow(id);
  }

  @LogMethod
  setFullscreen(id: number) {
    let windowClass = this.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return;
    }

    if (this.deviceInfoAdapter.isNormalWindowMode()) {
      this.abilityManager.getProxy(id)?.updateAvoidAreaStatus(true);
    }

    if (deviceInfo.sdkApiVersion >= 14) {
      windowClass.maximize(window.MaximizePresentation.ENTER_IMMERSIVE_DISABLE_TITLE_AND_DOCK_HOVER)
        .catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to maximize the window. Cause:' + JSON.stringify(err));
        });
    } else {
      windowClass.maximize(window.MaximizePresentation.ENTER_IMMERSIVE)
        .catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to maximize the window. Cause:' + JSON.stringify(err));
        });
    }
  }

  @LogMethod
  setBounds(id: number, bounds: WindowBound) {
    let windowClass = this.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return;
    }

    const windowProp = windowClass.getWindowProperties();
    let xComBorder: number = windowProp?.drawableRect.left || 0;
    let xComTop: number = windowProp?.drawableRect.top || 0;
    bounds.left -= xComBorder;
    bounds.top -= xComTop;
    bounds.width = bounds.width + xComBorder + xComBorder;
    bounds.height = bounds.height + xComBorder + xComTop;

    try {
      if (windowClass.getWindowStatus() !== window.WindowStatusType.MAXIMIZE &&
        windowClass.getWindowStatus() !== window.WindowStatusType.FULL_SCREEN) {
        windowClass.moveWindowToAsync(bounds.left, bounds.top)
          .then(() => {
            if (windowClass?.getWindowStatus() !== window.WindowStatusType.MAXIMIZE &&
              windowClass?.getWindowStatus() !== window.WindowStatusType.FULL_SCREEN) {
              windowClass?.resizeAsync(bounds.width, bounds.height)
                .catch((err: BusinessError) => {
                  LogUtil.error(TAG,
                    'Failed to change the window size. Cause:' + JSON.stringify(err) + ' window status:' +
                    windowClass?.getWindowStatus());
                });
            }
          }).catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to move the window. Cause:' + JSON.stringify(err) + ' window status:' +
          windowClass?.getWindowStatus());
        });
      }
    } catch (exception) {
      LogUtil.error(TAG, 'move the window exception. Cause:' + JSON.stringify(exception));
    }
  }

  @LogMethod
  setEnabled(enable: boolean, id: number): boolean {
    let windowClass = this.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return false;
    }
    windowClass.setWindowTouchable(enable)
      .catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Failed to set the window to be touchable. Cause:' + JSON.stringify(err));
        return false;
      });
    return true;
  }

  @LogMethod
  setWindowLimits(minWidth: number,
                  minHeight: number,
                  maxWidth: number,
                  maxHeight: number,
                  id: number) {
    let windowClass = this.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return;
    }

    const windowProp = windowClass.getWindowProperties();
    let xComBorder: number = windowProp?.drawableRect.left || 0;
    let xComTop: number = windowProp?.drawableRect.top || 0;

    try {
      let windowLimits: window.WindowLimits = {
        minWidth: minWidth === 0 ? minWidth : minWidth + xComBorder + xComBorder,
        minHeight: minHeight === 0 ? minHeight : minHeight + xComTop + xComBorder,
        maxWidth: maxWidth === 0 ? maxWidth : maxWidth + xComBorder + xComBorder,
        maxHeight: maxHeight === 0 ? maxHeight : maxHeight + xComTop + xComBorder,
      };
      windowClass.setWindowLimits(windowLimits, true)
        .catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to change the window limits. Cause: ' + JSON.stringify(err));
        });
    } catch (exception) {
      LogUtil.error(TAG, 'change the window limits exception. Cause:' + JSON.stringify(exception));
    }
  }

  @LogMethod
  setWindowButtonVisibility(id: number, visible: boolean) {
    this.windowButtonVisibility.set(id, visible);
    let windowClass = this.getWindow(id);
    if (!windowClass) {
      LogUtil.warn(TAG, `Window is not ready when setting title button visibility, id: ${id}.`);
      return;
    }
    if (this.ctxAdapter.isPadNormalModel()) {
      LogUtil.info(TAG, 'tablet free multi-window model is disabled');
      return;
    }
    try {
      windowClass.setWindowTitleButtonVisible(visible, visible, visible);
    } catch (exception) {
      LogUtil.error(TAG, 'Failed to set window title button visibility. Cause: ' + JSON.stringify(exception));
    }
  }

  @LogMethod
  getWindowButtonVisibility(id: number): boolean {
    return this.windowButtonVisibility.get(id) ?? true;
  }

  @LogMethod
  maximize(id: number) {
    let windowClass = this.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return;
    }

    if (windowClass.getWindowStatus() === window.WindowStatusType.MAXIMIZE) {
      return;
    }

    try {
      windowClass.maximize(window.MaximizePresentation.EXIT_IMMERSIVE).then(() => {
        LogUtil.info(TAG, 'Succeeded in maximizing the window.');
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Failed to maximize the window. Cause:' + JSON.stringify(err));
      });

      if (!this.deviceInfoAdapter.isPcMode()) {
        this.abilityManager.getProxy(id)?.updateAvoidAreaStatus(false);
      }
    } catch (exception) {
      LogUtil.error(TAG, 'maximize the window exception. Cause:' + JSON.stringify(exception));
    }
  }

  @LogMethod
  unMaximize(id: number) {
    let windowClass = this.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return;
    }

    try {
      windowClass.recover().then(() => {
        LogUtil.info(TAG, 'Succeeded in setting the system bar to be invisible.');
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Failed to recover the window. Cause: ' + JSON.stringify(err));
      });
    } catch (exception) {
      LogUtil.error(TAG, 'recover the window exception. Cause:' + JSON.stringify(exception));
    }
  }

  @LogMethod
  minimize(id: number) {
    let windowClass = this.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return;
    }
    windowClass.minimize()
      .catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Failed to minimize the window. Cause: ' + JSON.stringify(err));
      });
  }

  @LogMethod
  setTitle(title:string, id: number) {
    let proxy = this.abilityManager.getProxy(id);
    proxy?.setWindowTitle(title);
  }

  @LogMethod
  relaunch(): boolean {
    let applicationContext = this.ctxAdapter.getContext().getApplicationContext();
    let want: Want = {
      bundleName: this.bundleName,
      abilityName: 'EntryAbility'
    };
    try {
      applicationContext.restartApp(want);
      return true;
    } catch (err) {
      LogUtil.error(TAG, 'restartApp fail, error:' + JSON.stringify(err));
      return false;
    }
  }

  @LogMethod
  setAspectRatio(id: number, aspectRatio: number) {
    let windowClass = this.getWindow(id);
    try {
      if (aspectRatio <= 0) {
        windowClass?.resetAspectRatio()?.then(() => {
          LogUtil.info(TAG, 'Succeeded in setting aspect ratio of window.');
        }).catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to set the aspect ratio of window. Cause:' + JSON.stringify(err));
        });
      } else {
        let promise = deviceInfo.sdkApiVersion < 21 ? windowClass?.setAspectRatio(aspectRatio) :
          windowClass?.setContentAspectRatio(aspectRatio, false, true);
        promise?.then(() => {
          LogUtil.info(TAG, 'Succeeded in setting aspect ratio of window.');
        }).catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to set the aspect ratio of window. Cause:' + JSON.stringify(err));
        });
      }
    } catch (exception) {
      LogUtil.error(TAG, 'Failed to set the aspect ratio of window. Cause: ' + JSON.stringify(exception));
    }
  }

  @LogMethod
  setUseNativeFrame(id: number, useNativeFrame: boolean) {
    let windowClass = this.getWindow(id);
    try {
      windowClass?.setWindowDecorVisible(useNativeFrame);
      if (!this.ctxAdapter.isPadNormalModel()) {
        windowClass?.setWindowTitleButtonVisible(useNativeFrame, useNativeFrame, useNativeFrame);
        windowClass?.setWindowTitleMoveEnabled(useNativeFrame);
      } else {
        LogUtil.info(TAG, 'tablet free multi-window model is disabled');
      }
    } catch (exception) {
      LogUtil.error(TAG, `Failed to set the visibility of window decor. Cause code: ${exception.code}, message: ${exception.message}`);
    }
  }

  @LogMethod
  setBackgroundColor(id: number, argbColor: number) {
    let windowClass = this.getWindow(id);
    const backgroundColor = WindowStyle.decimalColorToHex(argbColor);
    let data = WindowStyle.getStyleData(id) ?? {
      backgroundColor: backgroundColor,
      opacity: 1
    };
    data.backgroundColor = backgroundColor;
    WindowStyle.updateStyleData(id, data);
    WindowStyle.getUpdateStyleFunc(id)?.(data);
    windowClass?.setWindowBackgroundColor(`#${backgroundColor}`);
  }

  @LogMethod
  setOpacity(id: number, opacity: number) {
    let windowClass = this.getWindow(id);
    let data = WindowStyle.getStyleData(id) ?? {
      backgroundColor: 'ffffffff',
      opacity: opacity
    };
    data.opacity = opacity;
    WindowStyle.updateStyleData(id, data);
    WindowStyle.getUpdateStyleFunc(id)?.(data);
    windowClass?.setWindowBackgroundColor(
      `#${WindowStyle.decimalOpacityToHex(opacity)}${data.backgroundColor.slice(2)}`);
  }

  @LogMethod
  setContentProtection(id: number, enable: boolean) {
    let windowClass = this.getWindow(id);
    try {
      windowClass?.setWindowPrivacyMode(enable, (err: BusinessError) => {
        const errCode: number = err.code;
        if (errCode) {
          LogUtil.error(TAG, `Failed to set the window to privacy mode. Cause code: ${err.code}, message: ${err.message}`);
          return;
        }
        LogUtil.info(TAG, 'Succeeded in setting the window to privacy mode.');
      });
    } catch (exception) {
      LogUtil.error(TAG, `Failed to set the window to privacy mode. Cause code: ${exception.code}, message: ${exception.message}`);
    }
  }

  @LogMethod
  setMovable(id: number, movable: boolean) {
    let windowClass = this.getWindow(id);
    try {
      windowClass?.setWindowTitleMoveEnabled(movable);
    } catch (exception) {
      LogUtil.error(TAG, `Failed to set the window Movable. Cause code: ${exception.code}, message: ${exception.message}`);
    }
  }

  @LogMethod
  setResizable(id: number, resizable: boolean) {
    let windowClass = this.getWindow(id);
    try {
      windowClass?.setResizeByDragEnabled(resizable).then(() => {}).catch((err: BusinessError) => {
        LogUtil.error(TAG, `Failed to set the window resizable. Cause ${JSON.stringify(err)}`);
      });
    } catch (exception) {
      LogUtil.error(TAG, `Failed to set the window resizable. Cause code: ${exception.code}, message: ${exception.message}`);
    }
  }

  @LogMethod
  setFocusable(id: number, focusable: boolean): void {
    const windowClass = this.getWindow(id);
    try {
      windowClass?.setWindowFocusable(focusable).then(() => {
        LogUtil.info(TAG, `setWindowFocusable succeeded, id: ${id}, focusable: ${focusable}`);
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, `setWindowFocusable failed, id: ${id}: ${JSON.stringify(err)}`);
      });
    } catch (exception) {
      LogUtil.error(TAG, `setWindowFocusable threw, id: ${id}: ${JSON.stringify(exception)}`);
    }
  }

  @LogMethod
  startWindowMoving(id: number) {
    let window = this.getWindow(id);
    if (deviceInfo.sdkApiVersion >= 14) {
      window?.startMoving().then(() => {
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, `startWindowMoving fail, error info: ${JSON.stringify(err)}`);
      });
    } else {
      LogUtil.error(TAG, 'startWindowMoving fail, sdkApiVersion is less than 14');
    }
  }

  @LogMethod
  startWindowMovingWithOffset(id: number, offsetX: number, offsetY: number) {
    let window = this.getWindow(id);
    if (deviceInfo.sdkApiVersion >= 15) {
      window?.startMoving(offsetX, offsetY).then(() => {
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, `startWindowMovingWithOffset fail, error info: ${JSON.stringify(err)}`);
      });
    } else {
      LogUtil.error(TAG, 'startWindowMovingWithOffset fail, sdkApiVersion is less than 15');
    }
  }

  @LogMethod
  getWindowsByCoordinate(coordinate: PointCoordinate,
                         callback: (windowIds: Array<string>) => void) {
    let windowIds = new Array<string>();
    if (deviceInfo.sdkApiVersion >= 14) {
      try {
        window.getWindowsByCoordinate(coordinate.displayId, this.queryWindowNum,
          coordinate.x, coordinate.y).then((windows) => {
          for (let win of windows) {
            let originWindowId: number = win.getWindowProperties().id
            let windowId = this.abilityManager.getWindowIdByOriginWindow(originWindowId);
            if (windowId) {
              windowIds.push(windowId);
            }
          }
          callback(windowIds);
        }).catch((err: BusinessError) => {
          LogUtil.error(TAG, 'window.getWindowsByCoordinate fail, code:' + JSON.stringify(err.code) +
            ',message:' + JSON.stringify(err.message));
          callback(windowIds);
        });
      } catch (err) {
        LogUtil.error(TAG, 'getWindowsByCoordinate fail, error:' + JSON.stringify(err));
        callback(windowIds);
      }
    } else {
      LogUtil.error(TAG, 'getWindowsByCoordinate fail, sdkApiVersion is less than 14');
      callback(windowIds);
    }
	}

  @LogMethod
  restore(id: number) {
    let windowClass = this.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return;
    }
    windowClass.restore().then(() => {
      LogUtil.info(TAG, 'Succeeded in restoring the window.');
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, 'Failed to restore the window. Cause: ' + JSON.stringify(err));
    });
  }

  @LogMethod
  getOriginWindowIds(windowIds: Array<number>): Array<number> {
    let originWindowIds = new Array<number>();
    try {
      for (let i = 0; i < windowIds.length; i++) {
        let originWindowId = this.abilityManager.getProxy(windowIds[i])?.getOriginWindowId();
        originWindowIds.push(originWindowId ? originWindowId : -1);
      }
    } catch (err) {
      let message = (err as BusinessError).message;
      LogUtil.error(TAG, `getOriginWindowIds failed.: ${message}`);
    }
    return originWindowIds;
  }

  @LogMethod
  shiftWindowMouseEvent(sourceId: number, targetId: number,
    callback: (result: boolean) => void): void {
    if (deviceInfo.sdkApiVersion >= 15) {
      try {
        let sourceOriginWindowId = this.abilityManager.getProxy(sourceId)?.getOriginWindowId();
        let targetOriginWindowId = this.abilityManager.getProxy(targetId)?.getOriginWindowId();
        window.shiftAppWindowPointerEvent(sourceOriginWindowId, targetOriginWindowId).then(() => {
          LogUtil.info(TAG, 'shiftWindowEvent success.');
          callback(true);
        }).catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to shiftWindowEvent. Cause: ' + JSON.stringify(err));
          callback(false);
        })
      } catch (err) {
        let message = (err as BusinessError).message;
        LogUtil.error(TAG, `shiftWindowEvent failed.: ${message}`);
        callback(false);
      }
    } else {
      LogUtil.error(TAG, 'shiftWindowEvent fail, sdkApiVersion is less than 15');
      callback(false);
    }
  }

  @LogMethod
  bind(id: string, callback: (nodeContent: NodeContent | undefined) => void) {
    let nodeContent = this.nodeHandleManager.getNodeContent(id);
    if (!nodeContent) {
      LogUtil.warn(TAG, 'bind node handle with node content failed, not find node content for id' + id);
      callback(undefined);
      return;
    }
    callback(nodeContent);
  }

  @LogMethod
  unbind(id: string, callback: (nodeContent: NodeContent | undefined) => void) {
    let nodeContent = this.nodeHandleManager.getNodeContent(id);
    if (!nodeContent) {
      LogUtil.warn(TAG, 'unbind node handle with node content failed, not find node content for id' + id);
      callback(undefined);
      return;
    }
    callback(nodeContent);
  }

  @LogMethod
  shiftWindowTouchEvent(sourceId: number, targetId: number,
    fingerId: number, callback: (result: boolean) => void): void {
    if (deviceInfo.sdkApiVersion >= 20) {
      try {
        let sourceOriginWindowId = this.abilityManager.getProxy(sourceId)?.getOriginWindowId();
        let targetOriginWindowId = this.abilityManager.getProxy(targetId)?.getOriginWindowId();
        window.shiftAppWindowTouchEvent(sourceOriginWindowId, targetOriginWindowId, fingerId).then(() => {
          LogUtil.info(TAG, 'shiftWindowTouchEvent success.');
          callback(true);
        }).catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to shiftWindowTouchEvent. Cause: ' + JSON.stringify(err));
          callback(false);
        })
      } catch (err) {
        let message = (err as BusinessError).message;
        LogUtil.error(TAG, `shiftWindowTouchEvent failed.: ${message}`);
        callback(false);
      }
    } else {
      LogUtil.error(TAG, 'shiftWindowTouchEvent fail, sdkApiVersion is less than 20');
      callback(false);
    }
  }

  @LogMethod
  setWindowIcon(id: number, icon: NotificationAdapterImage): void {
    if (deviceInfo.sdkApiVersion < 22) {
      LogUtil.error(TAG, 'setWindowIcon fail, sdkApiVersion is less than 22');
      return;
    }

    const context = this.abilityManager.getProxy(id)?.getWindowContext() as common.UIAbilityContext;
    if (context === undefined) {
      LogUtil.error(TAG, `getWindowContext() failed, windowId: ${id}`);
      return;
    }
    const options: image.InitializationOptions = {
      editable: false,
      pixelFormat: image.PixelMapFormat.BGRA_8888,
      size: { height: icon.height, width: icon.width }
    };
    image.createPixelMap(icon.buff, options).then((pixelMap) => {
      context.setMissionWindowIcon(pixelMap).catch((err: BusinessError) => {
        LogUtil.error(TAG, `setMissionWindowIcon failed, err: ${JSON.stringify(err)}`);
      });
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, `createPixelMap failed, err: ${JSON.stringify(err)}`);
    });
  }

  @LogMethod
  setWindowShadow(id: number, hasShadow: boolean): void {
    const windowClass = this.getWindow(id);
    if (windowClass === undefined) {
      LogUtil.info(TAG, `[shadow] Window is not ready; state remains queued, id: ${id}`);
      return;
    }
    this.applyShadow(windowClass, id, hasShadow);
  }
};
