// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { injectable, inject } from 'inversify';
import { MODULE_TYPE } from "../common/ModuleType";
import { BaseAdapter } from '../common/BaseAdapter';
import { AbilityManager } from '../common/AbilityManager';
import LogMethod from '../common/LogDecorator';
import LogUtil from '../utils/LogUtil';
import { WebProxy, FakeWebProxy } from '../interface/WebProxy';
import { deviceInfo, settings } from '@kit.BasicServicesKit';
import common from '@ohos.app.ability.common';

const TAG: string = 'ContextAdapter';

@injectable()
export class ContextAdapter extends BaseAdapter {
    private abilityManager: AbilityManager;
    private context: Context;
    private activeWindow: string = '';
    // false means free multi-window mode is disabled on a tablet.
    private windowPcmodeSwitchStatus: boolean = false;
    private lastActiveUIAbility: string = '';
    private hideKeeperContext: common.UIAbilityContext | undefined = undefined;
    private hiddenWindowId: string = '';

    constructor(
        @inject(AbilityManager) abilityManager: AbilityManager,
        @inject(MODULE_TYPE.Context) ctx: Context
    ) {
        super();
        this.abilityManager = abilityManager;
        this.context = ctx;
    }

    public getContext(): Context {
        return this.context;
    }

    @LogMethod
    public setActiveWindow(activeWindow: string) {
        LogUtil.info(TAG, 'set current active window:' + activeWindow);
        this.activeWindow = activeWindow;
        let webProxy = this.abilityManager.getProxy(activeWindow);
        if (webProxy && webProxy.isUIAbility()) {
            LogUtil.info(TAG, 'set last active UI ability: ' + activeWindow);
            this.lastActiveUIAbility = activeWindow;
        }
    }

    public getActiveContext(): Context | undefined {
      let activeProxy = this.getActiveProxy();
      let activeContext = activeProxy?.getWindowContext();
      if (activeContext) {
        return activeContext;
      }
      if (!this.hideKeeperContext) {
        LogUtil.error(TAG, 'no active window context');
      }
      return this.hideKeeperContext;
    }

    public setHideKeeperContext(context: common.UIAbilityContext): void {
      this.hideKeeperContext = context;
    }

    public setHiddenWindowId(windowId: string): void {
      this.hiddenWindowId = windowId;
    }

    public getHiddenWindowId(): string {
      return this.hiddenWindowId;
    }

    public clearHiddenWindowId(windowId: string): void {
      if (this.hiddenWindowId === windowId) {
        this.hiddenWindowId = '';
      }
    }

    public getActiveProxy(): WebProxy {
        let activeProxy = this.abilityManager.getProxy(this.activeWindow);
        if (activeProxy) {
            return activeProxy;
        }
 
        activeProxy = this.abilityManager.getProxy(this.lastActiveUIAbility);
        if (activeProxy) {
            return activeProxy;
        }
        LogUtil.error(TAG, 'No active proxy. use default proxy');
 
        if (this.abilityManager.getProxyCount() > 0) {
            return this.abilityManager.getProxyList()[0];
        } else {
            LogUtil.error(TAG, 'No proxy can be used');
            return new FakeWebProxy();
        }
    }

    public updateWindowPcmodeSwitchStatus(context: Context): void {
        try {
            let value = settings.getValueSync(context, 'window_pcmode_switch_status', 'false',
                settings.domainName.USER_PROPERTY);
            LogUtil.info(TAG, 'update window_pcmode_switch_status, new status:' + value);
            this.windowPcmodeSwitchStatus = value === 'true';
        } catch (err) {
            LogUtil.error(TAG, 'update window_pcmode_switch_status fail, err:' + JSON.stringify(err));
        }
    }

    public isPadNormalModel(): boolean {
        return deviceInfo.deviceType === 'tablet' && !this.windowPcmodeSwitchStatus;
    }
}
