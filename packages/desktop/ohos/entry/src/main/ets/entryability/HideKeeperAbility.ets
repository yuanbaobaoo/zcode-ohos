// Copyright (c) 2026 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import UIAbility from '@ohos.app.ability.UIAbility';
import window from '@ohos.window';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { registerHideKeeperContext } from 'web_engine';

const TAG: string = 'HideKeeperAbility';

// Keeps the Electron application process alive while all user-visible
// BrowserWindow UIAbilities are hidden. This ability is excluded from missions,
// so it does not create a replacement Dock item.
export default class HideKeeperAbility extends UIAbility {
  onCreate(): void {
    registerHideKeeperContext(this.context);
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    windowStage.getMainWindow()
      .then(async (mainWindow: window.Window) => {
        // Keep this mission-less window technically foreground so HarmonyOS
        // does not freeze Electron's main-loop timers while every real
        // BrowserWindow is hidden. Make the keeper effectively invisible
        // instead of minimizing it.
        mainWindow.setWindowBackgroundColor('#00000000');
        await mainWindow.resize(1, 1);
        await mainWindow.moveWindowTo(0, 0);
      })
      .catch((err: BusinessError) => {
        hilog.error(0x0000, TAG, 'Failed to configure keeper window: %{public}s', JSON.stringify(err));
      });
  }
}
