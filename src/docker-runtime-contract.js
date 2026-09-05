import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const BROKER_REASON_CODES = Object.freeze([
  "BROKER_RUNTIME_PROTECTED",
  "BROKER_PROCESS_CONTAINMENT_UNAVAILABLE",
  "BROKER_DOCKER_CONTRACT_INPUT_INVALID",
  "BROKER_IMAGE_REFERENCE_MUTABLE",
  "BROKER_CONTAINER_INSPECT_INVALID",
  "BROKER_CONTAINER_IMAGE_MISMATCH",
  "BROKER_CONTAINER_USER_MISMATCH",
  "BROKER_CONTAINER_MOUNT_MISMATCH",
  "BROKER_CONTAINER_READONLY_UNAVAILABLE",
  "BROKER_CONTAINER_PRIVILEGE_MISMATCH",
  "BROKER_CONTAINER_NAMESPACE_MISMATCH",
  "BROKER_CONTAINER_CAPABILITY_MISMATCH",
  "BROKER_CONTAINER_DEVICE_MISMATCH",
  "BROKER_CONTAINER_RESOURCE_MISMATCH",
  "BROKER_CONTAINER_LABEL_MISMATCH",
  "BROKER_LAUNCH_RESULT_INVALID",
]);

const PACKAGE_LABEL = "io.github.gustavoarielms.sdd-codegraph.package";
const CONTRACT_LABEL = "io.github.gustavoarielms.sdd-codegraph.contract-version";
const RUN_LABEL = "io.github.gustavoarielms.sdd-codegraph.run-id";
const PACKAGE_NAME = "@gustavoarielms/sdd-codegraph-cli";
const CONTRACT_VERSION = "1";
const WORKSPACE = "/workspace";
const CODEX_HOME = "/run/codex";
const TMP = "/tmp";
const TMPFS_SIZE_BYTES = 67_108_864;
const MEMORY_BYTES = 1_073_741_824;
const NANO_CPUS = 2_000_000_000;
const PIDS_LIMIT = 256;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const IMAGE_PATTERN = /^[A-Za-z0-9._/-]+@sha256:[a-f0-9]{64}$/u;
const RUN_ID_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_USER_PATTERN = /^[1-9][0-9]*(?::[1-9][0-9]*)?$/u;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const REASON_CODE_SET = new Set(BROKER_REASON_CODES);

const PERMISSION_PROFILES = Object.freeze(["workspace-only", "read-only"]);
const RESOURCE_LIMITS = Object.freeze({
  memoryBytes: MEMORY_BYTES,
  nanoCpus: NANO_CPUS,
  pidsLimit: PIDS_LIMIT,
});
const RUNTIME_LIMITS = Object.freeze({
  interruptTimeoutMs: 1_000,
  operationTimeoutMs: 30_000,
  removalTimeoutMs: 10_000,
  startupTimeoutMs: 30_000,
  stderrBytes: 1_048_576,
  stdoutBytes: 1_048_576,
  turnTimeoutMs: 120_000,
});

export const DOCKER_RUNTIME_CONTRACT = Object.freeze({
  capabilityAdd: Object.freeze([]),
  capabilityDrop: Object.freeze(["ALL"]),
  codexHome: CODEX_HOME,
  contractVersion: CONTRACT_VERSION,
  labels: Object.freeze({
    contract: CONTRACT_LABEL,
    package: PACKAGE_LABEL,
    run: RUN_LABEL,
  }),
  limits: RUNTIME_LIMITS,
  namespaces: Object.freeze({
    ipc: "private",
    network: "bridge",
    pid: "private",
    user: "private",
    uts: "private",
  }),
  packageName: PACKAGE_NAME,
  permissionProfiles: PERMISSION_PROFILES,
  resources: RESOURCE_LIMITS,
  tmp: TMP,
  tmpfsSizeBytes: TMPFS_SIZE_BYTES,
  workspace: WORKSPACE,
});

export const DOCKER_LAUNCHER_RESULT_SCHEMA = deepFreeze({
  $id: "https://github.com/gustavoarielms/multi-sdd-team/docker-launcher-result.schema.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $comment: "Structural validation only; validateDockerLauncherResult is required for semantic identity correlation.",
  type: "object",
  additionalProperties: false,
  required: ["trusted", "reason_code", "runtime", "permission_profile"],
  properties: {
    trusted: { type: "boolean" },
    reason_code: { type: "string", enum: BROKER_REASON_CODES },
    runtime: { const: "docker" },
    permission_profile: { type: "string", enum: PERMISSION_PROFILES },
    prompt_snapshot_sha256: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    container_image_digest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    sessionId: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
    threadId: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
    turnId: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
    completion: {
      type: "object",
      additionalProperties: false,
      required: ["threadId", "turn"],
      properties: {
        threadId: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
        turn: {
          type: "object",
          additionalProperties: false,
          required: ["id", "status"],
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" },
            status: { type: "string", enum: ["completed", "failed", "interrupted", "disabled"] },
          },
        },
      },
    },
  },
  allOf: [{
    if: {
      properties: { trusted: { const: true } },
      required: ["trusted"],
    },
    then: {
      required: [
        "prompt_snapshot_sha256",
        "container_image_digest",
        "threadId",
        "turnId",
        "completion",
      ],
      properties: {
        prompt_snapshot_sha256: {},
        container_image_digest: {},
        threadId: {},
        turnId: {},
        reason_code: { const: "BROKER_RUNTIME_PROTECTED" },
        completion: {
          type: "object",
          properties: {
            turn: {
              type: "object",
              properties: { status: { const: "completed" } },
            },
          },
        },
      },
    },
    else: {
      properties: {
        reason_code: { not: { const: "BROKER_RUNTIME_PROTECTED" } },
      },
    },
  }],
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function contractError(reasonCode) {
  return new Error(reasonCode);
}

function requireContract(condition, reasonCode) {
  if (!condition) throw contractError(reasonCode);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keysEqual(value, expected) {
  return isRecord(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

function requireExactKeys(value, expected, reasonCode) {
  requireContract(keysEqual(value, expected), reasonCode);
}

function requireNoUnknownKeys(value, expected, reasonCode) {
  requireContract(
    isRecord(value) && Object.keys(value).every((key) => expected.includes(key)),
    reasonCode,
  );
}

function isAbsoluteProjectRoot(projectRoot) {
  return typeof projectRoot === "string"
    && projectRoot.length > 1
    && (path.posix.isAbsolute(projectRoot) || path.win32.isAbsolute(projectRoot))
    && projectPathApi(projectRoot).normalize(projectRoot) === projectRoot
    && !projectRoot.endsWith("/")
    && !projectRoot.endsWith("\\")
    && !projectRoot.includes(",")
    && ![...projectRoot].some((character) => character.codePointAt(0) <= 31);
}

function projectPathApi(projectRoot) {
  return path.posix.isAbsolute(projectRoot) ? path.posix : path.win32;
}

function validateRuntimeInput(input) {
  requireExactKeys(
    input,
    ["approvedImage", "permissionProfile", "projectRoot", "runId"],
    "BROKER_DOCKER_CONTRACT_INPUT_INVALID",
  );
  requireExactKeys(
    input.approvedImage,
    ["digest", "reference", "user"],
    "BROKER_DOCKER_CONTRACT_INPUT_INVALID",
  );
  requireContract(
    PERMISSION_PROFILES.includes(input.permissionProfile),
    "BROKER_DOCKER_CONTRACT_INPUT_INVALID",
  );
  requireContract(isAbsoluteProjectRoot(input.projectRoot), "BROKER_DOCKER_CONTRACT_INPUT_INVALID");
  requireContract(
    typeof input.runId === "string"
      && typeof input.approvedImage.digest === "string"
      && typeof input.approvedImage.reference === "string"
      && typeof input.approvedImage.user === "string"
      && RUN_ID_PATTERN.test(input.runId)
      && SAFE_USER_PATTERN.test(input.approvedImage.user),
    "BROKER_DOCKER_CONTRACT_INPUT_INVALID",
  );
  requireContract(
    DIGEST_PATTERN.test(input.approvedImage.digest)
      && IMAGE_PATTERN.test(input.approvedImage.reference)
      && input.approvedImage.reference.endsWith(`@${input.approvedImage.digest}`),
    "BROKER_IMAGE_REFERENCE_MUTABLE",
  );
  return input;
}

function expectedLabels(runId) {
  return {
    [CONTRACT_LABEL]: CONTRACT_VERSION,
    [PACKAGE_LABEL]: PACKAGE_NAME,
    [RUN_LABEL]: runId,
  };
}

function expectedMounts(projectRoot, permissionProfile) {
  const readOnlyProject = permissionProfile === "read-only";
  const projectPath = projectPathApi(projectRoot);
  return [
    {
      destination: WORKSPACE,
      propagation: "rprivate",
      readOnly: readOnlyProject,
      recursiveReadOnly: readOnlyProject,
      source: projectRoot,
      type: "bind",
    },
    {
      destination: `${WORKSPACE}/.codex`,
      propagation: "rprivate",
      readOnly: true,
      recursiveReadOnly: true,
      source: projectPath.join(projectRoot, ".codex"),
      type: "bind",
    },
    {
      destination: CODEX_HOME,
      mode: 0o700,
      readOnly: false,
      sizeBytes: TMPFS_SIZE_BYTES,
      type: "tmpfs",
    },
    {
      destination: TMP,
      mode: 0o1777,
      readOnly: false,
      sizeBytes: TMPFS_SIZE_BYTES,
      type: "tmpfs",
    },
  ];
}

function bindMountArgument(mount) {
  const options = [
    "type=bind",
    `src=${mount.source}`,
    `dst=${mount.destination}`,
  ];
  if (mount.readOnly) options.push("readonly");
  options.push(`bind-propagation=${mount.propagation}`);
  if (mount.recursiveReadOnly) options.push("bind-recursive=readonly");
  return `--mount=${options.join(",")}`;
}

function tmpfsMountArgument(mount) {
  const mode = mount.mode === 0o700 ? "0700" : "01777";
  return `--mount=type=tmpfs,dst=${mount.destination},tmpfs-size=${mount.sizeBytes},tmpfs-mode=${mode}`;
}

export function buildDockerCreateInvocation(input) {
  validateRuntimeInput(input);
  const labels = expectedLabels(input.runId);
  const mounts = expectedMounts(input.projectRoot, input.permissionProfile);
  return {
    command: "docker",
    shell: false,
    args: [
      "create",
      "--pull=never",
      `--label=${PACKAGE_LABEL}=${labels[PACKAGE_LABEL]}`,
      `--label=${CONTRACT_LABEL}=${labels[CONTRACT_LABEL]}`,
      `--label=${RUN_LABEL}=${labels[RUN_LABEL]}`,
      "--read-only",
      "--privileged=false",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges=true",
      `--pids-limit=${PIDS_LIMIT}`,
      `--memory=${MEMORY_BYTES}`,
      `--cpus=${NANO_CPUS / 1_000_000_000}`,
      "--network=bridge",
      "--ipc=private",
      `--user=${input.approvedImage.user}`,
      `--workdir=${WORKSPACE}`,
      `--env=CODEX_HOME=${CODEX_HOME}`,
      bindMountArgument(mounts[0]),
      bindMountArgument(mounts[1]),
      tmpfsMountArgument(mounts[2]),
      tmpfsMountArgument(mounts[3]),
      input.approvedImage.reference,
    ],
  };
}

function validateInspectImage(image, approvedImage) {
  requireExactKeys(image, ["digest", "reference", "user"], "BROKER_CONTAINER_IMAGE_MISMATCH");
  requireContract(
    IMAGE_PATTERN.test(image.reference)
      && image.reference === approvedImage.reference
      && image.digest === approvedImage.digest,
    "BROKER_CONTAINER_IMAGE_MISMATCH",
  );
  requireContract(image.user === approvedImage.user, "BROKER_CONTAINER_USER_MISMATCH");
}

function validateInspectPrivileges(inspect) {
  requireContract(inspect.rootfsReadOnly === true, "BROKER_CONTAINER_READONLY_UNAVAILABLE");
  requireContract(
    inspect.privileged === false && inspect.noNewPrivileges === true,
    "BROKER_CONTAINER_PRIVILEGE_MISMATCH",
  );
  requireExactKeys(inspect.capabilities, ["add", "drop"], "BROKER_CONTAINER_CAPABILITY_MISMATCH");
  requireContract(
    isDeepStrictEqual(inspect.capabilities, { add: [], drop: ["ALL"] }),
    "BROKER_CONTAINER_CAPABILITY_MISMATCH",
  );
  requireContract(Array.isArray(inspect.devices) && inspect.devices.length === 0, "BROKER_CONTAINER_DEVICE_MISMATCH");
}

function validateInspectNamespaces(namespaces) {
  requireExactKeys(
    namespaces,
    ["ipc", "network", "pid", "user", "uts"],
    "BROKER_CONTAINER_NAMESPACE_MISMATCH",
  );
  requireContract(
    isDeepStrictEqual(namespaces, DOCKER_RUNTIME_CONTRACT.namespaces),
    "BROKER_CONTAINER_NAMESPACE_MISMATCH",
  );
}

function validateInspectMounts(mounts, input) {
  requireContract(Array.isArray(mounts) && mounts.length === 4, "BROKER_CONTAINER_MOUNT_MISMATCH");
  const expected = expectedMounts(input.projectRoot, input.permissionProfile);
  for (let index = 0; index < 2; index += 1) {
    requireContract(
      isRecord(mounts[index]) && Object.keys(mounts[index]).length === 6,
      "BROKER_CONTAINER_MOUNT_MISMATCH",
    );
  }
  const recursivelyReadOnly = mounts[1].recursiveReadOnly === true
    && (input.permissionProfile !== "read-only" || mounts[0].recursiveReadOnly === true);
  requireContract(recursivelyReadOnly, "BROKER_CONTAINER_READONLY_UNAVAILABLE");
  requireContract(isDeepStrictEqual(mounts, expected), "BROKER_CONTAINER_MOUNT_MISMATCH");
}

function validateInspectResources(resources) {
  requireExactKeys(
    resources,
    ["memoryBytes", "nanoCpus", "pidsLimit"],
    "BROKER_CONTAINER_RESOURCE_MISMATCH",
  );
  requireContract(isDeepStrictEqual(resources, RESOURCE_LIMITS), "BROKER_CONTAINER_RESOURCE_MISMATCH");
}

export function validateDockerInspect(inspect, input) {
  validateRuntimeInput(input);
  requireNoUnknownKeys(inspect, [
    "capabilities",
    "devices",
    "image",
    "labels",
    "mounts",
    "namespaces",
    "noNewPrivileges",
    "privileged",
    "resources",
    "rootfsReadOnly",
    "workingDirectory",
  ], "BROKER_CONTAINER_INSPECT_INVALID");
  validateInspectImage(inspect.image, input.approvedImage);
  requireContract(inspect.workingDirectory === WORKSPACE, "BROKER_CONTAINER_INSPECT_INVALID");
  validateInspectPrivileges(inspect);
  validateInspectNamespaces(inspect.namespaces);
  validateInspectMounts(inspect.mounts, input);
  validateInspectResources(inspect.resources);
  requireExactKeys(inspect.labels, [CONTRACT_LABEL, PACKAGE_LABEL, RUN_LABEL], "BROKER_CONTAINER_LABEL_MISMATCH");
  requireContract(
    isDeepStrictEqual(inspect.labels, expectedLabels(input.runId)),
    "BROKER_CONTAINER_LABEL_MISMATCH",
  );
  return inspect;
}

function validIdentifier(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function validateCompletion(result) {
  requireExactKeys(result.completion, ["threadId", "turn"], "BROKER_LAUNCH_RESULT_INVALID");
  requireExactKeys(result.completion.turn, ["id", "status"], "BROKER_LAUNCH_RESULT_INVALID");
  requireContract(
    result.completion.threadId === result.threadId
      && result.completion.turn.id === result.turnId
      && ["completed", "failed", "interrupted", "disabled"].includes(result.completion.turn.status),
    "BROKER_LAUNCH_RESULT_INVALID",
  );
}

export function validateDockerLauncherResult(result) {
  const allowed = [
    "completion",
    "container_image_digest",
    "permission_profile",
    "prompt_snapshot_sha256",
    "reason_code",
    "runtime",
    "sessionId",
    "threadId",
    "trusted",
    "turnId",
  ];
  requireNoUnknownKeys(result, allowed, "BROKER_LAUNCH_RESULT_INVALID");
  requireContract(
    typeof result.trusted === "boolean"
      && result.runtime === "docker"
      && PERMISSION_PROFILES.includes(result.permission_profile)
      && REASON_CODE_SET.has(result.reason_code),
    "BROKER_LAUNCH_RESULT_INVALID",
  );
  for (const digest of [result.prompt_snapshot_sha256, result.container_image_digest]) {
    if (digest !== undefined) {
      requireContract(
        typeof digest === "string" && DIGEST_PATTERN.test(digest),
        "BROKER_LAUNCH_RESULT_INVALID",
      );
    }
  }
  if (result.sessionId !== undefined) requireContract(validIdentifier(result.sessionId), "BROKER_LAUNCH_RESULT_INVALID");
  const hasLifecycle = [result.threadId, result.turnId, result.completion].some((value) => value !== undefined);
  if (hasLifecycle) {
    requireContract(validIdentifier(result.threadId) && validIdentifier(result.turnId), "BROKER_LAUNCH_RESULT_INVALID");
    validateCompletion(result);
  }
  if (result.trusted) {
    requireContract(
      result.reason_code === "BROKER_RUNTIME_PROTECTED"
        && DIGEST_PATTERN.test(result.prompt_snapshot_sha256)
        && DIGEST_PATTERN.test(result.container_image_digest)
        && hasLifecycle
        && result.completion.turn.status === "completed",
      "BROKER_LAUNCH_RESULT_INVALID",
    );
  } else {
    requireContract(result.reason_code !== "BROKER_RUNTIME_PROTECTED", "BROKER_LAUNCH_RESULT_INVALID");
  }
  return result;
}
