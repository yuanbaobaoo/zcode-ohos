/*
 * Copyright (c) 2023-2026 Huawei Device Co., Ltd.
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

import { ContextType, ConfigData } from "../common/Constants";
import lazy { NativeContext } from '../interface/CommonInterface';
import JsBindingUtils from "./JsBindingUtils";
import { Deque } from "@kit.ArkTS";
import LogUtil from "../utils/LogUtil"

const TAG: string = 'AbilityIdController';

export default class AbilityIdController {
  private static instance: AbilityIdController = new AbilityIdController();
  private nativeContext: NativeContext = JsBindingUtils.getNativeContext(ContextType.kMainProcess);
  private uniqueIdQueue: Deque<string> = new Deque<string>();

  private constructor() {
    LogUtil.info(TAG, 'constructor()');
  }

  static acquireUniqueId() {
    let instance = AbilityIdController.instance;
    let id = ConfigData.WINDOW_PREFIX + instance.nativeContext.AcquireUniqueId();
    instance.uniqueIdQueue.insertFront(id);
    LogUtil.info(TAG, `acquire unique id: ${id}`);
    return id;
  }

  static cacheUniqueId(id: string): string {
    AbilityIdController.instance.uniqueIdQueue.insertFront(id);
    LogUtil.info(TAG, `cache unique id: ${id}`);
    return id;
  }

  static getUniqueId() {
    let instance = AbilityIdController.instance;
    let id = instance.uniqueIdQueue.popLast();
    if (id === undefined) {
      id = ConfigData.WINDOW_PREFIX + instance.nativeContext.AcquireUniqueId();
      LogUtil.warn(TAG, `unique id queue was empty, generated fallback id: ${id}`);
    }
    LogUtil.info(TAG, `get unique id: ${id}`);
    return id;
  }
};
