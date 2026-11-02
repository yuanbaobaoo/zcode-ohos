// ============================================================
// OHOS HDC Tool Handler
// ============================================================
// 沙箱禁 UDS bind，hdc server 起不来；exec 又被 MAC 拦，只能以纯 JS 资产
// 在 agent 进程内动态 import 直连 hdcd（spec 11）。

import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { isOhosRuntime } from "@zcode/shared";
import {
  CoreErrorType,
  OhosHdcAction,
  OhosHdcInputJsonSchema,
  OhosHdcInputSchema,
  OhosHdcOutputJsonSchema,
  OhosHdcOutputSchema,
  createCoreError,
  type OhosHdcInput,
  type OhosHdcOutput,
} from "@zcode/contracts";

import type { ToolEntry, ToolHandler } from "../../tool/types.js";

export const OHOS_HDC_TOOL_NAME = "ohos_hdc";

// 资产在 glm 内的相对位置（与 bundled-hdc-direct-assets.mjs 的 stage 目标一致）
const HDCD_MODULE_SEGMENTS = ["node-runtime", "hdc-direct", "dist", "src", "index.js"];
// 设备侧上传中转目录（hdcd 的 file 任务只允许写设备可写路径）
const DEVICE_TMP_DIR = "/data/local/tmp";
// install 后未指定 ability 时的默认值
const DEFAULT_ABILITY = "EntryAbility";
// 工具输出上限：超过后在模型侧截断，避免灌爆上下文
const MAX_OUTPUT_BYTES = 100_000;
// 默认操作超时（单条设备命令 / 一次上传）
const DEFAULT_TIMEOUT_MS = 120_000;
// 环境变量覆盖：本地开发时可指向源码产物
const MODULE_PATH_ENV = "HDC_DIRECT_MODULE";
// 环境变量覆盖：显式指定 hdcd 端口（免去 param 探测）
const PORT_ENV = "HDC_DIRECT_PORT";
// headless 进程没有 Host 注入的 ZCODE_BUNDLED_RESOURCE_DIR，回退安装包内固定 glm 路径
const OHOS_BUNDLED_GLM_FALLBACK =
    "/data/storage/el1/bundle/electron/resources/resfile/resources/glm";

// hdc-direct 会话的最小契约（只声明本工具用到的成员）
interface HdcDirectSession {
    shell(command: string): Promise<Buffer>;
    shellStr(command: string): Promise<string>;
    fileSend(localPath: string, remotePath: string): Promise<string>;
    fileRecv(remotePath: string, localPath: string): Promise<string>;
    close(): void;
}

// hdc-direct 库的最小契约
interface HdcDirectModule {
    HdcSession: {
        connect(host: string, port: number, options?: { timeoutMs?: number }): Promise<HdcDirectSession>;
    };
    localHdcPort(): number | null;
    loadTargets(): string[];
    splitTarget(target: string): { host: string; port: number };
}

// 可注入依赖：测试用它替换真实模块加载与端口探测
export interface OhosHdcToolDeps {
    // 加载 hdc-direct 模块
    loadModule: () => Promise<HdcDirectModule>;
    // 进程环境（target 解析与端口覆盖）
    env: NodeJS.ProcessEnv;
}

// 模块加载结果缓存：同一进程内多次调用只解析一次
let cachedModule: Promise<HdcDirectModule> | undefined;

function resolveModulePath(env: NodeJS.ProcessEnv, platform: string = process.platform): string | undefined {
    const override = env[MODULE_PATH_ENV]?.trim();
    if (override) return override;
    const resourceDir = env.ZCODE_BUNDLED_RESOURCE_DIR?.trim() ?? (isOhosRuntime(platform) ? OHOS_BUNDLED_GLM_FALLBACK : undefined);
    if (!resourceDir) return undefined;
    return [resourceDir, ...HDCD_MODULE_SEGMENTS].join("/");
}

// 运行期从 glm 读取，不静态打包；失败不缓存，资产修复后可重试
function loadModuleFromBundle(env: NodeJS.ProcessEnv, platform: string = process.platform): Promise<HdcDirectModule> {
    const modulePath = resolveModulePath(env, platform);
    if (!modulePath) {
        return Promise.reject(
            createCoreError(
                CoreErrorType.ConfigurationError,
                "ohos_hdc 资产不可用：既无 ZCODE_BUNDLED_RESOURCE_DIR，也找不到安装包内的 glm 资产（未随包 stage hdc-direct）",
                {
                    recoverable: false,
                    context: { toolName: OHOS_HDC_TOOL_NAME },
                },
            ),
        );
    }
    cachedModule ??= import(pathToFileURL(modulePath).href).then(
        (module) => module as unknown as HdcDirectModule,
        (error: unknown) => {
            // 失败不缓存，允许用户重装/修复资产后重试
            cachedModule = undefined;
            throw createCoreError(
                CoreErrorType.ConfigurationError,
                `ohos_hdc 资产加载失败：${modulePath}。请重新构建 OHOS 包（bundle-ohos 会硬校验该资产）。`,
                {
                    cause: error instanceof Error ? error : undefined,
                    recoverable: false,
                    context: { toolName: OHOS_HDC_TOOL_NAME, modulePath },
                },
            );
        },
    );
    return cachedModule;
}

// 解析目标设备：显式参数 → 环境变量端口 → 本机无线调试端口
function resolveTarget(explicit: string | undefined, env: NodeJS.ProcessEnv, api: HdcDirectModule): string {
    if (explicit) return explicit;
    const portFromEnv = env[PORT_ENV]?.trim();
    if (portFromEnv) return `127.0.0.1:${portFromEnv}`;
    const port = api.localHdcPort();
    if (port) return `127.0.0.1:${port}`;
    throw createCoreError(
        CoreErrorType.ConfigurationError,
        "无法确定设备端口：请在设备上开启无线调试（开发者选项），或显式传入 target / HDC_DIRECT_PORT",
        { recoverable: false, context: { toolName: OHOS_HDC_TOOL_NAME } },
    );
}

// 一条命令一个短连接：daemon 的 task 按 channel 生命周期设计，复用不可靠（spec 11）
async function withSession<T>(
    api: HdcDirectModule,
    target: string,
    timeoutMs: number,
    run: (session: HdcDirectSession) => Promise<T>,
): Promise<T> {
    const { host, port } = api.splitTarget(target);
    const session = await api.HdcSession.connect(host, port, { timeoutMs });
    try {
        return await run(session);
    } finally {
        session.close();
    }
}

function truncateOutput(text: string): string {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes <= MAX_OUTPUT_BYTES) return text;
    return `${Buffer.from(text, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8")}\n… [output truncated]`;
}

function toToolError(error: unknown): Error {
    if (error instanceof Error && "type" in error) return error;
    const message = error instanceof Error ? error.message : String(error);
    return createCoreError(CoreErrorType.ToolExecutionFailed, `ohos_hdc 执行失败：${message}`, {
        cause: error instanceof Error ? error : undefined,
        context: { toolName: OHOS_HDC_TOOL_NAME },
    });
}

async function runOhosHdc(input: OhosHdcInput, deps: OhosHdcToolDeps): Promise<OhosHdcOutput> {
    const api = await deps.loadModule();
    const timeoutMs = input.action === OhosHdcAction.Shell ? (input.timeoutMs ?? DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

    if (input.action === OhosHdcAction.ListTargets) {
        const targets = [...api.loadTargets()];
        const port = api.localHdcPort();
        const fallback = port ? `127.0.0.1:${port}` : undefined;
        if (fallback && !targets.includes(fallback)) targets.push(fallback);
        return {
            action: input.action,
            target: fallback,
            targets,
            output: targets.length > 0 ? targets.join("\n") : "(no targets)",
            exitCode: 0,
        };
    }

    const target = resolveTarget(input.target, deps.env, api);

    if (input.action === OhosHdcAction.Shell) {
        const output = await withSession(api, target, timeoutMs, (session) => session.shellStr(input.command));
        return { action: input.action, target, output: truncateOutput(output), exitCode: 0 };
    }

    if (input.action === OhosHdcAction.FileSend) {
        const summary = await withSession(api, target, timeoutMs, (session) =>
            session.fileSend(input.localPath, input.remotePath),
        );
        return { action: input.action, target, output: truncateOutput(summary), exitCode: 0 };
    }

    if (input.action === OhosHdcAction.FileRecv) {
        const summary = await withSession(api, target, timeoutMs, (session) =>
            session.fileRecv(input.remotePath, input.localPath),
        );
        return { action: input.action, target, output: truncateOutput(summary), exitCode: 0 };
    }

    // 截图：设备端 snapshot_display 落盘后经 file recv 拉回，模型拿到本地路径即可 Read。
    // 不再让模型自己拼 nc/base64 转发（真机实测曾为此写两个临时 Node 脚本）。
    if (input.action === OhosHdcAction.Screenshot) {
        const stamp = Date.now();
        const remotePath = `${DEVICE_TMP_DIR}/zcode-screenshot-${stamp}.jpeg`;
        const localPath = input.localPath ?? join(tmpdir(), `zcode-screenshot-${stamp}.jpeg`);
        const displayId = input.displayId ?? 0;
        await withSession(api, target, timeoutMs, (session) =>
            session.shellStr(`snapshot_display -i ${displayId} -f ${remotePath} -t jpeg`),
        );
        let summary: string;
        try {
            summary = await withSession(api, target, timeoutMs, (session) =>
                session.fileRecv(remotePath, localPath),
            );
        } finally {
            // 清理设备中转文件；失败不影响已下载的截图
            await withSession(api, target, timeoutMs, (session) =>
                session.shellStr(`rm -f ${remotePath}`),
            ).catch(() => undefined);
        }
        return { action: input.action, target, output: `${localPath}\n${summary}`, exitCode: 0 };
    }

    // install
    const remotePath = `${DEVICE_TMP_DIR}/${basename(input.hapPath)}`;
    const chunks: string[] = [];
    if (input.uninstallFirst) {
        if (!input.bundleName) {
            throw createCoreError(
                CoreErrorType.ConfigurationError,
                "uninstallFirst 需要同时提供 bundleName",
                { recoverable: false, context: { toolName: OHOS_HDC_TOOL_NAME } },
            );
        }
        chunks.push(await withSession(api, target, timeoutMs, (s) => s.shellStr(`bm uninstall -n ${input.bundleName}`)));
    }
    await withSession(api, target, timeoutMs, (s) => s.fileSend(input.hapPath, remotePath));
    const installOutput = await withSession(api, target, timeoutMs, (s) =>
        s.shellStr(`bm install -p ${remotePath} -r -d`),
    );
    chunks.push(installOutput);
    if (input.bundleName) {
        const ability = input.ability ?? DEFAULT_ABILITY;
        chunks.push(
            await withSession(api, target, timeoutMs, (s) =>
                s.shellStr(`aa start -b ${input.bundleName} -a ${ability}`),
            ),
        );
    }
    await withSession(api, target, timeoutMs, (s) => s.shellStr(`rm -f ${remotePath}`));
    const exitCode = installOutput.includes("successfully") ? 0 : 1;
    return { action: input.action, target, output: truncateOutput(chunks.join("\n")), exitCode };
}

export function createOhosHdcHandler(deps: Partial<OhosHdcToolDeps> = {}): ToolHandler<unknown, unknown> {
    const resolved: OhosHdcToolDeps = {
        loadModule: deps.loadModule ?? (() => loadModuleFromBundle(deps.env ?? process.env)),
        env: deps.env ?? process.env,
    };
    return async (input) => {
        const parsed = OhosHdcInputSchema.parse(input) as OhosHdcInput;
        try {
            return await runOhosHdc(parsed, resolved);
        } catch (error) {
            throw toToolError(error);
        }
    };
}

const OHOS_HDC_PROVIDER_DESCRIPTION = [
    "Runs HDC operations against the local HarmonyOS device by talking to hdcd directly over TCP.",
    "",
    "Use it instead of the `hdc` CLI on this platform: the hdc server cannot start inside the app sandbox",
    "(AF_UNIX bind is denied), so `hdc list targets` stays empty and `devecocli run` reports no devices.",
    "When `devecocli run`, `hdc install`, or any hdc command fails with no devices, switch to this tool —",
    "that failure is a sandbox limitation and is not fixable from inside the session.",
    "",
    "Actions: list_targets | shell | file_send | file_recv | screenshot | install.",
    "Install uploads the HAP to /data/local/tmp, runs `bm install -r -d`, and optionally starts the ability.",
    "`screenshot` captures the device display and saves it locally in one call — use it instead of",
    "snapshot_display plus manual transfer scripts.",
    "The first connection asks the user to allow debugging on the device.",
].join("\n");

// 工具入口：仅 OHOS 会话注册（由 handlers/index.ts 门控）
export const ohosHdcToolEntry: ToolEntry = {
    capability: "Run HDC shell, file transfer and HAP install against the local HarmonyOS device",
    metadata: {
        // 平台说明已并入工具描述（不再单独占系统提示词段），alwaysLoad 保证模型一定看到
        alwaysLoad: true,
        name: OHOS_HDC_TOOL_NAME,
        description: OHOS_HDC_PROVIDER_DESCRIPTION,
        modelInstructions: [
            "Use `list_targets` first when unsure whether the device is reachable.",
            "Build and sign HAPs with `hvigorw` / `devecocli` as usual; this tool covers deploy, launch and device logs.",
            "To show the user the running app, call `screenshot` and then Read the returned path; do not build your own transfer.",
            "Prefer `install` over manual `bm install` sequences so the upload is cleaned up.",
        ],
        readOnly: false,
        destructive: true,
        concurrentSafe: false,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        sideEffectScope: "system",
        riskLevel: "high",
        needsApproval: true,
    },
    handler: createOhosHdcHandler(),
    inputSchema: OhosHdcInputJsonSchema,
    outputSchema: OhosHdcOutputJsonSchema,
    runtimeInputSchema: OhosHdcInputSchema,
    runtimeOutputSchema: OhosHdcOutputSchema,
    permission: {
        permission: "ohos.hdc",
        reason: "ohos_hdc runs commands and installs packages on the connected HarmonyOS device",
        riskLevel: "high",
        sideEffectScope: "system",
        needsApproval: true,
        patternSources: ["toolName"],
        alwaysAllowPatternSources: ["toolName"],
        denyPriority: "beforeAsk",
    },
    resultBudget: {
        maxInlineBytes: MAX_OUTPUT_BYTES,
        maxModelBytes: MAX_OUTPUT_BYTES,
        strategy: "truncate",
        preview: {
            maxBytes: MAX_OUTPUT_BYTES,
            direction: "head",
        },
    },
    timeout: {
        defaultMs: DEFAULT_TIMEOUT_MS,
        maxMs: 600_000,
        allowCallOverride: false,
    },
    cancellation: {
        supported: true,
        cleanup: "none",
        userVisibleMessage: "ohos_hdc was cancelled before the device operation completed",
    },
    trace: {
        required: true,
        propagateToAdapters: false,
        recordInput: "summary",
        recordOutput: "summary",
    },
};
