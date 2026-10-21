// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { injectable } from 'inversify';
import { ConfigData } from './Constants';
import { WebProxy } from '../interface/WebProxy';

AppStorage.setOrCreate('abilityProxyList', []);

@injectable()
export class AbilityManager {
  private appStorage: WebProxy[];

  constructor() {
    let appStorageLink: SubscribedAbstractProperty<WebProxy[]>
      = AppStorage.link('abilityProxyList');
    this.appStorage = appStorageLink.get();
  }

  private paramNormalization(proxyId: string | number): string {
    if (typeof proxyId === 'number') {
      return ConfigData.WINDOW_PREFIX + proxyId;
    }
    return proxyId;
  }

  public addProxy(proxy: WebProxy) {
    for (let i = 0; i < this.appStorage.length; i++) {
      if (proxy.getWindowId() === this.appStorage[i].getWindowId()) {
        return;
      }
    }
    this.appStorage.push(proxy);
  }

  public removeProxy(proxyId: string | number) {
    let id = this.paramNormalization(proxyId);
    for (let i = 0; i < this.appStorage.length; i++) {
      if (id === this.appStorage[i].getWindowId()) {
        this.appStorage.splice(i, 1);
        break;
      }
    }
  }

  public getProxy(proxyId: string | number): WebProxy | undefined {
    let id = this.paramNormalization(proxyId);
    for (let i = 0; i < this.appStorage.length; i++) {
      if (id === this.appStorage[i].getWindowId()) {
        return this.appStorage[i];
      }
    }
    return undefined;
  }

  public getProxyDefault(): WebProxy | undefined {
    if (this.isEmpty()) {
      return undefined;
    }
    return this.appStorage[0];
  }

  public isEmpty(): boolean {
    return this.appStorage.length === 0;
  }

  public getProxyCount(): number {
    return this.appStorage.length;
  }

  public getProxyList(): WebProxy[] {
    return this.appStorage;
  }
  
  public getWindowIdByOriginWindow(originWindowId: number): string {
    for (let i = 0; i < this.appStorage.length; i++) {
      if (originWindowId === this.appStorage[i].getOriginWindowId()) {
        return this.appStorage[i].getWindowId();
      }
    }
    return "";
  }

  public getOriginWindowId(windowId: string): number {
    for (let i = 0; i < this.appStorage.length; i++) {
      if (windowId === this.appStorage[i].getWindowId()) {
        return this.appStorage[i].getOriginWindowId();
      }
    }
    return -1;
  }

};
