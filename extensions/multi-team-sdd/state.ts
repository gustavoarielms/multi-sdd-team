import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RuntimeState, SecurityMode } from "./types.js";

const ENTRY_TYPE = "multi-team-sdd-state";

let runtimeState: RuntimeState = {
  securityMode: "passive",
  orchestratorEnabled: true,
  updatedAt: new Date(0).toISOString(),
};

export function getRuntimeState(): RuntimeState {
  return runtimeState;
}

export function setSecurityMode(mode: SecurityMode): void {
  runtimeState = {
    ...runtimeState,
    securityMode: mode,
    updatedAt: new Date().toISOString(),
  };
}

export function setOrchestratorEnabled(enabled: boolean): void {
  runtimeState = {
    ...runtimeState,
    orchestratorEnabled: enabled,
    updatedAt: new Date().toISOString(),
  };
}

export function restoreRuntimeState(ctx: ExtensionContext): RuntimeState {
  runtimeState = {
    securityMode: "passive",
    orchestratorEnabled: true,
    updatedAt: new Date(0).toISOString(),
  };

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
    const data = entry.data as Partial<RuntimeState> | undefined;
    if (!data) continue;

    runtimeState = {
      securityMode: data.securityMode === "active" ? "active" : "passive",
      orchestratorEnabled: data.orchestratorEnabled !== false,
      updatedAt: data.updatedAt ?? runtimeState.updatedAt,
    };
  }

  return runtimeState;
}

export function persistRuntimeState(pi: ExtensionAPI): void {
  pi.appendEntry<RuntimeState>(ENTRY_TYPE, {
    ...runtimeState,
    updatedAt: new Date().toISOString(),
  });
}
