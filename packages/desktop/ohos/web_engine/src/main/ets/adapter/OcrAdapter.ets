// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import { injectable } from 'inversify';
import { BaseAdapter } from '../common/BaseAdapter';
import { OcrAdapterImage, TextWord } from '../interface/CommonInterface';
import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';
import image from '@ohos.multimedia.image';
import { textRecognition } from '@kit.CoreVisionKit';
import { BusinessError } from '@ohos.base';

const TAG: string = 'Ocr';
const OCR_IMAGE_PIXEL_FORMAT: number = 3
const OCR_IMAGE_EDITABLE: boolean = false

@injectable()
export class OcrAdapter extends BaseAdapter {

  @LogMethod
  async ocrFunction(callback: Function, requestImage: OcrAdapterImage) {
    let wordsArray :Array<TextWord> = new Array();
    let imagePixel: image.PixelMap = await this.convertImagePixelMap(requestImage) as image.PixelMap;
    if (!imagePixel) {
      callback(wordsArray);
      LogUtil.error(TAG, `covert image piexel failed`);
      return;
    }
    let visionInfo: textRecognition.VisionInfo = {
      pixelMap: imagePixel as image.PixelMap
    };
    textRecognition.recognizeText(visionInfo, (error: BusinessError, data: textRecognition.TextRecognitionResult) => {
      if (error.code !== 0) {
        LogUtil.error(TAG, `textRecognition.recognizeText :${JSON.stringify(error.message)}`);
        callback(wordsArray);
        return;
      }
      for (const block of data.blocks) {
        for (const line of block.lines) {
          for (let word of line.words) {
            let word1: TextWord = word;
            wordsArray.push(word1);
          }
        }
      }
      callback(wordsArray, wordsArray.length);
      if(imagePixel) {
        imagePixel.release();
      }
    });
  }

  private async convertImagePixelMap(requestImage: OcrAdapterImage): Promise<image.PixelMap | undefined>  {
    let pixmap: image.PixelMap;
    if (requestImage.width === 0 || requestImage.height === 0) {
      LogUtil.warn(TAG, 'image is empty, no conversion required');
      return undefined;
    }
    let opts: image.InitializationOptions = {
      editable: OCR_IMAGE_EDITABLE,
      pixelFormat: OCR_IMAGE_PIXEL_FORMAT,
      size: {
        height: requestImage.height,
        width: requestImage.width
      }
    }
    try {
      pixmap = await image.createPixelMap(requestImage.buff, opts);
      return pixmap;
    } catch (error) {
      LogUtil.error(TAG, 'failed convert image pixel map because: ' +  JSON.stringify(error));
      return undefined;
    }
  }

}