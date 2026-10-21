// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { inject, injectable } from 'inversify';
import { BusinessError } from '@ohos.base';
import { deviceInfo } from '@kit.BasicServicesKit';
import { window } from '@kit.ArkUI';
import { BaseAdapter } from '../common/BaseAdapter';
import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';
import { AdapterType, NewWindowParam, WindowBound } from '../interface/CommonInterface';
import lazy { SystemFloatingWindowManager } from '../common/SystemFloatingWindowManager';
import lazy { ContextAdapter } from './ContextAdapter';
import { WindowStyle, IUpdateStyle } from '../common/WindowStyle';
import { common } from '@kit.AbilityKit';

const TAG: string = 'SystemFloatingWindowWindow';

@injectable()
export class SystemFloatingWindowAdapter extends BaseAdapter {
  private ctxAdapter: ContextAdapter;
  private systemFloatingWindowManager: SystemFloatingWindowManager;

  constructor(
    @inject(ContextAdapter) ctxAdapter: ContextAdapter,
    @inject(SystemFloatingWindowManager) systemFloatingWindowManager: SystemFloatingWindowManager,
  ) {
  super();
    this.ctxAdapter = ctxAdapter;
    this.systemFloatingWindowManager = systemFloatingWindowManager;
  }

  @LogMethod
  createWindow(param: NewWindowParam) {
    let activeContext = this.ctxAdapter.getActiveContext() as common.UIAbilityContext;
    if (!activeContext) {
      LogUtil.warn(TAG, 'Failed to get active context');
      return;
    }

    let bounds: WindowBound = {
      left: param.bounds.left,
      top: param.bounds.top,
      width: param.bounds.width,
      height: param.bounds.height,
    };
    const out_bounds = this.adjustBounds(bounds);
    let config: window.Configuration = {
      name: param.window_id,
      windowType: window.WindowType.TYPE_FLOAT,
      ctx: activeContext,
      decorEnabled: !param.hide_title_bar
    };
    if (param.display_id !== 0) {
      config.displayId = param.display_id;
    }
    window.createWindow(config, (err: BusinessError, data) => {
      if (err.code) {
        LogUtil.error(TAG, 'Failed to create window. Cause: ' + JSON.stringify(err));
        return;
      }

      try {
        data.moveWindowTo(out_bounds.left, out_bounds.top)
          .then(() => {
            data.resize(out_bounds.width, out_bounds.height)
              .catch((err: BusinessError) => {
                LogUtil.error(TAG, 'Failed to change the window size. Cause:' + JSON.stringify(err));
              });
          }).catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to move the window. Cause:' + JSON.stringify(err));
        });
      } catch (exception) {
        LogUtil.error(TAG, 'move the window exception. Cause:' + JSON.stringify(exception));
      }

      try {
        data.on('windowSizeChange', (size) => {
          const windowProp = data.getWindowProperties();
          let windowBound: WindowBound = {
            left: windowProp.windowRect.left + windowProp.drawableRect.left,
            top: windowProp.windowRect.top + windowProp.drawableRect.top,
            width: size.width - windowProp.drawableRect.left - windowProp.drawableRect.left,
            height: size.height - windowProp.drawableRect.top - windowProp.drawableRect.top,
          };
          this.nativeContext.OnWindowSizeChange(param.window_id, windowBound);
        });
      } catch (exception) {
        LogUtil.error(TAG,'Failed to enable the listener for window size changes. Cause: ' + JSON.stringify(exception));
      }

      try {
        data.on("windowRectChange", (option) => {
          this.nativeContext.OnWindowRectChange(param.window_id, option.rect, option.reason.valueOf());
        });
      } catch (exception) {
        LogUtil.error(TAG,'Failed to enable the listener for window rect changes. Cause: ' + JSON.stringify(exception));
      }

      try {
        data.on('windowEvent', (type) => {
          this.nativeContext.OnWindowEvent(param.window_id, type.valueOf());
        });
      } catch (exception) {
        LogUtil.error(TAG, 'Failed to register callback. Cause: ' + JSON.stringify(exception));
      }

      try {
        data.on("windowVisibilityChange", (visible) => {
          this.nativeContext.OnWindowVisibilityChange(param.window_id, visible);
        });
      } catch (exception) {
        LogUtil.error(TAG, 'Failed to register callback. Cause: ' + JSON.stringify(exception));
      }

      try {
        data.on('displayIdChange', (displayId) => {
          this.nativeContext.OnWindowDisplayIdChange(param.window_id, displayId);
        });
      } catch (exception) {
        LogUtil.error(TAG, `register displayIdChange listener fail, xcomponentId:${param.window_id},
                      exception: ${JSON.stringify(exception)}`);
      }

      let windowClass = data;
      this.cacheWindow(param.window_id, windowClass);

      const proxy = this.ctxAdapter.getActiveProxy();
      const windowProperties = windowClass.getWindowProperties();
      this.nativeContext.OnWindowCreated(
        proxy?.getAbilityId(), windowProperties.id, windowProperties.name,
        param.window_id, AdapterType.kSystemFloatingWindow);

      let startUri: string = ''
      const para: Record<string, string | IUpdateStyle> = {
        'xcomponentId': param.window_id,
        'startUri': startUri,
        'updateStyle': {
          'registerUpdateStyleFunction': WindowStyle.registerUpdateStyleFunction,
          'removeUpdateStyleFunction': WindowStyle.removeUpdateStyleFunction
        }
      };
      let storage: LocalStorage = new LocalStorage(para);
      storage.setOrCreate('abilityId', proxy?.getAbilityId());
      storage.setOrCreate('originWindowId', windowProperties.id);
      windowClass.loadContent(this.getContentPath(), storage, (err, data) => {
        let errCode: number = err.code;
        if (errCode) {
          LogUtil.error(TAG, 'Failed to load the content. Cause:' + JSON.stringify(err));
          return;
        }
        try {
          windowClass.setWindowDecorVisible(!param.hide_title_bar);
        } catch (exception) {
          LogUtil.error(TAG, 'Failed to update floating window decor. Cause:' + JSON.stringify(exception));
        }
        windowClass.showWindow()
          .catch((err: BusinessError) => {
            LogUtil.error(TAG, 'Failed to show the window. Cause:' + JSON.stringify(err));
          });
      })
    });
  }

  private getContentPath(): string {
    if (this.nativeContext.IsSupportNodeHandleFeature()) {
      return 'pages/NodeHandleWindow';
    } else {
      return 'pages/Index';
    }
  }

  @LogMethod
  closeWindow(id: number) {
    let mainWindowId = this.systemFloatingWindowManager.getMainWindowId(id);
    if (mainWindowId) {
      const floatingWindow = this.systemFloatingWindowManager.getWindow(id);
      if (floatingWindow) {
        const abilityId = this.ctxAdapter.getActiveProxy()?.getAbilityId();
        const originWindowId = floatingWindow.getWindowProperties().id;
        floatingWindow.destroyWindow().then(() => {
          this.nativeContext.OnWindowClosed(abilityId, originWindowId);
        }).catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to destroy floating window. Cause:' + JSON.stringify(err));
        });
      }
      this.systemFloatingWindowManager.removeSystemFloatingWindow(mainWindowId, id);
    }
  }

  @LogMethod
  setBounds(id: number,
            bounds: WindowBound,
            onCompleted: (ret: boolean) => void) {
    let windowClass = this.systemFloatingWindowManager.getWindow(id);
    if (!windowClass) {
      onCompleted(false);
      LogUtil.error(TAG, 'Failed to obtain the main window.');
      return;
    }

    const windowProp = windowClass?.getWindowProperties();
    let xComBorder: number = windowProp?.drawableRect.left || 0;
    let xComTop: number = windowProp?.drawableRect.top || 0;
    bounds.left -= xComBorder;
    bounds.top -= xComTop;
    bounds.width = bounds.width + xComBorder + xComBorder;
    bounds.height = bounds.height + xComBorder + xComTop;

    try {
      windowClass.moveWindowTo(bounds.left, bounds.top)
        .then(() => {
          windowClass?.resize(bounds.width, bounds.height)
            .then(() => {
              onCompleted(true);
            }).catch((err: BusinessError) => {
            onCompleted(false);
            LogUtil.error(TAG, 'Failed to change the window size. Cause:' + JSON.stringify(err));
          });
        }).catch((err: BusinessError) => {
        onCompleted(false);
        LogUtil.error(TAG, 'Failed to move the window. Cause:' + JSON.stringify(err));
      });
    } catch (exception) {
      onCompleted(false);
      LogUtil.error(TAG, 'move the window exception. Cause:' + JSON.stringify(exception));
    }
  }

  @LogMethod
  hideWindow(id: number): void {
    let windowClass = this.systemFloatingWindowManager.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the system float window for hideWindow.');
      return;
    }
    // 悬浮窗的 minimize() 即"隐藏"，可用 showWindow() 恢复（见 @ohos.window 文档）。
    windowClass.minimize().then(() => {
      LogUtil.info(TAG, 'Succeeded in hiding the system float window.');
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, `Failed to hide the system float window. Cause: ${JSON.stringify(err)}`);
    });
  }

  @LogMethod
  showWindow(id: number): void {
    let windowClass = this.systemFloatingWindowManager.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the system float window for showWindow.');
      return;
    }
    // 与 hideWindow 的 minimize() 配对: 恢复显示。
    windowClass.showWindow().then(() => {
      LogUtil.info(TAG, 'Succeeded in showing the system float window.');
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, `Failed to show the system float window. Cause: ${JSON.stringify(err)}`);
    });
  }

  setMovable(id: number, movable: boolean): void {
    let windowClass = this.systemFloatingWindowManager.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the system float window for setMovable.');
      return;
    }
    try {
      // 注意: 系统悬浮窗上该接口会被窗管拒绝(1300004 Unauthorized operation,
      // 窗口类型不支持)。此处捕获以免异常逸出 NAPI; 若后续系统放开即可生效。
      windowClass.setWindowTitleMoveEnabled(movable);
    } catch (exception) {
      LogUtil.warn(TAG, `setWindowTitleMoveEnabled unsupported on system floating window, id: ${id}, ` +
        `cause code: ${exception.code}, message: ${exception.message}`);
    }
  }

  setEnabled(enable: boolean, id: number): boolean {
    let windowClass = this.systemFloatingWindowManager.getWindow(id);
    if (!windowClass) {
      LogUtil.error(TAG, 'Failed to obtain the system float window.');
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
    let windowClass = this.systemFloatingWindowManager.getWindow(id);
    const windowProp = windowClass?.getWindowProperties();
    let xComBorder: number = windowProp?.drawableRect.left || 0;
    let xComTop: number = windowProp?.drawableRect.top || 0;

    try {
      let windowLimits: window.WindowLimits = {
        minWidth: minWidth === 0 ? minWidth : minWidth + xComBorder + xComBorder,
        minHeight: minHeight === 0 ? minHeight : minHeight + xComTop + xComBorder,
        maxWidth: maxWidth === 0 ? maxWidth : maxWidth + xComBorder + xComBorder,
        maxHeight: maxHeight === 0 ? maxHeight : maxHeight + xComTop + xComBorder,
      };
      windowClass?.setWindowLimits(windowLimits)
        .catch((err: BusinessError) => {
          LogUtil.error(TAG, 'Failed to change the window limits. Cause: ' + JSON.stringify(err));
        });
    } catch (exception) {
      LogUtil.error(TAG, 'change the window limits exception. Cause:' + JSON.stringify(exception));
    }
  }

  @LogMethod
  setBackgroundColor(id: number, argbColor: number) {
    const windowClass = this.systemFloatingWindowManager.getWindow(id);
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
    const windowClass = this.systemFloatingWindowManager.getWindow(id);
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
    const windowClass = this.systemFloatingWindowManager.getWindow(id);
    try {
      windowClass?.setWindowPrivacyMode(enable, (err: BusinessError) => {
        if (err.code) {
          LogUtil.error(TAG, 'Failed to set floating window privacy mode: ' + JSON.stringify(err));
        }
      });
    } catch (exception) {
      LogUtil.error(TAG, 'Failed to set floating window privacy mode: ' + JSON.stringify(exception));
    }
  }

  @LogMethod
  startWindowMoving(id: number) {
    let window = this.systemFloatingWindowManager.getWindow(id);
    window?.startMoving().then(() => {
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, `startWindowMoving fail, error info: ${JSON.stringify(err)}`);
    });
  }

  @LogMethod
  getOriginWindowId(windowId: number): number {
    try {
      let window = this.systemFloatingWindowManager.getWindow(windowId);
      if (window) {
        return window.getWindowProperties().id;
      }
    } catch (err) {
      let message = (err as BusinessError).message;
      LogUtil.error(TAG, `getOriginWindowId failed, windowId:${windowId}, message:: ${message}`);
    }
    return -1;
  }

  @LogMethod
  setWindowShadow(id: number, hasShadow: boolean) {
    let windowClass = this.systemFloatingWindowManager.getWindow(id);
    if (windowClass === undefined) {
      LogUtil.error(TAG, `setWindowShadow fail, window is not exist! windowId: ${id}, hasShadow: ${hasShadow}`);
      return;
    }
    const radius: number = hasShadow ? 15 : 0;
    if (deviceInfo.sdkApiVersion >= 17) {
      windowClass.setWindowShadowRadius(radius);
    } else {
      LogUtil.error(TAG, 'setWindowShadow fail, sdkApiVersion is less than 17');
    }
  }

  private adjustBounds(bounds: WindowBound): WindowBound {
    let out_bounds = bounds;
    let mainWindow = this.ctxAdapter.getActiveProxy().getWindow();
    if (!mainWindow) {
      return out_bounds;
    }
    const windowProp = mainWindow?.getWindowProperties();
    let xComBorder: number = windowProp?.drawableRect.left || 0;
    let xComTop: number = windowProp?.drawableRect.top || 0;
    out_bounds.left -= xComBorder;
    out_bounds.top -= xComTop;
    out_bounds.width += xComBorder + xComBorder;
    out_bounds.height += xComBorder + xComTop;
    return out_bounds;
  }

  private cacheWindow(id: string, windowClass: window.Window) {
    let mainWindowId = this.ctxAdapter.getActiveProxy().getWindowId();
    if (mainWindowId) {
      this.systemFloatingWindowManager.addSystemFloatingWindow(mainWindowId, {
        "id": id,
        "window": windowClass
      });
    }
  }
};
