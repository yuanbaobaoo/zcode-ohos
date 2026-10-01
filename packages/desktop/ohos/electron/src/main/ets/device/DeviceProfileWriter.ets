/*
 * 设备画像写入（模拟器判定唯一事实源，specs/ohos-port/06）：主页面 aboutToAppear
 * 同步写 device-profile.json（早于 XComponent 构建 → 早于 electron main 读取），
 * 供 main 决策是否降级 SwiftShader 软件渲染。写失败只告警：main 读不到按真机处理。
 */
import deviceInfo from '@ohos.deviceInfo';
import fileIo from '@ohos.file.fs';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@ohos.base';
import { hilog } from '@kit.PerformanceAnalysisKit';

const TAG: string = 'DeviceProfileWriter';
const PROFILE_FILENAME: string = 'device-profile.json';

interface DeviceProfile {
  type: string,
  productModel: string,
  hardwareModel: string,
  deviceType: string,
  writtenAt: number
}

export class DeviceProfileWriter {
  static write(context: common.UIAbilityContext): void {
    const profile: DeviceProfile = {
      type: 'zcode-ohos-device-profile',
      productModel: deviceInfo.productModel,
      hardwareModel: deviceInfo.hardwareModel,
      deviceType: deviceInfo.deviceType,
      writtenAt: Date.now()
    };
    const path: string = `${context.filesDir}/${PROFILE_FILENAME}`;
    try {
      const file = fileIo.openSync(
        path,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC
      );
      fileIo.writeSync(file.fd, JSON.stringify(profile));
      fileIo.closeSync(file);
      hilog.info(0x0000, TAG, 'profile written, productModel=%{public}s', deviceInfo.productModel);
    } catch (err) {
      const message = (err as BusinessError)?.message ?? JSON.stringify(err);
      hilog.error(0x0000, TAG, 'profile write failed: %{public}s', message);
    }
  }
}
