// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { inject, injectable } from 'inversify';
import window from '@ohos.window';
import { IParams,
         ISubWindowInfo,
         NewWindowParam,
         WindowBound,
         AdapterType } from '../interface/CommonInterface';
import { AbilityManager } from '../common/AbilityManager';
import { BaseAdapter } from '../common/BaseAdapter';
import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';
import { BusinessError } from '@kit.BasicServicesKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { SystemFloatingWindowManager } from '../common/SystemFloatingWindowManager';
import { NodeHandleManager } from '../common/NodeHandleManager';
import { WindowStyle } from '../common/WindowStyle';
import { ContextAdapter } from './ContextAdapter';

const TAG: string = 'SubWindow';
const FEEDBACK_X: number = 2;
const MAX_TOTAL_SUB_WINDOW_NUM: number = 20;

@injectable()
export class SubWindowAdapter extends BaseAdapter {
  private abilityManager: AbilityManager;
  private ctxAdapter: ContextAdapter;
  private systemFloatingWindowManager: SystemFloatingWindowManager;
  private subWindowList: (ISubWindowInfo)[] = [];
  private reusableSubWindow: Map<string, (ISubWindowInfo)[]> =
    new Map<string, (ISubWindowInfo)[]>();
  private globalCache: (ISubWindowInfo)[] = [];
  private nodeHandleManager: NodeHandleManager;
  private backgroundColors: Map<string, string> = new Map<string, string>();

  constructor(
    @inject(AbilityManager) abilityManager: AbilityManager,
    @inject(ContextAdapter) ctxAdapter: ContextAdapter,
    @inject(SystemFloatingWindowManager) systemFloatingWindowManager: SystemFloatingWindowManager,
    @inject(NodeHandleManager) nodeHandleManager: NodeHandleManager,
  ) {
    super();
    this.abilityManager = abilityManager;
    this.ctxAdapter = ctxAdapter;
    this.systemFloatingWindowManager = systemFloatingWindowManager;
    this.nodeHandleManager = nodeHandleManager;
  }

  @LogMethod
  createSubWindow(param: NewWindowParam) {
    LogUtil.info(
        TAG,
        `[ohoswindow] in SubWindowAdapter createSubWindow, param is:\n` +
            `parent_id=${param.parent_id}\n` + `window_id=${param.window_id}\n` +
            `bounds={ left=${param.bounds.left}, top=${param.bounds.top}, ` +
            `width=${param.bounds.width}, height=${param.bounds.height} }\n` +
            `init_color_argb=${param.init_color_argb}\n` +
            `hide_title_bar=${param.hide_title_bar}\n` +
            `use_dark_mode=${param.use_dark_mode}\n` +
            `caption_button_visible=${param.caption_button_visible}\n` +
            `ability_type=${param.ability_type}\n` + `app_id=${param.app_id}`);
    let parentId = param.parent_id
    let fixedBounds = this.adjustBounds(parentId, param.bounds);
    const para: Record<string, IParams> = {
      'subWindowParams': {
        id: param.window_id,
        size: [fixedBounds.width, fixedBounds.height],
        initColorRgb: param.init_color_argb,
      }
    };
    let subStorage: LocalStorage = new LocalStorage(para);
    subStorage.setOrCreate('windowOpacity', 1);
    this.createNewWindow(parentId, param.window_id, fixedBounds, subStorage,
      param.hide_title_bar, this.nativeContext.IsSupportNodeHandleFeature() && param.focusable);
  }

  @LogMethod
  reuseSubWindow(param: NewWindowParam): string {
    let parentId = param.parent_id
    let fixedBounds = this.adjustBounds(parentId, param.bounds);
    const reusableWindow =
      this.findReuseableSubWindow(param.window_id, parentId, fixedBounds.width, fixedBounds.height);
    if (reusableWindow) {
      let proxy = this.abilityManager.getProxy(parentId);
      if (!proxy) {
        let mainWindowId = this.systemFloatingWindowManager.getMainWindowId(parentId);
        proxy = this.abilityManager.getProxy((mainWindowId as string));
      }
      this.nativeContext.OnWindowCreated(proxy?.getAbilityId(), reusableWindow.subWindow.getWindowProperties().id,
        reusableWindow.subWindow.getWindowProperties().name, reusableWindow.id, AdapterType.kSubWindow);
      LogUtil.info(
          TAG,
          `[ohoswindow] in SubWindowAdapter reuseSubWindow, param is:\n` +
              `parent_id=${param.parent_id}\n` + `window_id=${param.window_id}\n` +
              `bounds={ left=${param.bounds.left}, top=${param.bounds.top}, ` +
              `width=${param.bounds.width}, height=${param.bounds.height} }\n` +
              `init_color_argb=${param.init_color_argb}\n` +
              `hide_title_bar=${param.hide_title_bar}\n` +
              `use_dark_mode=${param.use_dark_mode}\n` +
              `caption_button_visible=${param.caption_button_visible}\n` +
              `ability_type=${param.ability_type}\n` + `app_id=${param.app_id}`);
      try {
        reusableWindow.subWindow.setWindowDecorVisible(!param.hide_title_bar);
        reusableWindow.localStorage.setOrCreate('windowOpacity', 1);
        let paramsLink: SubscribedAbstractProperty<IParams> =
          reusableWindow.localStorage.link('subWindowParams');
        let lastParams = paramsLink.get();
        lastParams.initColorRgb = param.init_color_argb;
        paramsLink.set(lastParams);
        this.resizeSubWindow(reusableWindow.subWindow, fixedBounds.width, fixedBounds.height);
        this.moveSubWindow(reusableWindow.subWindow, fixedBounds.left, fixedBounds.top, parentId);
        this.nativeContext.OnContentLoaded(proxy?.getAbilityId(), reusableWindow.subWindow.getWindowProperties().id,
          reusableWindow.id, this.nodeHandleManager.getNodeContent(reusableWindow.id));
        reusableWindow.subWindow.setWindowFocusable(
          this.nativeContext.IsSupportNodeHandleFeature() && param.focusable)
          .then(() => reusableWindow.subWindow.showWindow())
          .catch((err: BusinessError) => {
            reusableWindow.id = "";
            LogUtil.error(TAG, 'Failed to reuseSubWindow: ' + reusableWindow.id + ', err: ' + JSON.stringify(err));
          });
        return reusableWindow.id;
      } catch (e) {
        LogUtil.error(TAG,'[ohoswindow] reuseSubWindow error' + reusableWindow.id);
      }
    }
    return "";
  }

  private getParentWindow(parentId: string): window.Window | undefined {
    let mainWindow = this.abilityManager.getProxy(parentId)?.getWindow();
    if (!mainWindow) {
      let mainWindowId = this.systemFloatingWindowManager.getMainWindowId(parentId);
      mainWindow = this.abilityManager.getProxy((mainWindowId as string))?.getWindow();
    }
    return mainWindow;
  }

  private adjustBounds(parentId: string, bounds: WindowBound): WindowBound {
    // Do not mutate the bounds object received from the native bridge. Popup
    // parameters can be retained and reused by the native side; changing the
    // object in place makes the correction accumulate across menu/tooltip
    // reuse and causes their anchor position to drift.
    let adjustedBounds: WindowBound = {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height
    };
    let mainWindow = this.getParentWindow(parentId);
    if (!mainWindow) {
      return adjustedBounds;
    }
    const windowProp = mainWindow.getWindowProperties();
    if (windowProp && windowProp.drawableRect.left !== 0) {
      adjustedBounds.top += windowProp.drawableRect.left;
    } else {
      // In full-screen mode, when a sub-window is created, the window is
      // moved left by two pixels to adjust its position relative to the cursor point.
      adjustedBounds.top += FEEDBACK_X;
    }
    return adjustedBounds;
  }

  private findSubWindow(id: string): ISubWindowInfo | undefined {
    for (let i = 0; i < this.subWindowList.length; i++) {
      const item = this.subWindowList[i];
      if (item && item.id === id) {
        return item;
      }
    }
    return undefined;
  }

  private findReuseableSubWindow(windowId: string, parentId: string, width: number, height: number)
    : ISubWindowInfo | undefined {
    let reusableSubWindowList = this.reusableSubWindow.get(parentId);
    if (!reusableSubWindowList) {
      return undefined;
    }
    for (let i = 0; i < reusableSubWindowList.length; i++) {
      const reusableWindow = reusableSubWindowList[i];
      if (!reusableWindow) {
        continue;
      }
      try {
        // 复用要在原生侧重新登记这个窗口(OnWindowCreated/OnContentLoaded)，而这些通知需要
        // parent 能解析出 ability。子窗不是独立 ability：popup 挂在子窗上时这里两级都取不到，
        // 继续复用会把 undefined 当作 abilityId 传给原生接口，JSBind 参数类型不匹配后原生层
        // 崩溃。因此把它当作不可复用条目摘掉(清理方式与 dc221e31983 一致)，交回上层走 Create。
        let parentProxy = this.abilityManager.getProxy(reusableWindow.parentId);
        if (!parentProxy) {
          let mainWindowId = this.systemFloatingWindowManager.getMainWindowId(reusableWindow.parentId);
          parentProxy = this.abilityManager.getProxy((mainWindowId as string));
        }
        if (!parentProxy) {
          LogUtil.warn(
            TAG,
            `[ohoswindow] drop reusable subwindow ${reusableWindow.id}, ` +
                `parent ability not found: ${reusableWindow.parentId}`);
          this.nodeHandleManager.removeNodeContent(reusableWindow.id);
          reusableSubWindowList.splice(i, 1);
          i--;
          continue;
        }
        const rect = reusableWindow.subWindow.getWindowProperties().windowRect;
        const maxDistance:number = 2;
        if (Math.abs(rect.width - width) <= maxDistance &&
          Math.abs(rect.height - height) <= maxDistance) {
          reusableSubWindowList.splice(i, 1);
          let found = false;
          for (let j = 0; j < this.globalCache.length; j++) {
            if (this.globalCache[j].parentId === reusableWindow.parentId &&
                this.globalCache[j].id === reusableWindow.id) {
              found = true;
              this.globalCache.splice(j, 1);
              break;
            }
          }
          if (!found) {
            LogUtil.error(TAG, '[ohoswindow] Global cache is inconsistent with cache of ' + reusableWindow.parentId);
          }
          LogUtil.info(TAG, `[ohoswindow] reusableWindow ${reusableWindow.id} size ${reusableSubWindowList.length}`);
          let nodeContent = this.nodeHandleManager.getNodeContent(reusableWindow.id);
          if (nodeContent == undefined) {
            LogUtil.error(TAG, 'Not find nodecontent of subwindow, id: ' + reusableWindow.id);
            return undefined;
          }
          this.nodeHandleManager.removeNodeContent(reusableWindow.id);
          this.nodeHandleManager.addNodeContent(windowId, nodeContent);
          reusableWindow.id = windowId;
          this.subWindowList.push(reusableWindow);
          return reusableWindow;
        }
      } catch (exception) {
        this.nodeHandleManager.removeNodeContent(reusableWindow.id);
        reusableSubWindowList.splice(i, 1);
        i--;
        LogUtil.warn(TAG, `[ohoswindow] Failed to find reuseable subwindow, exception ${JSON.stringify(exception)}`);
      }
    }
    return undefined;
  }

  private createNewWindow(parentId: string,
                          id: string,
                          bounds: WindowBound,
                          subStorage: LocalStorage,
                          hideTitleBar: boolean,
                          focusable: boolean) {
    LogUtil.info(TAG, `[ohoswindow] in SubWindowAdapter createNewWindow, id is ${id}, parent id is ${parentId}`);
    let proxy = this.abilityManager.getProxy(parentId);
    if (!proxy) {
      let mainWindowId = this.systemFloatingWindowManager.getMainWindowId(parentId);
      proxy = this.abilityManager.getProxy((mainWindowId as string));
    }
    if (!proxy) {
      proxy = this.ctxAdapter.getActiveProxy();
    }
    proxy?.createSubWindow(id, !hideTitleBar)
      .then((data: window.Window) => {
        this.nativeContext.OnWindowCreated(proxy?.getAbilityId(), data.getWindowProperties().id,
          data.getWindowProperties().name, id, AdapterType.kSubWindow);
        subStorage.setOrCreate('abilityId', proxy?.getAbilityId());
        subStorage.setOrCreate('originWindowId', data.getWindowProperties().id);
        this.initSubWindow(data, parentId, id, bounds, subStorage, hideTitleBar, focusable);
      }).catch((error: BusinessError) => {
      LogUtil.error(TAG, '[ohoswindow] Failed to create the subWindow. Cause: ' + JSON.stringify(error));
    });
  }

  private initSubWindow(data: window.Window,
                        parentId: string,
                        id: string,
                        bounds: WindowBound,
                        subStorage: LocalStorage,
                        hideTitleBar: boolean,
                        focusable: boolean) {
    LogUtil.info(TAG, `[ohoswindow] in SubWindowAdapter initSubWindow, id is ${id}, parent id is ${parentId}`);
    try {
      let windowClass = data;
      windowClass.keepKeyboardOnFocus(true);
      const windowInfo: ISubWindowInfo = {
        id: id,
        parentId: parentId,
        subWindow: windowClass,
        localStorage: subStorage
      };
      this.subWindowList.push(windowInfo);

      windowClass.on('windowSizeChange', (size) => {
        const prop = data.getWindowProperties();
        let windowBound: WindowBound = {
          left: prop.windowRect.left,
          top: prop.windowRect.top,
          width: size.width,
          height: size.height
        };
        this.nativeContext.OnWindowSizeChange(windowInfo.id, windowBound);
      });

      if (this.nativeContext.IsSupportNodeHandleFeature()) {
        windowClass.on('windowRectChange', (option) => {
          this.nativeContext.OnWindowRectChange(windowInfo.id, option.rect, option.reason.valueOf());
        });
      }

      this.moveSubWindow(windowClass, bounds.left, bounds.top, parentId);
      if (bounds.width > 0 && bounds.height > 0) {
        this.resizeSubWindow(windowClass, bounds.width, bounds.height);
      }
      windowClass.loadContent(this.getContentPath(), subStorage, (err) => {
        if (err.code) {
          LogUtil.error(TAG, '[ohoswindow] Failed to load the subwindow. Cause:' + JSON.stringify(err));
          return;
        }
        windowClass.setWindowFocusable(focusable)
          .then(() => {
            windowClass.showWindow()
              .then(() => {
                try {
                  windowClass.setWindowDecorVisible(!hideTitleBar);
                  this.resizeSubWindow(windowClass, bounds.width, bounds.height);
                  this.moveSubWindow(windowClass, bounds.left, bounds.top, parentId);
                } catch (exception) {
                  LogUtil.error(TAG, '[ohoswindow] Failed to update subwindow decor. Cause: ' +
                    JSON.stringify(exception));
                }
              })
              .catch((err: BusinessError) => {
                LogUtil.error(TAG, '[ohoswindow] Failed to show SubWindow. Cause: ' + JSON.stringify(err));
              });
          }).catch(() => {
          LogUtil.error(TAG, '[ohoswindow] set focusable failed')
        });
      });
    } catch (exception) {
      LogUtil.error(TAG,'[ohoswindow] Failed to create sub window. Cause: ' + JSON.stringify(exception));
    }
  }

  private getContentPath(): string {
    if (this.nativeContext.IsSupportNodeHandleFeature()) {
      return 'pages/NodeHandleSubWindow';
    } else {
      return 'pages/SubWindow';
    }
  }

  private async resizeSubWindow(windowClass: window.Window, width: number, height: number) {
    return await windowClass.resize(width, height);
  }

  private moveSubWindow(windowClass: window.Window, x: number, y: number, parentId: string) {
    if (deviceInfo.sdkApiVersion >= 15) {
      let displayId : number | undefined;
      let mainWindow = this.getParentWindow(parentId);
      if (mainWindow) {
        const prop = mainWindow.getWindowProperties();
        displayId = prop.displayId;
      }
      try {
        let config: window.MoveConfiguration = {
          displayId: displayId
        };
        let promise = windowClass.moveWindowToAsync(x, y, config);
        promise.then(() => {
          LogUtil.info(TAG, `Succeeded in moving the window, display id: ${displayId}`);
        }).catch((err: BusinessError) => {
          LogUtil.error(TAG, `Failed to move the window. Cause code: ${err.code},
            message: ${err.message}, display id: ${displayId}`);
        });
      } catch (exception) {
        LogUtil.error(TAG, `Failed to move the window. Cause code: ${exception.code},
          message: ${exception.message}, display id: ${displayId}`);
      }
    } else {
      windowClass.moveWindowTo(x, y, (err) => {
        if (err.code) {
          LogUtil.error(TAG, 'Failed to move the subWindow. Cause:' + JSON.stringify(err));
        }
      });
    }
  }

  @LogMethod
  cancelSubWindow(id: string) {
    const index = this.subWindowList.findIndex(item => item?.id === id);
    if (index === -1) {
      LogUtil.error(TAG, 'Failed to find and cancel SubWindow, id' + id);
      return;
    }
    const item = this.subWindowList[index];
    item.subWindow.minimize();
    this.addReuseWindow(item);
    this.subWindowList.splice(index, 1);
    let proxy = this.abilityManager.getProxy(item.parentId);
    if (!proxy) {
      let mainWindowId = this.systemFloatingWindowManager.getMainWindowId(item.parentId);
      proxy = this.abilityManager.getProxy((mainWindowId as string));
    }
    if (!proxy) {
      // 窗口已经 minimize 并放回复用缓存，这里只是补原生通知。parent 取不到 ability 时
      // (例如子窗已销毁)不能把 undefined 当 abilityId 传给原生接口，跳过通知即可。
      LogUtil.warn(TAG, `[ohoswindow] cancelSubWindow: parent ability not found: ${item.parentId}`);
      return;
    }
    this.nativeContext.OnContentUnloaded(proxy.getAbilityId(), item.subWindow.getWindowProperties().id, item.id);
    this.nativeContext.OnWindowClosed(proxy.getAbilityId(), item.subWindow.getWindowProperties().id);
  }

  private addReuseWindow(item: ISubWindowInfo) {
    LogUtil.info(TAG, `[ohoswindow] in SubWindowAdapter addReuseWindow.`);
    if (!item) {
      LogUtil.error(TAG, 'addReuseWindow fail');
    }
    let total = this.getTotalSubWindowNum();
    this.globalCache.push(item);
    let reuseWindowList = this.reusableSubWindow.get(item.parentId);
    if (reuseWindowList) {
      reuseWindowList.push(item);
    } else {
      this.reusableSubWindow.set(item.parentId, [item]);
    }
    if (total > MAX_TOTAL_SUB_WINDOW_NUM) {
      let oldest = this.globalCache.shift();
      if (oldest) {
        let target = this.reusableSubWindow.get(oldest.parentId);
        if (!target) {
          LogUtil.error(TAG, 'Global cache is inconsistent with cache of ' + oldest.parentId);
        } else {
          let found = false;
          for (let i = 0; i < target.length; i++) {
            if (oldest.id === target[i].id) {
              found = true;
              target.splice(i, 1);
              break;
            }
          }
          if (!found) {
            LogUtil.error(TAG, 'Global cache is inconsistent with cache of ' + oldest.parentId);
          }
        }
        oldest.subWindow.destroyWindow().catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to destroy the subWindow. Cause:' + JSON.stringify(err));
        });
      } else {
        LogUtil.error(TAG, 'Global cache should not be empty at this point');
      }
    }
  }

  private getTotalSubWindowNum(): number {
    return this.subWindowList.length + this.globalCache.length;
  }

  @LogMethod
  hideSubWindow(id: string) {
    const item = this.findSubWindow(id);
    if (item == undefined) {
      LogUtil.error(TAG, 'Failed to find and hide SubWindow, id: ' + id);
      return;
    }
    item.subWindow.minimize().catch((err: BusinessError) => {
      LogUtil.error(TAG, 'Failed to hide SubWindow. Cause: ' + JSON.stringify(err));
    });
  }

  @LogMethod
  showSubWindow(id: string) {
    LogUtil.info(TAG, `[ohoswindow] in SubWindowAdapter showSubWindow, id is ${id}`);
    const item = this.findSubWindow(id);
    item?.subWindow.showWindow().catch((err: BusinessError) => {
      LogUtil.error(TAG, '[ohoswindow] Failed to show SubWindow. Cause: ' + JSON.stringify(err));
    });
  }

  @LogMethod
  setSubWindowBounds(id: string, r: WindowBound) {
    const item = this.findSubWindow(id);
    if (item == undefined) {
      LogUtil.error(TAG, 'Failed to find and set SubWindow bounds, id: ' + id);
      return;
    }
    let windowClass = item.subWindow;
    try {
      windowClass.resize(r.width, r.height, (err) => {
        if (err.code) {
          LogUtil.error(TAG, 'Failed to change the subWindow size. Cause:' + JSON.stringify(err));
          return;
        }
      });
      windowClass.moveWindowTo(r.left, r.top, (err) => {
        if (err.code) {
          LogUtil.error(TAG, 'Failed to move the subwindow. Cause:' + JSON.stringify(err));
          return;
        }
      });
    } catch (exception) {
      LogUtil.error(TAG, 'Failed to set SubWindow bounds. Cause: ' + JSON.stringify(exception));
    }
  }

  @LogMethod
  setWindowLimits(minWidth: number, minHeight: number, maxWidth: number,
                  maxHeight: number, id: string) {
    const item = this.findSubWindow(id);
    if (!item) {
      LogUtil.error(TAG, 'Failed to find and set SubWindow limits, id: ' + id);
      return;
    }
    const prop = item.subWindow.getWindowProperties();
    const border = prop?.drawableRect.left || 0;
    const top = prop?.drawableRect.top || 0;
    const limits: window.WindowLimits = {
      minWidth: minWidth === 0 ? 0 : minWidth + border + border,
      minHeight: minHeight === 0 ? 0 : minHeight + top + border,
      maxWidth: maxWidth === 0 ? 0 : maxWidth + border + border,
      maxHeight: maxHeight === 0 ? 0 : maxHeight + top + border,
    };
    item.subWindow.setWindowLimits(limits, true).catch((err: BusinessError) => {
      LogUtil.error(TAG, 'Failed to set SubWindow limits: ' + JSON.stringify(err));
    });
  }

  @LogMethod
  setMovable(id: string, movable: boolean): void {
    const item = this.findSubWindow(id);
    if (!item) {
      LogUtil.error(TAG, 'Failed to find SubWindow for setMovable, id: ' + id);
      return;
    }
    item.subWindow.setWindowTitleMoveEnabled(movable);
  }

  @LogMethod
  setEnabled(id: string, enable: boolean): boolean {
    const item = this.findSubWindow(id);
    if (!item) {
      LogUtil.error(TAG, 'Failed to find and enable SubWindow, id: ' + id);
      return false;
    }
    item.subWindow.setWindowTouchable(enable).catch((err: BusinessError) => {
      LogUtil.error(TAG, 'Failed to set SubWindow touchable: ' + JSON.stringify(err));
    });
    return true;
  }

  @LogMethod
  setBackgroundColor(id: string, argbColor: number) {
    const item = this.findSubWindow(id);
    if (!item) {
      return;
    }
    const color = WindowStyle.decimalColorToHex(argbColor);
    this.backgroundColors.set(id, color);
    item.subWindow.setWindowBackgroundColor(`#${color}`);
  }

  @LogMethod
  setOpacity(id: string, opacity: number) {
    const item = this.findSubWindow(id);
    if (!item) {
      return;
    }
    const color = this.backgroundColors.get(id) ?? 'ffffffff';
    item.localStorage.setOrCreate('windowOpacity', opacity);
    item.subWindow.setWindowBackgroundColor(
      `#${WindowStyle.decimalOpacityToHex(opacity)}${color.slice(2)}`);
  }

  @LogMethod
  setContentProtection(id: string, enable: boolean) {
    const item = this.findSubWindow(id);
    try {
      item?.subWindow.setWindowPrivacyMode(enable, (err: BusinessError) => {
        if (err.code) {
          LogUtil.error(TAG, 'Failed to set SubWindow privacy mode: ' + JSON.stringify(err));
        }
      });
    } catch (exception) {
      LogUtil.error(TAG, 'Failed to set SubWindow privacy mode: ' + JSON.stringify(exception));
    }
  }

  @LogMethod
  startWindowMoving(id: string) {
    this.findSubWindow(id)?.subWindow.startMoving().catch((err: BusinessError) => {
      LogUtil.error(TAG, 'Failed to start moving SubWindow: ' + JSON.stringify(err));
    });
  }

  @LogMethod
  getOriginWindowId(id: string): number {
    try {
      return this.findSubWindow(id)?.subWindow.getWindowProperties().id ?? -1;
    } catch (exception) {
      LogUtil.error(TAG, 'Failed to get SubWindow origin id: ' + JSON.stringify(exception));
      return -1;
    }
  }

  @LogMethod
  setWindowShadow(id: string, hasShadow: boolean) {
    const item = this.findSubWindow(id);
    if (item && deviceInfo.sdkApiVersion >= 17) {
      item.subWindow.setWindowShadowRadius(hasShadow ? 15 : 0);
    }
  }

  private getWindowName(window: window.Window) {
    try {
      let prop = window.getWindowProperties();
      return prop?.name;
    } catch (error) {
      LogUtil.warn(TAG, 'Failed to get window name');
    }
    return "";
  }
}
