// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import JsBindingUtils from '../utils/JsBindingUtils';
import Inject from '../common/InjectModule';
import lazy { SubWindowAdapter } from '../adapter/SubWindowAdapter';
import type { NewWindowParam, WindowBound } from '../interface/CommonInterface';

function implSubWindowAdapter(): SubWindowAdapter {
  return Inject.getOrCreate(SubWindowAdapter);
}

function createSubWindow(param: NewWindowParam) {
  implSubWindowAdapter().createSubWindow(param)
}

function showSubWindow(id: string) {
  implSubWindowAdapter().showSubWindow(id);
}

function hideSubWindow(id: string) {
  implSubWindowAdapter().hideSubWindow(id);
}

function cancelSubWindow(id: string) {
  implSubWindowAdapter().cancelSubWindow(id);
}

function setSubWindowBounds(id: string, r: WindowBound) {
  implSubWindowAdapter().setSubWindowBounds(id, r);
}

function setWindowLimits(minWidth: number, minHeight: number, maxWidth: number,
                         maxHeight: number, id: string) {
  implSubWindowAdapter().setWindowLimits(minWidth, minHeight, maxWidth, maxHeight, id);
}

function setMovable(id: string, movable: boolean): void {
  implSubWindowAdapter().setMovable(id, movable);
}

function setEnabled(id: string, enable: boolean): boolean {
  return implSubWindowAdapter().setEnabled(id, enable);
}

function setBackgroundColor(id: string, argbColor: number) {
  implSubWindowAdapter().setBackgroundColor(id, argbColor);
}

function setOpacity(id: string, opacity: number) {
  implSubWindowAdapter().setOpacity(id, opacity);
}

function setContentProtection(id: string, enable: boolean) {
  implSubWindowAdapter().setContentProtection(id, enable);
}

function startWindowMoving(id: string) {
  implSubWindowAdapter().startWindowMoving(id);
}

function getOriginWindowId(id: string): number {
  return implSubWindowAdapter().getOriginWindowId(id);
}

function setWindowShadow(id: string, hasShadow: boolean) {
  implSubWindowAdapter().setWindowShadow(id, hasShadow);
}

function reuseSubWindow(param: NewWindowParam): string {
  return implSubWindowAdapter().reuseSubWindow(param);
}

export class SubWindowAdapterBind {
  static bind() {
    JsBindingUtils.bindFunction("SubWindow.Create", createSubWindow);
    JsBindingUtils.bindFunction("SubWindow.Show", showSubWindow);
    JsBindingUtils.bindFunction("SubWindow.Hide", hideSubWindow);
    JsBindingUtils.bindFunction("SubWindow.Cancel", cancelSubWindow);
    JsBindingUtils.bindFunction("SubWindow.SetBounds", setSubWindowBounds);
    JsBindingUtils.bindFunction("SubWindow.SetWindowLimits", setWindowLimits);
    JsBindingUtils.bindFunction("SubWindow.SetMovable", setMovable);
    JsBindingUtils.bindFunction("SubWindow.SetEnabled", setEnabled);
    JsBindingUtils.bindFunction("SubWindow.SetBackgroundColor", setBackgroundColor);
    JsBindingUtils.bindFunction("SubWindow.SetOpacity", setOpacity);
    JsBindingUtils.bindFunction("SubWindow.SetContentProtection", setContentProtection);
    JsBindingUtils.bindFunction("SubWindow.StartWindowMoving", startWindowMoving);
    JsBindingUtils.bindFunction("SubWindow.GetOriginWindowId", getOriginWindowId);
    JsBindingUtils.bindFunction("SubWindow.SetWindowShadow", setWindowShadow);
    JsBindingUtils.bindFunction("SubWindow.ReuseSubWindow", reuseSubWindow);
  }
}
