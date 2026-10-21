// Copyright (c) 2025 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';

import { BaseAdapter } from '../common/BaseAdapter';
import { inject, injectable } from 'inversify';
import { ContextAdapter } from './ContextAdapter';
import { promptAction, UIContext } from '@kit.ArkUI';
import { BusinessError } from '@kit.BasicServicesKit';
import picker from '@ohos.file.picker';
import fs from '@ohos.file.fs';
import { fileUri } from '@kit.CoreFileKit';

const TAG: string = 'Dialog';
const BUTTON_COLOR: string = '#0A59F7';
const DEFAULT_DIR: string = 'file://docs/storage/Users/currentUser';
const MAX_SELECT_NUMBER: number = 500;
const ALL_FILE_DESC: string = 'All Files';

interface IMessageBoxSettings {
  parent_id: number,
  type: string,
  title: string,
  message: string,
  detail: string,
  checkbox_label: string,
  checkbox_checked: boolean,
  cancel_id: number,
  default_id: number,
  buttons: string[]
}

interface IFilter {
  name: string,
  extensions: string[]
}

interface IFileDialogSettings {
  parent_id: number,
  title: string,
  message: string,
  button_label: string,
  default_path: string,
  filters: IFilter[],
  properties_open_directory: boolean,
  properties_open_mixed: boolean,
  properties_multi_selections: boolean
}

@injectable()
export class DialogAdapter extends BaseAdapter {
  private ctxAdapter: ContextAdapter;

  constructor(@inject(ContextAdapter) ctxAdapter: ContextAdapter) {
    super();
    this.ctxAdapter = ctxAdapter;
  }

  private getUIContext(): UIContext | undefined {
    return this.ctxAdapter.getActiveProxy().getWindow()?.getUIContext();
  }

  @LogMethod
  showMessageBox(settings: string, buffer: ArrayBuffer, width: number, height: number,
    callback: (button_id: number, checkbox_checked: boolean) => void) {
    LogUtil.info(TAG, 'showMessageBox settings: ' + settings);
    let boxSettings: IMessageBoxSettings;
    try {
      boxSettings = JSON.parse(settings) as IMessageBoxSettings;
    } catch (err) {
      LogUtil.error(TAG, 'showMessageBox parse settings failed: ' + JSON.stringify(err));
      callback(0, false);
      return;
    }

    // The native side blocks on a promise waiting for exactly one callback
    // invocation; guard against double / missing responses.
    let responded = false;
    const respond = (buttonId: number): void => {
      if (responded) {
        return;
      }
      responded = true;
      callback(buttonId, false);
    };

    let cancelId: number = boxSettings.cancel_id ?? 0;
    let uiContext = this.getUIContext();
    if (!uiContext) {
      LogUtil.error(TAG, 'showMessageBox no UIContext, fallback callback');
      respond(cancelId);
      return;
    }

    let title: string = boxSettings.title ?? '';
    let message: string = boxSettings.message ?? '';
    if (boxSettings.detail && boxSettings.detail.length > 0) {
      message = message.length > 0 ? (message + '\n' + boxSettings.detail) : boxSettings.detail;
    }

    let srcButtons: string[] = boxSettings.buttons ?? [];
    if (srcButtons.length === 0) {
      srcButtons = ['OK'];
    }
    let buttons: Array<promptAction.Button> = srcButtons.map((text: string): promptAction.Button => {
      return { text: text, color: BUTTON_COLOR };
    });

    try {
      uiContext.getPromptAction().showDialog({
        title: title,
        message: message,
        buttons: buttons
      }).then((data: promptAction.ShowDialogSuccessResponse) => {
        respond(data.index);
      }).catch((err: BusinessError) => {
        // Dismissed via back / outside tap.
        LogUtil.info(TAG, 'showMessageBox dismissed: ' + JSON.stringify(err));
        respond(cancelId);
      });
    } catch (err) {
      LogUtil.error(TAG, 'showMessageBox showDialog failed: ' + JSON.stringify(err));
      respond(cancelId);
    }
  }

  @LogMethod
  showErrorBox(title: string, content: string, callback: (result: boolean) => void) {
    let responded = false;
    const respond = (): void => {
      if (responded) {
        return;
      }
      responded = true;
      callback(true);
    };

    let uiContext = this.getUIContext();
    if (!uiContext) {
      LogUtil.error(TAG, 'showErrorBox no UIContext, fallback callback');
      respond();
      return;
    }

    let buttons: Array<promptAction.Button> = [{ text: 'OK', color: BUTTON_COLOR }];
    try {
      uiContext.getPromptAction().showDialog({
        title: title,
        message: content,
        buttons: buttons
      }).then(() => {
        respond();
      }).catch((err: BusinessError) => {
        LogUtil.info(TAG, 'showErrorBox dismissed: ' + JSON.stringify(err));
        respond();
      });
    } catch (err) {
      LogUtil.error(TAG, 'showErrorBox showDialog failed: ' + JSON.stringify(err));
      respond();
    }
  }

  // CPM6218:下载/上传需要文件选择器。经 DocumentViewPicker 实现"打开/另存为"。
  @LogMethod
  showOpenDialog(settings: string, callback: (filePaths: string[], canceled: boolean) => void) {
    let dialogSettings: IFileDialogSettings;
    try {
      dialogSettings = JSON.parse(settings) as IFileDialogSettings;
    } catch (err) {
      LogUtil.error(TAG, 'showOpenDialog parse settings failed: ' + JSON.stringify(err));
      callback([], true);
      return;
    }

    let options = new picker.DocumentSelectOptions();
    if (dialogSettings.properties_open_directory) {
      options.selectMode = picker.DocumentSelectMode.FOLDER;
      if (dialogSettings.properties_open_mixed) {
        options.selectMode = picker.DocumentSelectMode.MIXED;
      }
    }
    if (dialogSettings.properties_multi_selections) {
      options.maxSelectNumber = MAX_SELECT_NUMBER;
    }
    if (dialogSettings.filters && dialogSettings.filters.length > 0) {
      options.fileSuffixFilters = this.getFilterArray(dialogSettings.filters);
    } else {
      options.fileSuffixFilters = [ALL_FILE_DESC + '|.*'];
    }
    let dirAndFile: string[] = this.handleDefaultPath(dialogSettings.default_path);
    options.defaultFilePathUri = dirAndFile[0];

    try {
      let documentPicker = new picker.DocumentViewPicker();
      documentPicker.select(options).then((result: Array<string>) => {
        if (!result || result.length === 0) {
          callback([], true);
        } else {
          callback(result, false);
        }
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, 'showOpenDialog select failed: ' + JSON.stringify(err));
        callback([], true);
      });
    } catch (err) {
      LogUtil.error(TAG, 'showOpenDialog failed: ' + JSON.stringify(err));
      callback([], true);
    }
  }

  @LogMethod
  showSaveDialog(settings: string, callback: (filePath: string, canceled: boolean) => void) {
    let dialogSettings: IFileDialogSettings;
    try {
      dialogSettings = JSON.parse(settings) as IFileDialogSettings;
    } catch (err) {
      LogUtil.error(TAG, 'showSaveDialog parse settings failed: ' + JSON.stringify(err));
      callback('', true);
      return;
    }

    let options = new picker.DocumentSaveOptions();
    let dirAndFile: string[] = this.handleDefaultPath(dialogSettings.default_path);
    options.defaultFilePathUri = dirAndFile[0];
    if (dirAndFile[1].length > 0) {
      options.newFileNames = [dirAndFile[1]];
    }
    if (dialogSettings.filters && dialogSettings.filters.length > 0) {
      options.fileSuffixChoices = this.getFilterArray(dialogSettings.filters);
    } else {
      options.fileSuffixChoices = [ALL_FILE_DESC + '|.*'];
    }

    try {
      let documentPicker = new picker.DocumentViewPicker();
      documentPicker.save(options).then((result: Array<string>) => {
        if (!result || result.length === 0) {
          callback('', true);
        } else {
          callback(result[0], false);
        }
      }).catch((err: BusinessError) => {
        LogUtil.error(TAG, 'showSaveDialog save failed: ' + JSON.stringify(err));
        callback('', true);
      });
    } catch (err) {
      LogUtil.error(TAG, 'showSaveDialog failed: ' + JSON.stringify(err));
      callback('', true);
    }
  }

  // 把 default_path 拆成 [目录URI, 文件名],供 picker 作默认位置/默认文件名。
  private handleDefaultPath(default_path: string): string[] {
    let dirAndFile: string[] = [DEFAULT_DIR, ''];
    if (!default_path || default_path.length === 0) {
      return dirAndFile;
    }
    try {
      const uriPrefix: string = 'file://docs';
      let pathOrUri: string = default_path.trim();
      let isFileUri: boolean = pathOrUri.startsWith(uriPrefix + '/');
      let path: string = pathOrUri;
      let uri: string = pathOrUri;
      if (isFileUri) {
        // Picker URIs percent-encode Chinese and special characters. Convert
        // only the path used for filesystem checks and filename display.
        path = decodeURIComponent(pathOrUri.slice(uriPrefix.length));
      } else {
        uri = fileUri.getUriFromPath(path);
      }
      let exist = fs.accessSync(path);
      let fileNameIndex: number = path.lastIndexOf('/');
      let fileUriIndex: number = uri.lastIndexOf('/');
      let dirPath: string = path.slice(0, fileNameIndex);
      let dirUri: string = uri.slice(0, fileUriIndex);
      let fileName: string = path.slice(fileNameIndex + 1);
      if (!exist) {
        if (fs.accessSync(dirPath)) {
          dirAndFile[0] = dirUri;
        }
        dirAndFile[1] = fileName;
      } else {
        let stat = fs.statSync(path);
        if (stat.isDirectory()) {
          dirAndFile[0] = uri;
        } else if (stat.isFile()) {
          dirAndFile[0] = dirUri;
          dirAndFile[1] = fileName;
        }
      }
    } catch (err) {
      LogUtil.error(TAG, 'handleDefaultPath failed: ' + JSON.stringify(err));
    }
    return dirAndFile;
  }

  private getFilterArray(filters: IFilter[]): Array<string> {
    let copy = new Array<string>();
    for (const filter of filters) {
      copy.push(filter.name + '(*.' + filter.extensions.join(';*.') + ')|.' + filter.extensions.join(',.'));
    }
    return copy;
  }
}
