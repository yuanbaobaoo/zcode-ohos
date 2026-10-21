// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import JsBindingUtils from '../utils/JsBindingUtils';
import Inject from '../common/InjectModule';
import lazy { ContextPathAdapter } from '../adapter/ContextPathAdapter';

function implContextPathAdapter(): ContextPathAdapter {
  return Inject.getOrCreate(ContextPathAdapter);
}

function getCacheDir(): string {
  return implContextPathAdapter().getCacheDir();
}

function getTempDir(): string {
  return implContextPathAdapter().getTempDir();
}

function getFilesDir(): string {
  return implContextPathAdapter().getFilesDir();
}

function getBundleDir(): string {
  return implContextPathAdapter().getBundleDir();
}

function getUserDocumentDir(): string {
  return implContextPathAdapter().getUserDocumentDir();
}

function getUserDesktopDir(): string {
  return implContextPathAdapter().getUserDesktopDir();
}

function getUserDownloadDir(): string {
  return implContextPathAdapter().getUserDownloadDir();
}

function getAppDownloadDir(callback: (downloadDirPath: string) => void): void{
  return implContextPathAdapter().getAppDownloadDir(callback);
}

export class ContextPathAdapterBind {
  static bind() {
    JsBindingUtils.bindFunction('ContextPathAdapter.GetCacheDir', getCacheDir);
    JsBindingUtils.bindFunction('ContextPathAdapter.GetTempDir', getTempDir);
    JsBindingUtils.bindFunction('ContextPathAdapter.GetFilesDir', getFilesDir);
    JsBindingUtils.bindFunction('ContextPathAdapter.GetBundleDir', getBundleDir);
    JsBindingUtils.bindFunction('ContextPathAdapter.GetUserDocumentDir', getUserDocumentDir);
    JsBindingUtils.bindFunction('ContextPathAdapter.GetUserDesktopDir', getUserDesktopDir);
    JsBindingUtils.bindFunction('ContextPathAdapter.GetUserDownloadDir', getUserDownloadDir);
    JsBindingUtils.bindFunction('ContextPathAdapter.GetAppDownloadDir', getAppDownloadDir);
  }
}