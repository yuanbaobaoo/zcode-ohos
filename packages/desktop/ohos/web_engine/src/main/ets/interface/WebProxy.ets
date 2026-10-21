// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { common } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { ChangeEventType } from '../interface/CommonInterface';

export interface WebProxy {
  getWindowStage: () => window.WindowStage | undefined;
  getWindow: () => window.Window | undefined;
  getWindowContext: () => common.Context | undefined;
  getAbilityId: () => string;
  getWindowId: () => string;
  closeWindow: () => void;
  hideWindow: () => void;
  setWindowTitle: (title:string) => void;
  createSubWindow: (name: string, decorEnabled?: boolean) => Promise<window.Window>;
  getOriginWindowId: () => number;
  isUIAbility: () => boolean;
  updateAvoidAreaStatus: (isFullScreen: boolean) => void;
  setDeviceModeChangeEvent: (deviceModeChangeEvent: ChangeEventType | undefined) => void;
};

export class FakeWebProxy implements WebProxy {
  getWindowStage(): window.WindowStage | undefined {
    return undefined;
  }

  getWindow(): window.Window | undefined {
    return undefined;
  }

  getWindowContext(): common.Context | undefined {
    return undefined;
  }

  getWindowId(): string {
    return '';
  }

  closeWindow() {}

  hideWindow() {}

  setWindowTitle(title:string) {}

  createSubWindow(name: string, decorEnabled?: boolean): Promise<window.Window> {
    return new Promise<window.Window>((resolve, reject) => {
      reject('fake window.')
    });
  }

  getOriginWindowId(): number {
    return -1;
  }

  isUIAbility(): boolean {
    return true;
  }

  updateAvoidAreaStatus(isFullScreen: boolean) {}

  setDeviceModeChangeEvent(deviceModeChangeEvent: ChangeEventType | undefined) {}

  getAbilityId(): string {
    return '';
  }
}
