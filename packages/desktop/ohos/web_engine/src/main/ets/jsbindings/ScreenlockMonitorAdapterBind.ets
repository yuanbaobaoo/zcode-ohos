// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import JsBindingUtils from '../utils/JsBindingUtils';
import Inject from '../common/InjectModule';
import lazy { ScreenlockMonitorAdapter } from '../adapter/ScreenlockMonitorAdapter';

function implScreenlockMonitorAdapter(): ScreenlockMonitorAdapter {
  return Inject.getOrCreate(ScreenlockMonitorAdapter);
}

function startListeningForScreenlock(callback: Function): void {
  implScreenlockMonitorAdapter().startListeningForScreenlock(callback);
}

function stopListeningForScreenlock(): void {
  implScreenlockMonitorAdapter().stopListeningForScreenlock();
}

export class ScreenlockMonitorAdapterBind {
  static bind() {
    JsBindingUtils.bindFunction('ScreenlockMonitorAdapter.StartListeningForScreenlock', startListeningForScreenlock);
    JsBindingUtils.bindFunction('ScreenlockMonitorAdapter.StopListeningForScreenlock', stopListeningForScreenlock);
  }
}