// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { injectable } from 'inversify';
import Base from '@ohos.base';
import CommonEventManager from '@ohos.commonEventManager';

import { BaseAdapter } from '../common/BaseAdapter';
import { BatteryInfo } from '../interface/CommonInterface'
import batteryInfo from '@ohos.batteryInfo'
import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';

const INVALID_VALUE: number = -1;
const TAG: string = 'BatteryAdapter';
const SUBSCRIBE_INFO: CommonEventManager.CommonEventSubscribeInfo = {
  events: [
    CommonEventManager.Support.COMMON_EVENT_BATTERY_CHANGED,
    CommonEventManager.Support.COMMON_EVENT_POWER_CONNECTED,
    CommonEventManager.Support.COMMON_EVENT_POWER_DISCONNECTED
  ]
};

@injectable()
export class BatteryAdapter extends BaseAdapter {
  private subscriber: CommonEventManager.CommonEventSubscriber | undefined = undefined;
  private batteryStatus: BatteryInfo = {
    batterySOC: -1,
    chargingStatus: -1,
    isBatteryPresent: false,
    estimatedRemainingChargeTime: INVALID_VALUE,
    nowCurrent: INVALID_VALUE,
    remainingEnergy: INVALID_VALUE
  };

  private subscribeCallBack(err: Base.BusinessError, data: CommonEventManager.CommonEventData, callback: (batteryStatus: BatteryInfo) => void) {
    if (err) {
      LogUtil.error(TAG, 'subscribe failed, code is %{public}d, error: ' + JSON.stringify(err));
      return;
    }
    const params = data.parameters;
    if (params === undefined || params["chargeState"] === undefined ||
      params["present"] === undefined || params["soc"] === undefined) {
      LogUtil.warn(TAG, 'subscribe event params is invalid.');
      return;
    }
    if (this.batteryStatus.batterySOC !== (params["soc"] as number) ||
      this.batteryStatus.chargingStatus !== (params["chargeState"] as number) ||
      this.batteryStatus.isBatteryPresent !== (params["present"] as boolean)) {
      this.batteryStatus.batterySOC = params["soc"] as number;
      this.batteryStatus.chargingStatus = params["chargeState"] as number;
      this.batteryStatus.isBatteryPresent = params["present"] as boolean;
      callback(this.batteryStatus);
    }
  }

  private createSubscriberCallBack(err: Base.BusinessError,
                                   sub: CommonEventManager.CommonEventSubscriber,
                                   callback: (batteryStatus: BatteryInfo) => void) {
    if (err) {
      LogUtil.error(TAG, 'createSubscriber failed, error: ' + JSON.stringify(err));
      return;
    }
    if (!sub) {
      LogUtil.error(TAG, 'The envent subscriber does not exist');
      return;
    }
    this.subscriber = sub;
    CommonEventManager.subscribe(this.subscriber,
      (err: Base.BusinessError, data: CommonEventManager.CommonEventData) => this.subscribeCallBack(err, data, callback));
  }

  @LogMethod
  GetBatteryInfo(callback: (batteryStatus: BatteryInfo) => void): boolean {
    try {
      this.batteryStatus.batterySOC = batteryInfo.batterySOC;
      this.batteryStatus.chargingStatus = batteryInfo.chargingStatus as number;
      this.batteryStatus.isBatteryPresent = batteryInfo.isBatteryPresent;
      if (callback) {
        callback(this.batteryStatus);
      }
    } catch (err) {
      LogUtil.error(TAG, 'Failed to obtain battery status, error:' + JSON.stringify(err));
      return false;
    }
    return true;
  }

  @LogMethod
  registerBatteryUpdateCallback(callback: (batteryStatus: BatteryInfo) => void): boolean {
    try {
      if (!callback) {
        LogUtil.warn(TAG, 'subscribe call back is not exist');
        return false;
      }
      CommonEventManager.createSubscriber(SUBSCRIBE_INFO,
        (err: Base.BusinessError, sub: CommonEventManager.CommonEventSubscriber) => this.createSubscriberCallBack(err, sub, callback));
    } catch (err) {
      LogUtil.error(TAG, 'createSubscriber failed, code is %{public}d, error: ' + JSON.stringify(err));
      return false;
    }
    return true;
  }

  @LogMethod
  unregisterBatteryUpdateCallback(): void {
    try {
      if (!this.subscriber) {
        LogUtil.warn(TAG, 'The envent subscriber does not exist');
        return;
      }
      CommonEventManager.unsubscribe(this.subscriber, (err:Base.BusinessError) => {
        if (err) {
          LogUtil.error(TAG, 'unsubscribe failed, error: ' + JSON.stringify(err));
        }
      });
    } catch (err) {
      LogUtil.error(TAG, 'unsubscribe failed, error: ' + JSON.stringify(err));
    }
  }
};