// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import JsBindingUtils from '../utils/JsBindingUtils';
import Inject from '../common/InjectModule';
import lazy { AppWindowAdapter } from '../adapter/AppWindowAdapter';
import type { NewWindowParam, PointCoordinate, WindowBound, NotificationAdapterImage } from '../interface/CommonInterface';
import { NodeContent } from '@kit.ArkUI';

function implAppWindowAdapter(): AppWindowAdapter {
  return Inject.getOrCreate(AppWindowAdapter);
}

function createWindow(param: NewWindowParam) {
  implAppWindowAdapter().createWindow(param);
}

function closeWindow(id: number) {
  implAppWindowAdapter().closeWindow(id);
}

function hideWindow(id: number) {
  implAppWindowAdapter().hideWindow(id);
}

function showWindow(id: number) {
  implAppWindowAdapter().showWindow(id);
}

function activateWindow(id: number) {
  implAppWindowAdapter().activateWindow(id);
}

function setFullscreen(id: number) {
  implAppWindowAdapter().setFullscreen(id);
}

function setBounds(id: number, bounds: WindowBound) {
  implAppWindowAdapter().setBounds(id, bounds);
}

function setEnabled(enable: boolean, id: number): boolean {
  return implAppWindowAdapter().setEnabled(enable, id);
}

function setWindowLimits(minWidth: number,
                         minHeight: number,
                         maxWidth: number,
                         maxHeight: number,
                         id: number) {
  implAppWindowAdapter().setWindowLimits(minWidth, minHeight, maxWidth, maxHeight, id);
}

function setWindowButtonVisibility(id: number, visible: boolean) {
  implAppWindowAdapter().setWindowButtonVisibility(id, visible);
}

function getWindowButtonVisibility(id: number): boolean {
  return implAppWindowAdapter().getWindowButtonVisibility(id);
}

function maximize(id: number) {
  implAppWindowAdapter().maximize(id);
}

function unMaximize(id: number) {
  implAppWindowAdapter().unMaximize(id);
}

function minimize(id: number) {
  implAppWindowAdapter().minimize(id);
}

function setTitle(title:string, id: number) {
  implAppWindowAdapter().setTitle(title, id);
}

function setAspectRatio(id: number, aspectRatio: number) {
  implAppWindowAdapter().setAspectRatio(id, aspectRatio);
}

function setUseNativeFrame(id: number, useNativeFrame: boolean) {
  implAppWindowAdapter().setUseNativeFrame(id, useNativeFrame);
}

function setBackgroundColor(id: number, argbColor: number) {
  implAppWindowAdapter().setBackgroundColor(id, argbColor);
}

function relaunch() : boolean {
  return implAppWindowAdapter().relaunch();
}

function startWindowMoving(id: number) {
  implAppWindowAdapter().startWindowMoving(id);
}

function getWindowsByCoordinate(coordinate: PointCoordinate,
                                callback: (windowIds: Array<string>) => void) {
  implAppWindowAdapter().getWindowsByCoordinate(coordinate, callback);
}

function restore(id: number) {
  implAppWindowAdapter().restore(id);
}

function shiftWindowMouseEvent(sourceId: number, targetId: number,
                          callback: (result: boolean) => void) {
  implAppWindowAdapter().shiftWindowMouseEvent(sourceId, targetId, callback);
}

function startWindowMovingWithOffset(id: number, offsetX: number, offsetY: number) {
  implAppWindowAdapter().startWindowMovingWithOffset(id, offsetX, offsetY);
}

function getOriginWindowIds(windowIds: Array<number>): Array<number> {
  return implAppWindowAdapter().getOriginWindowIds(windowIds);
}

function bind(id: string, callback: (nodeContent: NodeContent | undefined) => void) {
  implAppWindowAdapter().bind(id, callback);
}

function unbind(id: string, callback: (nodeContent: NodeContent | undefined) => void) {
  implAppWindowAdapter().unbind(id, callback);
}

function shiftWindowTouchEvent(sourceId: number, targetId: number,
  fingerId: number, callback: (result: boolean) => void) {
  implAppWindowAdapter().shiftWindowTouchEvent(sourceId, targetId, fingerId, callback);
}

function setWindowIcon(id: number, icon: NotificationAdapterImage) {
  implAppWindowAdapter().setWindowIcon(id, icon);
}

function setWindowShadow(id: number, hasShadow: boolean) {
  implAppWindowAdapter().setWindowShadow(id, hasShadow);
}

function setMovable(id: number, movable: boolean) {
  implAppWindowAdapter().setMovable(id, movable);
}

function setResizable(id: number, resizable: boolean) {
  implAppWindowAdapter().setResizable(id, resizable);
}

function setFocusable(id: number, focusable: boolean) {
  implAppWindowAdapter().setFocusable(id, focusable);
}

function getWindowId(id: number): number {
  return implAppWindowAdapter().getWindowId(id);
}

export class AppWindowAdapterBind {
  static bind() {
    JsBindingUtils.bindFunction("AppWindow.CreateWindow", createWindow);
    JsBindingUtils.bindFunction("AppWindow.CloseWindow", closeWindow);
    JsBindingUtils.bindFunction("AppWindow.HideWindow", hideWindow);
    JsBindingUtils.bindFunction("AppWindow.SetFullscreen", setFullscreen);
    JsBindingUtils.bindFunction("AppWindow.SetBounds", setBounds);
    JsBindingUtils.bindFunction("AppWindow.SetEnabled", setEnabled);
    JsBindingUtils.bindFunction("AppWindow.SetWindowLimits", setWindowLimits);
    JsBindingUtils.bindFunction("AppWindow.SetWindowButtonVisibility", setWindowButtonVisibility);
    JsBindingUtils.bindFunction("AppWindow.GetWindowButtonVisibility", getWindowButtonVisibility);
    JsBindingUtils.bindFunction("AppWindow.Maximize", maximize);
    JsBindingUtils.bindFunction("AppWindow.UnMaximize", unMaximize);
    JsBindingUtils.bindFunction("AppWindow.Minimize", minimize);
    JsBindingUtils.bindFunction("AppWindow.SetTitle", setTitle);
    JsBindingUtils.bindFunction("AppWindow.SetAspectRatio", setAspectRatio);
    JsBindingUtils.bindFunction("AppWindow.SetUseNativeFrame", setUseNativeFrame);
    JsBindingUtils.bindFunction("AppWindow.SetBackgroundColor", setBackgroundColor);
    JsBindingUtils.bindFunction("AppWindow.ShowWindow", showWindow);
    JsBindingUtils.bindFunction("AppWindow.ActivateWindow", activateWindow);
    JsBindingUtils.bindFunction("AppWindow.Relaunch", relaunch);
    JsBindingUtils.bindFunction("AppWindow.StartWindowMoving", startWindowMoving);
    JsBindingUtils.bindFunction("AppWindow.GetWindowsByCoordinate", getWindowsByCoordinate);
    JsBindingUtils.bindFunction("AppWindow.Restore", restore);
    JsBindingUtils.bindFunction("AppWindow.ShiftWindowMouseEvent", shiftWindowMouseEvent);
    JsBindingUtils.bindFunction("AppWindow.StartWindowMovingWithOffset", startWindowMovingWithOffset);
    JsBindingUtils.bindFunction("AppWindow.GetOriginWindowIds", getOriginWindowIds);
    JsBindingUtils.bindFunction("AppWindow.Bind", bind);
    JsBindingUtils.bindFunction("AppWindow.UnBind", unbind);
    JsBindingUtils.bindFunction("AppWindow.ShiftWindowTouchEvent", shiftWindowTouchEvent);
    JsBindingUtils.bindFunction("AppWindow.SetWindowIcon", setWindowIcon);
    JsBindingUtils.bindFunction("AppWindow.SetWindowShadow", setWindowShadow);
    JsBindingUtils.bindFunction("AppWindow.SetMovable", setMovable);
    JsBindingUtils.bindFunction("AppWindow.SetResizable", setResizable);
    JsBindingUtils.bindFunction("AppWindow.SetFocusable", setFocusable);
    JsBindingUtils.bindFunction("AppWindow.GetWindowId", getWindowId);
  }
}
