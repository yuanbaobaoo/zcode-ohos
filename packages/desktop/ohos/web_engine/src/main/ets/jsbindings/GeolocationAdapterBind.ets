// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import JsBindingUtils from '../utils/JsBindingUtils';
import Inject from '../common/InjectModule';
import lazy { GeolocationAdapter } from '../adapter/GeolocationAdapter';
import type geoLocationManager from '@ohos.geoLocationManager';

function implGeolocationAdapter(): GeolocationAdapter {
  return Inject.getOrCreate(GeolocationAdapter);
}

function startListening(
  onLocationReport: (location: geoLocationManager.Location) => void,
  onErrorReport: (errorCode: number) => void
): void {
  implGeolocationAdapter().startListening(onLocationReport, onErrorReport);
}

function stopListening(): void {
  implGeolocationAdapter().stopListening();
}

export class GeolocationAdapterBind {
  static bind() {
    JsBindingUtils.bindFunction('GeolocationAdapter.StartListening', startListening);
    JsBindingUtils.bindFunction('GeolocationAdapter.StopListening', stopListening);
  }
}
