// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import JsBindingUtils from '../utils/JsBindingUtils';
import Inject from '../common/InjectModule';
import lazy { OcrAdapter } from '../adapter/OcrAdapter';
import lazy { OcrAdapterImage } from '../interface/CommonInterface';

function implOcrAdapter(): OcrAdapter {
  return Inject.getOrCreate(OcrAdapter);
}

async function ocrFunction(callback: Function, requestImage: OcrAdapterImage) {
  await implOcrAdapter().ocrFunction(callback, requestImage);
}

export class OcrAdapterBind {
  static bind() {
    JsBindingUtils.bindFunction("OcrAdapter.OcrFunction", ocrFunction);
  }
}