// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// OHOS Computer Use 的 ArkTS 执行端（spec 13）：文件桥服务 + inputEventClient 注入。
// 语义（14 工具映射、键表、op 编排）在 packages/zcode-cua/ohos-computer-use.js；
// 本文件只按白名单解释 op 列表，保持薄解释器，不承载业务判断。
import { inputEventClient, Button, Axis, KeyCode } from '@kit.InputKit';
import { screenshot } from '@kit.ArkUI';
import { image } from '@kit.ImageKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { abilityAccessCtrl, bundleManager, common, Permissions } from '@kit.AbilityKit';
import { BusinessError } from '@ohos.base';
import { hilog } from '@kit.PerformanceAnalysisKit';
import fs from '@ohos.file.fs';
import util from '@ohos.util';

const TAG: string = 'ComputerControl';
const BRIDGE_DIR_NAME: string = 'computer-control';
const TOKEN_FILENAME: string = 'token.json';
const STATUS_FILENAME: string = 'status.json';
const PERMISSION_REQUEST_FILENAME: string = 'permission.request';
// 截屏产物目录（spec 15 M3）。
const SHOTS_DIR_NAME: string = 'shots';
const SCREENSHOT_JPEG_QUALITY: number = 80;
// 录屏（帧流，spec 15 M4）：CUSTOM_SCREEN_RECORDING 是 manual_settings+system_basic，
// 三方无法弹窗授权；因此录屏用公开截屏 API 的连续帧实现，只依赖截屏权限。
const RECORDINGS_DIR_NAME: string = 'recordings';
const RECORD_FPS_MIN: number = 1;
const RECORD_FPS_MAX: number = 5;
const RECORD_MAX_FRAMES_DEFAULT: number = 300;
const CMD_PREFIX: string = 'cmd-';
const ACK_PREFIX: string = 'ack-';
// 桥轮询间隔：注入延迟上限（Node 侧 25ms 轮询 ack，端到端 ~2 个间隔）。
const POLL_INTERVAL_MS: number = 50;
// 权限轮询间隔：设置页门控的状态回流上限（spec 08 全盘文件同款常驻轮询范式）。
const PERMISSION_POLL_INTERVAL_MS: number = 1000;
const CONTROL_DEVICE_PERMISSION: Permissions = 'ohos.permission.CONTROL_DEVICE';
// 屏幕捕获（spec 15 M3）：AVScreenCapture 的自定义录制要求该 user_grant 权限；缺失时取帧
// 调用永不返回（系统日志 Verify custom screen recording failed）。
const SCREEN_CAPTURE_PERMISSION: Permissions = 'ohos.permission.CUSTOM_SCREEN_CAPTURE';
// 拉起应用时的默认 entry ability（鸿蒙应用约定；可用 launch 参数覆盖）。
const DEFAULT_LAUNCH_ABILITY: string = 'EntryAbility';

// Node 侧 ohos-computer-use.js 编排的 op；字段按 op 类型部分使用。
interface ControlOp {
  op?: string;
  x?: number;
  y?: number;
  button?: number;
  axis?: string;
  value?: number;
  key?: string;
  text?: string;
  ms?: number;
}

interface BridgeCommand {
  id?: string;
  token?: string;
  type?: string;
  args?: Record<string, Object>;
}

interface BridgeAckOk {
  id: string;
  ok: boolean;
  data: Object;
}

interface BridgeAckErr {
  id: string;
  ok: boolean;
  error: BridgeAckError;
}

interface ExecResult {
  done: boolean;
}

interface AppEntry {
  bundle_id: string;
  name: string;
}

interface AppListResult {
  apps: AppEntry[];
  enumeration: string;
  reason: string;
}

interface RecordSession {
  id: string;
  dir: string;
  fps: number;
  maxFrames: number;
  frames: number;
  bytes: number;
  startedAt: number;
  timer: number;
  capturing: boolean;
}

interface RecordResult {
  sessionId: string;
  dir: string;
  frames: number;
  bytes: number;
  durationMs: number;
}

interface ShotResult {
  path: string;
  bytes: number;
  width: number;
  height: number;
  provider: string;
}

interface LaunchResult {
  bundleName: string;
  ability: string;
  launched: boolean;
}

interface TokenFile {
  token: string;
  updatedAt: number;
}

interface BridgeAckError {
  message: string;
  code: string;
}

// 「电脑控制」聚合门禁：辅助操作 + 截屏两个权限全部授予才允许开启（spec 13/15）。
// 录屏走截屏 API 的连续帧，不再需要 CUSTOM_SCREEN_RECORDING（2026-11-05 定论）。
interface ControlPermissions {
  controlDevice: boolean;
  screenCapture: boolean;
}

interface ControlStatus {
  apiAvailable: boolean;
  permission: string;
  permissions: ControlPermissions;
  bridgeAlive: boolean;
  capture: string;
  updatedAt: number;
}

// 基键名 → 键码数值。别名/大小写/shift 组合由 Node 侧归一，这里只收基键；
// 用数值表规避 ArkTS 对枚举算术的限制，使用点统一 as KeyCode。
const KEY_TABLE: Record<string, number> = {
  'enter': KeyCode.KEYCODE_ENTER as number,
  'escape': KeyCode.KEYCODE_ESCAPE as number,
  'tab': KeyCode.KEYCODE_TAB as number,
  'backspace': KeyCode.KEYCODE_DEL as number,
  'delete': KeyCode.KEYCODE_FORWARD_DEL as number,
  'space': KeyCode.KEYCODE_SPACE as number,
  'dpad_up': KeyCode.KEYCODE_DPAD_UP as number,
  'dpad_down': KeyCode.KEYCODE_DPAD_DOWN as number,
  'dpad_left': KeyCode.KEYCODE_DPAD_LEFT as number,
  'dpad_right': KeyCode.KEYCODE_DPAD_RIGHT as number,
  'move_home': KeyCode.KEYCODE_MOVE_HOME as number,
  'move_end': KeyCode.KEYCODE_MOVE_END as number,
  'page_up': KeyCode.KEYCODE_PAGE_UP as number,
  'page_down': KeyCode.KEYCODE_PAGE_DOWN as number,
  'ctrl_left': KeyCode.KEYCODE_CTRL_LEFT as number,
  'alt_left': KeyCode.KEYCODE_ALT_LEFT as number,
  'shift_left': KeyCode.KEYCODE_SHIFT_LEFT as number,
  'meta_left': KeyCode.KEYCODE_META_LEFT as number,
  '-': KeyCode.KEYCODE_MINUS as number,
  '=': KeyCode.KEYCODE_EQUALS as number,
  '[': KeyCode.KEYCODE_LEFT_BRACKET as number,
  ']': KeyCode.KEYCODE_RIGHT_BRACKET as number,
  '\\': KeyCode.KEYCODE_BACKSLASH as number,
  ';': KeyCode.KEYCODE_SEMICOLON as number,
  "'": KeyCode.KEYCODE_APOSTROPHE as number,
  ',': KeyCode.KEYCODE_COMMA as number,
  '.': KeyCode.KEYCODE_PERIOD as number,
  '/': KeyCode.KEYCODE_SLASH as number,
  '`': KeyCode.KEYCODE_GRAVE as number,
  'a': KeyCode.KEYCODE_A as number,
  'b': KeyCode.KEYCODE_B as number,
  'c': KeyCode.KEYCODE_C as number,
  'd': KeyCode.KEYCODE_D as number,
  'e': KeyCode.KEYCODE_E as number,
  'f': KeyCode.KEYCODE_F as number,
  'g': KeyCode.KEYCODE_G as number,
  'h': KeyCode.KEYCODE_H as number,
  'i': KeyCode.KEYCODE_I as number,
  'j': KeyCode.KEYCODE_J as number,
  'k': KeyCode.KEYCODE_K as number,
  'l': KeyCode.KEYCODE_L as number,
  'm': KeyCode.KEYCODE_M as number,
  'n': KeyCode.KEYCODE_N as number,
  'o': KeyCode.KEYCODE_O as number,
  'p': KeyCode.KEYCODE_P as number,
  'q': KeyCode.KEYCODE_Q as number,
  'r': KeyCode.KEYCODE_R as number,
  's': KeyCode.KEYCODE_S as number,
  't': KeyCode.KEYCODE_T as number,
  'u': KeyCode.KEYCODE_U as number,
  'v': KeyCode.KEYCODE_V as number,
  'w': KeyCode.KEYCODE_W as number,
  'x': KeyCode.KEYCODE_X as number,
  'y': KeyCode.KEYCODE_Y as number,
  'z': KeyCode.KEYCODE_Z as number,
  '0': KeyCode.KEYCODE_0 as number,
  '1': KeyCode.KEYCODE_1 as number,
  '2': KeyCode.KEYCODE_2 as number,
  '3': KeyCode.KEYCODE_3 as number,
  '4': KeyCode.KEYCODE_4 as number,
  '5': KeyCode.KEYCODE_5 as number,
  '6': KeyCode.KEYCODE_6 as number,
  '7': KeyCode.KEYCODE_7 as number,
  '8': KeyCode.KEYCODE_8 as number,
  '9': KeyCode.KEYCODE_9 as number,
};

// ArkTS 限制 throw 只能是 Error 实例：桥内错误统一用带 code 的 Error 子类。
class ControlError extends Error {
  readonly errorCode: number;

  constructor(code: number, message: string) {
    super(message);
    this.errorCode = code;
  }
}

function fail(code: number, message: string): ControlError {
  return new ControlError(code, message);
}

function buttonOf(value: number): Button {
  if (value === 1) {
    return Button.MIDDLE;
  }
  if (value === 2) {
    return Button.RIGHT;
  }
  return Button.LEFT;
}

function axisOf(value: string): Axis {
  if (value === 'horizontal') {
    return Axis.SCROLL_HORIZONTAL;
  }
  return Axis.SCROLL_VERTICAL;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export class ComputerControlService {
  private static readonly instance: ComputerControlService = new ComputerControlService();

  static getInstance(): ComputerControlService {
    return ComputerControlService.instance;
  }

  private bridgeDir: string = '';
  private token: string = '';
  private pollTimer: number = -1;
  // 单飞行：50ms tick 会重叠，重入会让两条命令的按键事件交错（真机实证 4300001）。
  private consuming: boolean = false;
  private permissionTimer: number = -1;
  private mouse: inputEventClient.MouseController | undefined = undefined;
  private keyboard: inputEventClient.KeyboardController | undefined = undefined;
  private status: ControlStatus = {
    apiAvailable: false,
    permission: 'unknown',
    permissions: { controlDevice: false, screenCapture: false },
    bridgeAlive: false,
    capture: 'unsupported',
    updatedAt: 0,
  };

  async init(context: common.Context): Promise<void> {
    this.bridgeDir = `${context.filesDir}/${BRIDGE_DIR_NAME}`;
    this.setContext(context);
    try {
      if (!fs.accessSync(this.bridgeDir)) {
        fs.mkdirSync(this.bridgeDir);
      }
      this.cleanStaleBridgeFiles();
      this.token = util.generateRandomUUID();
      const tokenFile: TokenFile = { token: this.token, updatedAt: Date.now() };
      this.writeText(`${this.bridgeDir}/${TOKEN_FILENAME}`, `${JSON.stringify(tokenFile)}\n`);
      this.status.apiAvailable = this.probeApiAvailable();
      // 启动即写一次聚合权限快照（key 用于首帧 UI 不出现"未知"态），但不触发任何授权弹窗。
      const initialPermissions = this.probePermissions();
      this.status.permissions = initialPermissions;
      this.status.permission =
        initialPermissions.controlDevice && initialPermissions.screenCapture ? 'granted' : 'needs-grant';
      this.startPolling();
      this.startPermissionPoll();
      this.checkScreenCapturePermission();
      this.status.bridgeAlive = true;
      this.flushStatus();
      hilog.info(0x0000, TAG, 'bridge ready: api=%{public}s permission=%{public}s',
        `${this.status.apiAvailable}`, this.status.permission);
      // 授权触发收敛到设置页请求文件（spec 13 M2）；启动期不再自动弹授权（spec 08 裁定）。
      if (this.status.apiAvailable && this.status.permission === 'granted') {
        this.warmUpControllers();
      }
    } catch (err) {
      hilog.error(0x0000, TAG, 'init failed: %{public}s', JSON.stringify(err));
    }
  }

  dispose(): void {
    if (this.pollTimer !== -1) {
      clearInterval(this.pollTimer);
      this.pollTimer = -1;
    }
    if (this.permissionTimer !== -1) {
      clearInterval(this.permissionTimer);
      this.permissionTimer = -1;
    }
    if (this.bridgeDir === '') {
      return;
    }
    this.status.bridgeAlive = false;
    this.flushStatus();
  }

  // ————————————————————————— 桥轮询 —————————————————————————

  private startPolling(): void {
    // 单飞行：每 tick 至多消费一条命令，天然串行（spec 13 D2）。
    this.pollTimer = setInterval(() => {
      this.consumeOneCommand().catch((err: BusinessError) => {
        hilog.warn(0x0000, TAG, 'bridge command failed: %{public}s', JSON.stringify(err));
      });
    }, POLL_INTERVAL_MS);
  }

  private async consumeOneCommand(): Promise<void> {
    if (this.consuming) {
      return;
    }
    this.consuming = true;
    try {
      await this.consumeNextCommand();
    } finally {
      this.consuming = false;
    }
  }

  private async consumeNextCommand(): Promise<void> {
    const names = fs.listFileSync(this.bridgeDir).sort();
    const cmdName = names.find((name) => name.startsWith(CMD_PREFIX) && name.endsWith('.json'));
    if (cmdName === undefined) {
      return;
    }
    const cmdPath = `${this.bridgeDir}/${cmdName}`;
    let command: BridgeCommand | undefined = undefined;
    try {
      command = JSON.parse(fs.readTextSync(cmdPath)) as BridgeCommand;
    } catch (err) {
      const id = cmdName.slice(CMD_PREFIX.length).replace(/\.json$/, '');
      const detail: BridgeAckError = {
        message: `malformed command: ${JSON.stringify(err)}`,
        code: 'invalid_request',
      };
      this.writeAck(id, false, detail);
      this.unlinkQuietly(cmdPath);
      return;
    }
    if (command.token !== this.token) {
      // 伪造/过期 token：拒绝且不留任何副作用（spec 13 D6）。
      hilog.warn(0x0000, TAG, 'bridge token mismatch, command refused');
      this.unlinkQuietly(cmdPath);
      return;
    }
    try {
      const data = await this.dispatch(command);
      this.writeAck(command.id ?? '', true, data);
    } catch (err) {
      const error = err as Error;
      const detail: BridgeAckError = {
        message: `${error.message ?? JSON.stringify(err)}`.trim(),
        code: this.errorCodeOf(error),
      };
      this.writeAck(command.id ?? '', false, detail);
    } finally {
      this.unlinkQuietly(cmdPath);
    }
  }

  private async dispatch(command: BridgeCommand): Promise<Object> {
    // 诊断用：桥收到什么命令（type 不含参数值，无敏感内容）。spec 15 M3 排查时曾因缺少
    // 这一行无法区分"模型没传 app 引用"与"桥没收到 launch"，故常驻。
    hilog.info(0x0000, TAG, 'bridge command: type=%{public}s', command.type ?? '(none)');
    if (command.type === 'record_start') {
      return this.startRecording(command.args);
    }
    if (command.type === 'record_stop') {
      return this.stopRecording();
    }
    if (command.type === 'screenshot') {
      // 鸿蒙公开截屏 API（@ohos.screenshot，spec 15 M3+）：要求 CUSTOM_SCREEN_CAPTURE。
      // 不走 AVScreenCapture「自定义录屏」——那条在本厂商端口被系统拒绝（真机实证）。
      return await this.captureScreen(command.args);
    }
    if (command.type === 'list_apps') {
      return this.listApps();
    }
    if (command.type === 'launch') {
      return await this.launchApp(command.args);
    }
    if (command.type !== 'exec') {
      throw fail(999999, `unknown command type: ${command.type ?? '(none)'}`);
    }
    const ops = (command.args?.['ops'] as Object[] | undefined) ?? [];
    for (const rawOp of ops) {
      const op = rawOp as ControlOp;
      await this.runOp(op);
    }
    const result: ExecResult = { done: true };
    return result;
  }

  // ————————————————————————— 应用拉起（spec 15） —————————————————————————

  // 枚举已安装应用**不可行**：bundleManager.getAllBundleInfo / queryAbilityInfo 在公开 SDK 里
  // 不存在（后者还需要 ohos.permission.GET_ABILITY_INFO 系统权限）。所以这里如实报"不支持"，
  // 由 Node 侧回落桌面模型并提示用 `ohos_hdc shell "bm dump -a"` 查 bundle 名 —— 不编造列表。
  private listApps(): Object {
    const result: AppListResult = {
      apps: [],
      enumeration: 'unsupported',
      reason: 'public bundle API cannot enumerate installed apps; query bundle names via ohos_hdc shell "bm dump -a"',
    };
    return result;
  }

  // 拉起语义与上游一致：get_app_state 的透明拉起。
  // 用 launcher want（action=home + entity.system.home）而不是只给 bundleName：后者缺
  // action/abilityName 会以 16000001「ability not found」失败；也不做 getBundleInfo 预检——
  // 跨应用查询 bundle 信息需要特权权限，预检会把存在的应用误判成"不存在"（真机实证）。
  private async launchApp(args: Record<string, Object> | undefined): Promise<Object> {
    const bundleName = args?.['bundleName'];
    const target = typeof bundleName === 'string' ? bundleName.trim() : '';
    if (target.length === 0) {
      throw fail(999999, 'launch needs bundleName');
    }
    const ctx = this.contextForPermission;
    if (ctx === undefined) {
      throw fail(801, 'ability context unavailable');
    }
    const abilityArg = args?.['ability'];
    const ability = typeof abilityArg === 'string' && abilityArg.trim().length > 0
      ? abilityArg.trim()
      : DEFAULT_LAUNCH_ABILITY;
    // 真机实证（spec 15 M3，2026-11-05）：显式 abilityName 的 startAbility 能拉起目标应用
    // （QQ 进程实测出现）。必须用 startAbility 而不是 startAbilityForResult —— 后者要等目标
    // ability 返回结果才 resolve，拉起类调用会一直挂住（自检实测 20s+ 无 resolved 日志）。
    hilog.info(0x0000, TAG, 'launch request: %{public}s/%{public}s', target, ability);
    try {
      await (ctx as common.UIAbilityContext).startAbility({
        bundleName: target,
        abilityName: ability,
      });
      hilog.info(0x0000, TAG, 'launch dispatched: %{public}s', target);
    } catch (err) {
      const be = err as BusinessError<void>;
      hilog.error(0x0000, TAG, 'launch rejected: code=%{public}d msg=%{public}s',
        be.code ?? -1, `${be.message ?? JSON.stringify(err)}`);
      throw fail(be.code ?? 999999, `startAbility failed for ${target}: ${JSON.stringify(err)}`);
    }
    const ack: LaunchResult = { bundleName: target, ability, launched: true };
    return ack;
  }

  // ————————————————————————— 自检（spec 15 M3） —————————————————————————

  /** 录屏自检：录 3 秒后停止并落 hilog（`--ps zcode.selftest record`）。 */
  async runRecordSelfTest(): Promise<void> {
    try {
      const started = this.startRecording({ 'fps': 2 });
      hilog.info(0x0000, TAG, 'selftest record started: %{public}s', JSON.stringify(started));
      await new Promise<void>((resolve) => setTimeout(resolve, 3000));
      const result = this.stopRecording();
      hilog.info(0x0000, TAG, 'selftest record ok: %{public}s', JSON.stringify(result));
    } catch (err) {
      hilog.error(0x0000, TAG, 'selftest record failed: %{public}s', JSON.stringify(err));
    }
  }

  /** 截屏自检：直接走生产截屏路径并落 hilog（`--ps zcode.selftest screenshot`）。 */
  async runScreenshotSelfTest(): Promise<void> {
    try {
      const result = await this.captureScreen({ 'displayId': 0 });
      hilog.info(0x0000, TAG, 'selftest screenshot ok: %{public}s', JSON.stringify(result));
    } catch (err) {
      hilog.error(0x0000, TAG, 'selftest screenshot failed: %{public}s', JSON.stringify(err));
    }
  }

  /** 直接调用拉起路径并落 hilog（宿主可用 `aa start --ps zcode.selftest launch:<bundle>` 触发）。 */
  async runLaunchSelfTest(bundleName: string): Promise<void> {
    const args: Record<string, Object> = { 'bundleName': bundleName };
    try {
      const result = await this.launchApp(args);
      hilog.info(0x0000, TAG, 'selftest launch ok: %{public}s', JSON.stringify(result));
    } catch (err) {
      hilog.error(0x0000, TAG, 'selftest launch failed: %{public}s', JSON.stringify(err));
    }
  }

  // ————————————————————————— 授权自检（spec 15 M4） —————————————————————————

  // 验证两条授权路径：截屏走系统弹窗（user_grant）；辅助操作走设置页（manual_settings）。
  async runPermissionSelfTest(): Promise<void> {
    const ctx = this.contextForPermission;
    if (ctx === undefined) {
      hilog.error(0x0000, TAG, 'selftest perm: no ability context');
      return;
    }
    const atManager = abilityAccessCtrl.createAtManager();
    try {
      const captureResult = await atManager.requestPermissionsFromUser(
        ctx as common.UIAbilityContext, [SCREEN_CAPTURE_PERMISSION]);
      hilog.info(0x0000, TAG, 'selftest perm capture authResults=%{public}s',
        JSON.stringify(captureResult.authResults));
    } catch (err) {
      hilog.error(0x0000, TAG, 'selftest perm capture request failed: %{public}s', JSON.stringify(err));
    }
    // manual_settings 正确入口是 openPermissionOnSetting（API 22+，直接打开该权限的设置页）；
    // requestPermissionOnSetting 只收 user_grant，传 manual_settings 必报 12100014（SDK 契约）。
    this.openPermissionPanel(ctx);
    hilog.info(0x0000, TAG, 'selftest perm: control settings page dispatched');
  }

  // 只为自检：跳到应用信息设置页（manual_settings 权限只能这样授权）。
  async runControlPermissionSelfTest(): Promise<void> {
    this.openAppSettingsPage('computer control (manual_settings)');
  }

  // ————————————————————————— 录屏（帧流，spec 15 M4） —————————————————————————

  // 为什么是帧流：录屏权限 CUSTOM_SCREEN_RECORDING 为 manual_settings + system_basic，
  // 平台不允许三方应用弹窗授权（真机 requestPermissionsFromUser=2、requestPermissionOnSetting=12100014）。
  // 截屏 API 的连续帧能覆盖"看屏幕变化"的产品诉求，且只需 CUSTOM_SCREEN_CAPTURE（可弹窗）。
  private startRecording(args: Record<string, Object> | undefined): Object {
    if (this.recordSession !== undefined) {
      throw fail(999999, `a recording is already running: ${this.recordSession.id}`);
    }
    const fpsArg = args?.['fps'];
    const maxArg = args?.['maxFrames'];
    const fps = typeof fpsArg === 'number'
      ? Math.min(RECORD_FPS_MAX, Math.max(RECORD_FPS_MIN, Math.round(fpsArg))) : 2;
    const maxFrames = typeof maxArg === 'number'
      ? Math.max(1, Math.round(maxArg)) : RECORD_MAX_FRAMES_DEFAULT;
    const id = `rec-${Date.now()}`;
    const dir = `${this.bridgeDir}/${RECORDINGS_DIR_NAME}/${id}`;
    try {
      fs.mkdirSync(dir, true);
    } catch (err) {
      throw fail(999999, `cannot create recording dir: ${JSON.stringify(err)}`);
    }
    const session: RecordSession = {
      id, dir, fps, maxFrames, frames: 0, bytes: 0, startedAt: Date.now(), timer: -1, capturing: false,
    };
    session.timer = setInterval((): void => {
      void this.captureRecordFrame(session);
    }, Math.round(1000 / fps));
    this.recordSession = session;
    hilog.info(0x0000, TAG, 'record started: %{public}s fps=%{public}d', id, fps);
    const started: RecordResult = { sessionId: id, dir, frames: 0, bytes: 0, durationMs: 0 };
    return started;
  }

  private async captureRecordFrame(session: RecordSession): Promise<void> {
    if (session.capturing || session.frames >= session.maxFrames) {
      return;
    }
    session.capturing = true;
    let pixelMap: image.PixelMap | undefined;
    try {
      pixelMap = await screenshot.capture({ displayId: 0 });
      const packer: image.ImagePacker = image.createImagePacker();
      const buffer: ArrayBuffer = await packer.packing(pixelMap, {
        format: 'image/jpeg', quality: SCREENSHOT_JPEG_QUALITY,
      });
      const framePath = `${session.dir}/frame-${String(session.frames).padStart(4, '0')}.jpeg`;
      const file = fs.openSync(framePath, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(file.fd, buffer);
      } finally {
        fs.closeSync(file);
      }
      session.frames += 1;
      session.bytes += buffer.byteLength;
    } catch (err) {
      hilog.warn(0x0000, TAG, 'record frame failed: %{public}s', JSON.stringify(err));
    } finally {
      session.capturing = false;
      if (pixelMap !== undefined) {
        try {
          await pixelMap.release();
        } catch (err) {
          // 释放失败不影响已写入的帧
        }
      }
    }
  }

  private stopRecording(): Object {
    const session = this.recordSession;
    if (session === undefined) {
      throw fail(999999, 'no recording is running');
    }
    this.recordSession = undefined;
    clearInterval(session.timer);
    const result: RecordResult = {
      sessionId: session.id,
      dir: session.dir,
      frames: session.frames,
      bytes: session.bytes,
      durationMs: Date.now() - session.startedAt,
    };
    hilog.info(0x0000, TAG, 'record stopped: %{public}s frames=%{public}d bytes=%{public}d',
      result.sessionId, result.frames, result.bytes);
    return result;
  }

  // ————————————————————————— 截屏（spec 15 M3+） —————————————————————————

  // 用鸿蒙公开截屏 API 抓整屏并编码 JPEG 落盘到桥目录；失败按 BusinessError 码回传。
  // 权限：ohos.permission.CUSTOM_SCREEN_CAPTURE（user_grant / normal，module.json5 已声明）。
  private async captureScreen(args: Record<string, Object> | undefined): Promise<Object> {
    const displayArg = args?.['displayId'];
    const option: screenshot.CaptureOption = {
      displayId: typeof displayArg === 'number' ? displayArg : 0,
    };
    let pixelMap: image.PixelMap | undefined;
    try {
      pixelMap = await screenshot.capture(option);
      const packer: image.ImagePacker = image.createImagePacker();
      const buffer: ArrayBuffer = await packer.packing(pixelMap, {
        format: 'image/jpeg',
        quality: SCREENSHOT_JPEG_QUALITY,
      });
      const info = await pixelMap.getImageInfo();
      const shotsDir = `${this.bridgeDir}/${SHOTS_DIR_NAME}`;
      try {
        fs.mkdirSync(shotsDir, true);
      } catch (err) {
        // 目录已存在属预期
      }
      const shotPath = `${shotsDir}/shot-${Date.now()}.jpeg`;
      const file = fs.openSync(shotPath, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(file.fd, buffer);
      } finally {
        fs.closeSync(file);
      }
      const result: ShotResult = {
        path: shotPath,
        bytes: buffer.byteLength,
        width: info.size.width,
        height: info.size.height,
        provider: 'arkts-screenshot',
      };
      hilog.info(0x0000, TAG, 'screenshot ok: %{public}dx%{public}d %{public}d bytes',
        result.width, result.height, result.bytes);
      return result;
    } catch (err) {
      const be = err as BusinessError<void>;
      hilog.error(0x0000, TAG, 'screenshot failed: code=%{public}d msg=%{public}s',
        be.code ?? -1, `${be.message ?? JSON.stringify(err)}`);
      // 201 = 权限未授予：把用户引导到系统设置（requestPermissionsFromUser 在 PC 上会秒拒）。
      if (be.code === 201) {
        this.openScreenCaptureSetting();
      }
      throw fail(be.code ?? 999999, `screenshot failed: ${JSON.stringify(err)}`);
    } finally {
      if (pixelMap !== undefined) {
        try {
          await pixelMap.release();
        } catch (err) {
          // 释放失败不影响已落盘的结果
        }
      }
    }
  }

  // manual_settings 权限（电脑控制/录屏）在本运行时无法用 requestPermissionOnSetting 打开
  // （恒 12100014，真机实证），与全盘访问同一范式：跳应用信息设置页，用户手动开启。
  openAppSettingsPage(reason: string): void {
    const ctx = this.contextForPermission;
    if (ctx === undefined) {
      return;
    }
    hilog.info(0x0000, TAG, 'opening app settings for: %{public}s', reason);
    (ctx as common.UIAbilityContext).startAbility({
      bundleName: 'com.huawei.hmos.settings',
      abilityName: 'com.huawei.hmos.settings.MainAbility',
      uri: 'application_info_entry',
      parameters: { pushParams: 'ai.ohpc.zcode' },
    }).catch((err: BusinessError<void>): void => {
      hilog.error(0x0000, TAG, 'jump to app settings failed: %{public}s', JSON.stringify(err));
    });
  }

  private openScreenCaptureSetting(): void {
    this.openAppSettingsPage('screen capture (user_grant denied)');
  }

  // ————————————————————————— op 解释器 —————————————————————————

  private async ensureControllers(): Promise<void> {
    if (this.mouse !== undefined && this.keyboard !== undefined) {
      return;
    }
    if (!this.status.apiAvailable) {
      throw fail(801, 'inputEventClient is unavailable on this device');
    }
    try {
      this.mouse = this.mouse ?? await inputEventClient.createMouseController();
      this.keyboard = this.keyboard ?? await inputEventClient.createKeyboardController();
      if (this.status.permission !== 'granted') {
        this.status.permission = 'granted';
        this.flushStatus();
      }
    } catch (err) {
      const be = err as BusinessError<void>;
      if (be.code === 201) {
        // 注入被拒说明用户尚未在设置页开启：刷新状态，回流交给常驻权限轮询。
        this.status.permission = 'needs-grant';
        this.flushStatus();
      }
      throw err as Error;
    }
  }

  private async runOp(op: ControlOp): Promise<void> {
    switch (op.op) {
      case 'move':
        await this.ensureControllers();
        await this.mouse!.moveTo(0, op.x ?? 0, op.y ?? 0);
        break;
      case 'button_down':
        await this.ensureControllers();
        await this.mouse!.pressButton(buttonOf(op.button ?? 0));
        break;
      case 'button_up':
        await this.ensureControllers();
        await this.mouse!.releaseButton(buttonOf(op.button ?? 0));
        break;
      case 'wheel': {
        await this.ensureControllers();
        const axis = axisOf(op.axis ?? 'vertical');
        await this.mouse!.beginAxis(axis, 0);
        await this.mouse!.updateAxis(axis, op.value ?? 0);
        await this.mouse!.endAxis(axis);
        break;
      }
      case 'key_down':
        await this.ensureControllers();
        await this.keyboard!.pressKey(this.keyCodeOf(op.key) as KeyCode);
        break;
      case 'key_up':
        await this.ensureControllers();
        await this.keyboard!.releaseKey(this.keyCodeOf(op.key) as KeyCode);
        break;
      case 'paste': {
        await this.ensureControllers();
        // 剪贴板写入必须先于组合键落地；op 串行保证了这一点（spec 13 D4）。
        const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, op.text ?? '');
        await pasteboard.getSystemPasteboard().setData(data);
        // 回读校验：setData 静默失败时 ctrl+v 会毫无反应（真机排查，spec 13 实施记录）。
        try {
          const check = await pasteboard.getSystemPasteboard().getData();
          hilog.debug(0x0000, TAG, 'paste clipboard chars: %{public}d',
            (check.getPrimaryText() ?? '').length);
        } catch (readErr) {
          hilog.warn(0x0000, TAG, 'paste clipboard read-back failed: %{public}s',
            JSON.stringify(readErr));
        }
        await this.keyboard!.pressKey(KeyCode.KEYCODE_CTRL_LEFT);
        await this.keyboard!.pressKey(KeyCode.KEYCODE_V);
        await this.keyboard!.releaseKey(KeyCode.KEYCODE_V);
        await this.keyboard!.releaseKey(KeyCode.KEYCODE_CTRL_LEFT);
        break;
      }
      case 'sleep':
        await sleep(Math.min(op.ms ?? 0, 10_000));
        break;
      case 'reset':
        break;
      default:
        throw fail(999999, `unknown op: ${op.op ?? '(none)'}`);
    }
  }

  private keyCodeOf(name: string | undefined): number {
    const code = name === undefined ? undefined : KEY_TABLE[name];
    if (code === undefined) {
      throw fail(999999, `unknown key: ${name ?? '(none)'}`);
    }
    return code;
  }

  // ————————————————————————— 状态与工具 —————————————————————————

  private probeApiAvailable(): boolean {
    try {
      return canIUse('SystemCapability.MultimodalInput.Input.InputSimulator');
    } catch (err) {
      return false;
    }
  }

  // 常驻权限 tick：①消费设置页落下的「去开启」请求文件（spec 08 同款通道）；
  // ②复查授权态、值变化才重写 status.json（PC 上 onForeground 不可靠，spec 08 实证，
  // 用户自行去系统设置开启也能回流）。1s 对 checkAccessTokenSync 是本地廉价调用。
  private startPermissionPoll(): void {
    if (this.permissionTimer !== -1) {
      return;
    }
    this.permissionTimer = setInterval((): void => {
      this.consumePermissionRequest();
      this.refreshPermissionState();
    }, PERMISSION_POLL_INTERVAL_MS);
  }

  private consumePermissionRequest(): void {
    try {
      const reqPath = `${this.bridgeDir}/${PERMISSION_REQUEST_FILENAME}`;
      if (!fs.accessSync(reqPath)) {
        return;
      }
      fs.unlinkSync(reqPath);
      const context = this.contextForPermission;
      if (context !== undefined) {
        this.openPermissionPanel(context);
      }
    } catch (err) {
      hilog.warn(0x0000, TAG, 'consume permission request failed: %{public}s',
        JSON.stringify(err));
    }
  }

  // CONTROL_DEVICE 的 grantMode 是 manual_settings（PermissionDefinitions.json，真机实证
  // requestPermissionsFromUser 秒拒）：弹窗类 API 一律不可用——
  //   · requestPermissionOnSetting 只接受 user_grant 且被撤销的权限，传 manual_settings 必报
  //     12100014（SDK @ohos.abilityAccessCtrl.d.ts，since 21）；
  //   · manual_settings 的正确入口是 openPermissionOnSetting(context, permission)（since 22），
  //     直接打开该权限的系统设置页。
  // 老设备/未实现该 API 时回退到应用信息页（用户仍可手动开）。
  private openPermissionPanel(context: common.Context): void {
    const atManager = abilityAccessCtrl.createAtManager();
    const fallback = (reason: string): void => {
      hilog.warn(0x0000, TAG, 'openPermissionOnSetting unavailable: %{public}s', reason);
      this.openAppSettingsPage('computer control (manual_settings)');
    };
    try {
      atManager.openPermissionOnSetting(context, CONTROL_DEVICE_PERMISSION)
        .then((result: abilityAccessCtrl.SelectedResult): void => {
          hilog.info(0x0000, TAG, 'openPermissionOnSetting resolved: %{public}s',
            JSON.stringify(result));
          this.refreshPermissionState();
        })
        .catch((err: BusinessError): void => {
          fallback(`code=${err.code}`);
        });
    } catch (err) {
      fallback(JSON.stringify(err));
    }
  }

  // 授权到位后预热控制器：既提前暴露 201/801，也让首个命令少一次冷启动。
  private warmUpControllers(): void {
    this.ensureControllers()
      .then(() => hilog.info(0x0000, TAG, 'controllers warmed up'))
      .catch((err: BusinessError) => hilog.warn(0x0000, TAG,
        'controller warm-up failed: %{public}d', err.code ?? -1));
  }

  private refreshPermissionState(): void {
    const next = this.probePermissions();
    const previous = this.status.permissions;
    const unchanged = previous !== undefined &&
      previous.controlDevice === next.controlDevice &&
      previous.screenCapture === next.screenCapture;
    if (unchanged) {
      return;
    }
    const allGranted = next.controlDevice && next.screenCapture;
    this.status.permissions = next;
    this.status.permission = allGranted ? 'granted' : 'needs-grant';
    this.flushStatus();
    hilog.info(0x0000, TAG, 'permissions refreshed: control=%{public}s capture=%{public}s',
      `${next.controlDevice}`, `${next.screenCapture}`);
    if (allGranted) {
      this.warmUpControllers();
    }
  }

  // 屏幕捕获权限（user_grant，normal 级）状态检查：只记录，不主动弹窗。
  // 真机实证：PC 上 requestPermissionsFromUser 会秒拒（-1），有效路径是 201 时打开系统设置
  // （见 captureScreen 的 201 分支）。这里保留检查以便启动日志能看出权限状态。
  checkScreenCapturePermission(): void {
    const ctx = this.contextForPermission;
    if (ctx === undefined) {
      return;
    }
    try {
      const info = bundleManager.getBundleInfoForSelfSync(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
      const granted = abilityAccessCtrl.createAtManager().checkAccessTokenSync(
        info.appInfo.accessTokenId, SCREEN_CAPTURE_PERMISSION);
      hilog.info(0x0000, TAG, 'screen capture permission: %{public}s',
        granted === 0 ? 'granted' : 'needs-grant (will open setting on first capture)');
    } catch (err) {
      hilog.error(0x0000, TAG, 'screen capture permission probe failed: %{public}s', JSON.stringify(err));
    }
  }

  // 一次读取两个权限（辅助操作 / 截屏），供聚合门禁与 UI 提示共用。
  // 任何一次查询失败都按未授予处理（fail-closed），避免门禁被异常状态绕过。
  private probePermissions(): ControlPermissions {
    const denied: ControlPermissions = {
      controlDevice: false, screenCapture: false,
    };
    const ctx = this.contextForPermission;
    if (ctx === undefined) {
      return denied;
    }
    try {
      const info = bundleManager.getBundleInfoForSelfSync(
        bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION);
      const atManager = abilityAccessCtrl.createAtManager();
      const tokenId = info.appInfo.accessTokenId;
      return {
        controlDevice: atManager.checkAccessTokenSync(tokenId, CONTROL_DEVICE_PERMISSION) === 0,
        screenCapture: atManager.checkAccessTokenSync(tokenId, SCREEN_CAPTURE_PERMISSION) === 0,
      };
    } catch (err) {
      hilog.warn(0x0000, TAG, 'probe permissions failed: %{public}s', JSON.stringify(err));
      return denied;
    }
  }

  // init 后保存的 context 引用，供运行期权限复查使用。
  private contextForPermission: common.Context | undefined = undefined;
  // 帧流录制会话（同一时刻只允许一个）。
  private recordSession: RecordSession | undefined = undefined;
  // 截屏授权弹窗每进程只请求一次。
  private capturePermissionRequested: boolean = false;

  private setContext(context: common.Context): void {
    this.contextForPermission = context;
  }

  private flushStatus(): void {
    this.status.updatedAt = Date.now();
    this.writeText(`${this.bridgeDir}/${STATUS_FILENAME}`, `${JSON.stringify(this.status)}\n`);
  }

  private errorCodeOf(err: Error): string {
    const code: number | undefined =
      err instanceof ControlError ? err.errorCode : (err as BusinessError<void>).code;
    if (code === 201) {
      return 'not_authorized';
    }
    if (code === 801) {
      return 'unavailable';
    }
    if (code === 999999) {
      return 'invalid_request';
    }
    return 'helper_unavailable';
  }

  private writeAck(id: string, ok: boolean, dataOrError: Object): void {
    let text: string;
    if (ok) {
      const ack: BridgeAckOk = { id, ok, data: dataOrError };
      text = `${JSON.stringify(ack)}\n`;
    } else {
      const detail = dataOrError as BridgeAckError;
      const ack: BridgeAckErr = { id, ok, error: detail };
      text = `${JSON.stringify(ack)}\n`;
    }
    this.writeText(`${this.bridgeDir}/${ACK_PREFIX}${id}.json`, text);
  }

  // @ohos.file.fs 无 writeTextSync（读有 readTextSync，写必须 fd，spec 08 先例）。
  private writeText(path: string, text: string): void {
    const file = fs.openSync(path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    try {
      fs.writeSync(file.fd, text);
    } finally {
      fs.closeSync(file);
    }
  }

  private unlinkQuietly(path: string): void {
    try {
      fs.unlinkSync(path);
    } catch (err) {
      // 已被并发轮次删除属预期，不当作命令失败。
    }
  }

  private cleanStaleBridgeFiles(): void {
    try {
      for (const name of fs.listFileSync(this.bridgeDir)) {
        // permission.request 一并清：上一次进程遗留的请求不该在本次启动弹面板。
        if (name.startsWith(CMD_PREFIX) || name.startsWith(ACK_PREFIX) ||
          name === PERMISSION_REQUEST_FILENAME) {
          fs.unlinkSync(`${this.bridgeDir}/${name}`);
        }
      }
    } catch (err) {
      // 首次启动目录为空属预期。
    }
  }
}
