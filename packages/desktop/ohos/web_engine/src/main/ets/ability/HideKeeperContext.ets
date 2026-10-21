// Copyright (c) 2026 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import common from '@ohos.app.ability.common';
import { ContextAdapter } from '../adapter/ContextAdapter';
import Inject from '../common/InjectModule';

export function registerHideKeeperContext(context: common.UIAbilityContext): void {
  Inject.get(ContextAdapter).setHideKeeperContext(context);
}
