import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";

const SAFE_CONFIGURED_PROFILES = new Set(["workspace-only", "workspace", "read-only"]);
const SAFE_RUNTIME_PROFILES = new Set(["workspace-only", ":workspace", ":read-only"]);
const SAFE_RUNTIME_SANDBOXES = new Set(["seatbelt"]);
const LEGACY_RUNTIME_SANDBOXES = new Set(["read-only", "workspace-write"]);
const DENIED_ERROR_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

function result(state, reasonCode, trusted = false) {
  return { state, trusted, reason_code: reasonCode };
}

function isLegacyRuntime(legacySettings, runtimeProfile, runtimeSandbox) {
  return legacySettings.length > 0
    || runtimeProfile === "workspace-write"
    || LEGACY_RUNTIME_SANDBOXES.has(runtimeSandbox);
}

function isElevatedRuntime(configuredProfile, runtimeProfile, runtimeSandbox) {
  return configuredProfile === "danger-full-access"
    || runtimeProfile === ":danger-full-access"
    || runtimeSandbox === "danger-full-access";
}

function isSupportedRuntime(configuredProfile, runtimeProfile, runtimeSandbox) {
  return SAFE_CONFIGURED_PROFILES.has(configuredProfile)
    && SAFE_RUNTIME_PROFILES.has(runtimeProfile)
    && SAFE_RUNTIME_SANDBOXES.has(runtimeSandbox);
}

export function classifyPromptProtection({
  configuredProfile,
  runtimeProfile,
  runtimeSandbox,
  promptDrift = [],
  unsafePaths = [],
  legacySettings = [],
  probe = {},
}) {
  if (unsafePaths.length > 0) return result("unsafe", "MANAGED_PROMPT_UNSAFE_PATH");
  if (promptDrift.length > 0) return result("drifted", "MANAGED_PROMPT_DRIFT");
  if (isLegacyRuntime(legacySettings, runtimeProfile, runtimeSandbox)) {
    return result("legacy", "MANAGED_PROMPT_LEGACY_RUNTIME");
  }
  if (isElevatedRuntime(configuredProfile, runtimeProfile, runtimeSandbox)) {
    return result("elevated", "MANAGED_PROMPT_ELEVATED_PROFILE");
  }
  if (!isSupportedRuntime(configuredProfile, runtimeProfile, runtimeSandbox)) {
    return result("unproven", "MANAGED_PROMPT_RUNTIME_UNPROVEN");
  }
  if (probe.fileWrite === "writable" || probe.directoryMutation === "writable") {
    return result("elevated", "MANAGED_PROMPT_BOUNDARY_WRITABLE");
  }
  if (probe.fileWrite !== "denied" || probe.directoryMutation !== "denied") {
    return result("unproven", "MANAGED_PROMPT_RUNTIME_UNPROVEN");
  }
  return result("protected", "MANAGED_PROMPTS_PROTECTED", true);
}

function classifyProbeError(error) {
  if (DENIED_ERROR_CODES.has(error?.code)) return "denied";
  return "unknown";
}

export async function probeManagedPromptBoundary(agentsRoot, promptPath, options = {}) {
  const fileSystem = options.fs ?? fs;
  let fileWrite;
  try {
    const flags = fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await fileSystem.open(promptPath, flags);
    await handle.close();
    fileWrite = "writable";
  } catch (error) {
    fileWrite = classifyProbeError(error);
  }

  let directoryMutation;
  try {
    await fileSystem.access(agentsRoot, fsConstants.W_OK);
    directoryMutation = "writable";
  } catch (error) {
    directoryMutation = classifyProbeError(error);
  }

  return { fileWrite, directoryMutation };
}
