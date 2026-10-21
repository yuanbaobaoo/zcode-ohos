// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import AbilityStage from '@ohos.app.ability.AbilityStage';
import Inject from '../common/InjectModule';
import JsBindingUtils from '../utils/JsBindingUtils';
import LogUtil from '../utils/LogUtil';
import Want from '@ohos.app.ability.Want';
import { CommandType, ConfigData, ContextType } from '../common/Constants';
import { ConfigurationConstant, Configuration, AbilityConstant } from '@kit.AbilityKit';
import { NativeThemeAdapter } from '../adapter/NativeThemeAdapter'
import lazy { CommonDependencyProvider } from '../common/CommonDependencyProvider';
import lazy { GlobalThisHelper } from '../utils/GlobalThisHelper';
import lazy { NativeContext, BrowserCloseResponse, TrayExitResponse } from '../interface/CommonInterface';
import AbilityIdController from '../utils/AbilityIdController';
import LogMethod from '../common/LogDecorator';

const DELAYED_TIME = 0;
const TAG: string = 'WebAbilityStage';

export class WebAbilityStage extends AbilityStage {
  private nativeContext: NativeContext | undefined = undefined;
  private nativeThemeAdapter: NativeThemeAdapter | undefined;
  private static SLEEP_INTERVAL_MS = 10;
  private static MAXIMUM_NUM_OF_SLEEP_CYCLES = 250;
  @LogMethod
  onCreate(): void {
    LogUtil.info(TAG, '[ohoswindow] in WebAbilityStage onCreate.');
    this.runTaskAsync();
  }

  @LogMethod
  onAcceptWant(want: Want): string {
    LogUtil.info(TAG, '[ohoswindow] in WebAbilityStage onAcceptWant, want is ' + JSON.stringify(want));
    let instanceKey = want.parameters?.instanceKey;
    if (typeof instanceKey === 'string' && /^browser\d+$/.test(instanceKey)) {
      return AbilityIdController.cacheUniqueId(instanceKey);
    }

    if (GlobalThisHelper.isLaunched()) {
      if (want && want.parameters) {
        if (want.parameters["appId"] !== undefined) {
          let appId = want.parameters['appId'] as string;
          let xcomponentId = GlobalThisHelper.getWebappWindow(appId);
          if (xcomponentId !== '') {
            return xcomponentId;
          }
        }
      }
      let lastActiveBrowserId = GlobalThisHelper.getLastActiveBrowserId();
      if (lastActiveBrowserId !== undefined) {
        return lastActiveBrowserId;
      }
      let widgetId = this.nativeContext?.GetLastActiveWidgetId();
      if (widgetId) {
        return ConfigData.WINDOW_PREFIX + widgetId;
      }
    }
    return AbilityIdController.acquireUniqueId();
  }

  onConfigurationUpdate(config: Configuration) {
    this.nativeThemeAdapter?.setSystemNativeTheme(config.colorMode);
  }

  @LogMethod
  async onPrepareTerminationAsync(): Promise<AbilityConstant.PrepareTermination> {
    LogUtil.info(TAG, "ability stage prepare to quit async and app exit");
    if (!this.nativeContext) {
      this.nativeContext = JsBindingUtils.getNativeContext(ContextType.kMainProcess);
    }
    if (GlobalThisHelper.isLaunched()) {
      this.nativeContext?.ExecuteCommand(
        CommandType.kTrayQuitRequest, { is_sync: false });

      let trayResponse: TrayExitResponse = TrayExitResponse.kUndetermined;
      let trayCnt = 0;
      for (let i = 0; i < WebAbilityStage.MAXIMUM_NUM_OF_SLEEP_CYCLES; i++) {
        trayCnt++;
        await this.sleep(WebAbilityStage.SLEEP_INTERVAL_MS);
        trayResponse = this.nativeContext.GetTrayExitResponse();
        if (trayResponse !== TrayExitResponse.kUndetermined) {
          break;
        }
      }
      LogUtil.info(TAG, `tray quit response: ${trayResponse}, checks: ${trayCnt}`);
      if (trayResponse !== TrayExitResponse.kAllowed) {
        return AbilityConstant.PrepareTermination.CANCEL;
      }

      this.nativeContext?.ExecuteCommand(
        CommandType.kAppExit, { is_sync: false });
    } else {
      return AbilityConstant.PrepareTermination.TERMINATE_IMMEDIATELY;
    }
    let response: BrowserCloseResponse = BrowserCloseResponse.kUndetermined;
    let cnt = 0;
    for (let i = 0; i < WebAbilityStage.MAXIMUM_NUM_OF_SLEEP_CYCLES; i++) {
      cnt++;
      await this.sleep(WebAbilityStage.SLEEP_INTERVAL_MS);
      response = this.nativeContext.GetAppCloseResponse();
      if (response !== BrowserCloseResponse.kUndetermined) {
        break;
      }
    }
    LogUtil.info(TAG, "ability stage prepare to quit async done response:" + response + " cnt:" + cnt);
    if (response === BrowserCloseResponse.kClosingContinue || response === BrowserCloseResponse.kClosed) {
      return AbilityConstant.PrepareTermination.TERMINATE_IMMEDIATELY;
    }
    return AbilityConstant.PrepareTermination.CANCEL;
  }

  sleep(delay: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  onDestroy(): void {
    LogUtil.info(TAG, "ability stage on destroy");
  }

  private runTaskAsync() {
    setTimeout(() => {
      // see https://wiki.huawei.com/domains/21385/wiki/40123/WIKI202311072298113 section 2.1
      this.context.getApplicationContext().setColorMode(ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET);
      JsBindingUtils.initNativeContext(ContextType.kMainProcess);
      this.nativeContext = JsBindingUtils.getNativeContext(ContextType.kMainProcess);
      if (!GlobalThisHelper.isLaunched()) {
        let appContext = this.context.getApplicationContext();
        GlobalThisHelper.appInit(new CommonDependencyProvider(appContext));
      }
      import('../jsbindings/JsBindingMethod').then((ns:ESObject) => {
        ns.JsBindingMethod.bind();
        this.nativeThemeAdapter = Inject.get(NativeThemeAdapter);
        JsBindingUtils.SetContextPaths();
      }).catch(()=>{
        LogUtil.error(TAG, 'runTaskAsync: import JsBindingMethod failed');
      });
    }, DELAYED_TIME)
  }
}
