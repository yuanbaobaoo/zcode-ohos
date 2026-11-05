// ============================================================
// OHOS HDC Tool - 设备侧 hdc 通道（直连 hdcd）
// ============================================================
// 工具 schema 统一归 contracts；实现与开关在 core 的 ohos-device 能力（spec 11）。
// schema 必须是单对象（顶层 action 判别、其余字段全部可选）：多路 discriminatedUnion
// 会让 GLM 系模型参数绑定失败、整批调用退化成空对象入参（2026-11-04 真机 model-io
// 实证 11/11 全空）。逐 action 的必需字段由 core executor 校验，缺参以
// ConfigurationError 回传模型。
//
// spec 15：本工具收敛为**纯设备调试/部署通道**（list_targets / shell / file_send /
// file_recv / install）。控制类动作（ui_input / dump_layout / screenshot）已删除——
// 改变设备状态的能力只允许经 Computer Use 一条通道，避免两套语义并存。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const OhosHdcAction = {
  ListTargets: "list_targets",
  Shell: "shell",
  FileSend: "file_send",
  FileRecv: "file_recv",
  Install: "install",
} as const;

export type OhosHdcAction = (typeof OhosHdcAction)[keyof typeof OhosHdcAction];

// 公共字段：显式 target 优先于环境与端口探测
const targetField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Host:port of the device hdcd, e.g. 127.0.0.1:46273. Defaults to the local wireless-debug port (persist.hdc.port); pass explicitly when wireless debugging is off but hdcd is reachable.",
  );

// 设备标识会拼进 bm/aa 命令，必须限制为标识符字符。
const deviceIdentifierField = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.$]+$/, "must contain only letters, digits, '_', '.', '$'");

export const OhosHdcInputSchema = z
  .object({
    action: z
      .nativeEnum(OhosHdcAction)
      .describe(
        [
          "Device hdc channel action. Required fields per action:",
          "list_targets []; shell [command]; file_send [localPath,remotePath];",
          "file_recv [remotePath,localPath]; install [hapPath].",
          "This tool is for device debugging and deployment only; drive the device UI with Computer Use.",
        ].join(" "),
      ),
    // action=shell
    command: z
      .string()
      .min(1)
      .optional()
      .describe("action=shell (required): command to run through the device shell."),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(600_000)
      .optional()
      .describe("action=shell: command timeout in milliseconds."),
    // action=file_send / file_recv
    localPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        "action=file_send (required): local source file. action=file_recv (required): destination path on this machine.",
      ),
    remotePath: z
      .string()
      .min(1)
      .optional()
      .describe(
        "action=file_send (required): destination path on the device. action=file_recv (required): source file path on the device.",
      ),
    // action=install
    hapPath: z
      .string()
      .min(1)
      .optional()
      .describe("action=install (required): local path of the signed HAP to install."),
    bundleName: deviceIdentifierField
      .optional()
      .describe(
        "action=install: bundle name to launch after install (required with uninstallFirst).",
      ),
    ability: deviceIdentifierField
      .optional()
      .describe("action=install: ability name to launch; defaults to EntryAbility."),
    uninstallFirst: z
      .boolean()
      .optional()
      .describe("action=install: uninstall the existing bundle before installing."),
    target: targetField,
  })
  .strict();

export type OhosHdcInput = z.infer<typeof OhosHdcInputSchema>;

export const OhosHdcOutputSchema = z
  .object({
    action: z.string(),
    target: z.string().optional(),
    output: z.string(),
    exitCode: z.number().int(),
    targets: z.array(z.string()).optional(),
  })
  .strict();

export type OhosHdcOutput = z.infer<typeof OhosHdcOutputSchema>;

export const OhosHdcInputJsonSchema = toToolJsonSchema(OhosHdcInputSchema);
export const OhosHdcOutputJsonSchema = toToolJsonSchema(OhosHdcOutputSchema);
