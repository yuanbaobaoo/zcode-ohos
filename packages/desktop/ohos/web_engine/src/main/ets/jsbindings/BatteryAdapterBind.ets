// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import JsBindingUtils from '../utils/JsBindingUtils';
import Inject from '../common/InjectModule';
import lazy { BatteryAdapter } from '../adapter/BatteryAdapter';
import type { BatteryInfo } from '../interface/CommonInterface'

function implBatteryAdapter(): BatteryAdapter {
  return Inject.getOrCreate(BatteryAdapter);
}

function getBatteryInfo(callback: (batteryStatus: BatteryInfo) => void): boolean {
  return implBatteryAdapter().GetBatteryInfo(callback);
}

function registerBatteryUpdateCallback(callback: (batteryStatus: BatteryInfo) => void): boolean {
  return implBatteryAdapter().registerBatteryUpdateCallback(callback);
}

function unregisterBatteryUpdateCallback(): void {
  implBatteryAdapter().unregisterBatteryUpdateCallback();
}

export class BatteryAdapterBind {
  static bind() {
    JsBindingUtils.bindFunction('BatteryAdapter.GetBatteryInfo', getBatteryInfo);
    JsBindingUtils.bindFunction('BatteryAdapter.RegisterBatteryUpdateCallback', registerBatteryUpdateCallback);
    JsBindingUtils.bindFunction('BatteryAdapter.UnregisterBatteryUpdateCallback', unregisterBatteryUpdateCallback);
  }
}