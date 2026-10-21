// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { injectable } from 'inversify';
import Base from '@ohos.base';
import CommonEventManager from '@ohos.commonEventManager';

import { BaseAdapter } from '../common/BaseAdapter';
import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';

const TAG: string = "ScreenlockMonitorAdapter";
const SCREEN_LOCKED: string = "usual.event.SCREEN_LOCKED";
const SCREEN_UNLOCKED: string = "usual.event.SCREEN_UNLOCKED";

@injectable()
export class ScreenlockMonitorAdapter extends BaseAdapter {
  private subscriber: CommonEventManager.CommonEventSubscriber | undefined = undefined;
  private subscribeInfo: CommonEventManager.CommonEventSubscribeInfo = {
    events: [
      CommonEventManager.Support.COMMON_EVENT_SCREEN_LOCKED,
      CommonEventManager.Support.COMMON_EVENT_SCREEN_UNLOCKED
    ]
  };

  private subscribeScreenlock(callback: Function, subscriber: CommonEventManager.CommonEventSubscriber) {
    CommonEventManager.subscribe(subscriber,
      (err: Base.BusinessError, data:CommonEventManager.CommonEventData) => {
        if (err) {
          LogUtil.error(TAG, 'subscribe failed, error: ' + JSON.stringify(err));
          return;
        }
        if(data.event === SCREEN_LOCKED) {
          callback('locked');
        } else if (data.event === SCREEN_UNLOCKED) {
          callback('unlocked');
        }
      });
  }

  @LogMethod
  startListeningForScreenlock(callback: Function): void {
    try {
      CommonEventManager.createSubscriber(this.subscribeInfo,
        (err: Base.BusinessError, commonEventSubscriber: CommonEventManager.CommonEventSubscriber) => {
          if (err) {
            LogUtil.error(TAG, 'createSubscriber failed, error: ' + JSON.stringify(err));
            return;
          }
          this.subscriber = commonEventSubscriber;
          this.subscribeScreenlock(callback, this.subscriber)
        });
    } catch (err) {
      LogUtil.error(TAG, 'createSubscriber failed, error: ' + JSON.stringify(err));
    }
  }

  @LogMethod
  stopListeningForScreenlock(): void {
    try {
      CommonEventManager.unsubscribe(this.subscriber, (err:Base.BusinessError) => {
        LogUtil.info(TAG, 'unsubscribe err: ' + JSON.stringify(err));
      });
    } catch (err) {
      LogUtil.error(TAG, 'unsubscribe failed, error: ' + JSON.stringify(err));
    }
  }
};
