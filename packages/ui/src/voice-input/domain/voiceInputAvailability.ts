/** 语音输入入口的显示与可用性；缺麦克风后端时入口仍显示但禁用（spec 02）。 */
export interface VoiceInputAvailabilityInput {
  /** 桌面本机才提供语音入口；手机远控关闭。 */
  enabled: boolean;
  /** 宿主是否提供语音入口（桌面本机为 true，Web 省略）。 */
  hasEntry: boolean;
  hasMicrophone: boolean;
  hasService: boolean;
  isLoggedIn: boolean;
}

export interface VoiceInputAvailability {
  /** 是否渲染入口：只取决于环境、服务与登录态。 */
  visible: boolean;
  /** 是否可以开始录音。 */
  available: boolean;
  /** 显示但当前平台没有麦克风权限后端。 */
  unsupported: boolean;
}

export function resolveVoiceInputAvailability(
  input: VoiceInputAvailabilityInput,
): VoiceInputAvailability {
  const visible = input.enabled && input.hasEntry && input.hasService && input.isLoggedIn;
  const available = visible && input.hasMicrophone;
  return { visible, available, unsupported: visible && !input.hasMicrophone };
}
