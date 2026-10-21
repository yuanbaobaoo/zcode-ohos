// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { inject, injectable } from 'inversify';
import { common, OpenLinkOptions, UIAbility, Want, wantConstant } from '@kit.AbilityKit';

import { BaseAdapter } from '../common/BaseAdapter';
import LogMethod from '../common/LogDecorator';
import LaunchHelper from '../utils/LaunchHelper';
import { ContextAdapter } from './ContextAdapter';
import { fileUri } from '@kit.CoreFileKit';
import LogUtil from '../utils/LogUtil';
import { fileManagerService } from '@kit.FileManagerServiceKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { uniformTypeDescriptor } from '@kit.ArkData';
import image from '@ohos.multimedia.image';
import util from '@ohos.util';

const TAG: string = 'FileManagerAdapter';
const OPEN_IN_FOLDER_LINK: string = 'filemanager://openDirectory';
const BASE64_PREFIX: string = ';base64,'

@injectable()
export class FileManagerAdapter extends BaseAdapter {
  private ctxAdapter: ContextAdapter;

  constructor(@inject(ContextAdapter) ctxAdapter: ContextAdapter) {
    super();
    this.ctxAdapter = ctxAdapter;
  }

  @LogMethod
  openItemInFolder(filePath: string, onCompleted?: (ret: boolean) => void) {
    let uri = fileUri.getUriFromPath(filePath);
    let openLinkOptions: OpenLinkOptions = {
      parameters: {
        'fileUri': uri
      }
    };
    let context = this.ctxAdapter.getActiveContext() as common.UIAbilityContext;
    if (!context) {
      LogUtil.warn(TAG, 'Failed to get context');
      onCompleted?.(false);
      return;
    }
    try {
      context.openLink(OPEN_IN_FOLDER_LINK, openLinkOptions, (err, result) => {
        if(err){
          onCompleted?.(false);
          LogUtil.error(TAG,
            `Failed to open in folder ,err is: ${JSON.stringify(err)}, result is ${JSON.stringify(result)}`);
        } else {
          onCompleted?.(true);
        }
      })
    } catch (err) {
      onCompleted?.(false);
      LogUtil.error(TAG, `Failed to execute openLink , err is : ${JSON.stringify(err)}`);
    }
  }

  @LogMethod
  openVerifiedItem(filePath: string, onCompleted?: (ret: boolean) => void) {
    let uri = fileUri.getUriFromPath(filePath);
    const want: Want = {
      // Configure read and write permissions for shared files,
      // such as granting read and write authorization to shared applications
      flags: wantConstant.Flags.FLAG_AUTH_WRITE_URI_PERMISSION |
             wantConstant.Flags.FLAG_AUTH_READ_URI_PERMISSION,
      action: "ohos.want.action.viewData",
      uri: uri
    }
    onCompleted?.(LaunchHelper.Launch(this.ctxAdapter.getActiveContext(), want));
  }

  // 对齐 37:http/https 链接调系统默认浏览器(platform_util OpenExternal)。
  @LogMethod
  openUrlInDefaultBrowser(url: string) {
    const want: Want = {
      action: 'ohos.want.action.viewData',
      entities: ['entity.system.browsable'],
      uri: url
    };
    LaunchHelper.Launch(this.ctxAdapter.getActiveContext(), want);
  }

  @LogMethod
  openExternal(url: string, options: string) {
    const want: Want = {
      flags: wantConstant.Flags.FLAG_START_WITHOUT_TIPS,
      uri: url,
      action: "ohos.want.action.viewData"
    };
    LaunchHelper.Launch(this.ctxAdapter.getActiveContext(), want);
  }

  @LogMethod
  getFileTypeIdByFileExtension(filenameExtension: string): string {
    try {
      let typeId: string = uniformTypeDescriptor.getUniformDataTypeByFilenameExtension(filenameExtension);
      if (!typeId) {
        LogUtil.error(TAG, "getUniformDataTypeByFilenameExtension failed! FilenameExtension is: " + filenameExtension);
        return '';
      }
      return typeId;
    } catch (error) {
      LogUtil.error(TAG,
        `getUniformDataTypeByFilenameExtension throws an exception.FilenameExtension is: ${filenameExtension}: error is: ` +
        JSON.stringify(error));
      return '';
    }
  }
 
  @LogMethod
  getFileIconByFileTypeId(fileTypeId: string, callback: (icon: ArrayBuffer) => void): void {
    let buffer = new ArrayBuffer(0);
    try {
      fileManagerService.getFileIcon(fileTypeId).then((retIcon: string | Resource) => {
        if (typeof retIcon === 'string') {
          this.convertIcon(retIcon, (result: ArrayBuffer) => {
            callback(result);
          });
          return;
        }
 
        let resPath: string = retIcon.params?.[0]
        let resName = resPath.split('.').pop()
 
        try {
          this.ctxAdapter.getContext()
            .resourceManager
            .getMediaBase64ByName(resName, (error: BusinessError, value: string) => {
              if (error != null) {
                LogUtil.error(TAG, `getMediaBase64ByName failed,fileTypeId is:${fileTypeId},error is:` + error);
                callback(buffer);
              } else {
                this.convertIcon(value, (result: ArrayBuffer) => {
                  callback(result);
                  return;
                });
              }
            });
        } catch (error) {
          LogUtil.error(TAG,
            `callback getMediaContentBase64 failed,fileTypeId is:${fileTypeId},error is:` + JSON.stringify(error));
          callback(buffer);
        }
      });
    } catch (error) {
      LogUtil.error(TAG,
        `getFileIconByFileExtension failed,fileTypeId is:${fileTypeId}, error is:` + JSON.stringify(error));
      callback(buffer)
    }
  }
 
  @LogMethod
  private convertIcon(iconBase64: string, callback: (icon: ArrayBuffer) => void): void {
    let idx = iconBase64.indexOf(BASE64_PREFIX);
    let pureBase64 = idx >= 0 ? iconBase64.substring(idx + BASE64_PREFIX.length) : iconBase64;
 
    let helper = new util.Base64Helper();
    try {
      let u8: Uint8Array = helper.decodeSync(pureBase64);
      const imageSource = image.createImageSource(u8.buffer);
      if (imageSource === undefined) {
        LogUtil.error(TAG, 'createImageSource failed!');
        callback(new ArrayBuffer(0));
        return;
      }
      imageSource.createPixelMap().then((pixelMap: image.PixelMap) => {
        let packOpts: image.PackingOption = { format: "image/png", quality: 100 }
        const imagePackerObj: image.ImagePacker = image.createImagePacker();
        imagePackerObj.packToData(pixelMap, packOpts)
          .then((data: ArrayBuffer) => {
            callback(data);
          }).catch((error: BusinessError) => {
          LogUtil.error(TAG, `Failed to pack the image.code ${error.code},message is ${error.message}`);
          callback(new ArrayBuffer(0));
        })
      }).catch((error: BusinessError) => {
        LogUtil.error(TAG, `Failed to create PixelMap.code ${error.code},message is ${error.message}`);
        callback(new ArrayBuffer(0));
      })
    } catch (error) {
      LogUtil.error(TAG, 'base64 icon decode failed! error is:' + JSON.stringify(error));
      callback(new ArrayBuffer(0));
    }
  }
}
