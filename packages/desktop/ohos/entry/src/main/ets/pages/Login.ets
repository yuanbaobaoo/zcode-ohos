// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { ILoginInfo, ILogin } from 'web_engine';
import { QuickLoginButtonComponent, QuickLoginResult } from 'account_quick_login';


let storage = LocalStorage.getShared();
@Entry(storage)
@Component
struct Index {
  @LocalStorageLink('login') login: ILogin = {
    loginCallbackFunc: (loginInfo: ILoginInfo) => {},
    accountUeaStateCallbackFunc: (active: boolean) => {},
    ownerWindowId: -1
  };

  private loginCallback_: (loginInfo: ILoginInfo) => void = (loginInfo: ILoginInfo) => {};
  private accountUeaStateCallback_: (active: boolean) => void = (active: boolean) => {};

  private handleLoginResult(loginInfo: QuickLoginResult): void {
    this.loginCallback_(loginInfo as ILoginInfo);
  }

  private handleAccountUeaState(active: boolean): void {
    this.accountUeaStateCallback_(active);
  }

  aboutToAppear() {
    this.loginCallback_ = this.login.loginCallbackFunc;
    this.accountUeaStateCallback_ = this.login.accountUeaStateCallbackFunc;
  }

  aboutToDisappear() {

  }

  build() {
    RelativeContainer() {
      QuickLoginButtonComponent({
        loginCallback: (loginInfo: QuickLoginResult) => this.handleLoginResult(loginInfo),
        accountUeaStateCallback: (active: boolean) => this.handleAccountUeaState(active),
        ownerWindowId: this.login.ownerWindowId,
        appName: 'Electron Quick Login',
        appDescription: 'Huawei Account Kit quick login',
        appIcon: $r('app.media.app_icon')
      })
        .backgroundColor(0xffffff)
    }
    // Account Kit verification shares this host's UI context. Keep its
    // ancestor tree visible and enabled so the SMS field can receive input.
    .height('100%')
    .width('100%')
  }
}
