// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { injectable } from 'inversify';
import childProcessManager from '@ohos.app.ability.childProcessManager';
import { BusinessError } from '@ohos.base';
import { ChildProcessArgs, ChildProcessOptions } from '@kit.AbilityKit';

import { BaseAdapter } from '../common/BaseAdapter';
import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';

function fireProcessBind(
  srcEntry: string,
  entryParams: string,
  fds: Record<string, number>,
  isolationMode: boolean,
  callback: Function
): void {
  const invalidPid: number = -1;
  try {
    const args: ChildProcessArgs = {
      entryParams: entryParams,
      fds: fds
    };
    const opts: ChildProcessOptions = {
      isolationMode: isolationMode
    };
    LogUtil.info('ProcessAdapter', `startArkChildProcess args: ${JSON.stringify(args)}`);
    childProcessManager.startArkChildProcess(srcEntry, args, opts)
      .then((result) => {
        callback(result);
      }, (err: BusinessError) => {
        callback(invalidPid);
        LogUtil.error('ProcessAdapter', `startArkChildProcess failed: ${err}, srcEntry: ${srcEntry}`);
      });
  } catch (err) {
    callback(invalidPid);
    LogUtil.error('ProcessAdapter', `startArkChildProcess failed: ${err}, srcEntry: ${srcEntry}`);
  }
}

@injectable()
export class ProcessAdapter extends BaseAdapter {
  @LogMethod
  startChildProcess(
    srcEntry: string,
    entryParams: string,
    fds: Record<string, number>,
    isolationMode: boolean,
    callback: Function
  ): void {
    fireProcessBind(srcEntry, entryParams, fds, isolationMode, callback);
  }
}
