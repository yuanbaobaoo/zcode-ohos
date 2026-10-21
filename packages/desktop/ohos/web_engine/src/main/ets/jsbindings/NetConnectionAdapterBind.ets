// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import JsBindingUtils from '../utils/JsBindingUtils';
import Inject from '../common/InjectModule';
import lazy { NetConnectionAdapter } from '../adapter/NetConnectionAdapter';

function implNetConnectionAdapter(): NetConnectionAdapter {
  return Inject.getOrCreate(NetConnectionAdapter);
}

function showSystemSettings(uri: string, subUri?: string): void {
  implNetConnectionAdapter().showSystemSettings(uri, subUri);
}

export class NetConnectionAdapterBind {
  static bind() {
    JsBindingUtils.bindFunction("NetConnection.ShowSystemSettings", showSystemSettings);
  }
}