// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import LogUtil from '../utils/LogUtil';
import window from '@ohos.window';
import Want from '@ohos.app.ability.Want';
import JsBindingUtils from '../utils/JsBindingUtils';
import { ChangeEventType, NativeContext } from '../interface/CommonInterface';
import { CommandType, ConfigData, ContextType } from '../common/Constants';
import CheckEmptyUtils from '../utils/CheckEmptyUtils';
import { WebProxy } from '../interface/WebProxy';
import { common, EmbeddedUIExtensionAbility, UIExtensionContentSession } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { CmdArgsHelper } from '../utils/CmdArgsHelper';

const TAG: string = 'WebBaseExtensionAbility';

export class WebBaseExtensionAbility extends EmbeddedUIExtensionAbility implements WebProxy {
  protected xcomponentId: string = ''; // Guest module id
  protected startUri: string = '';
  protected hostModuleId: number = 0; // Host module id
  protected hostModuleType: number = 0; // Host module type, Ability or SubWindow
  protected userData: string = ''; // Host module specified
  protected session: UIExtensionContentSession | undefined = undefined;
  protected nativeContext: NativeContext =
    JsBindingUtils.getNativeContext(ContextType.kMainProcess);
  protected hideTitleBar: boolean = true;
  protected cmdArgs: Array<string> = [];

  private initParameters(want: Want) {
    if (want.parameters) {
      if (want.parameters['xcomponentId'] !== undefined) {
        this.xcomponentId = want.parameters['xcomponentId'] as string;
      }
      if (want.parameters['hostModuleId'] !== undefined) {
        this.hostModuleId = want.parameters['hostModuleId'] as number;
      }
      if (want.parameters['hostModuleType'] !== undefined) {
        this.hostModuleType = want.parameters['hostModuleType'] as number;
      }
      if (want.parameters['userData'] !== undefined) {
        this.userData = want.parameters['userData'] as string;
      }
      let args = want.parameters['cmdArgs'];
      this.cmdArgs = CmdArgsHelper.getCmdArgs(args);
    }

    if (want.uri) {
      let storePath = want.uri as string;
      // convert storage path to uri
      this.startUri = storePath.replace("file://docs/", "file:///");
    }
  }

  onSessionCreate(want: Want, session: UIExtensionContentSession) {
    this.initParameters(want);

    if (CheckEmptyUtils.isEmpty(this.xcomponentId)) {
      LogUtil.info(TAG, 'onCreate, Allocate xcomponent id');
      let widgetId = this.nativeContext.ExecuteCommand(CommandType.kGetWidget, {}).widget_Id;
      this.xcomponentId = ConfigData.WINDOW_PREFIX + widgetId;
    }

    this.session = session;
  }

  // implements WebProxy interface
  getWindowStage(): window.WindowStage | undefined {
    return undefined;
  }

  getWindow(): window.Window | undefined {
    return undefined;
  }

  getWindowContext(): common.Context {
    return this.context;
  }

  getWindowId(): string {
    return this.xcomponentId;
  }

  closeWindow() {
    this.context.terminateSelf()
      .then(() => {
        LogUtil.info(TAG, 'terminate Self id: ' + this.getWindowId());
      })
      .catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Failed to terminate Self: ' + JSON.stringify(err));
      });
  }

  hideWindow() {
    this.closeWindow();
  }

  setWindowTitle(title:string) {}

  createSubWindow(name: string, decorEnabled: boolean = false): Promise<window.Window> {
    return new Promise<window.Window>((resolve, reject) => {
      if (!this.session) {
        reject('Failed to get Session');
        return;
      }
      const windowProxy = this.session.getUIExtensionWindowProxy();
      const subWindowOpts: window.SubWindowOptions = {
        title: 'This is a subwindow',
        decorEnabled: decorEnabled
      };
      windowProxy?.createSubWindowWithOptions(name, subWindowOpts)
        .then((data: window.Window) => {
          resolve(data);
        }).catch((error: BusinessError) => {
        reject(error);
      })
    });
  }

  getOriginWindowId(): number {
    return -1;
  }

  isUIAbility(): boolean {
    return false;
  }

  updateAvoidAreaStatus(isFullScreen: boolean) {}

  setDeviceModeChangeEvent(deviceModeChangeEvent: ChangeEventType | undefined) {}

  getAbilityId(): string {
    return '';
  }
};
