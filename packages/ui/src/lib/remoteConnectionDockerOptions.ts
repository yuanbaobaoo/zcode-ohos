import type { DockerContainerInfo, IPlatformService, RemoteTarget } from "@zcode/shared";

/** OHOS 没有 docker CLI/daemon；UI 保留入口，但选中后只提示不支持 (spec 02)。 */
export function isDockerConnectionUnsupportedOnOhos(input: {
  kind: RemoteTarget["kind"];
  isOhos: boolean;
}): boolean {
  return input.kind === "docker" && input.isOhos;
}

type DockerOptionsPlatform = Pick<IPlatformService, "isDockerAvailable" | "listDockerContainers">;

export interface RemoteConnectionDockerOptionsResult {
  dockerAvailable: boolean | null;
  dockerContainers: DockerContainerInfo[];
  error: string;
}

export async function loadRemoteConnectionDockerOptions(
  platform: DockerOptionsPlatform,
): Promise<RemoteConnectionDockerOptionsResult> {
  try {
    const dockerAvailable = await platform.isDockerAvailable();
    if (!dockerAvailable) {
      return {
        dockerAvailable: false,
        dockerContainers: [],
        error: "",
      };
    }

    const dockerContainers = await platform.listDockerContainers();
    return {
      dockerAvailable: true,
      dockerContainers,
      error: "",
    };
  } catch (runtimeError) {
    return {
      dockerAvailable: null,
      dockerContainers: [],
      error: String(runtimeError),
    };
  }
}

export function resolveDockerContainerSelectionAfterRefresh({
  currentContainer,
  dockerContainers,
}: {
  currentContainer: string;
  dockerContainers: DockerContainerInfo[];
}): string {
  const selectedContainer = currentContainer.trim();
  if (!selectedContainer) {
    return "";
  }

  const selectedContainerStillRunning = dockerContainers.some(
    (container) => container.name === selectedContainer || container.id === selectedContainer,
  );

  return selectedContainerStillRunning ? selectedContainer : "";
}
