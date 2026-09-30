// Persists DocumentViewPicker URI grants across app restarts.
//
// Picker grants are process-lifetime by default: after a cold start the app
// loses access to the picked folder (hmdfs EPERM on raw paths), which breaks
// the ZCode workspace. With ohos.permission.FILE_ACCESS_PERSIST declared we
// can persist the grant at pick time and re-activate it on every launch.
import { fileShare, fileIo } from '@kit.CoreFileKit';
import { preferences } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import LogUtil from './LogUtil';

const TAG: string = 'UriGrantHelper';
const PREFS_NAME: string = 'zcode_uri_grants';
const KEY_URIS: string = 'persisted_uris';
const LOG_FILE: string = '/uri-grant.log';

// hilog rotates away within minutes on device; mirror grant events to a file
// in the app cache so grant timing stays inspectable across restarts.
function fileLog(context: common.Context, msg: string): void {
  try {
    const path: string = context.getApplicationContext().cacheDir + LOG_FILE;
    const f = fileIo.openSync(path, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.APPEND);
    fileIo.writeSync(f.fd, new Date().toISOString() + ' ' + msg + '\n');
    fileIo.closeSync(f);
  } catch (e) {
    LogUtil.warn(TAG, 'fileLog failed');
  }
}

export class UriGrantHelper {
  private static toPolicies(uris: string[]): fileShare.PolicyInfo[] {
    return uris.map((u) => ({
      uri: u,
      operationMode: fileShare.OperationMode.READ_MODE | fileShare.OperationMode.WRITE_MODE,
    } as fileShare.PolicyInfo));
  }

  /** Persist freshly picked URIs and remember them for future activations. */
  static async persistUris(context: common.Context, uris: string[]): Promise<void> {
    if (!uris || uris.length === 0) {
      return;
    }
    try {
      // Normalize to the application context: ability contexts resolve
      // preferences/cacheDir to haps/<module>/ while the picker's context
      // resolves to the app-level dirs; read and write must use the same one.
      const appCtx: common.Context = context.getApplicationContext();
      await fileShare.persistPermission(UriGrantHelper.toPolicies(uris));
      const prefs = preferences.getPreferencesSync(appCtx, { name: PREFS_NAME });
      const saved: string[] = JSON.parse(prefs.getSync(KEY_URIS, '[]') as string) as string[];
      const merged: string[] = Array.from(new Set(saved.concat(uris)));
      prefs.putSync(KEY_URIS, JSON.stringify(merged));
      prefs.flush();
      LogUtil.info(TAG, 'persistPermission ok: ' + JSON.stringify(uris));
      fileLog(appCtx, 'persistPermission ok: ' + JSON.stringify(uris));
    } catch (e) {
      const err = e as BusinessError;
      LogUtil.error(TAG, `persistPermission failed: ${err.code} ${err.message}`);
      fileLog(context, `persistPermission failed: ${err.code} ${err.message}`);
    }
  }

  /** Re-activate all persisted grants. Call once at ability onCreate. */
  static async activateSaved(context: common.Context): Promise<void> {
    try {
      const appCtx: common.Context = context.getApplicationContext();
      const prefs = preferences.getPreferencesSync(appCtx, { name: PREFS_NAME });
      const saved: string[] = JSON.parse(prefs.getSync(KEY_URIS, '[]') as string) as string[];
      if (saved.length === 0) {
        fileLog(appCtx, 'activateSaved: nothing saved');
        return;
      }
      fileLog(appCtx, 'activateSaved: activating ' + JSON.stringify(saved));
      await fileShare.activatePermission(UriGrantHelper.toPolicies(saved));
      LogUtil.info(TAG, 'activatePermission ok: ' + JSON.stringify(saved));
      fileLog(appCtx, 'activatePermission ok: ' + JSON.stringify(saved));
    } catch (e) {
      const err = e as BusinessError;
      LogUtil.error(TAG, `activatePermission failed: ${err.code} ${err.message}`);
      fileLog(context, `activatePermission failed: ${err.code} ${err.message}`);
    }
  }
}
