import type { ModelMessageContent } from "@zcode/contracts";
import { isOhosRuntime } from "@zcode/shared";
import { formatBashModelContent } from "./bash-model-content.js";

// agent 所在命名空间的 /usr/bin 是空挂载（spec 03），`#!/usr/bin/env …` 脚本会以
// "bad interpreter" 失败；这里只补一行可执行的替代方式，不改写命令、不重试。
// OHOS 的管道执行会把 stderr 并进 stdout（真机实证 exit=126 时 stderr 为空），
// 判定必须同时看两路。
const OHOS_ENV_SHEBANG_FAILURE_RE =
  /bad interpreter:.*\/usr\/bin\/env|\/usr\/bin\/env:.*no such file|cannot execute: required file not found/i;
const HINT_TAG = "[ohos]";

export function buildOhosEnvShebangHint(
  output: unknown,
  platform: string = process.platform,
): string | null {
  if (!isOhosRuntime(platform)) return null;
  if (!output || typeof output !== "object") return null;
  const record = output as { exitCode?: unknown; stderr?: unknown; stdout?: unknown };
  if (record.exitCode === 0) return null;
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const stdout = typeof record.stdout === "string" ? record.stdout : "";
  if (!OHOS_ENV_SHEBANG_FAILURE_RE.test(`${stderr}\n${stdout}`)) return null;
  return `${HINT_TAG} /usr/bin/env is unavailable in this process; run the script with an explicit interpreter (node/bash/python3 <file>).`;
}

export function formatOhosBashModelContent(
  output: unknown,
  platform: string = process.platform,
): ModelMessageContent {
  const content = formatBashModelContent(output);
  const hint = buildOhosEnvShebangHint(output, platform);
  if (!hint || typeof content !== "string" || content.includes(HINT_TAG)) return content;
  return `${content}\n\n${hint}`;
}