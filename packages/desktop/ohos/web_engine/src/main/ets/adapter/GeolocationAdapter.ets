// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { injectable } from 'inversify';
import geoLocationManager from '@ohos.geoLocationManager';
import BusinessError from "@ohos.base";

import { BaseAdapter } from '../common/BaseAdapter';
import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';

@injectable()
export class GeolocationAdapter extends BaseAdapter {
  private static TAG: string = 'GeolocationAdapter';

  @LogMethod
  startListening(
    onLocationReport: (location: geoLocationManager.Location) => void,
    onErrorReport: (errorCode: number) => void
  ): void {
    let locationChange = (location: geoLocationManager.Location): void => {
      if (location) {
        onLocationReport(location);
      }
    };
    let requestInfo: geoLocationManager.LocationRequest = {
      'priority': geoLocationManager.LocationRequestPriority.FIRST_FIX,
      'scenario': geoLocationManager.LocationRequestScenario.UNSET,
      'timeInterval': 1,
      'distanceInterval': 0,
      'maxAccuracy': 0
    };
    try {
      geoLocationManager.on('locationChange', requestInfo, locationChange);
    } catch (err) {
      LogUtil.error(GeolocationAdapter.TAG, 'err:' + JSON.stringify(err));
      onErrorReport((err as BusinessError.BusinessError).code);
    }
  }

  @LogMethod
  stopListening(): void {
    geoLocationManager.off('locationChange');
  }
}
