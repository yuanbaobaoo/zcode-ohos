/*
 * Copyright (c) 2023-2025 Huawei Device Co., Ltd.
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this list of
 *    conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list
 *    of conditions and the following disclaimer in the documentation and/or other materials
 *    provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors may be used
 *    to endorse or promote products derived from this software without specific prior written
 *    permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS;
 * OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
 * OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
 * ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
 
import { WebNodeHandleWindow } from 'web_engine';
import CustomChildProcess from '../process/CustomChildProcess';
import { KeyCode } from '@kit.InputKit';
import { uiObserver, window } from '@kit.ArkUI';
import LogUtil from 'web_engine/src/main/ets/utils/LogUtil';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@ohos.base';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { ShareReceiveCoordinator } from '../share/ShareReceiveCoordinator';
import { DeviceProfileWriter } from '../device/DeviceProfileWriter';
 
const TAG: string = 'NodeHandleWindow';

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
struct NodeHandleWindow {
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
 
  aboutToAppear(): void {
    // registerUpdateStyleFunction
    this.updateStyle.registerUpdateStyleFunction(this.xcomponentId, this.initStyle, (style: IStyleData) => {
      this.backgroundColor_ = `#${style.backgroundColor}`;
      this.opacity_ = style.opacity;
    });
    uiObserver.on('densityUpdate', this.getUIContext(), (info: uiObserver.DensityInfo) => {
      this.density = info.density;
    });
    // 碰一碰投送接收：注册须在实际加载的主页面（本页或 pages/Index 按特性二选一），
    // EntryAbility 窗口创建时机过早会注册无效（真机实证）。
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

  aboutToDisappear(): void {
    // removeUpdateStyleFunction
    this.updateStyle.removeUpdateStyleFunction(this.xcomponentId);
    uiObserver.off('densityUpdate', this.getUIContext());
    ShareReceiveCoordinator.unregister();
  }
 
  build() {
    Row() {
      WebNodeHandleWindow()
    }.onKeyEvent((event?: KeyEvent) => {
      if (event) {
        if (event.type == KeyType.Down && event.keyCode == KeyCode.KEYCODE_ESCAPE) {
          event.stopPropagation();
        }
      }
    })
    .backgroundColor(Color.Black)//(this.backgroundColor_)
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