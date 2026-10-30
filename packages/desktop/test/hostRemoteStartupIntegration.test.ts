import { runStartupReconnectBatch } from "../src/host/sourceServerStartupReconnect.js";
import { connectSourceServerTarget } from "../src/host/connectSourceServerTarget.js";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

/** Host 入口依赖 Electron utilityProcess；执行真实函数体，平台与连接端口在本边界注入。 */
async function loadHostSource() {
  const file = new URL("../src/host/index.ts", import.meta.url);
  return ts.createSourceFile(
    file.pathname,
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

function compile(source: string) {
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
    .outputText;
}

interface RemoteServices {
  generation: number;
  clientConfig?: object;
}
interface ReconnectEvent {
  sourceServerId: string;
  serverInfo: { serverId: string; capabilities: { processResourceTelemetry?: boolean } };
  services: RemoteServices;
}
interface RemoteHandle {
  services: RemoteServices;
  onDidReconnect(listener: () => void): void;
  dispose(): Promise<void>;
}

describe("Window Host 的 Source 重连与数据库启动整合", () => {
  it.each([true, false, undefined])(
    "Source 遥测初始声明为 %s 时按能力门控，重连换代刷新能力并释放旧订阅",
    async (initialTelemetryCapability) => {
      const source = await loadHostSource();
      const node = source.statements.find(
        (item): item is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(item) &&
          item.name?.text === "createWindowRemoteConnectionHandle",
      );
      if (!node) throw new Error("Host connection factory is missing");
      const registrations: {
        generation: number;
        disposed: boolean;
        config?: object;
        telemetrySupported: boolean;
      }[] = [];
      let reconnect: ((event: ReconnectEvent) => void) | undefined;
      const info = {
        serverId: "source-1",
        capabilities: { processResourceTelemetry: initialTelemetryCapability },
      };
      const reconnectedInfo = {
        serverId: "source-1",
        capabilities: { processResourceTelemetry: true },
      };
      const clientConfig = { config: "host" };
      const manager = {
        connect: async () => ({
          services: { generation: 1 },
          serverInfo: info,
          sourceServerId: "source-1",
        }),
        onDidChangeState: () => ({ dispose() {} }),
        onDidInvalidateConnection: () => ({ dispose() {} }),
        onDidReconnect: (listener: (event: ReconnectEvent) => void) => {
          reconnect = listener;
          return { dispose() {} };
        },
      };
      const createHandle = runInNewContext(
        `${compile(node.getText(source))};createWindowRemoteConnectionHandle;`,
        {
          connectSourceServerTarget,
          activeServices: { get: () => clientConfig },
          IClientConfigService: {},
          sourceServerDirectory: {
            ensureProfile: async () => ({ profileId: "profile-1" }),
            snapshot: async () => ({ servers: [] }),
          },
          ensureSourceServerConnectionManager: async () => manager,
          sourceServerDisplayNameById: new Map(),
          parentPort: {},
          logger: { warn() {} },
          remoteMediaRangePreviewEnabled: false,
          createServerRemoteWorkspaceServiceCollection: (params: {
            connectionServices: RemoteServices;
            clientConfigService: object;
          }) => ({
            generation: params.connectionServices.generation,
            clientConfig: params.clientConfigService,
          }),
          resolveResourceTelemetryEnvironmentKey: () => "environment",
          registerHostServiceResourceTelemetry: (params: {
            services: RemoteServices;
            telemetrySupported: boolean;
          }) => {
            const registration = {
              generation: params.services.generation,
              disposed: false,
              config: params.services.clientConfig,
              telemetrySupported: params.telemetrySupported,
            };
            registrations.push(registration);
            return {
              dispose() {
                registration.disposed = true;
              },
            };
          },
          disposeHostRemoteConnection: async (connection: { dispose(): void }) =>
            connection.dispose(),
        },
      ) as (params: {
        target: { kind: "ssh" };
        signal: AbortSignal;
        remoteAssets: object;
      }) => Promise<RemoteHandle>;
      const handle = await createHandle({
        target: { kind: "ssh" },
        signal: new AbortController().signal,
        remoteAssets: {},
      });
      const generations: number[] = [];
      handle.onDidReconnect(() => generations.push(handle.services.generation));
      reconnect?.({
        sourceServerId: "source-1",
        serverInfo: reconnectedInfo,
        services: { generation: 2 },
      });

      expect(generations).toEqual([2]);
      expect(registrations).toEqual([
        {
          generation: 1,
          disposed: true,
          config: clientConfig,
          telemetrySupported: initialTelemetryCapability === true,
        },
        { generation: 2, disposed: false, config: clientConfig, telemetrySupported: true },
      ]);
      await handle.dispose();
      expect(registrations.every((registration) => registration.disposed)).toBe(true);
      reconnect?.({
        sourceServerId: "source-1",
        serverInfo: reconnectedInfo,
        services: { generation: 3 },
      });
      expect(handle.services.generation).toBe(2);
      expect(registrations).toHaveLength(2);
    },
  );

  it("业务服务只在数据库准备完成后创建；OHOS 启动接缝保留", async () => {
    const source = await loadHostSource();
    let initNode: ts.IfStatement | undefined;
    function findInit(node: ts.Node): void {
      if (
        ts.isIfStatement(node) &&
        node.expression.getText(source) === "msg.type === HostMessageTypes.InitLocal"
      ) {
        initNode = node;
      } else {
        ts.forEachChild(node, findInit);
      }
    }
    findInit(source);
    if (!initNode) throw new Error("Host InitLocal handler is missing");
    const blockText = initNode.getText(source);

    // 上游 v3.17.1 把启动编排抽到 createHostDatabaseStartup({ initializeServices })。
    // 时序保证（原 vm 用例语义）：createLocalServices 只允许出现在 initializeServices
    // 回调体内——数据库准备先行，业务服务随后创建，回调外不得直接创建业务服务。
    const createLocalServicesCalls: ts.CallExpression[] = [];
    const initializeServiceCallbacks: ts.FunctionLikeDeclaration[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "createLocalServices"
      ) {
        createLocalServicesCalls.push(node);
      }
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "initializeServices" &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        initializeServiceCallbacks.push(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(initNode);
    expect(initializeServiceCallbacks.length).toBeGreaterThan(0);
    expect(createLocalServicesCalls.length).toBeGreaterThan(0);
    for (const call of createLocalServicesCalls) {
      const insideCallback = initializeServiceCallbacks.some(
        (callback) => call.pos >= callback.pos && call.end <= callback.end,
      );
      expect(
        insideCallback,
        `createLocalServices 调用必须位于 initializeServices 回调内: ${call.getText(source)}`,
      ).toBe(true);
    }

    // OHOS 接缝（specs/ohos-port/02）：agent spawn cwd 回退、官方插件资源根经
    // InitLocal 消息下发（fork env 传不进 appspawn host）、浏览器后端身份透传。
    expect(blockText).toContain("msg.agentSpawnFallbackCwd ?? resolveDefaultSpawnCwd()");
    expect(blockText).toContain("process.env.ZCODE_BUNDLED_RESOURCE_DIR = msg.bundledResourceDir");
    expect(blockText).toContain("browserBackendIdentity = msg.browserBackendIdentity");
  });
});
