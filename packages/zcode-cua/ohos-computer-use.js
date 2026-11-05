// OHOS Computer Use producer（spec 13）：闭源 Helper 的鸿蒙等价物。
// 语义全部收在本文件——14 工具映射、op 编排、键表；ArkTS 侧（entry/computerControl）
// 只按白名单解释 op 列表。桥协议与时序见 specs/ohos-port/13 D2。
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// host/agent 进程视角的桥目录；ArkTS 侧为 context.filesDir/computer-control（同一文件，
// spec 07 双视图先例）。
export const OHOS_COMPUTER_CONTROL_BRIDGE_DIR =
  "/data/storage/el2/base/haps/electron/files/computer-control";

const TOKEN_FILE = "token.json";
const STATUS_FILE = "status.json";
// 截图子通道（main 进程 desktopCapturer 拥有，spec 13）：req/res/shot 三类文件。
const CMD_PREFIX = "cmd-";
const ACK_PREFIX = "ack-";
const DEFAULT_BRIDGE_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 25;
// op 数量与文本长度上限：桥命令面保持有界（spec 13 D6）。
const MAX_OPS_PER_COMMAND = 500;
const MAX_TEXT_LENGTH = 5000;
// 滚轮一页折算的轴步数（inputEventClient 轴单位未在文档中定义，真机校准值，spec 13 D4）。
const WHEEL_NOTCHES_PER_PAGE = 3;

// 截图通道的会话级状态缓存：request_access 报告用。
const captureState = { last: undefined };

function isOhosPlatform(platform = process.platform) {
  return platform === "ohos" || platform === "openharmony" || platform === "harmonyos";
}

// 平台身份（spec 15）：显式信号 ∨ 平台名。ZCODE_OHOS_RUNTIME=1 由 host 引导注入、随 env
// 继承到 MCP 子进程——子进程即便改由用户环境 node 启动（platform 报 linux）仍自证是鸿蒙。
export function isOhosIdentity(platform = process.platform) {
  return process.env?.ZCODE_OHOS_RUNTIME?.trim() === "1" || isOhosPlatform(platform);
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ————————————————————————— 文件桥客户端 —————————————————————————

class BridgeCommandError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BridgeCommandError";
    this.code = code ?? "internal";
  }
}

async function callBridge(bridgeDir, type, args = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
  const token = readJsonFile(join(bridgeDir, TOKEN_FILE))?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new BridgeCommandError(
      "Computer Use bridge is unavailable: ArkTS service did not start",
      "helper_unavailable",
    );
  }
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const cmdPath = join(bridgeDir, `${CMD_PREFIX}${id}.json`);
  const ackPath = join(bridgeDir, `${ACK_PREFIX}${id}.json`);
  // 串行由 ArkTS 单飞行队列保证；这里再限一次命令的 op 规模。
  if (Array.isArray(args.ops) && args.ops.length > MAX_OPS_PER_COMMAND) {
    throw new BridgeCommandError(`op list exceeds ${MAX_OPS_PER_COMMAND} entries`, "invalid_request");
  }
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(cmdPath, `${JSON.stringify({ id, token, type, args })}\n`, "utf8");
  const deadline = Date.now() + timeoutMs;
  try {
    // 只轮询不 watch：跨进程 watch 在 el2 上的事件语义未实证，轮询上限 25ms 粒度。
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const ack = readJsonFile(ackPath);
      if (ack && ack.id === id) {
        if (ack.ok === true) return ack.data ?? {};
        throw new BridgeCommandError(
          typeof ack.error?.message === "string" ? ack.error.message : "bridge command failed",
          ack.error?.code,
        );
      }
    }
    // 注入类动作可能已发出：交给上层以 action_sent 语义报 TIMEOUT（spec 13 D2 不自动重试）。
    throw new BridgeCommandError(`Computer Use bridge timed out after ${timeoutMs}ms`, "timeout");
  } finally {
    rmSync(cmdPath, { force: true });
    rmSync(ackPath, { force: true });
  }
}

// 截图（spec 15 M3+）：唯一路径是 ArkTS 的公开截屏 API（@ohos.screenshot.capture）。
// 历史上的 native desktopCapturer / hdcd 回退已删除 —— 本厂商端口 AVScreenCapture 被系统拒绝，
// hdcd 又要求开发者模式，两者都不是产品路径（真机实证，见 specs/ohos-port/13）。
// 失败时如实报 unavailable，由设置页引导用户授权。
async function captureScreenshot(bridgeDir, timeoutMs) {
  try {
    const shot = await callBridge(bridgeDir, "screenshot", { displayId: 0 }, { timeoutMs });
    const path = typeof shot?.path === "string" ? shot.path : undefined;
    if (!path) {
      throw new BridgeCommandError("screenshot: bridge returned no path", "helper_unavailable");
    }
    const bytes = readFileSync(path).length;
    if (bytes === 0) {
      throw new BridgeCommandError("screenshot produced an empty file", "helper_unavailable");
    }
    return { id: `arkts-${Date.now()}`, ok: true, path, bytes, provider: "arkts-screenshot" };
  } catch (error) {
    throw error;
  }
}

function readShotBase64(res) {
  const buffer = readFileSync(res.path);
  return { base64: buffer.toString("base64"), bytes: buffer.length };
}

// ————————————————————————— 键表（Node 侧唯一事实源） —————————————————————————

// 单字符 → 基键 + 是否 shift（US 布局）。ArkTS 侧按基键名映射 KeyCode。
const CHAR_KEY_TABLE = (() => {
  const table = new Map();
  for (let code = 97; code <= 122; code += 1) {
    const lower = String.fromCharCode(code);
    table.set(lower, { key: lower, shift: false });
    table.set(lower.toUpperCase(), { key: lower, shift: true });
  }
  for (let code = 48; code <= 57; code += 1) {
    const digit = String.fromCharCode(code);
    table.set(digit, { key: digit, shift: false });
  }
  const pairs = [
    [" ", "space", false],
    ["`", "`", false],
    ["~", "`", true],
    ["-", "-", false],
    ["_", "-", true],
    ["=", "=", false],
    ["+", "=", true],
    ["[", "[", false],
    ["{", "[", true],
    ["]", "]", false],
    ["}", "]", true],
    ["\\", "\\", false],
    ["|", "\\", true],
    [";", ";", false],
    [":", ";", true],
    ["'", "'", false],
    ['"', "'", true],
    [",", ",", false],
    ["<", ",", true],
    [".", ".", false],
    [">", ".", true],
    ["/", "/", false],
    ["?", "/", true],
    ["!", "1", true],
    ["@", "2", true],
    ["#", "3", true],
    ["$", "4", true],
    ["%", "5", true],
    ["^", "6", true],
    ["&", "7", true],
    ["*", "8", true],
    ["(", "9", true],
    [")", "0", true],
  ];
  for (const [char, key, shift] of pairs) table.set(char, { key, shift });
  return table;
})();

// 修饰键别名 → 统一基键名（cmd 映射 meta，与 mac 习惯对齐）。
const MODIFIER_ALIASES = new Map([
  ["ctrl", "ctrl_left"],
  ["control", "ctrl_left"],
  ["alt", "alt_left"],
  ["option", "alt_left"],
  ["shift", "shift_left"],
  ["win", "meta_left"],
  ["meta", "meta_left"],
  ["cmd", "meta_left"],
  ["command", "meta_left"],
]);

// 命名键别名（key 工具的 token）。
const NAMED_KEY_ALIASES = new Map([
  ["enter", "enter"],
  ["return", "enter"],
  ["esc", "escape"],
  ["escape", "escape"],
  ["tab", "tab"],
  ["backspace", "backspace"],
  ["delete", "delete"],
  ["del", "delete"],
  ["space", "space"],
  ["up", "dpad_up"],
  ["down", "dpad_down"],
  ["left", "dpad_left"],
  ["right", "dpad_right"],
  ["arrowup", "dpad_up"],
  ["arrowdown", "dpad_down"],
  ["arrowleft", "dpad_left"],
  ["arrowright", "dpad_right"],
  ["home", "move_home"],
  ["end", "move_end"],
  ["pageup", "page_up"],
  ["pagedown", "page_down"],
  ["ctrl", "ctrl_left"],
  ["control", "ctrl_left"],
  ["alt", "alt_left"],
  ["option", "alt_left"],
  ["shift", "shift_left"],
  ["win", "meta_left"],
  ["meta", "meta_left"],
  ["cmd", "meta_left"],
  ["command", "meta_left"],
]);

// 解析 key 工具的 text（"ctrl+shift+t"）为基键名数组；未知 token 报错。
function parseKeyChord(text) {
  return String(text)
    .split("+")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)
    .map((token) => {
      const named = NAMED_KEY_ALIASES.get(token);
      if (named) return named;
      const char = CHAR_KEY_TABLE.get(token);
      if (char) return char.key;
      throw invalidRequest(`unknown key token: ${token}`);
    });
}

function charToKeyOps(char) {
  const entry = CHAR_KEY_TABLE.get(char);
  if (!entry) return undefined;
  const ops = [];
  if (entry.shift) ops.push({ op: "key_down", key: "shift_left" });
  ops.push({ op: "key_down", key: entry.key });
  ops.push({ op: "key_up", key: entry.key });
  if (entry.shift) ops.push({ op: "key_up", key: "shift_left" });
  return ops;
}

// ————————————————————————— CallToolResult 组装 —————————————————————————

// broker snake 错误码 → SDK 的 ERROR_CODE_BY_BROKER 全部可映射（computer-use-client.mjs）。
function okResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function errorResult(code, message, extra = {}) {
  return {
    content: [{ type: "text", text: JSON.stringify({ code, message, ...extra }) }],
    isError: true,
  };
}

function invalidRequest(message) {
  const error = new BridgeCommandError(message, "invalid_request");
  return error;
}

function actionSentOf(error) {
  // 桥超时的动作可能已发出；其余桥错误按未发出处理（ArkTS 端原子执行单个 op 前的失败）。
  return error.code === "timeout";
}

// ————————————————————————— 工具实现 —————————————————————————

// 应用模型（spec 15）：list_apps 读设备真实安装列表，get_app_state(appRef) 负责拉起。
// 上游把"启动/激活"并进了 get_app_state 的透明拉起（computer-use-client 头注），所以这里
// 不新增第 15 个工具，只补 ArkTS 侧的 list_apps / launch 两个 op。

// 兜底模型：枚举不可用时仍给模型一个可操作目标（整屏），而不是让它直接失败。
function pseudoApp() {
  return {
    name: "HarmonyOS Desktop",
    bundle_id: "ohos.desktop",
    running: true,
    display_id: 0,
  };
}

function requireCoordinateTarget(target, toolName) {
  if (!target || typeof target !== "object") {
    throw invalidRequest(`${toolName} needs a target object`);
  }
  if (target.type === "coordinate") {
    const { x, y } = target;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw invalidRequest(`${toolName} coordinate target needs numeric x/y`);
    }
    return { x: Math.trunc(x), y: Math.trunc(y) };
  }
  if (target.type === "element") {
    throw new BridgeCommandError(
      `${toolName}: element targets are not available on this platform; use {type:"coordinate", x, y}`,
      "element_unavailable",
    );
  }
  throw invalidRequest(`${toolName}: unsupported target type ${String(target.type)}`);
}

function modifiersToKeyNames(modifiers) {
  if (!modifiers) return [];
  return String(modifiers)
    .split("+")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0)
    .map((token) => {
      const named = MODIFIER_ALIASES.get(token) ?? NAMED_KEY_ALIASES.get(token);
      if (named) return named;
      const char = CHAR_KEY_TABLE.get(token);
      if (char) return char.key;
      throw invalidRequest(`unknown modifier: ${token}`);
    });
}

function buttonOf(mouseButton) {
  const value = mouseButton ?? "left";
  if (value === "left") return 0;
  if (value === "middle") return 1;
  if (value === "right") return 2;
  throw invalidRequest(`unsupported mouse_button: ${String(value)}`);
}

function wheelOps(direction, amount) {
  const pages = Math.min(Math.max(Number(amount) || 1, 0), 100);
  const notches = Math.round(pages * WHEEL_NOTCHES_PER_PAGE);
  if (notches === 0) return [];
  const axis = direction === "left" || direction === "right" ? "horizontal" : "vertical";
  // 轴值方向：垂直向下为正、水平向右为正（真机校准点，spec 13 实施记录）。
  const sign = direction === "up" || direction === "left" ? -1 : 1;
  return [{ op: "wheel", axis, value: sign * notches }];
}

function normalizeAppEntry(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const bundleId = typeof raw.bundle_id === "string" && raw.bundle_id.trim() ? raw.bundle_id.trim() : undefined;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined;
  if (!bundleId && !name) return undefined;
  return { name: name ?? bundleId, ...(bundleId ? { bundle_id: bundleId } : {}) };
}

// SDK 的 app ref 形状：{bundle_id} / {name} / 裸字符串（客户端已按 bundleId 启发式归一）。
function resolveAppRef(args) {
  const direct = args.app ?? args.app_id ?? args.target_app;
  let raw;
  if (typeof direct === "string" && direct.trim()) {
    raw = { bundle_id: direct.trim() };
  } else if (direct && typeof direct === "object") {
    raw = normalizeAppEntry(direct);
  }
  if (!raw && typeof args.bundle_id === "string" && args.bundle_id.trim()) {
    raw = { bundle_id: args.bundle_id.trim() };
  }
  if (!raw) return undefined;
  // 平台只能按 bundle id 拉起：显示名无法反查（公开 SDK 无枚举/反查 API），
  // 直接拒绝比发出一个必然失败的 startAbility 更好，错误信息里给出发现途径。
  const bundleId = raw.bundle_id;
  if (!bundleId) {
    throw invalidRequest(
      `app "${raw.name}" must be addressed by bundle id on this platform; ` +
        "find it with ohos_hdc shell: bm dump -a | grep <keyword>",
    );
  }
  return { bundle_id: bundleId };
}

async function listInstalledApps(bridgeDir, timeoutMs) {
  const data = await callBridge(bridgeDir, "list_apps", {}, { timeoutMs });
  const apps = Array.isArray(data?.apps)
    ? data.apps.map(normalizeAppEntry).filter((entry) => entry !== undefined)
    : [];
  const reason = typeof data?.reason === "string" && data.reason.trim() ? data.reason.trim() : undefined;
  return { apps, reason };
}

// startAbility 拉起：已在栈顶时只会前置，不重启（幂等）。
async function launchApp(bridgeDir, timeoutMs, appRef) {
  return await callBridge(bridgeDir, "launch", { bundleName: appRef.bundle_id }, { timeoutMs });
}

async function executeTool(bridgeDir, timeoutMs, toolName, args = {}) {
  switch (toolName) {
    case "request_access": {
      const status = readJsonFile(join(bridgeDir, STATUS_FILE)) ?? {};
      // 上游状态报告映射（spec 13 D4）：accessibility↔CONTROL_DEVICE，screen_recording↔capture。
      const accessibility =
        status.permission === "granted"
          ? "granted"
          : status.permission === "needs-grant"
            ? "unknown"
            : "denied";
      // capture 由 main 的 shots 子通道提供；首调前未知，成败后缓存（不为此付取屏成本）。
      const screenRecording =
        captureState.last === "ready"
          ? "granted"
          : captureState.last === "denied"
            ? "denied"
            : "unknown";
      return okResult({
        accessibility,
        screen_recording: screenRecording,
        bridge_alive: status.bridgeAlive === true,
        api_available: status.apiAvailable === true,
        note: "input injection needs accessibility granted; screenshots are served by the desktop capture channel",
      });
    }
    case "stop_computer_control": {
      await callBridge(bridgeDir, "exec", { ops: [{ op: "reset" }] }, { timeoutMs });
      return okResult({ stopped: true });
    }
    case "list_apps": {
      try {
        const { apps, reason } = await listInstalledApps(bridgeDir, timeoutMs);
        if (apps.length > 0) return okResult({ apps });
        // 公开 SDK 没有枚举 API（见 ArkTS listApps 注释）：如实说明，并给模型可执行的下一步。
        return okResult({
          apps: [pseudoApp()],
          note:
            `app enumeration is not available on this platform (${reason ?? "no public bundle listing API"}). ` +
            "Use a bundle id with get_app_state, and discover it via ohos_hdc shell: bm dump -a | grep <keyword>",
        });
      } catch (error) {
        return okResult({
          apps: [pseudoApp()],
          note: `app enumeration unavailable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    case "list_windows":
      // bundleManager 不提供窗口栈：整屏是唯一可见窗口（与 get_app_state 的视觉闭环一致）。
      return okResult({
        windows: [{ ...pseudoApp(), window_id: 0, focused: true, bounds: "full-display" }],
      });
    // 录屏（spec 15 M4）：帧流录制，桥命令由 ArkTS 连续调用截屏 API 实现。
    // 上游工具集若不暴露这两个名字，也仍可由应用侧直接经桥调用。
    case "record_start": {
      return okResult(await callBridge(bridgeDir, "record_start", args, { timeoutMs }));
    }
    case "record_stop": {
      return okResult(await callBridge(bridgeDir, "record_stop", {}, { timeoutMs }));
    }
    case "get_app_state": {
      const includeScreenshot = args.include_screenshot === true;
      const appRef = resolveAppRef(args);
      let app = pseudoApp();
      let launched;
      if (appRef) {
        // 拉起失败要把原因交给模型（通常是 bundle 名不对），不能静默截图了事。
        launched = await launchApp(bridgeDir, timeoutMs, appRef);
        app = {
          name: appRef.name ?? appRef.bundle_id,
          bundle_id: appRef.bundle_id ?? appRef.name,
          running: true,
          display_id: 0,
        };
        // 冷启动需要一点时间把窗口画出来；截图前留一个短稳定窗（不是超时兜底）。
        await sleep(400);
      }
      const payload = {
        app,
        state_id: `ohos-desktop-${Date.now()}`,
        ...(launched ? { launched } : {}),
        tree: "visual mode: this platform has no accessibility tree; observe with screenshots and act on coordinates",
      };
      if (!includeScreenshot) return okResult(payload);
      try {
        const shotRes = await captureScreenshot(bridgeDir, timeoutMs);
        const shot = readShotBase64(shotRes);
        captureState.last = "ready";
        return {
          content: [
            {
              type: "text",
              // provider 必须可观测：真机上曾出现"到底哪条取屏路径在工作"完全看不出来的情况。
              text: JSON.stringify({
                ...payload,
                capture: { provider: shotRes.provider ?? "unknown", bytes: shotRes.bytes },
              }),
            },
            { type: "image", data: shot.base64, mimeType: "image/jpeg" },
          ],
        };
      } catch (error) {
        captureState.last = "denied";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...payload,
                screenshot: `unavailable: ${error instanceof Error ? error.message : String(error)}`,
              }),
            },
          ],
        };
      }
    }
    case "left_click": {
      const { x, y } = requireCoordinateTarget(args.target, toolName);
      const button = buttonOf(args.mouse_button);
      const count = Math.min(Math.max(Number(args.click_count) || 1, 1), 3);
      const mods = modifiersToKeyNames(args.modifiers);
      const ops = [];
      if (args.strategy === "a11y") {
        throw new BridgeCommandError("a11y strategy is not available on this platform", "action_unavailable");
      }
      ops.push({ op: "move", x, y });
      for (const key of mods) ops.push({ op: "key_down", key });
      for (let i = 0; i < count; i += 1) {
        ops.push({ op: "button_down", button });
        ops.push({ op: "button_up", button });
      }
      for (const key of mods.reverse()) ops.push({ op: "key_up", key });
      await callBridge(bridgeDir, "exec", { ops }, { timeoutMs });
      return okResult({ action_sent: true });
    }
    case "left_click_drag": {
      const from = requireCoordinateTarget(args.from_target, toolName);
      const to = requireCoordinateTarget(args.to ?? args.to_target, toolName);
      const mods = modifiersToKeyNames(args.modifiers);
      const ops = [{ op: "move", x: from.x, y: from.y }];
      for (const key of mods) ops.push({ op: "key_down", key });
      ops.push({ op: "button_down", button: 0 }, { op: "move", x: to.x, y: to.y }, { op: "button_up", button: 0 });
      for (const key of mods.reverse()) ops.push({ op: "key_up", key });
      await callBridge(bridgeDir, "exec", { ops }, { timeoutMs });
      return okResult({ action_sent: true });
    }
    case "scroll": {
      const { x, y } = requireCoordinateTarget(args.target, toolName);
      const direction = String(args.scroll_direction ?? "down");
      if (!["up", "down", "left", "right"].includes(direction)) {
        throw invalidRequest(`unsupported scroll_direction: ${direction}`);
      }
      const ops = [{ op: "move", x, y }, ...wheelOps(direction, args.scroll_amount)];
      await callBridge(bridgeDir, "exec", { ops }, { timeoutMs });
      return okResult({ action_sent: true });
    }
    case "type": {
      const text = String(args.text ?? "");
      if (text.length === 0) return okResult({ action_sent: false });
      if (text.length > MAX_TEXT_LENGTH) {
        throw invalidRequest(`text exceeds ${MAX_TEXT_LENGTH} characters`);
      }
      // 裸键输入不经输入法：非 ASCII 打不出来，契约上强制走 paste（spec 13 背景）。
      for (const char of text) {
        if (!CHAR_KEY_TABLE.has(char)) {
          throw new BridgeCommandError(
            `type only supports ASCII on this platform; use paste for "${char}"`,
            "invalid_request",
          );
        }
      }
      if (args.target) requireCoordinateTarget(args.target, toolName);
      const ops = [];
      for (const char of text) ops.push(...charToKeyOps(char));
      await callBridge(bridgeDir, "exec", { ops }, { timeoutMs });
      return okResult({ action_sent: true });
    }
    case "paste": {
      const text = String(args.text ?? "");
      if (text.length === 0 || text.length > MAX_TEXT_LENGTH) {
        throw invalidRequest(`paste text must be 1..${MAX_TEXT_LENGTH} characters`);
      }
      // 剪贴板会被覆盖：工具描述已明示（spec 13 D6）。真机实证 Ctrl+V 组合键会被 IME
      // 消费（spec 13 实施记录）：结果带核查指引，未落字时改走 right_click → 截图定位
      // 「粘贴」菜单项 → 点击。
      await callBridge(bridgeDir, "exec", { ops: [{ op: "paste", text }] }, { timeoutMs });
      return okResult({
        action_sent: true,
        verify_hint:
          "ctrl+v may be swallowed by the IME; take a screenshot to confirm, and if the text did not land use right_click then click the 粘贴 menu item",
      });
    }
    case "key": {
      const names = parseKeyChord(args.text);
      if (names.length === 0) throw invalidRequest("key needs a non-empty text chord");
      if (names.length > 5) {
        throw new BridgeCommandError("at most 5 keys can be held simultaneously", "invalid_request");
      }
      const repeat = Math.min(Math.max(Number(args.repeat) || 1, 1), 100);
      const holdMs = Math.min(Math.max(Number(args.hold_seconds) || 0, 0), 10) * 1000;
      const ops = [];
      for (let i = 0; i < repeat; i += 1) {
        for (const key of names) ops.push({ op: "key_down", key });
        if (holdMs > 0) ops.push({ op: "sleep", ms: Math.trunc(holdMs) });
        for (const key of [...names].reverse()) ops.push({ op: "key_up", key });
      }
      await callBridge(bridgeDir, "exec", { ops }, { timeoutMs });
      return okResult({ action_sent: true });
    }
    case "perform_action":
      throw new BridgeCommandError(
        "perform_action needs accessibility elements, unavailable on this platform; use left_click on coordinates",
        "action_unavailable",
      );
    case "set_value":
      throw new BridgeCommandError(
        "set_value needs accessibility elements, unavailable on this platform; use click + type or paste",
        "not_settable",
      );
    case "select_text":
      throw new BridgeCommandError(
        "select_text needs accessibility elements, unavailable on this platform; use drag",
        "not_selectable",
      );
    default:
      throw new BridgeCommandError(`unknown Computer Use tool: ${toolName}`, "invalid_request");
  }
}

// ————————————————————————— runtime 装配 —————————————————————————

export function createOhosComputerUseRuntime(options = {}) {
  const bridgeDir = options.bridgeDir ?? OHOS_COMPUTER_CONTROL_BRIDGE_DIR;
  const bridgeTimeoutMs = options.bridgeTimeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
  const platform = options.platform ?? process.platform;
  if (!isOhosIdentity(platform)) {
    throw new Error("createOhosComputerUseRuntime is only available on OHOS");
  }
  return {
    async execute(input) {
      const toolName = String(input?.toolName ?? "");
      try {
        return await executeTool(bridgeDir, bridgeTimeoutMs, toolName, input?.arguments);
      } catch (error) {
        if (error instanceof BridgeCommandError) {
          return errorResult(error.code, error.message, { action_sent: actionSentOf(error) });
        }
        return errorResult("internal", error instanceof Error ? error.message : String(error), {
          action_sent: false,
        });
      }
    },
    async closeSession() {},
    async dispose() {},
  };
}
