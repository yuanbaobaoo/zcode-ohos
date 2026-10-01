// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { WebWindow } from 'web_engine';
import { KeyCode } from '@kit.InputKit';
import CustomChildProcess from '../process/CustomChildProcess';
import LogUtil from 'web_engine/src/main/ets/utils/LogUtil';
import { uiObserver, window } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@ohos.base';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ShareReceiveCoordinator } from '../share/ShareReceiveCoordinator';
import { DeviceProfileWriter } from '../device/DeviceProfileWriter';

const TAG: string = 'Index';
 
interface IStyleData {
  backgroundColor: string,
  opacity: number
};

interface IUpdateStyle {
  registerUpdateStyleFunction: Function,
  removeUpdateStyleFunction: Function
};

CustomChildProcess.toString();
let storage = LocalStorage.getShared();
@Entry(storage)
@Component
struct Index {
  @LocalStorageLink('updateStyle') updateStyle: IUpdateStyle = {
    registerUpdateStyleFunction: (id: string, initStyle: IStyleData, func: (style: IStyleData) => void) => {},
    removeUpdateStyleFunction: (id: string) => {}
  };
  @LocalStorageLink('xcomponentId') xcomponentId: string = '';

  private initStyle: IStyleData = {
    backgroundColor: 'ffffffff',
    opacity: 1
  };

  @State private backgroundColor_: string = `#${this.initStyle.backgroundColor}`;
  @State private opacity_: number = this.initStyle.opacity;

  @LocalStorageProp('statusBarHeight') statusBarHeight: number = 0;
  @State density: number = 0;

  aboutToAppear() {
    // registerUpdateStyleFunction
    this.updateStyle.registerUpdateStyleFunction(this.xcomponentId, this.initStyle, (style: IStyleData) => {
      this.backgroundColor_ = `#${style.backgroundColor}`;
      this.opacity_ = style.opacity;
    });

    uiObserver.on('densityUpdate', this.getUIContext(), (info: uiObserver.DensityInfo) => {
      this.density = info.density;
    });

    // 碰一碰投送接收：官方示例均为页面级注册（aboutToAppear/onDisappear 配对）。
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      DeviceProfileWriter.write(context);
      window.getLastWindow(context).then((win: window.Window): void => {
        ShareReceiveCoordinator.register(context, win.getWindowProperties().id);
      }).catch((err: BusinessError): void => {
        hilog.error(0x0000, TAG, 'share receive register failed: %{public}s', err.message);
      });
    } catch (err) {
      hilog.error(0x0000, TAG, 'share receive register threw: %{public}s',
        (err as BusinessError)?.message ?? JSON.stringify(err));
    }
  }

  aboutToDisappear() {
    // removeUpdateStyleFunction
    this.updateStyle.removeUpdateStyleFunction(this.xcomponentId);

    uiObserver.off('densityUpdate', this.getUIContext());
    ShareReceiveCoordinator.unregister();
  }

  build() {
    Row() {
      WebWindow()
    }.onKeyEvent((event?: KeyEvent) => {
      if (event) {
        if (event.type == KeyType.Down && event.keyCode == KeyCode.KEYCODE_ESCAPE) {
          event.stopPropagation();
        }
      }
    })
    .backgroundColor(Color.Transparent)//(this.backgroundColor_)
    .opacity(this.opacity_)
    .width('100%')
    .height('100%')
    .padding({
      top: this.getStatusBarHeight(),
    })
  }
  
  getStatusBarHeight(): number {
    LogUtil.info(TAG, 'Avoidance function, statusBarHeight:' + this.statusBarHeight + ',density:' + this.density);
    return this.getUIContext().px2vp(this.statusBarHeight);
  }
}
