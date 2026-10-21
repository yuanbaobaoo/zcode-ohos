// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { StartOptions, Want } from '@kit.AbilityKit';
import LogUtil from './LogUtil';
import common from '@ohos.app.ability.common';
import { BusinessError } from '@kit.BasicServicesKit';

const TAG: string = 'LaunchHelper';

export default class LaunchHelper {
  static LaunchWithOptions(uiContext: Context | undefined,
                           want: Want,
                           options: StartOptions,
                           retryWithoutStatusBarItem: boolean = false): boolean {
    try {
      let context = uiContext as common.UIAbilityContext ||
        uiContext as common.UIExtensionContext;
      if (!context) {
        LogUtil.error(TAG, `[ohoswindow] excute failed, want: ${JSON.stringify(want)}, options:  ${JSON.stringify(options)}`);
        return false;
      }
      context.startAbility(want, options)
        .catch((error: BusinessError) => {
          if (retryWithoutStatusBarItem && error.code === 16000067) {
            // Apps without a status-bar item cannot use ATTACH_TO_STATUS_BAR_ITEM.
            // processMode and startupVisibility must either both be set or both omitted.
            const fallbackOptions: StartOptions = {
              windowLeft: options.windowLeft,
              windowTop: options.windowTop,
              windowWidth: options.windowWidth,
              windowHeight: options.windowHeight,
              minWindowWidth: options.minWindowWidth,
              minWindowHeight: options.minWindowHeight,
              maxWindowWidth: options.maxWindowWidth,
              maxWindowHeight: options.maxWindowHeight,
              startWindowBackgroundColor: options.startWindowBackgroundColor
            };
            if (options.displayId !== undefined) {
              fallbackOptions.displayId = options.displayId;
            }
            LogUtil.warn(TAG, '[ohoswindow] status-bar launch rejected (16000067), retrying as regular window');
            context.startAbility(want, fallbackOptions).catch((fallbackError: BusinessError) => {
              LogUtil.error(TAG, `[ohoswindow] regular-window launch failed. Cause: ${JSON.stringify(fallbackError)}`);
            });
          } else {
            LogUtil.error(TAG, `[ohoswindow] excute failed. Cause: ${JSON.stringify(error)}`);
          }
      });
    } catch (exception) {
      LogUtil.error(TAG, `[ohoswindow] excute failed exception. Cause: ${JSON.stringify(exception)}`);
      return false;
    }
    return true;
  }

  static async AsyncLaunch(uiContext: Context | undefined,
                           want: Want,
                           options: StartOptions = {}): Promise<boolean> {
    try {
      let context = uiContext as common.UIAbilityContext ||
        uiContext as common.UIExtensionContext;
      if (!context) {
        LogUtil.error(TAG, `excute failed, want: ${JSON.stringify(want)}, options:  ${JSON.stringify(options)}`);
        return false;
      }
      await context.startAbility(want, options);
      return true;
    } catch (exception) {
      LogUtil.error(TAG, `excute failed exception. Cause: ${JSON.stringify(exception)}`);
      return false;
    }
  }

  static Launch(uiContext: Context | undefined, want: Want): boolean {
    return LaunchHelper.LaunchWithOptions(uiContext, want, {});
  }
}
