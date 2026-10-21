import { loginComponentManager, LoginWithHuaweiIDButton } from '@kit.AccountKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { promptAction, router } from '@kit.ArkUI';
import { connection } from '@kit.NetworkKit';
import { authentication } from '@kit.AccountKit';
import { util } from '@kit.ArkTS';
import { common, ConfigurationConstant } from '@kit.AbilityKit';

export interface QuickLoginProviderData {
  provider: string;
  resultVersion: number;
  capabilityVersion: string;
}

export interface QuickLoginResult {
  status: boolean;
  resultSchemaVersion: number;
  authCode: string;
  unionId: string;
  openId: string;
  idToken: string;
  anonymousPhone: string;
  errorCode?: string;
  errorMessage?: string;
  providerData?: QuickLoginProviderData;
}

const loginFailInfo: QuickLoginResult = {
  status: false,
  resultSchemaVersion: 1,
  authCode: '',
  unionId: '',
  openId: '',
  idToken: '',
  anonymousPhone: '',
  errorCode: 'LOGIN_CANCELLED',
  errorMessage: 'The user cancelled quick login'
};


@Component
export struct QuickLoginButtonComponent {
  // 获取登录信息的回调函数
  loginCallback: (loginInfo: QuickLoginResult) => void = (loginInfo: QuickLoginResult) => {};
  accountUeaStateCallback: (active: boolean) => void = (active: boolean) => {};
  ownerWindowId: number = -1;
  appName: string = 'Quick Login Sample';
  appDescription: string = '';
  appIcon?: Resource;

  logTag: string = 'QuickLoginButtonComponent';
  domainId: number = 0x0000;
  // 第二步获取的匿名化手机号传到此处
  @State quickLoginAnonymousPhone: string = '';
  @State preAuthenticationReady: boolean = false;
  // 是否勾选协议
  @State isSelected: boolean = false;
  private terminalDispatched: boolean = false;
  private preAuthenticationSettled: boolean = false;
  private accountUeaActive: boolean = false;
  private static PRE_AUTHENTICATION_TIMEOUT_MS: number = 5000;
  // 华为账号用户认证协议链接，此处仅为示例，实际开发过程中，出于可维护性、安全性等方面考虑，域名不建议硬编码在本地
  private static USER_AUTHENTICATION_PROTOCOL: string =
    'https://privacy.consumer.huawei.com/legal/id/authentication-terms.htm?code=CN&language=zh-CN';
  // 由接入应用替换为自己的协议地址。为空时不会跳转到不可信或占位页面。
  private static USER_SERVICE_PROTOCOL: string = '';
  private static PRIVACY_PROTOCOL: string = '';
  private static USER_SERVICE_TAG = '用户服务协议';
  private static PRIVACY_TAG = '隐私协议';
  private static USER_AUTHENTICATION_TAG = '华为账号用户认证协议';

  private logInfo(message: string): void {
    hilog.info(this.domainId, this.logTag,
      `[QuickLogin][ownerWindowId=${this.ownerWindowId}] ${message}`);
  }

  private logError(message: string): void {
    hilog.error(this.domainId, this.logTag,
      `[QuickLogin][ownerWindowId=${this.ownerWindowId}] ${message}`);
  }

  private setAccountUeaActive(active: boolean, phase: string): void {
    if (this.accountUeaActive === active) {
      return;
    }
    this.accountUeaActive = active;
    this.logInfo(`Account Kit UEA state changed, active=${active}, phase=${phase}`);
    this.accountUeaStateCallback(active);
  }

  private makeFailure(errorCode: string, errorMessage: string): QuickLoginResult {
    return {
      status: false,
      resultSchemaVersion: 1,
      authCode: '',
      unionId: '',
      openId: '',
      idToken: '',
      anonymousPhone: '',
      errorCode: errorCode,
      errorMessage: errorMessage
    };
  }

  private dispatchTerminal(loginInfo: QuickLoginResult, phase: string): void {
    if (this.terminalDispatched) {
      this.logInfo(
        `duplicate terminal result ignored, phase=${phase}, status=${loginInfo.status}, ` +
        `errorCode=${loginInfo.errorCode ?? 'none'}`);
      return;
    }
    this.terminalDispatched = true;
    this.setAccountUeaActive(false, `${phase}-terminal`);
    if (!this.preAuthenticationReady) {
      this.preAuthenticationSettled = true;
    }
    this.controller.setEnabled(false);
    this.logInfo(
      `terminal result dispatched, phase=${phase}, status=${loginInfo.status}, ` +
      `errorCode=${loginInfo.errorCode ?? 'none'}`);
    this.loginCallback(loginInfo);
  }

  private dispatchFailure(errorCode: string, errorMessage: string, phase: string): void {
    this.dispatchTerminal(this.makeFailure(errorCode, errorMessage), phase);
  }

  private getUserFacingError(errorCode: number): string {
    if (errorCode === ErrorCode.ERROR_CODE_NETWORK_ERROR) {
      return '网络未连接，请检查网络设置后重试';
    }
    if (errorCode === ErrorCode.ERROR_CODE_LOGIN_OUT) {
      return '当前设备未登录华为账号，请使用其他方式登录';
    }
    if (errorCode === ErrorCode.ERROR_CODE_NOT_SUPPORTED) {
      return '当前账号或设备暂不支持华为账号一键登录';
    }
    return '一键登录暂不可用，请使用其他方式登录';
  }
  // 定义LoginWithHuaweiIDButton展示的隐私文本，展示应用的用户服务协议、隐私协议和华为账号用户认证协议
  privacyText: loginComponentManager.PrivacyText[] = [{
    text: '已阅读并同意',
    type: loginComponentManager.TextType.PLAIN_TEXT
  }, {
    text: '《用户服务协议》',
    tag: QuickLoginButtonComponent.USER_SERVICE_TAG,
    type: loginComponentManager.TextType.RICH_TEXT
  }, {
    text: '《隐私协议》',
    tag: QuickLoginButtonComponent.PRIVACY_TAG,
    type: loginComponentManager.TextType.RICH_TEXT
  }, {
    text: '和',
    type: loginComponentManager.TextType.PLAIN_TEXT
  }, {
    text: '《华为账号用户认证协议》',
    tag: QuickLoginButtonComponent.USER_AUTHENTICATION_TAG,
    type: loginComponentManager.TextType.RICH_TEXT
  }, {
    text: '。',
    type: loginComponentManager.TextType.PLAIN_TEXT
  }];
  // 构造LoginWithHuaweiIDButton组件的控制器
  controller: loginComponentManager.LoginWithHuaweiIDButtonController =
    new loginComponentManager.LoginWithHuaweiIDButtonController()
      /**
       * 当应用使用自定义的登录页时，如果用户未同意协议，需要设置协议状态为NOT_ACCEPTED，当用户同意协议后再设置
       * 协议状态为ACCEPTED，才可以使用华为账号一键登录功能
       */
      .setAgreementStatus(loginComponentManager.AgreementStatus.NOT_ACCEPTED)
      .onClickLoginWithHuaweiIDButton((error: BusinessError | undefined,
        response: loginComponentManager.HuaweiIDCredential) => {
        this.handleLoginWithHuaweiIDButton(error, response);
      })
      .onClickEvent((error: BusinessError, clickEvent: loginComponentManager.ClickEvent) => {
        if (error) {
          this.setAccountUeaActive(false, 'login-button-click-error');
          this.dealAllError(error, 'login-button-click-event');
          return;
        }
        this.logInfo(`login button click event received, clickEvent=${clickEvent}`);
        this.setAccountUeaActive(true, 'login-button-click');
        this.controller.setEnabled(false);
      });
  agreementDialog: CustomDialogController = new CustomDialogController({
    builder: AgreementDialog({
      privacyText: this.privacyText,
      cancel: () => {
        this.logInfo('agreement dialog cancelled');
        this.agreementDialog.close();
        this.controller.setAgreementStatus(loginComponentManager.AgreementStatus.NOT_ACCEPTED);
        this.dispatchFailure('LOGIN_CANCELLED', 'The user declined the login agreements',
          'agreement-dialog-cancel');
      },
      confirm: () => {
        this.logInfo('agreement dialog confirmed; invoking continueLogin');
        this.agreementDialog.close();
        this.isSelected = true;
        this.controller.setAgreementStatus(loginComponentManager.AgreementStatus.ACCEPTED);
        // 调用此方法，同意协议与登录一并完成，无需再次点击登录按钮
        this.setAccountUeaActive(true, 'agreement-continue-login');
        this.controller.continueLogin((error: BusinessError) => {
          if (error) {
            this.setAccountUeaActive(false, 'agreement-continue-login-error');
            this.logError(
              `continueLogin failed, errorCode=${error.code}, errorMessage=${error.message}`);
            this.showToast(this.getUserFacingError(error.code));
            this.dispatchFailure(error.code.toString(), error.message, 'agreement-continue-login');
          } else {
            this.logInfo('continueLogin request accepted; waiting for Account Kit credential callback');
          }
        });
      },
      clickHyperlinkText: (tag: string) => {
        this.agreementDialog.close();
        // The dialog is closed while the protocol page is shown. Re-enable the
        // button so the user can resume login after navigating back.
        this.controller.setEnabled(true);
        this.openProtocol(tag);
      }
    }),
    autoCancel: false,
    alignment: DialogAlignment.Center,
  });

  // 传递页面渲染所需的数据，如匿名手机号等
  aboutToAppear(): void {
    this.logInfo('component appeared; starting anonymous-phone pre-authentication');
    this.getQuickLoginAnonymousPhone();
  }

  aboutToDisappear(): void {
    // The host hides this dialog while Account Kit owns the foreground UI.
    // Keep the interaction state until Account Kit returns its credential or error callback.
    this.logInfo(`component disappeared, accountUeaActive=${this.accountUeaActive}`);
  }

  getQuickLoginAnonymousPhone(): void {
    // 创建授权请求，并设置参数
    const authRequest = new authentication.HuaweiIDProvider().createAuthorizationWithHuaweiIDRequest();
    // 获取匿名手机号需传quickLoginAnonymousPhone这个scope，传参之前需要先申请“华为账号一键登录”权限
    authRequest.scopes = ['quickLoginAnonymousPhone'];
    // 用于防跨站点请求伪造
    const requestState: string = util.generateRandomUUID();
    authRequest.state = requestState;
    // 一键登录场景该参数必须设置为false
    authRequest.forceAuthorization = false;
    const controller = new authentication.AuthenticationController();
    this.logInfo('pre-authentication executeRequest started, scope=quickLoginAnonymousPhone');
    this.setAccountUeaActive(true, 'pre-authentication');
    const timeoutId: number = setTimeout(() => {
      if (this.preAuthenticationSettled) {
        return;
      }
      this.preAuthenticationSettled = true;
      this.setAccountUeaActive(false, 'pre-authentication-timeout');
      this.logError(
        `pre-authentication timed out after ${QuickLoginButtonComponent.PRE_AUTHENTICATION_TIMEOUT_MS}ms`);
      this.dispatchFailure('PREAUTH_TIMEOUT',
        'Huawei quick login pre-authentication timed out', 'anonymous-phone-pre-authentication-timeout');
    }, QuickLoginButtonComponent.PRE_AUTHENTICATION_TIMEOUT_MS);
    try {
      controller.executeRequest(authRequest).then((response: authentication.AuthorizationWithHuaweiIDResponse) => {
        this.setAccountUeaActive(false, 'pre-authentication-success');
        if (this.preAuthenticationSettled) {
          this.logInfo('late pre-authentication success ignored');
          return;
        }
        this.preAuthenticationSettled = true;
        clearTimeout(timeoutId);
        if (response.state !== requestState) {
          this.logError('pre-authentication state mismatch');
          this.dispatchFailure('PREAUTH_STATE_MISMATCH',
            'Huawei quick login pre-authentication state mismatch',
            'anonymous-phone-pre-authentication-state');
          return;
        }
        // 获取到UnionID、OpenID、匿名手机号
        const unionID = response.data?.unionID;
        const openID = response.data?.openID;
        const authorizationCode = response.data?.authorizationCode;
        const anonymousPhone = response.data?.extraInfo?.quickLoginAnonymousPhone as string;
        this.logInfo(
          `pre-authentication callback received, unionIdPresent=${unionID !== undefined && unionID !== null}, ` +
          `openIdPresent=${openID !== undefined && openID !== null}, ` +
          `authCodePresent=${authorizationCode !== undefined && authorizationCode !== null}, ` +
          `anonymousPhonePresent=${!!anonymousPhone}`);
        if (anonymousPhone) {
          this.quickLoginAnonymousPhone = anonymousPhone;
          this.preAuthenticationReady = true;
          this.logInfo('pre-authentication completed; quick login UI is now available');
          return;
        }
        this.logInfo('pre-authentication succeeded but anonymous phone is empty; requesting alternative login');
        this.dispatchFailure('ANONYMOUS_PHONE_UNAVAILABLE',
          'Huawei Account Kit did not return an anonymous phone number',
          'anonymous-phone-pre-authentication-empty');
      }).catch((error: BusinessError) => {
        this.setAccountUeaActive(false, 'pre-authentication-failure');
        if (this.preAuthenticationSettled) {
          this.logInfo(`late pre-authentication failure ignored, errorCode=${error.code}`);
          return;
        }
        this.preAuthenticationSettled = true;
        clearTimeout(timeoutId);
        this.dealAllError(error, 'anonymous-phone-pre-authentication');
      })
    } catch (error) {
      this.setAccountUeaActive(false, 'pre-authentication-sync-failure');
      if (this.preAuthenticationSettled) {
        return;
      }
      this.preAuthenticationSettled = true;
      clearTimeout(timeoutId);
      this.dealAllError(error as BusinessError, 'anonymous-phone-pre-authentication-sync');
    }
  }

  // Toast提示
  showToast(resource: string) {
    try {
      promptAction.showToast({
        message: resource,
        duration: 2000
      });
    } catch (error) {
      const message = (error as BusinessError).message
      const code = (error as BusinessError).code
      hilog.error(this.domainId, this.logTag, `showToast args  errCode is ${code}, errMessage is ${message}`);
    }
  }

  // 跳转华为账号用户认证协议页,该页面需在工程main_pages.json文件配置
  jumpToPrivacyWebView(url: string = QuickLoginButtonComponent.USER_AUTHENTICATION_PROTOCOL) {
    try {
      // 需在module.json5中配置“ohos.permission.GET_NETWORK_INFO”权限
      const checkNetConn = connection.hasDefaultNetSync();
      if (!checkNetConn) {
        this.showToast('服务或网络异常，请稍后重试');
        return;
      }
    } catch (error) {
      const message = error.message as string;
      const code = error.code as string;
      hilog.error(0x0000, 'testTag', `Failed to hasDefaultNetSync, errCode is ${code}, errMessage is ${message}`);
    }
    let targetUrl: string = url;
    const context = getContext(this) as common.UIAbilityContext;
    if (targetUrl === QuickLoginButtonComponent.USER_AUTHENTICATION_PROTOCOL &&
      context.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK) {
      targetUrl = `${targetUrl}&bgmode=black`;
    }
    router.pushUrl({
      // 需在module.json5配置“ohos.permission.INTERNET”网络权限
      url: 'pages/WebPage',
      params: {
        isFromDialog: true,
        url: targetUrl,
      }
    }, (err) => {
      if (err) {
        hilog.error(this.domainId, this.logTag,
          `Failed to jumpToPrivacyWebView, errCode is ${err.code}, errMessage is ${err.message}`);
      }
    });
  }

  private openProtocol(tag: string): void {
    let url: string = '';
    if (tag === QuickLoginButtonComponent.USER_SERVICE_TAG) {
      url = QuickLoginButtonComponent.USER_SERVICE_PROTOCOL;
    } else if (tag === QuickLoginButtonComponent.PRIVACY_TAG) {
      url = QuickLoginButtonComponent.PRIVACY_PROTOCOL;
    } else if (tag === QuickLoginButtonComponent.USER_AUTHENTICATION_TAG) {
      url = QuickLoginButtonComponent.USER_AUTHENTICATION_PROTOCOL;
    }
    if (!url) {
      this.logError(`protocol URL is not configured, tag=${tag}`);
      this.showToast('应用协议地址未配置');
      return;
    }
    this.jumpToPrivacyWebView(url);
  }

  handleLoginWithHuaweiIDButton(error: BusinessError | undefined,
    response: loginComponentManager.HuaweiIDCredential) {
    this.setAccountUeaActive(false, 'credential-callback');
    this.logInfo(
      `credential callback entered, hasError=${!!error}, responsePresent=${!!response}, ` +
      `agreementSelected=${this.isSelected}`);
    if (error) {
      this.logError(
        `credential callback failed, errorCode=${error.code}, errorMessage=${error.message}`);
      if (error.code === ErrorCode.ERROR_CODE_NETWORK_ERROR) {
        AlertDialog.show(
          {
            message: "网络未连接，请检查网络设置。",
            offset: { dx: 0, dy: -12 },
            alignment: DialogAlignment.Bottom,
            autoCancel: false,
            confirm: {
              value: "知道了",
              action: () => {
              }
            }
          }
        );
      } else if (error.code === ErrorCode.ERROR_CODE_AGREEMENT_STATUS_NOT_ACCEPTED) {
        // 未同意协议，弹出协议弹框，推荐使用该回调方式
        this.logInfo('agreement is not accepted; opening agreement dialog and keeping request pending');
        this.agreementDialog.open();
        return;
      } else if (error.code === ErrorCode.ERROR_CODE_LOGIN_OUT) {
        // 华为账号未登录提示
        this.showToast("华为账号未登录，请重试");
      } else if (error.code === ErrorCode.ERROR_CODE_NOT_SUPPORTED) {
        // 不支持该scopes或permissions提示
        this.showToast("该scopes或permissions不支持");
      } else if (error.code === ErrorCode.ERROR_CODE_PARAMETER_ERROR) {
        // 参数错误提示
        this.showToast("参数错误");
      } else {
        // 其他提示系统或服务异常
        this.showToast('服务或网络异常，请稍后重试');
      }
      this.dispatchFailure(error.code.toString(), error.message, 'credential-callback');
      return;
    }
    try {
      if (this.isSelected) {
        if (response) {
          // 开发者根据实际业务情况使用以下信息
          const authCode = response.authorizationCode;
          const openID = response.openID;
          const unionID = response.unionID;
          const idToken = response.idToken;
          this.logInfo(
            `credential callback succeeded, authCodePresent=${!!authCode}, openIdPresent=${!!openID}, ` +
            `unionIdPresent=${!!unionID}, idTokenPresent=${!!idToken}, ` +
            `anonymousPhonePreAuthPresent=${!!this.quickLoginAnonymousPhone}`);

          if (!authCode) {
            this.logError('credential callback did not contain an authorization code');
            this.dispatchFailure('AUTHORIZATION_CODE_MISSING',
              'Huawei Account Kit did not return an authorization code', 'credential-callback-validation');
            return;
          }

          // 回传数据给 electron
          const loginInfo: QuickLoginResult = {
            status: true,
            resultSchemaVersion: 1,
            authCode: authCode ? authCode.toString() : '',
            unionId: unionID ? unionID.toString() : '',
            openId: openID ? openID.toString() : '',
            idToken: idToken ? idToken.toString() : '',
            anonymousPhone: this.quickLoginAnonymousPhone.toString(),
            // This nested field intentionally demonstrates that Account Kit can
            // extend its ArkTS result without changing the C++/Electron bridge.
            providerData: {
              provider: 'HuaweiAccountKit',
              resultVersion: 1,
              capabilityVersion: '1.0.0'
            }
          };
          this.dispatchTerminal(loginInfo, 'credential-callback');
        } else {
          this.logError('credential callback returned no error and no response');
          this.dispatchFailure('EMPTY_CREDENTIAL_RESPONSE',
            'Huawei Account Kit returned an empty credential response', 'credential-callback-empty');
        }
      } else {
        this.logInfo('credential callback arrived before agreement acceptance; opening agreement dialog');
        this.agreementDialog.open();
      }
    } catch (err) {
      this.logError(
        `credential processing failed, errorCode=${err.code}, errorMessage=${err.message}`);
      AlertDialog.show(
        {
          message: '服务或网络异常，请稍后重试',
          offset: { dx: 0, dy: -12 },
          alignment: DialogAlignment.Bottom,
          autoCancel: false,
          confirm: {
            value: '知道了',
            action: () => {
            }
          }
        }
      );
      this.dispatchFailure(
        err.code ? err.code.toString() : 'LOGIN_FAILED',
        err.message ? err.message : 'Quick login failed',
        'credential-processing');
    }
  }

  // 错误处理
  dealAllError(error: BusinessError, phase: string = 'unknown'): void {
    const errorCode: string = error?.code !== undefined ? error.code.toString() : 'LOGIN_FAILED';
    const errorMessage: string = error?.message ? error.message : 'Huawei quick login failed';
    this.logError(`${phase} failed, errorCode=${errorCode}, errorMessage=${errorMessage}`);
    if (error?.code !== undefined) {
      this.showToast(this.getUserFacingError(error.code));
    }
    this.dispatchFailure(errorCode, errorMessage, phase);
  }

  build() {
    Scroll() {
      Column() {
        if (this.preAuthenticationReady) {
          Column() {
          Column() {
            Button({ type: ButtonType.Normal }) {
              Image($r('sys.media.ohos_ic_compnent_titlebar_back'))
                .backgroundColor(Color.Transparent)
                .borderRadius(20)
                .width(24)
                .height(24)
                .draggable(false)
                .autoResize(false)
                .focusable(true)
                .fillColor($r('sys.color.ohos_id_color_titlebar_icon'))
                .matchTextDirection(true)
            }
            .alignSelf(ItemAlign.Start)
            .backgroundColor($r('sys.color.ohos_id_color_button_normal'))
            .borderRadius(20)
            .width(40)
            .height(40)
            .onClick(() => {
              // 手动关闭登录页面
              this.logInfo('title-bar back clicked; dispatching LOGIN_CANCELLED');
              this.dispatchTerminal(loginFailInfo, 'title-bar-back');
            })
          }.width('100%').margin({ top: 16, })
          Column() {
            if (this.appIcon) {
              Image(this.appIcon)
                .width(48)
                .height(48)
                .draggable(false)
                .copyOption(CopyOptions.None)
            }

            Text(this.appName)
              .fontFamily($r('sys.string.ohos_id_text_font_family_medium'))
              .fontWeight(FontWeight.Medium)
              .fontWeight(FontWeight.Bold)
              .maxFontSize($r('sys.float.ohos_id_text_size_headline8'))
              .minFontSize($r('sys.float.ohos_id_text_size_body1'))
              .maxLines(1)
              .fontColor($r('sys.color.ohos_id_color_text_primary'))
              .constraintSize({ maxWidth: '100%' })
              .margin({
                top: 12,
              })

            Text(this.appDescription)
              .fontSize($r('sys.float.ohos_id_text_size_body2'))
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .fontFamily($r('sys.string.ohos_id_text_font_family_regular'))
              .fontWeight(FontWeight.Regular)
              .constraintSize({ maxWidth: '100%' })
              .margin({
                top: 8,
              })
          }.margin({
            top: 10
          })

          Column() {
            Text(this.quickLoginAnonymousPhone)
              .fontSize(36)
              .fontColor($r('sys.color.ohos_id_color_text_primary'))
              .fontFamily($r('sys.string.ohos_id_text_font_family_medium'))
              .fontWeight(FontWeight.Bold)
              .lineHeight(48)
              .textAlign(TextAlign.Center)
              .maxLines(1)
              .constraintSize({ maxWidth: '100%', minHeight: 48 })

            Text('华为账号绑定号码')
              .fontSize($r('sys.float.ohos_id_text_size_body2'))
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .fontFamily($r('sys.string.ohos_id_text_font_family_regular'))
              .fontWeight(FontWeight.Regular)
              .lineHeight(19)
              .textAlign(TextAlign.Center)
              .maxLines(1)
              .constraintSize({ maxWidth: '100%' })
              .margin({
                top: 8
              })
          }.margin({
            top: 64
          })

          Column() {
            LoginWithHuaweiIDButton({
              params: {
                // LoginWithHuaweiIDButton支持的样式
                style: loginComponentManager.Style.BUTTON_RED,
                // 账号登录按钮在登录过程中展示加载态
                extraStyle: {
                  buttonStyle: new loginComponentManager.ButtonStyle().loadingStyle({
                    show: true
                  })
                },
                // LoginWithHuaweiIDButton的边框圆角半径
                borderRadius: 24,
                // LoginWithHuaweiIDButton支持的登录类型
                loginType: loginComponentManager.LoginType.QUICK_LOGIN,
                // LoginWithHuaweiIDButton支持按钮的样式跟随系统深浅色模式切换
                supportDarkMode: true,
                // verifyPhoneNumber：如果华为账号用户在过去90天内未进行短信验证，是否拉起Account Kit提供的短信验证码页面
                verifyPhoneNumber: true
              },
              controller: this.controller
            })
          }
          .height(40)
          .margin({
            top: 56
          })

          Column() {
            Button({
              type: ButtonType.Capsule,
              stateEffect: true
            }) {
              Text('其他方式登录')
                .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
                .fontFamily($r('sys.string.ohos_id_text_font_family_medium'))
                .fontWeight(FontWeight.Medium)
                .fontSize($r('sys.float.ohos_id_text_size_button1'))
                .focusable(true)
                .focusOnTouch(true)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .maxLines(1)
                .padding({ left: 8, right: 8 })
            }
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .fontFamily($r('sys.string.ohos_id_text_font_family_medium'))
            .fontWeight(FontWeight.Medium)
            .backgroundColor($r('sys.color.ohos_id_color_button_normal'))
            .focusable(true)
            .focusOnTouch(true)
            .constraintSize({ minHeight: 40 })
            .width('100%')
            .onClick(() => {
              // 跳转到应用自定义的登录页面
              this.logInfo('alternative login clicked');
              this.dispatchFailure('ALTERNATIVE_LOGIN_REQUESTED',
                'The user requested another login method', 'alternative-login');
            })
          }.margin({ top: 16 })
        }.width('100%')

        Row() {
          Row() {
            Checkbox({ name: 'privacyCheckbox', group: 'privacyCheckboxGroup' })
              .width(24)
              .height(24)
              .focusable(true)
              .focusOnTouch(true)
              .margin({ top: 0 })
              .select(this.isSelected)
              .onChange((value: boolean) => {
                if (value) {
                  this.isSelected = true;
                  this.controller.setAgreementStatus(loginComponentManager.AgreementStatus.ACCEPTED);
                } else {
                  this.isSelected = false;
                  this.controller.setAgreementStatus(loginComponentManager.AgreementStatus.NOT_ACCEPTED);
                }
                hilog.info(this.domainId, this.logTag, `agreementChecked: ${value}`);
              })
          }

          Row() {
            Text() {
              ForEach(this.privacyText, (item: loginComponentManager.PrivacyText) => {
                if (item?.type === loginComponentManager.TextType.PLAIN_TEXT && item?.text) {
                  Span(item?.text)
                    .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                    .fontFamily($r('sys.string.ohos_id_text_font_family_regular'))
                    .fontWeight(FontWeight.Regular)
                    .fontSize($r('sys.float.ohos_id_text_size_body3'))
                } else if (item?.type === loginComponentManager.TextType.RICH_TEXT && item?.text) {
                  Span(item?.text)
                    .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
                    .fontFamily($r('sys.string.ohos_id_text_font_family_medium'))
                    .fontWeight(FontWeight.Medium)
                    .fontSize($r('sys.float.ohos_id_text_size_body3'))
                    .focusable(true)
                    .focusOnTouch(true)
                    .onClick(() => {
                      // 应用需要根据item.tag实现协议页面的跳转逻辑
                      hilog.info(this.domainId, this.logTag, `click privacy text tag: ${item.tag}`);
                      this.openProtocol(item.tag ?? '');
                    })
                }
              }, (item: loginComponentManager.PrivacyText) => item.text.toString())
            }
            .width('100%')
          }
          .margin({ left: 12 })
          .layoutWeight(1)
          .constraintSize({ minHeight: 24 })
        }
        .alignItems(VerticalAlign.Top)
        .margin({
          top:16,
          bottom: 16
        })
        } else {
          Column() {
            LoadingProgress()
              .width(40)
              .height(40)
              .color($r('sys.color.ohos_id_color_text_primary_activated'))
            Text('正在获取华为账号绑定号码…')
              .fontSize($r('sys.float.ohos_id_text_size_body1'))
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .margin({ top: 16 })
            Button('取消', { type: ButtonType.Capsule })
              .margin({ top: 24 })
              .onClick(() => {
                this.dispatchFailure('LOGIN_CANCELLED',
                  'The user cancelled quick login during pre-authentication',
                  'pre-authentication-cancel');
              })
          }
          .justifyContent(FlexAlign.Center)
          .height('100%')
          .width('100%')
        }
      }
      .justifyContent(FlexAlign.SpaceBetween)
      .constraintSize({ minHeight: '100%' })
      .margin({
        left: 16,
        right: 16
      })
    }
    .width('100%')
    .height('100%')
  }
}

@CustomDialog
export struct AgreementDialog {
  logTag: string = 'AgreementDialog';
  domainId: number = 0x0000;
  dialogController?: CustomDialogController;
  cancel: () => void = () => {
  };
  confirm: () => void = () => {
  };
  clickHyperlinkText: (tag: string) => void = (tag: string) => {
  };
  privacyText: loginComponentManager.PrivacyText[] = [];

  build() {
    Column() {
      Row() {
        Text('用户协议与隐私条款')
          .id('loginPanel_agreement_dialog_privacy_title')
          .maxFontSize($r('sys.float.ohos_id_text_size_headline8'))
          .minFontSize($r('sys.float.ohos_id_text_size_body1'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .fontFamily($r('sys.string.ohos_id_text_font_family_medium'))
          .fontWeight(FontWeight.Bold)
          .textAlign(TextAlign.Center)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .maxLines(2)
      }
      .alignItems(VerticalAlign.Center)
      .constraintSize({ minHeight: 56, maxWidth: 400 })
      .margin({
        left: $r('sys.float.ohos_id_max_padding_start'),
        right: $r('sys.float.ohos_id_max_padding_start')
      })

      Row() {
        Text() {
          ForEach(this.privacyText, (item: loginComponentManager.PrivacyText) => {
            if (item?.type === loginComponentManager.TextType.PLAIN_TEXT && item?.text) {
              Span(item?.text)
                .fontSize($r('sys.float.ohos_id_text_size_body1'))
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .fontFamily($r('sys.string.ohos_id_text_font_family_regular'))
                .fontWeight(FontWeight.Regular)
            } else if (item?.type === loginComponentManager.TextType.RICH_TEXT && item?.text) {
              Span(item?.text)
                .fontSize($r('sys.float.ohos_id_text_size_body1'))
                .fontColor('#CE0E2D')
                .fontFamily($r('sys.string.ohos_id_text_font_family_medium'))
                .fontWeight(FontWeight.Medium)
                .focusable(true)
                .focusOnTouch(true)
                .onClick(() => {
                  // 应用需要根据item.tag实现协议页面的跳转逻辑
                  hilog.info(this.domainId, this.logTag, `click privacy text tag: ${item.tag}`);
                  this.clickHyperlinkText(item.tag ?? '');
                })
            }
          }, (item: loginComponentManager.PrivacyText) => item.text.toString())
        }
        .width('100%')
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .maxLines(10)
        .textAlign(TextAlign.Start)
        .focusable(true)
        .focusOnTouch(true)
        .padding({ left: 24, right: 24 })
      }.width('100%')

      Flex({
        direction: FlexDirection.Row
      }) {
        Button('取消',
          { type: ButtonType.Capsule, stateEffect: true })
          .id('loginPanel_agreement_cancel_btn')
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .fontSize($r('sys.float.ohos_id_text_size_button1'))
          .fontFamily($r('sys.string.ohos_id_text_font_family_medium'))
          .backgroundColor(Color.Transparent)
          .fontWeight(FontWeight.Medium)
          .focusable(true)
          .focusOnTouch(true)
          .constraintSize({ minHeight: 40, maxWidth: 400 })
          .width('50%')
          .onClick(() => {
            hilog.info(this.domainId, this.logTag, 'AgreementDialog cancel.');
            this.cancel();
          })

        Button('同意并登录',
          { type: ButtonType.Capsule, stateEffect: true })
          .id('loginPanel_agreement_dialog_huawei_id_login_btn')
          .fontColor(Color.White)
          .backgroundColor('#CE0E2D')
          .fontSize($r('sys.float.ohos_id_text_size_button1'))
          .fontFamily($r('sys.string.ohos_id_text_font_family_medium'))
          .fontWeight(FontWeight.Medium)
          .focusable(true)
          .focusOnTouch(true)
          .constraintSize({ minHeight: 40, maxWidth: 400 })
          .width('50%')
          .onClick(() => {
            hilog.info(this.domainId, this.logTag, 'AgreementDialog confirm.');
            this.confirm();
          })
      }
      .margin({
        top: 8,
        left: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        right: $r('sys.float.ohos_id_elements_margin_horizontal_l'),
        bottom: 16
      })
    }.backgroundColor($r('sys.color.ohos_id_color_dialog_default_bg'))
    .padding({
      left: 16,
      right: 16
    })
  }
}

export enum ErrorCode {
  // 账号未登录
  ERROR_CODE_LOGIN_OUT = 1001502001,
  // 该账号不支持一键登录，如海外账号
  ERROR_CODE_NOT_SUPPORTED = 1001500003,
  // 网络错误
  ERROR_CODE_NETWORK_ERROR = 1001502005,
  // 用户未同意用户协议
  ERROR_CODE_AGREEMENT_STATUS_NOT_ACCEPTED = 1005300001,
  // 参数错误
  ERROR_CODE_PARAMETER_ERROR = 401,
  // 内部错误
  ERROR_CODE_INTERNAL_ERROR = 1001502009,
  // 应用指纹证书校验失败
  ERROR_CODE_FINGERPRINT_ERROR = 1001500001,
  // 重复请求
  ERROR_CODE_REQUEST_REFUSE = 1001500002,
  // 应用未申请scopes或permissions权限
  ERROR_CODE_PERMISSION_NOT_APPLIED = 1001502014,
  // 系统服务异常
  ERROR_CODE_SYSTEM_SERVICE = 12300001,
  // 用户取消
  ERROR_CODE_USER_CANCEL = 1001502012
}
