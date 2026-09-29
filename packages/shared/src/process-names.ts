import { isOhosRuntime } from "./runtimeEnv.js";

const ZCODE_PROCESS_PREFIX = "zcode";
const MAX_PROCESS_NAME_SEGMENT_LENGTH = 24;

function sanitizeProcessNameSegment(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, MAX_PROCESS_NAME_SEGMENT_LENGTH);
}

function joinZCodeProcessName(...segments: Array<string | null | undefined>): string {
  const sanitizedSegments = segments
    .map((segment) => sanitizeProcessNameSegment(segment))
    .filter((segment): segment is string => Boolean(segment));
  return [ZCODE_PROCESS_PREFIX, ...sanitizedSegments].join("-");
}

function pickWorkspaceTag(workspacePath: string | null | undefined): string | undefined {
  const trimmedPath = workspacePath?.trim();
  if (!trimmedPath) {
    return undefined;
  }

  const parts = trimmedPath.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? trimmedPath;
}

export function formatZCodeMainProcessName(): string {
  return joinZCodeProcessName("main");
}

export function formatZCodeGpuProcessName(): string {
  return joinZCodeProcessName("gpu");
}

export function formatZCodeHostProcessName(label?: string): string {
  return joinZCodeProcessName("host", label);
}

export function formatZCodeRendererProcessName(windowTitle?: string): string {
  const normalizedTitle = windowTitle?.trim();
  if (!normalizedTitle || normalizedTitle === "ZCode") {
    return joinZCodeProcessName("renderer", "main");
  }

  if (normalizedTitle === "Resource Manager") {
    return joinZCodeProcessName("renderer", "resource-manager");
  }

  const remoteWindowPrefix = "ZCode - ";
  if (normalizedTitle.startsWith(remoteWindowPrefix)) {
    return joinZCodeProcessName(
      "renderer",
      "remote",
      normalizedTitle.slice(remoteWindowPrefix.length),
    );
  }

  return joinZCodeProcessName("renderer", normalizedTitle);
}

export function formatZCodeAgentProcessName(provider: string, workspacePath?: string): string {
  return joinZCodeProcessName("agent", provider, pickWorkspaceTag(workspacePath));
}

export function formatZCodeUtilityProcessName(name?: string, type = "utility"): string {
  return joinZCodeProcessName(type, name);
}

// 鸿蒙 Electron（libelectron.so，Node 20.18）上 process.title 的 setter 会触发
// uv_set_process_title 内部的 memset 整数下溢并 SIGSEGV（整进程崩溃，见移植 spec 的
// 沙箱约束清单）。所有进程统一走本入口赋值 title，在 openharmony 平台上直接跳过。
export function assignProcessTitle(title: string): void {
  if (isOhosRuntime()) {
    return;
  }
  process.title = title;
}
