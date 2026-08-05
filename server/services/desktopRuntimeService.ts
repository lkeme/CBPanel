import type { DesktopRuntimeInfo, RuntimePlatform, ShellMode } from "../../src/shared/settings";

type DesktopRuntimeOptions = {
  shellMode: ShellMode;
  host: string;
  port: number;
  portable: boolean;
};

export class DesktopRuntimeService {
  constructor(private readonly options: DesktopRuntimeOptions) {}

  info(): DesktopRuntimeInfo {
    const desktop = this.options.shellMode === "desktop";
    return {
      shell: this.options.shellMode,
      platform: runtimePlatform(),
      chrome: desktop && process.platform === "win32" ? "custom" : "native",
      portable: this.options.portable,
      api: {
        host: this.options.host,
        port: this.options.port,
        tokenRequired: desktop,
      },
      sidecar: {
        status: desktop ? "ready" : "not-applicable",
        detail: desktop ? "Node sidecar API is running on a loopback port." : "Web mode uses the local Node server directly.",
      },
    };
  }
}

function runtimePlatform(): RuntimePlatform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return "unknown";
}
