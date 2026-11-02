// ============================================================
// OHOS HDC Tool - 设备侧 hdc 通道（直连 hdcd）
// ============================================================
// 工具 schema 统一归 contracts；实现与开关在 core 的 ohos-device 能力（spec 11）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const OhosHdcAction = {
  ListTargets: "list_targets",
  Shell: "shell",
  FileSend: "file_send",
  Install: "install",
} as const;

export type OhosHdcAction = (typeof OhosHdcAction)[keyof typeof OhosHdcAction];

// 公共字段：显式 target 优先于环境与端口探测
const targetField = z
  .string()
  .min(1)
  .optional()
  .describe("Host:port of the device hdcd, e.g. 127.0.0.1:46273. Defaults to the local debug port.");

export const OhosHdcListTargetsInputSchema = z
  .object({
    action: z.literal(OhosHdcAction.ListTargets),
  })
  .strict();

export const OhosHdcShellInputSchema = z
  .object({
    action: z.literal(OhosHdcAction.Shell),
    command: z.string().min(1).describe("Command to run through the device shell."),
    target: targetField,
    timeoutMs: z.number().int().positive().max(600_000).optional().describe("Command timeout in milliseconds."),
  })
  .strict();

export const OhosHdcFileSendInputSchema = z
  .object({
    action: z.literal(OhosHdcAction.FileSend),
    localPath: z.string().min(1).describe("Local file path in the workspace."),
    remotePath: z.string().min(1).describe("Destination path on the device."),
    target: targetField,
  })
  .strict();

export const OhosHdcInstallInputSchema = z
  .object({
    action: z.literal(OhosHdcAction.Install),
    hapPath: z.string().min(1).describe("Local path of the signed HAP to install."),
    target: targetField,
    bundleName: z.string().min(1).optional().describe("Bundle name to launch after install."),
    ability: z.string().min(1).optional().describe("Ability name to launch; defaults to EntryAbility."),
    uninstallFirst: z.boolean().optional().describe("Uninstall the existing bundle before installing."),
  })
  .strict();

export const OhosHdcInputSchema = z.discriminatedUnion("action", [
  OhosHdcListTargetsInputSchema,
  OhosHdcShellInputSchema,
  OhosHdcFileSendInputSchema,
  OhosHdcInstallInputSchema,
]);

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
