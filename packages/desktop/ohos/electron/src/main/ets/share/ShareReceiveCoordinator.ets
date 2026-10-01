// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/*
 * 碰一碰投送接收（华为分享沙箱接收，ArkTS 侧）。
 *
 * 机制（Share Kit《分享内容直达应用界面》）：按 windowId 注册 harmonyShare
 * 'dataReceive' 能力（起始 6.0.0(20)），手机触碰本应用窗口即把文件投进应用沙箱。
 * 本类只做搬运，零业务状态：接收成功后在批次目录写 manifest.json（批次完整性的
 * 唯一事实），由 Electron main 的 desktopOhosShareInbox 监听搬运并转发 renderer
 * （specs/ohos-port/05-碰一碰投送接收.md）。
 */

import { harmonyShare, systemShare } from '@kit.ShareKit';
import { uniformTypeDescriptor as utd } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { fileIo, fileUri } from '@kit.CoreFileKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { BusinessError } from '@ohos.base';

const TAG: string = 'ShareReceive';
// 图片与通用文件（文档）各至多 9 个；类型不在声明内时系统自动回落文件管理器。
const MAX_SUPPORTED_COUNT: number = 9;

// manifest 结构与 packages/services/src/ohos/ohosShareInbox.ts 的解析严格对齐。
interface ManifestFileEntry {
  filename: string;
}

interface ShareInboxManifest {
  type: string;
  batchId: string;
  receivedAt: number;
  files: Array<ManifestFileEntry>;
}

export class ShareReceiveCoordinator {
  private static context: common.UIAbilityContext | undefined = undefined;
  private static registry: harmonyShare.RecvCapabilityRegistry | undefined = undefined;

  static register(context: common.UIAbilityContext, windowId: number): void {
    if (ShareReceiveCoordinator.registry !== undefined) {
      return;
    }
    const registry: harmonyShare.RecvCapabilityRegistry = {
      windowId: windowId,
      capabilities: [
        { utd: utd.UniformDataType.IMAGE, maxSupportedCount: MAX_SUPPORTED_COUNT },
        { utd: utd.UniformDataType.FILE, maxSupportedCount: MAX_SUPPORTED_COUNT },
      ],
    };
    ShareReceiveCoordinator.context = context;
    ShareReceiveCoordinator.registry = registry;
    harmonyShare.on('dataReceive', registry, (receivableTarget: harmonyShare.ReceivableTarget) => {
      ShareReceiveCoordinator.handleReceive(receivableTarget);
    });
    hilog.info(0x0000, TAG, 'dataReceive registered, windowId=%{public}d', windowId);
  }

  static unregister(): void {
    if (ShareReceiveCoordinator.registry === undefined) {
      return;
    }
    harmonyShare.off('dataReceive', ShareReceiveCoordinator.registry);
    ShareReceiveCoordinator.registry = undefined;
    ShareReceiveCoordinator.context = undefined;
    hilog.info(0x0000, TAG, 'dataReceive unregistered');
  }

  private static handleReceive(receivableTarget: harmonyShare.ReceivableTarget): void {
    // 回调入口日志：装机排障时确认系统是否把投送路由到本应用（曾出现触碰已检测
    // 但未路由的形态，见 specs/ohos-port/05-碰一碰投送接收.md 排障记录）。
    hilog.info(0x0000, TAG, 'dataReceive callback enter');
    const context = ShareReceiveCoordinator.context;
    if (context === undefined) {
      receivableTarget.reject(harmonyShare.ReceivableErrorCode.NO_RECEIVABLE_ERROR);
      return;
    }
    const batchId: string = `share-${Date.now()}`;
    const batchDir: string = `${context.filesDir}/share-inbox/${batchId}`;
    try {
      // 官方 26 版示例：receive 目标先落盘存在，并以 fileUri.getUriFromPath 的
      // URI 形式传入（与更早指南的裸路径写法不同，URI 形式为准）。
      fileIo.mkdirSync(batchDir, true);
    } catch (err) {
      const message = (err as BusinessError)?.message ?? JSON.stringify(err);
      hilog.warn(0x0000, TAG, 'batch %{public}s mkdir: %{public}s', batchId, message);
    }
    receivableTarget.receive(fileUri.getUriFromPath(batchDir), {
      onDataReceived: (sharedData: systemShare.SharedData): void => {
        const records: Array<systemShare.SharedRecord> = sharedData.getRecords();
        hilog.info(0x0000, TAG, 'batch %{public}s data received, records=%{public}d', batchId, records.length);
      },
      onResult: (resultCode: harmonyShare.ShareResultCode): void => {
        if (resultCode !== harmonyShare.ShareResultCode.SHARE_SUCCESS) {
          hilog.warn(0x0000, TAG, 'batch %{public}s receive failed, code=%{public}d', batchId, resultCode);
          return;
        }
        ShareReceiveCoordinator.writeManifest(batchDir, batchId);
      },
    }).catch((err: BusinessError): void => {
      hilog.error(0x0000, TAG, 'batch %{public}s receive threw: %{public}s', batchId, err.message);
    });
  }

  // manifest 清单以批次目录的**实际落盘文件**为准（readdirSync），不依赖
  // onDataReceived 回传的记录——文件已由 receive() 写入磁盘，目录即事实。
  private static writeManifest(batchDir: string, batchId: string): void {
    try {
      const filenames: Array<string> = fileIo.listFileSync(batchDir)
        .filter((name: string): boolean => name !== 'manifest.json');
      if (filenames.length === 0) {
        hilog.warn(0x0000, TAG, 'batch %{public}s manifest skipped: empty dir', batchId);
        return;
      }
      const manifest: ShareInboxManifest = {
        type: 'zcode-share-inbox-manifest',
        batchId: batchId,
        receivedAt: Date.now(),
        files: filenames.map((filename: string): ManifestFileEntry => ({ filename: filename })),
      };
      const file = fileIo.openSync(
        `${batchDir}/manifest.json`,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC,
      );
      fileIo.writeSync(file.fd, JSON.stringify(manifest));
      fileIo.closeSync(file);
      hilog.info(0x0000, TAG, 'batch %{public}s manifest written, files=%{public}d', batchId, filenames.length);
    } catch (err) {
      const message = (err as BusinessError)?.message ?? JSON.stringify(err);
      hilog.error(0x0000, TAG, 'batch %{public}s manifest write failed: %{public}s', batchId, message);
    }
  }
}
