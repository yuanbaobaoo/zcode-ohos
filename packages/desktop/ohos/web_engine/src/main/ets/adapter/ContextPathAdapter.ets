// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { injectable, inject } from 'inversify';
import environment from '@ohos.file.environment';

import { BaseAdapter } from '../common/BaseAdapter';
import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';
import { ContextAdapter } from './ContextAdapter';
import { fileUri, picker } from '@kit.CoreFileKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';

const TAG: string = 'ContextPath';

@injectable()
export class ContextPathAdapter extends BaseAdapter {
  private ctxAdapter: ContextAdapter;

  constructor(@inject(ContextAdapter) ctxAdapter: ContextAdapter) {
    super();
    this.ctxAdapter = ctxAdapter;
  }

  @LogMethod
  getCacheDir(): string {
    return this.ctxAdapter.getContext().getApplicationContext().cacheDir;
  }

  @LogMethod
  getTempDir(): string {
    return this.ctxAdapter.getContext().getApplicationContext().tempDir;
  }

  @LogMethod
  getFilesDir(): string {
    return this.ctxAdapter.getContext().getApplicationContext().filesDir;
  }

  @LogMethod
  getBundleDir(): string {
    return this.ctxAdapter.getContext().bundleCodeDir;
  }

  @LogMethod
  getUserDocumentDir(): string {
    let userDir: string = this.getFilesDir() + '/UserDocument';
    try {
      userDir = environment.getUserDocumentDir();
    } catch (error) {
      LogUtil.error(TAG, `getUserDocumentDir failed: ${JSON.stringify(error)}`);
    }
    return userDir;
  }

  @LogMethod
  getUserDesktopDir(): string {
    let userDir: string = this.getFilesDir() + '/UserDesktop';
    try {
      userDir = environment.getUserDesktopDir();
    } catch (error) {
      LogUtil.error(TAG, `GetUserDesktopDir failed: ${JSON.stringify(error)}`);
    }
    return userDir;
  }

  @LogMethod
  getUserDownloadDir(): string {
    let userDir: string = this.getFilesDir() + '/UserDownload';
    try {
      userDir = environment.getUserDownloadDir();
    } catch (error) {
      LogUtil.error(TAG, `GetUserDownloadDir failed: ${JSON.stringify(error)}`);
    }
    return userDir;
  }

  @LogMethod
  getAppDownloadDir(callback: (downloadDirPath: string) => void) {
    let context = getContext(this) as common.Context;
    const documentViewPicker = new picker.DocumentViewPicker(context);
    const documentSaveOptions = new picker.DocumentSaveOptions();
    documentSaveOptions.pickerMode = picker.DocumentPickerMode.DOWNLOAD;
 
    documentViewPicker.save(documentSaveOptions).then((documentSaveResult: Array<string>) => {
      let downloadDirPath = new fileUri.FileUri(documentSaveResult[0]).path;
      callback(downloadDirPath);
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, `createAppDownloadDir failed: ${JSON.stringify(err)}`);
      callback('');
    })
  }
}