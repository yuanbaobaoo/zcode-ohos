/*
 * Copyright (c) 2023-2025 Huawei Device Co., Ltd.
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 * this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 * this list of conditions and the following disclaimer in the documentation
 * and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 * may be used to endorse or promote products derived from this software without
 * specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS;
 * OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
 * OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
 * ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import { NativeContext, WindowBound } from '../interface/CommonInterface';
import LogUtil from '../utils/LogUtil';
import JsBindingUtils from '../utils/JsBindingUtils';
import { NodeContent, window } from '@kit.ArkUI';
import { CommandType, ConfigData, ContextType } from '../common/Constants';
import { NodeHandleManager } from '../common/NodeHandleManager';
import Inject from '../common/InjectModule';
import { ContextAdapter } from '../adapter/ContextAdapter';
import { CmdArgsHelper } from '../utils/CmdArgsHelper';

@Component
export struct WebNodeHandleWindow {
  private static TAG: string = 'WebNodeHandleWindow';
  @LocalStorageLink('abilityId') abilityId: string = '';
  @LocalStorageLink('originWindowId') originWindowId: number = 0;
  @LocalStorageLink('xcomponentId') xComponentId: string = '';
  @LocalStorageLink('startUri') startUri: string = '';
  @LocalStorageLink('appId') appId: string = '';
  @LocalStorageLink('window') window: window.Window | undefined = undefined;
  @LocalStorageLink('statusBarHeight') statusBarHeight: number = 0;
  @LocalStorageLink('cmdArgs') cmdArgs: string[] = [];
  @LocalStorageLink('restoreHiddenWindowForExternalRelaunch')
  restoreHiddenWindowForExternalRelaunch: boolean = false;
  private nativeContext: NativeContext = JsBindingUtils.getNativeContext(ContextType.kMainProcess);
  private nodeHandleManager = Inject.get(NodeHandleManager);
  private contextAdapter = Inject.get(ContextAdapter);
  @State nodeContent: NodeContent = new NodeContent();
 
  aboutToAppear(): void {
    LogUtil.error(WebNodeHandleWindow.TAG, 'WebNodeHandleWindow aboutToAppear ' + this.xComponentId);
    this.nodeHandleManager.addNodeContent(this.xComponentId, this.nodeContent);
    this.nativeContext.OnContentLoaded(this.abilityId, this.originWindowId, this.xComponentId, this.nodeContent);
    if (this.restoreHiddenWindowForExternalRelaunch) {
      this.restoreHiddenWindowForExternalRelaunch = false;
      this.contextAdapter.clearHiddenWindowId(this.xComponentId);
      LogUtil.info(WebNodeHandleWindow.TAG,
        'Restore hidden Electron BrowserWindow after NodeContent loaded: ' + this.xComponentId);
      this.nativeContext.ExecuteCommand(CommandType.kSecondInstance, {
        user_data: JSON.stringify({
          argv: ['electron'],
          workingDirectory: ''
        })
      });
    }
    this.contextAdapter.setActiveWindow(this.xComponentId);
 
    this.setDefaultBounds();
    let vec_args = CmdArgsHelper.buildArgs(this.startUri, this.cmdArgs, this.appId);
    CmdArgsHelper.preProcessArgs(vec_args);
    this.nativeContext.runBrowser(vec_args);
  }
 
  aboutToDisappear(): void {
    this.nativeContext.OnContentUnloaded(this.abilityId, this.originWindowId, this.xComponentId);
    this.nodeHandleManager.removeNodeContent(this.xComponentId);
  }
 
  build() {
    ContentSlot(this.nodeContent)
  }
 
  private setDefaultBounds() {
    if (this.xComponentId !== ConfigData.DEFAULT_WINDOW_ID) {
      return;
    }
 
    let prop = this.window?.getWindowProperties();
    if (prop) {
      let windowRect: WindowBound = {
        left: prop.windowRect.left,
        top: prop.windowRect.top,
        width: prop.windowRect.width,
        height: prop.windowRect.height
      }

      let drawableRect: WindowBound = {
        left: prop.drawableRect.left,
        top: prop.drawableRect.top + this.statusBarHeight,
        width: prop.drawableRect.width,
        height: prop.drawableRect.height - this.statusBarHeight
      }
      let displayId = prop.displayId ?? ConfigData.INVALID_DISPLAY_ID;
      this.nativeContext.OnWindowInitSize(windowRect, drawableRect, displayId);
    }
 
    let state = this.window?.getWindowStatus();
    if (state) {
      this.nativeContext.OnWindowInitState(state);
    }
  }
}
