// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import JsBindingUtils from '../utils/JsBindingUtils';
import Inject from '../common/InjectModule';
import type { NewWindowParam, WindowBound } from '../interface/CommonInterface';
import lazy { SystemFloatingWindowAdapter } from '../adapter/SystemFloatingWindowAdapter';

function implSystemFloatingWindowAdapter(): SystemFloatingWindowAdapter {
  return Inject.getOrCreate(SystemFloatingWindowAdapter);
}

function createWindow(param: NewWindowParam) {
  implSystemFloatingWindowAdapter().createWindow(param);
}

function closeWindow(id: number) {
  implSystemFloatingWindowAdapter().closeWindow(id);
}

function setBounds(id: number,
                   bounds: WindowBound,
                   onCompleted: (ret: boolean) => void) {
  implSystemFloatingWindowAdapter().setBounds(id, bounds, onCompleted);
}

function setWindowLimits(minWidth: number, minHeight: number, maxWidth: number, maxHeight: number, id: number) {
  implSystemFloatingWindowAdapter().setWindowLimits(minWidth, minHeight, maxWidth, maxHeight, id);
}

function hideWindow(id: number): void {
  implSystemFloatingWindowAdapter().hideWindow(id);
}

function showWindow(id: number): void {
  implSystemFloatingWindowAdapter().showWindow(id);
}

function setMovable(id: number, movable: boolean): void {
  implSystemFloatingWindowAdapter().setMovable(id, movable);
}

function setEnabled(enable: boolean, id: number): boolean {
  return implSystemFloatingWindowAdapter().setEnabled(enable, id);
}

function startWindowMoving(id: number) {
  implSystemFloatingWindowAdapter().startWindowMoving(id);
}

function setBackgroundColor(id: number, argbColor: number) {
  implSystemFloatingWindowAdapter().setBackgroundColor(id, argbColor);
}

function setOpacity(id: number, opacity: number) {
  implSystemFloatingWindowAdapter().setOpacity(id, opacity);
}

function setContentProtection(id: number, enable: boolean) {
  implSystemFloatingWindowAdapter().setContentProtection(id, enable);
}

function getOriginWindowId(id: number): number {
  return implSystemFloatingWindowAdapter().getOriginWindowId(id);
}

function setWindowShadow(id: number, hasShadow: boolean) {
  implSystemFloatingWindowAdapter().setWindowShadow(id, hasShadow);
}

export class SystemFloatingWindowAdapterBind {
  static bind() {
    JsBindingUtils.bindFunction("SystemFloatingWindow.CreateWindow", createWindow);
    JsBindingUtils.bindFunction("SystemFloatingWindow.CloseWindow", closeWindow);
    JsBindingUtils.bindFunction("SystemFloatingWindow.SetBounds", setBounds);
    JsBindingUtils.bindFunction("SystemFloatingWindow.SetWindowLimits", setWindowLimits);
    JsBindingUtils.bindFunction("SystemFloatingWindow.HideWindow", hideWindow);
    JsBindingUtils.bindFunction("SystemFloatingWindow.ShowWindow", showWindow);
    JsBindingUtils.bindFunction("SystemFloatingWindow.SetMovable", setMovable);
    JsBindingUtils.bindFunction("SystemFloatingWindow.SetEnabled", setEnabled);
    JsBindingUtils.bindFunction("SystemFloatingWindow.StartWindowMoving", startWindowMoving);
    JsBindingUtils.bindFunction("SystemFloatingWindow.SetBackgroundColor", setBackgroundColor);
    JsBindingUtils.bindFunction("SystemFloatingWindow.SetOpacity", setOpacity);
    JsBindingUtils.bindFunction("SystemFloatingWindow.SetContentProtection", setContentProtection);
    JsBindingUtils.bindFunction("SystemFloatingWindow.GetOriginWindowId", getOriginWindowId);
    JsBindingUtils.bindFunction("SystemFloatingWindow.SetWindowShadow", setWindowShadow);
  }
}
