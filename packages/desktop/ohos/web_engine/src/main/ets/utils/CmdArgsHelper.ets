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
import LogUtil from "./LogUtil";
import bundleManager from '@ohos.bundle.bundleManager';
import { BusinessError } from '@ohos.base';
import { deviceInfo } from '@kit.BasicServicesKit';
import { NativeContext } from "../interface/CommonInterface";
import JsBindingUtils from "./JsBindingUtils";
import { ContextType } from "../common/Constants";

const TAG = 'CmdArgsHelper';
const SDK_VERSION_19 = 19;
const ENABLE_USER_INPUT_ARGS = false;

export interface ParsedArg {
  name: string;
  value: string | null; // null 表示纯 flag，无值
}

export class CmdArgsHelper {
  private static readonly DEFAULT_ARGS: string[] = [
    "chrome",
    "--use-gl=egl",
    "--enable-features=UseOzonePlatform",
    "--ozone-platform=ohos",
    "--enable-logging",
    "--no-zygote",
    "--disable-gpu-watchdog",
    "--inspect",
  ];
  private static readonly BLOCKED_ARGS_NAME: Set<string> = new Set([
    'ozone-platform',
    'bundle-installation-dir'
  ]);
  private static readonly CAN_BE_REPLACED_ARGS: string[] = [
    "--ozone-dump-file=/data/storage/el2/base/cache/",
    "--user-data-dir=/data/storage/el2/base/files/",
    "--force-renderer-accessibility=complete",
  ];

  private static getNativeContext(): NativeContext {
    return JsBindingUtils.getNativeContext(ContextType.kMainProcess);
  }

  /**
   * Read the Electron executable path configured for the current deployment.
   * HAP-bin and HNP packages use different sandbox paths, so this remains a
   * module metadata setting instead of being tied to a bundle name in code.
   */
  private static detectElectronExecPath(): string {
    try {
      const bundleFlags = bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION |
        bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_HAP_MODULE |
        bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_METADATA;
      const bundleInfo = bundleManager.getBundleInfoForSelfSync(bundleFlags);
      for (const hapModuleInfo of bundleInfo.hapModulesInfo) {
        for (const item of hapModuleInfo.metadata ?? []) {
          if (item.name === 'electron_exec_path_ohos' && item.value) {
            return item.value;
          }
        }
      }
    } catch (err) {
      const message = (err as BusinessError).message;
      LogUtil.error(TAG, `detectElectronExecPath failed: ${message}`);
    }
    return '';
  }

  public static buildArgs(startUri: string, userInputArgs?: string[], appId?: string): string[] {
    // 添加默认参数
    let vec_args = [...CmdArgsHelper.DEFAULT_ARGS];

    // pad添加 --in-process-gpu
    if (deviceInfo.deviceType === 'tablet') {
      vec_args.push("--in-process-gpu");
    }

    // 获取devConfig参数并整合
    const devConfigArgs = CmdArgsHelper.getNativeContext().GetDevCommandLines();
    vec_args = vec_args.concat(devConfigArgs);

    let resDir = '--bundle-installation-dir=' + getContext().resourceDir;
    vec_args.push(resDir);
    const electronExecPath = CmdArgsHelper.detectElectronExecPath();
    if (electronExecPath) {
      vec_args.push(`--electron-exec-path-ohos=${electronExecPath}`);
    }
    vec_args.push(startUri);
    if (appId !== undefined) {
      vec_args.push(appId);
    }

    let jsFlagsValue: string | null = null;
    // 接收用户输入的参数可能有安全问题，默认强制关闭，三方应用如有需要，开发者自行开启
    if (ENABLE_USER_INPUT_ARGS && userInputArgs && userInputArgs.length !== 0) {
      let cmdArgs: string[] = [];
      let parsedUserInputArgs = CmdArgsHelper.parseArgs(userInputArgs);

      // js-flags特殊处理
      jsFlagsValue = CmdArgsHelper.buildJsFlags(parsedUserInputArgs);
      const jsFlagsIndex = parsedUserInputArgs.findIndex(arg => arg.name === 'js-flags');
      if (jsFlagsIndex >= 0) {
        parsedUserInputArgs[jsFlagsIndex].value = jsFlagsValue;
      } else if (jsFlagsValue) {
        parsedUserInputArgs.push({ name: 'js-flags', value: jsFlagsValue });
      }

      cmdArgs = CmdArgsHelper.filterBlockedArgs(parsedUserInputArgs);
      vec_args = vec_args.concat(cmdArgs);
    } else {
      jsFlagsValue = CmdArgsHelper.buildJsFlags();
      vec_args.push(CmdArgsHelper.stringifyOne({ name: 'js-flags', value: jsFlagsValue }));
    }

    // 检查 vec_args 中是否包含 CAN_BE_REPLACED_ARGS 中的参数
    const parsedVecArgs = CmdArgsHelper.parseArgs(vec_args);
    const vecArgNames = new Set(parsedVecArgs.map(arg => arg.name));

    // 如果 vec_args 中不包含 CAN_BE_REPLACED_ARGS 中的参数，则追加
    for (const arg of CmdArgsHelper.CAN_BE_REPLACED_ARGS) {
      const parsedArg = CmdArgsHelper.parseOne(arg);
      if (parsedArg && !vecArgNames.has(parsedArg.name)) {
        vec_args.push(arg);
      }
    }

    return vec_args;
  }

  public static buildJsFlags(parsedUserInputArgs?: ParsedArg[]): string | null {
    const deviceType = deviceInfo.deviceType;
    const sdkVersion = deviceInfo.sdkApiVersion;
    const isTablet = (deviceType === 'tablet');
    const needJitlessForTablet = isTablet && (sdkVersion < SDK_VERSION_19);

    // 安全模式+权限判断需要jitless
    const securityJitless = CmdArgsHelper.getNativeContext().ShouldDisableJit();

    // 合并系统需求(平板+安全模式)
    let systemJsFlags: string | null = null;
    if (needJitlessForTablet || securityJitless) {
      systemJsFlags = '--jitless --no-drumbrake-register-optimization';
    }

    // 从用户输入中解析js-flags
    let userJsFlagsValue: string | null = null;
    if (parsedUserInputArgs) {
      for (const parsed of parsedUserInputArgs) {
        if (parsed.name === 'js-flags') {
          userJsFlagsValue = parsed.value;
          break;
        }
      }
    }

    return CmdArgsHelper.mergeJsFlags(systemJsFlags, userJsFlagsValue);
  }

  private static mergeJsFlags(systemJsFlags: string | null, userJsFlagsValue: string | null): string | null {
    // 情况1: 系统不需要jitless，用户也没输入
    if (!systemJsFlags && !userJsFlagsValue) {
      return null;
    }

    // 情况2: 系统需要jitless，用户没输入
    if (systemJsFlags && !userJsFlagsValue) {
      return systemJsFlags;
    }

    // 情况3: 系统不需要jitless，用户输入了
    if (!systemJsFlags && userJsFlagsValue) {
      return userJsFlagsValue;
    }

    // 情况4: 系统需要jitless，用户也输入了。
    // 系统安全参数放在最后，确保用户参数无法覆盖jitless及DrumBrake保护参数。
    return userJsFlagsValue + ' ' + systemJsFlags;
  }

  public static getCmdArgs(args: Object | undefined): string[] {
    try {
      if (args === undefined) {
        return [];
      }
      if (typeof args === 'string' && args.length > 0) {
        LogUtil.warn(TAG, "cmdArgs str:" + args);
        return CmdArgsHelper.tokenize(args);
      } else if (Array.isArray(args) && args.length > 0) {
        return args;
      }
      return [];
    } catch (err) {
      LogUtil.error(TAG, `get cmdArgs array failed, args is: ${args}, error:${JSON.stringify(err)}`);
      return [];
    }
  }

  /**
   * 把命令行字符串解析成 argv 数组，模拟 shell tokenize 行为
   * 支持双引号"..."包裹含空格的值，支持转义符\"
   *
   * 示例：
   * "--js-flags=\"--jitless --opt\" --nosandbox"
   * → ["--js-flags=--jitless --opt", "--no-sandbox"]
   */
  static tokenize(input: string): string[] {
    const args: string[] = [];
    let current = '';
    let inDoubleQuote = false;

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];

      // 处理转义符
      if (ch === '\\' && i + 1 < input.length) {
        const next = input[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i++; // 跳过下一个字符
          continue;
        }
      }

      // 处理双引号
      if (ch === '"') {
        inDoubleQuote = !inDoubleQuote;
        continue;
      }

      // 空格分割（仅在引号外）
      if (ch === ' ' && !inDoubleQuote) {
        if (current.length > 0) {
          args.push(current);
          current = '';
        }
        continue;
      }

      current += ch;
    }

    if (inDoubleQuote) {
      LogUtil.error(TAG, `tokenize failed: unclosed double quote in: "${input}"`);
      return [];
    }

    if (current.length > 0) {
      args.push(current);
    }

    return args;
  }


  static filterBlockedArgs(args: ParsedArg[]): string[] {
    const result: string[] = [];
    for (const arg of args) {
      if (!CmdArgsHelper.BLOCKED_ARGS_NAME.has(arg.name)) {
        result.push(CmdArgsHelper.stringifyOne(arg));
      } else {
        LogUtil.warn(TAG, `${arg} is blocked!`);
      }
    }
    return result;
  }

  static parseArgs(args: string[]): ParsedArg[] {
    const result: ParsedArg[] = [];
    for (const arg of args) {
      const parsedArg = CmdArgsHelper.parseOne(arg);
      if (parsedArg !== null) {
        result.push(parsedArg);
      }
    }
    return result;
  }

  static parseOne(arg: string): ParsedArg | null {
    const trimmed = arg.trim();

    let body: string;
    if (trimmed.startsWith('--')) {
      body = trimmed.slice(2);
    } else if (trimmed.startsWith('-')) {
      body = trimmed.slice(1);
    } else {
      return null;
    }

    if (body.length === 0) {
      return null;
    } // 单独的 "--" 或 "-"
    if (body.startsWith('-')) {
      return null;
    } // "---abc" 不合法，Chromium 也不认

    const eqIndex = body.indexOf('=');
    if (eqIndex === 0) {
      return null;
    } // "--=value" 或 "-=value" 不合法

    if (eqIndex < 0) {
      return { name: body, value: null };
    }
    return {
      name: body.slice(0, eqIndex),
      value: body.slice(eqIndex + 1),
    };
  }

  static stringifyOne(parsedArg: ParsedArg): string {
    return parsedArg.value !== null ? `--${parsedArg.name}=${parsedArg.value}` : `--${parsedArg.name}`;
  }

  static stringify(parsedArgs: ParsedArg[]): string[] {
    return parsedArgs.map(arg => CmdArgsHelper.stringifyOne(arg));
  }

  static preProcessArgs(vecArgs: string[]): string[] {
    // 处理参数，暂时没有具体实现
    return vecArgs;
  }
}
