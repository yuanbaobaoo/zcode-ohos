// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import JsBindingUtils from '../utils/JsBindingUtils';
import Inject from "../common/InjectModule";
import lazy { StatusBarManagerAdapter } from '../adapter/StatusBarManager';
import { hilog } from '@kit.PerformanceAnalysisKit';

function implStatusBarManagerAdapter(): StatusBarManagerAdapter {
  return Inject.getOrCreate(StatusBarManagerAdapter);
}

function setImage(whiteWidth: number,
                  whiteHeight: number,
                  whiteIconBuffer: ArrayBuffer,
                  onCompleted: (ret: boolean) => void,
                  callback: () => void,
                  blackWidth?: number,
                  blackHeight?: number,
                  blackIconBuffer?: ArrayBuffer): void {
  console.info('StatusBarBind: setImage called w=' + whiteWidth + ' h=' + whiteHeight + ' bufLen=' + (whiteIconBuffer ? whiteIconBuffer.byteLength : 0));
  try {
    implStatusBarManagerAdapter().SetImage(whiteWidth, whiteHeight, whiteIconBuffer, onCompleted, callback, blackWidth, blackHeight, blackIconBuffer);
    console.info('StatusBarBind: SetImage returned');
  } catch (e) {
    console.error('StatusBarBind: SetImage ERROR: ' + JSON.stringify(e));
  }
}

function setToolTips(tooltips: string): void {
  implStatusBarManagerAdapter().SetToolTips(tooltips);
}

function setContextMenu(menu_model: string, onCompleted: (ret: boolean) => void, callback: (id: Number) => void): void {
  implStatusBarManagerAdapter().SetContextMenu(menu_model, onCompleted, callback);
}

function removeFromStatusBar(onCompleted: (ret: boolean) => void) {
  implStatusBarManagerAdapter().RemoveFromStatusBar(onCompleted);
}

export class StatusBarManagerAdapterBind {
  static bind() {
    console.info('StatusBarManagerAdapterBind: registering...');
    hilog.info(0x0000, 'StatusBarBind', 'StatusBarManagerAdapterBind registering');

    JsBindingUtils.bindFunction("StatusBarManagerAdapter.SetImage", setImage);
    JsBindingUtils.bindFunction("StatusBarManagerAdapter.SetToolTips", setToolTips);
    hilog.info(0x0000, 'StatusBarBind', 'StatusBarManagerAdapterBind: SetToolTips registered');

    JsBindingUtils.bindFunction("StatusBarManagerAdapter.SetContextMenu", setContextMenu);
    JsBindingUtils.bindFunction("StatusBarManagerAdapter.RemoveFromStatusBar", removeFromStatusBar);
  }
}