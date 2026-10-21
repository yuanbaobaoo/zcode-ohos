// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { inject, injectable } from 'inversify';
import connection from '@ohos.net.connection';
import { BusinessError } from '@ohos.base';
import Want from '@ohos.app.ability.Want';

import { BaseAdapter } from '../common/BaseAdapter';
import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';
import LaunchHelper from '../utils/LaunchHelper';
import { ContextAdapter } from './ContextAdapter';
import CommonEventManager from '@ohos.commonEventManager';

const TAG: string = 'net';

@injectable()
export class NetConnectionAdapter extends BaseAdapter {
  private ctxAdapter: ContextAdapter;

  constructor(@inject(ContextAdapter) ctxAdapter: ContextAdapter) {
    super();
    this.ctxAdapter = ctxAdapter;
  }

  @LogMethod
  showSystemSettings(uri_value: string,
    subUri?: string): void {
    let want: Want = {
      bundleName: 'com.huawei.hmos.settings',
      abilityName: 'com.huawei.hmos.settings.MainAbility',
      uri: uri_value
    }
    if (subUri !== undefined) {
      want.parameters = {
        'subUri': subUri
      }
    }
    LaunchHelper.Launch(this.ctxAdapter.getActiveContext(), want);
  }
}