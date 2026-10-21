// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import UIAbility from '@ohos.app.ability.UIAbility';
import LogUtil from '../utils/LogUtil';
import window from '@ohos.window';
import Want from '@ohos.app.ability.Want';
import AbilityConstant from '@ohos.app.ability.AbilityConstant';
import JsBindingUtils from '../utils/JsBindingUtils';
import { ChangeEventType, NativeContext, WindowStatus } from '../interface/CommonInterface';
import { CommandType, ConfigData, ContextType } from '../common/Constants';
import CheckEmptyUtils from '../utils/CheckEmptyUtils';
import { WebProxy } from '../interface/WebProxy';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { WebAbilityStage } from '../application/WebAbilityStage';
import { CmdArgsHelper } from '../utils/CmdArgsHelper';
import AbilityIdController from '../utils/AbilityIdController';
import { systemShare } from '@kit.ShareKit';
import { ContinueAbility } from './ContinueAbility';
import Inject from '../common/InjectModule';
import { ContextAdapter } from '../adapter/ContextAdapter';

const TAG: string = 'WebBaseAbility';
const SHARE_ACTION: string = 'ohos.want.action.sendData';

interface NormalizedSharedRecord {
  utd?: Object | string | number | boolean;
  content?: Object | string | number | boolean;
  uri?: Object | string | number | boolean;
  title?: Object | string | number | boolean;
  description?: Object | string | number | boolean;
}

export class WebBaseAbility extends UIAbility implements WebProxy {
  // The xcomponentId is regarded as the index of the window aligned with the
  // ETS and C++ sides. In the Chromium main window, the value of xcomponentId
  // is the same as that of abilityId, and the historical architecture is
  // compatible.
  protected abilityId: string = '';
  protected xcomponentId: string = '';
  protected startUri: string = '';
  protected windowStage: window.WindowStage | undefined = undefined;
  protected nativeContext: NativeContext =
    JsBindingUtils.getNativeContext(ContextType.kMainProcess);
  // Keep the window undecorated until Chromium supplies its frame preference.
  // This prevents the system title bar from being committed before frame:false
  // reaches a newly created Electron window.
  protected hideTitleBar: boolean = true;
  protected originWindowId: number = -1;
  protected useDarkMode: boolean = false;
  protected isStateless: boolean = false;
  protected titleButtonVisible: boolean = true;
  protected focusable: boolean = true;
  protected appId: string = '';
  protected deviceModeChangeEvent: ChangeEventType | undefined = undefined;
  protected initStatus: WindowStatus = WindowStatus.FLOATING;
  protected cmdArgs: Array<string> = [];
  protected minimizable: boolean = !this.hideTitleBar;
  protected maximizable: boolean = !this.hideTitleBar;
  protected closable: boolean = !this.hideTitleBar;
  protected alwaysOntop: boolean = false;
  protected resizable: boolean = true;
  protected isModal: boolean = false;
  protected isPanel: boolean = false;
  protected electronManagedWindow: boolean = false;
  protected hidingByApi: boolean = false;
  private continueAbility: ContinueAbility | undefined = undefined;

  private initParameters(want: Want) {
    if (want && want.parameters) {
      const xcomponentId = want.parameters['xcomponentId'];
      if (typeof xcomponentId === 'string' && xcomponentId.length > 0) {
        this.xcomponentId = xcomponentId;
      }
      if (want.parameters['electronManagedWindow'] === true) {
        this.electronManagedWindow = true;
      }
      if (want.parameters["hideTitleBar"] !== undefined) {
        this.hideTitleBar = want.parameters['hideTitleBar'] as boolean;
      }
      if (want.parameters['minimizable'] !== undefined) {
        this.minimizable = want.parameters['minimizable'] as boolean;
      }
      if (want.parameters['maximizable'] !== undefined) {
        this.maximizable = want.parameters['maximizable'] as boolean;
      }
      if (want.parameters['closable'] !== undefined) {
        this.closable = want.parameters['closable'] as boolean;
      }
      if (want.parameters['resizable'] !== undefined) {
        this.resizable = want.parameters['resizable'] as boolean;
      }
      if (want.parameters['isModal'] !== undefined) {
        this.isModal = want.parameters['isModal'] as boolean;
      }
      if (want.parameters['isPanel'] !== undefined) {
        this.isPanel = want.parameters['isPanel'] as boolean;
      }
      if (want.parameters["useDarkMode"] !== undefined) {
        this.useDarkMode = want.parameters['useDarkMode'] as boolean;
      }
      if (want.parameters["titleButtonVisible"] !== undefined) {
        this.titleButtonVisible = want.parameters['titleButtonVisible'] as boolean;
      }
      if (want.parameters['focusable'] !== undefined) {
        this.focusable = want.parameters['focusable'] as boolean;
      }
      if (want.parameters["appId"] !== undefined) {
        this.appId = want.parameters['appId'] as string;
      }
      if (want.parameters["webappWindow"] !== undefined && want.parameters["webappWindow"] !== '') {
        this.appId = "--app-id=" + want.parameters['webappWindow'] as string;
      }
      if (want.parameters["initStatus"] !== undefined) {
        this.initStatus = want.parameters['initStatus'] as WindowStatus;
      }

      let args = want.parameters['cmdArgs'];
      this.cmdArgs = CmdArgsHelper.getCmdArgs(args);
    }

    if (want["uri"]) {
      let storePath = want['uri'] as string;
      // convert storage path to uri
      this.startUri = storePath.replace("file://docs/", "file:///");
    }
  }

  protected getContentPath(): string {
    if (this.nativeContext.IsSupportNodeHandleFeature()) {
      return 'pages/NodeHandleWindow';
    } else {
      return 'pages/Index';
    }
  }

  private getContinueAbility(): ContinueAbility {
    if (this.continueAbility === undefined) {
      this.continueAbility = new ContinueAbility(this.context, this.nativeContext);
    }
    return this.continueAbility;
  }

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam) {
    this.initParameters(want);
    this.handleSharedData(want);
    this.abilityId = this.xcomponentId;

    if (CheckEmptyUtils.isEmpty(this.xcomponentId)) {
      this.abilityId = AbilityIdController.getUniqueId();
      this.xcomponentId = this.abilityId;
      LogUtil.info(TAG, `onCreate set this.xcomponentId to: ${this.xcomponentId}`);
    } else {
      LogUtil.info(TAG, `widget already created, onCreate set this.xcomponentId to: ${this.xcomponentId}`);
    }

    this.handleContinueRestore(want, launchParam);
  }

  onContinue(wantParam: Record<string, Object>): AbilityConstant.OnContinueResult {
    return this.getContinueAbility().onContinue(wantParam);
  }

  protected handleContinueRestore(want: Want, launchParam: AbilityConstant.LaunchParam) {
    this.getContinueAbility().handleContinueRestore(want, launchParam);
  }

  onWindowStageCreate(windowStage: window.WindowStage) {
    this.windowStage = windowStage;
    this.originWindowId = windowStage?.getMainWindowSync().getWindowProperties().id;
    this.getContinueAbility().requestDistributedPermissionIfNeeded();
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    this.handleSharedData(want);
  }

  // implements WebProxy interface
  getWindowStage(): window.WindowStage | undefined {
    return this.windowStage;
  }

  getWindow(): window.Window | undefined {
    return this.windowStage?.getMainWindowSync();
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

  async hideWindow() {
    try {
      // A UIAbility is also the system mission backing an Electron top-level
      // window. Terminating the last one removes the Dock item, but would also
      // tear down the Electron process. Keep one mission-less ability alive so
      // BrowserWindow.show() can recreate and rebind the UIAbility later.
      Inject.get(ContextAdapter).setHiddenWindowId(this.xcomponentId);
      await this.context.startAbility({
        bundleName: this.context.abilityInfo.bundleName,
        abilityName: 'HideKeeperAbility'
      }, {
        hideStartWindow: true
      });
      this.hidingByApi = true;
      await this.context.terminateSelf();
      LogUtil.info(TAG, 'hide window by terminating UIAbility, id: ' + this.getWindowId());
    } catch (err) {
      Inject.get(ContextAdapter).clearHiddenWindowId(this.xcomponentId);
      this.hidingByApi = false;
      LogUtil.error(TAG, 'Failed to hide window: ' + JSON.stringify(err));
    }
  }

  setWindowTitle(title:string) {
    this.context.setMissionLabel(title)
      .catch((err: BusinessError) => {
        LogUtil.error(TAG, 'Failed to set title: ' + JSON.stringify(err));
      });
  }

  createSubWindow(name: string, decorEnabled: boolean = true): Promise<window.Window> {
    return new Promise<window.Window>((resolve, reject) => {
      if (!this.windowStage) {
        reject('Failed to get windowStage');
        return;
      }
      const options: window.SubWindowOptions = {
        title: '',
        decorEnabled: decorEnabled
      };
      this.windowStage.createSubWindowWithOptions(name, options)
        .then((data: window.Window) => {
          resolve(data);
        }).catch((error: BusinessError) => {
        reject(error);
      })
    });
  }

  getOriginWindowId(): number {
    return this.originWindowId;
  }

  isUIAbility(): boolean {
    return true;
  }

  public updateAvoidAreaStatus(isFullScreen: boolean) {
    let windowClass = this.getWindow();
 
    // Set window to full screen.
    windowClass?.setWindowLayoutFullScreen(true).then(() => {
      LogUtil.info(TAG, 'Succeeded in setting the window layout to full-screen mode.');
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, 'Failed to set the window layout to full-screen mode. Cause:' + JSON.stringify(err));
    });
 
    // Hide the navigation bar here.
    windowClass?.setSpecificSystemBarEnabled('navigationIndicator', false).then(() => {
      LogUtil.info(TAG, 'Succeeded in setting the navigation indicator to be invisible.');
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, `Failed to set the navigation indicator to be invisible. Code is ${err.code}, message is ${err.message}`);
    });
 
    // The top status bar is set up to be hidden when in full-screen mode and displayed when maximized.
    windowClass?.setSpecificSystemBarEnabled('status', !isFullScreen).then(() => {
      LogUtil.info(TAG, 'Succeeded in setting the status bar to be invisible.');
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, `Failed to set the status bar to be invisible. Code is ${err.code}, message is ${err.message}`);
    });
  }

  public setDeviceModeChangeEvent(deviceModeChangeEvent: ChangeEventType | undefined) {
    this.deviceModeChangeEvent = deviceModeChangeEvent;
  }

  getAbilityId(): string {
    return this.abilityId;
  }

  private handleSharedData(want: Want): void {
    if (!want || want.action !== SHARE_ACTION) {
      return;
    }
    systemShare.getSharedData(want).then((data: systemShare.SharedData) => {
      let records = data.getRecords();
      let sharedRecords: NormalizedSharedRecord[] = [];
      for (let i = 0; i < records.length; i++) {
        sharedRecords.push(this.normalizeSharedRecord(records[i]));
      }
      this.nativeContext.OnSharedDataReceived(JSON.stringify(sharedRecords));
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, 'Failed to get shared data: ' + JSON.stringify(err));
    });
  }

  private normalizeSharedRecord(record: systemShare.SharedRecord): NormalizedSharedRecord {
    let result: NormalizedSharedRecord = {};
    if (record.utd !== undefined && record.utd !== null) {
      result.utd = record.utd;
    }
    if (record.content !== undefined && record.content !== null) {
      result.content = record.content;
    }
    if (record.uri !== undefined && record.uri !== null) {
      result.uri = record.uri;
    }
    if (record.title !== undefined && record.title !== null) {
      result.title = record.title;
    }
    if (record.description !== undefined && record.description !== null) {
      result.description = record.description;
    }
    return result;
  }
};
