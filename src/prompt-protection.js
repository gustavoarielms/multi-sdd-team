import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";

const SAFE_CONFIGURED_PROFILES = new Set(["workspace-only", "workspace", "read-only"]);
const DENIED_ERROR_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

function result(state, reasonCode, trusted = false) {
  return { state, trusted, reason_code: reasonCode };
}

function probeStates(probe) {
  return [...(probe.fileWrites ?? []), ...(probe.directoryMutations ?? [])];
}

function configuredProfileResult(configuredProfile) {
  if (configuredProfile === "danger-full-access") {
    return result("elevated", "MANAGED_PROMPT_ELEVATED_PROFILE");
  }
  return SAFE_CONFIGURED_PROFILES.has(configuredProfile)
    ? undefined
    : result("unproven", "MANAGED_PROMPT_RUNTIME_UNPROVEN");
}

export function classifyPromptProtection({
  configuredProfile,
  promptDrift = [],
  unsafePaths = [],
  legacySettings = [],
  probe = {},
}) {
  if (unsafePaths.length > 0) return result("unsafe", "MANAGED_PROMPT_UNSAFE_PATH");
  if (promptDrift.length > 0) return result("drifted", "MANAGED_PROMPT_DRIFT");
  if (legacySettings.length > 0) {
    return result("legacy", "MANAGED_PROMPT_LEGACY_RUNTIME");
  }
  const configured = configuredProfileResult(configuredProfile);
  if (configured) return configured;
  if (probe.complete !== true) return result("unproven", "MANAGED_PROMPT_RUNTIME_UNPROVEN");
  const states = probeStates(probe);
  if (states.includes("writable")) {
    return result("elevated", "MANAGED_PROMPT_BOUNDARY_WRITABLE");
  }
  if (states.length === 0 || states.some((state) => state !== "denied")) {
    return result("unproven", "MANAGED_PROMPT_RUNTIME_UNPROVEN");
  }
  return result("unproven", "MANAGED_PROMPT_RUNTIME_UNPROVEN");
}

function classifyProbeError(error) {
  if (DENIED_ERROR_CODES.has(error?.code)) return "denied";
  return "unknown";
}

async function probeFileWrite(fileSystem, promptPath) {
  try {
    const flags = fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
    const handle = await fileSystem.open(promptPath, flags);
    await handle.close();
    return "writable";
  } catch (error) {
    return classifyProbeError(error);
  }
}

async function probeDirectoryMutation(fileSystem, directoryPath) {
  try {
    await fileSystem.access(directoryPath, fsConstants.W_OK);
    return "writable";
  } catch (error) {
    return classifyProbeError(error);
  }
}

export async function probeManagedPromptBoundary(directoryPaths, promptPaths, options = {}) {
  const fileSystem = options.fs ?? fs;
  const [fileWrites, directoryMutations] = await Promise.all([
    Promise.all(promptPaths.map((promptPath) => probeFileWrite(fileSystem, promptPath))),
    Promise.all(directoryPaths.map((directoryPath) => (
      probeDirectoryMutation(fileSystem, directoryPath)
    ))),
  ]);
  return { fileWrites, directoryMutations };
}
