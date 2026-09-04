import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { checkCodeGraph, checkProjectFiles } from "./installer.js";
import { runGovernanceChecks } from "./governance-checks.js";
import {
  assertSupportedNodeRuntime,
  BROKER_PERMISSION_PROFILE_IDS,
} from "./runtime-attestation.js";
import { captureProcessIdentity, terminateProcessTree } from "./engineering-gate-runtime.js";

export const BROKER_TOOL_NAME = "sdd_runtime_control";
const APPROVAL_REQUESTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);
const MAX_TOOL_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_RPC_INPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT_SERVER_REQUESTS = 8;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 1_000;
const DEFAULT_PERMISSION_ATTESTATION_TIMEOUT_MS = 1_000;
const MAX_PROMPT_FILE_BYTES = 1024 * 1024;
const MAX_MANAGED_PROMPT_COUNT = 64;
const MAX_MANAGED_PROMPT_TOTAL_BYTES = 8 * 1024 * 1024;
const PROMPT_READ_CHUNK_BYTES = 64 * 1024;
const RUNTIME_UNPROVEN = "BROKER_RUNTIME_EVIDENCE_UNAVAILABLE";
const PROCESS_CONTAINMENT_UNAVAILABLE = "BROKER_PROCESS_CONTAINMENT_UNAVAILABLE";

function brokerError(reasonCode) {
  return new Error(reasonCode);
}

function brokerReason(error) {
  return /^BROKER_[A-Z0-9_]+$/u.test(error?.message ?? "");
}

function exactOperation(arguments_) {
  return arguments_
    && typeof arguments_ === "object"
    && !Array.isArray(arguments_)
    && Object.keys(arguments_).length === 1
    && ["check", "governance"].includes(arguments_.operation)
    ? arguments_.operation
    : undefined;
}

function permissionProfileId(profile) {
  const id = BROKER_PERMISSION_PROFILE_IDS[profile];
  if (!id) throw brokerError("BROKER_UNSAFE_PERMISSION_PROFILE");
  return id;
}

function sandboxType(profile) {
  return profile === "read-only" ? "readOnly" : "workspaceWrite";
}

function sameRoots(actual, expected) {
  return Array.isArray(actual) && actual.length === 1 && actual[0] === expected;
}

function requireValue(condition, reasonCode) {
  if (!condition) throw brokerError(reasonCode);
}

function withDeadline(operation, timeoutMs, reasonCode, onTimeout = () => {}) {
  requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "BROKER_TIMEOUT_INVALID");
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      Promise.resolve()
        .then(onTimeout)
        .then(() => reject(brokerError(reasonCode)), reject);
    }, timeoutMs);
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error);
        },
      );
  });
}

function toolText(value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_TOOL_OUTPUT_BYTES) {
    throw brokerError("BROKER_RESULT_TOO_LARGE");
  }
  return text;
}

function withinRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sameFilesystemIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sameStableFile(left, right) {
  return sameFilesystemIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function managedDirectoryIdentities(projectRoot, filePath) {
  requireValue(withinRoot(projectRoot, filePath) && filePath !== projectRoot, "BROKER_PROMPT_SNAPSHOT_UNSAFE");
  const relative = path.relative(projectRoot, filePath);
  const segments = relative.split(path.sep);
  const identities = [];
  let current = projectRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let metadata;
    let resolved;
    try {
      [metadata, resolved] = await Promise.all([
        fs.lstat(current, { bigint: true }),
        fs.realpath(current),
      ]);
    } catch {
      throw brokerError("BROKER_PROMPT_SNAPSHOT_UNSAFE");
    }
    requireValue(metadata.isDirectory() && !metadata.isSymbolicLink(), "BROKER_PROMPT_SNAPSHOT_UNSAFE");
    requireValue(withinRoot(projectRoot, resolved), "BROKER_PROMPT_SNAPSHOT_UNSAFE");
    identities.push({ metadata, path: current });
  }
  return identities;
}

async function requireUnchangedDirectories(projectRoot, filePath, expected) {
  const current = await managedDirectoryIdentities(projectRoot, filePath);
  requireValue(current.length === expected.length, "BROKER_PROMPT_SNAPSHOT_UNSAFE");
  for (let index = 0; index < expected.length; index += 1) {
    requireValue(
      current[index].path === expected[index].path
      && sameFilesystemIdentity(current[index].metadata, expected[index].metadata),
      "BROKER_PROMPT_SNAPSHOT_UNSAFE",
    );
  }
}

async function requireDescriptorPath(projectRoot, filePath, descriptorMetadata) {
  let pathMetadata;
  let resolved;
  try {
    [pathMetadata, resolved] = await Promise.all([
      fs.lstat(filePath, { bigint: true }),
      fs.realpath(filePath),
    ]);
  } catch {
    throw brokerError("BROKER_PROMPT_SNAPSHOT_UNSAFE");
  }
  requireValue(
    pathMetadata.isFile()
    && !pathMetadata.isSymbolicLink()
    && sameFilesystemIdentity(pathMetadata, descriptorMetadata)
    && withinRoot(projectRoot, resolved),
    "BROKER_PROMPT_SNAPSHOT_UNSAFE",
  );
}

async function readPromptDescriptor(projectRoot, filePath, maxBytes, testHooks, handle, directories) {
  await testHooks?.afterPromptFileOpen?.({ filePath, handle });
  const before = await handle.stat({ bigint: true });
  requireValue(before.isFile() && !before.isSymbolicLink(), "BROKER_PROMPT_SNAPSHOT_UNSAFE");
  requireValue(before.size <= BigInt(maxBytes), "BROKER_PROMPT_SNAPSHOT_TOO_LARGE");
  await testHooks?.afterPromptFileStat?.({ filePath, handle, metadata: before });
  await requireUnchangedDirectories(projectRoot, filePath, directories);
  await requireDescriptorPath(projectRoot, filePath, before);

  const buffer = Buffer.alloc(maxBytes + 1);
  let totalBytesRead = 0;
  while (totalBytesRead < buffer.length) {
    const length = Math.min(PROMPT_READ_CHUNK_BYTES, buffer.length - totalBytesRead);
    const { bytesRead } = await handle.read(buffer, totalBytesRead, length, totalBytesRead);
    await testHooks?.onPromptFileRead?.({ bytesRead, filePath, totalBytesRead: totalBytesRead + bytesRead });
    if (bytesRead === 0) break;
    totalBytesRead += bytesRead;
  }
  requireValue(totalBytesRead <= maxBytes, "BROKER_PROMPT_SNAPSHOT_TOO_LARGE");
  const after = await handle.stat({ bigint: true });
  requireValue(sameStableFile(before, after), "BROKER_PROMPT_SNAPSHOT_UNSAFE");
  await requireUnchangedDirectories(projectRoot, filePath, directories);
  await requireDescriptorPath(projectRoot, filePath, after);
  return buffer.subarray(0, totalBytesRead);
}

async function readBoundedPromptFile(projectRoot, filePath, maxBytes, testHooks) {
  requireValue(Number.isSafeInteger(maxBytes) && maxBytes >= 0, "BROKER_PROMPT_SNAPSHOT_TOO_LARGE");
  const directories = await managedDirectoryIdentities(projectRoot, filePath);
  const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | noFollow);
  } catch {
    throw brokerError("BROKER_PROMPT_SNAPSHOT_UNSAFE");
  }
  let bytes;
  let failure;
  try {
    bytes = await readPromptDescriptor(projectRoot, filePath, maxBytes, testHooks, handle, directories);
  } catch (error) {
    failure = brokerReason(error) ? error : brokerError("BROKER_PROMPT_SNAPSHOT_UNSAFE");
  }
  try {
    await handle.close();
  } catch {
    failure ??= brokerError("BROKER_PROMPT_SNAPSHOT_UNSAFE");
  }
  if (failure) throw failure;
  return bytes;
}

function updateDigestRecord(digest, type, value) {
  const typeBytes = Buffer.from(type, "utf8");
  const valueBytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const header = Buffer.alloc(12);
  header.writeUInt32BE(typeBytes.length, 0);
  header.writeBigUInt64BE(BigInt(valueBytes.length), 4);
  digest.update(header.subarray(0, 4));
  digest.update(typeBytes);
  digest.update(header.subarray(4));
  digest.update(valueBytes);
}

async function managedPromptSnapshotDigest(projectRoot, testHooks) {
  const manifestPath = path.join(projectRoot, ".codex", "managed-prompts.json");
  const manifestBytes = await readBoundedPromptFile(
    projectRoot,
    manifestPath,
    Math.min(MAX_PROMPT_FILE_BYTES, MAX_MANAGED_PROMPT_TOTAL_BYTES),
    testHooks,
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes);
  } catch {
    throw brokerError("BROKER_PROMPT_MANIFEST_INVALID");
  }
  requireValue(Array.isArray(manifest.prompts), "BROKER_PROMPT_MANIFEST_INVALID");
  const promptPaths = manifest.prompts.map((prompt) => prompt?.path);
  requireValue(
    promptPaths.every((relative) => typeof relative === "string" && /^agents\/[A-Za-z0-9._-]+\.toml$/u.test(relative)),
    "BROKER_PROMPT_MANIFEST_INVALID",
  );
  requireValue(new Set(promptPaths).size === promptPaths.length, "BROKER_PROMPT_MANIFEST_INVALID");
  requireValue(promptPaths.length <= MAX_MANAGED_PROMPT_COUNT, "BROKER_PROMPT_INVENTORY_TOO_LARGE");
  const digest = createHash("sha256");
  updateDigestRecord(digest, "manifest", manifestBytes);
  let totalBytes = manifestBytes.length;
  for (const relative of [...promptPaths].sort()) {
    const relativeBytes = Buffer.from(relative, "utf8");
    totalBytes += relativeBytes.length;
    requireValue(totalBytes <= MAX_MANAGED_PROMPT_TOTAL_BYTES, "BROKER_PROMPT_SNAPSHOT_TOO_LARGE");
    const promptBytes = await readBoundedPromptFile(
      projectRoot,
      path.join(projectRoot, ".codex", ...relative.split("/")),
      Math.min(MAX_PROMPT_FILE_BYTES, MAX_MANAGED_PROMPT_TOTAL_BYTES - totalBytes),
      testHooks,
    );
    totalBytes += promptBytes.length;
    updateDigestRecord(digest, "prompt-path", relativeBytes);
    updateDigestRecord(digest, "prompt-content", promptBytes);
  }
  const value = `sha256:${digest.digest("hex")}`;
  await testHooks?.onPromptSnapshotDigest?.(value);
  return value;
}

function validateRuntime(initialize) {
  requireValue(["macos", "linux", "windows"].includes(initialize?.platformOs), "BROKER_RUNTIME_UNSUPPORTED");
  requireValue(typeof initialize?.platformFamily === "string", "BROKER_RUNTIME_UNSUPPORTED");
  requireValue(typeof initialize?.userAgent === "string" && initialize.userAgent.length > 0, "BROKER_RUNTIME_UNSUPPORTED");
}

function validateSandboxPolicy(sandbox, projectRoot, permissionProfile) {
  requireValue(sandbox?.type === sandboxType(permissionProfile), "BROKER_SANDBOX_POLICY_MISMATCH");
  requireValue(sandbox?.networkAccess === false, "BROKER_SANDBOX_POLICY_MISMATCH");
  const writableRoots = sandbox?.writableRoots;
  if (permissionProfile === "read-only") {
    requireValue(
      writableRoots === undefined || (Array.isArray(writableRoots) && writableRoots.length === 0),
      "BROKER_WORKSPACE_ROOT_MISMATCH",
    );
    return;
  }
  requireValue(sameRoots(writableRoots, projectRoot), "BROKER_WORKSPACE_ROOT_MISMATCH");
}

function validateThread(response, projectRoot, permissionProfile) {
  requireValue(response?.approvalPolicy === "never", "BROKER_APPROVAL_POLICY_MISMATCH");
  validateSandboxPolicy(response?.sandbox, projectRoot, permissionProfile);
  requireValue(response?.cwd === projectRoot && response?.thread?.cwd === projectRoot, "BROKER_PROJECT_MISMATCH");
  requireValue(typeof response?.thread?.id === "string", "BROKER_THREAD_ID_MISSING");
  requireValue(typeof response?.thread?.sessionId === "string", "BROKER_SESSION_ID_MISSING");
}

function validateResponsePermissionProfile(response, permissionProfile) {
  if (!Object.hasOwn(response ?? {}, "activePermissionProfile")) return false;
  requireValue(
    response.activePermissionProfile?.id === permissionProfileId(permissionProfile),
    "BROKER_PERMISSION_PROFILE_MISMATCH",
  );
  return true;
}

function validateThreadSettings(settings, projectRoot, permissionProfile) {
  requireValue(settings?.approvalPolicy === "never", "BROKER_APPROVAL_POLICY_MISMATCH");
  requireValue(
    settings?.activePermissionProfile?.id === permissionProfileId(permissionProfile),
    "BROKER_PERMISSION_PROFILE_MISMATCH",
  );
  validateSandboxPolicy(settings?.sandboxPolicy, projectRoot, permissionProfile);
  requireValue(settings?.cwd === projectRoot, "BROKER_PROJECT_MISMATCH");
}

function resolveServerOperation(request, expected) {
  if (APPROVAL_REQUESTS.has(request?.method)) throw brokerError("BROKER_APPROVAL_REQUESTED");
  if (request?.method !== "item/tool/call") throw brokerError("BROKER_SERVER_REQUEST_REJECTED");
  const params = request.params;
  if (params?.tool !== BROKER_TOOL_NAME || params?.namespace != null) {
    throw brokerError("BROKER_TOOL_MISMATCH");
  }
  const operation = exactOperation(params.arguments);
  if (!operation) throw brokerError("BROKER_ARGUMENTS_INVALID");
  const implementation = expected.operations[operation];
  if (typeof implementation !== "function") throw brokerError("BROKER_OPERATION_UNAVAILABLE");
  if (params.threadId !== expected.threadId) throw brokerError("BROKER_THREAD_MISMATCH");
  if (params.turnId !== expected.turnId) throw brokerError("BROKER_TURN_MISMATCH");
  return { implementation, params };
}

export function createDynamicToolSpec() {
  return {
    type: "function",
    name: BROKER_TOOL_NAME,
    description: "Run a package-owned, fail-closed SDD inspection. Current App Server evidence is insufficient to claim managed-prompt protection, so results remain unproven.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        operation: { type: "string", enum: ["check", "governance"] },
      },
      required: ["operation"],
    },
  };
}

function defaultOperations(targetPath) {
  return {
    async check() {
      const files = await checkProjectFiles(targetPath);
      const graph = files.protection.trusted
        ? checkCodeGraph(files.projectRoot)
        : { ok: false, reason: "CodeGraph was not evaluated because prompt protection is untrustworthy." };
      return {
        operation: "check",
        trusted: files.protection.trusted,
        reason_code: files.protection.reason_code,
        drift: files.drift,
        codegraph: graph,
      };
    },
    async governance() {
      const result = await runGovernanceChecks(targetPath);
      return {
        operation: "governance",
        trusted: result.trusted,
        blocking: result.blocking,
        document: result.document,
      };
    },
  };
}

export async function createAppServerBroker(options) {
  const {
    rpc,
    targetPath,
    permissionProfile = "read-only",
    operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  } = options;
  const projectRoot = await fs.realpath(path.resolve(targetPath));
  const activeProfile = permissionProfileId(permissionProfile);
  const operations = options.operations ?? defaultOperations(projectRoot);
  const usedCalls = new Set();
  let promptSnapshotSha256;
  let revocationReason;
  let threadId;
  let turnId;
  let pendingThreadSettings;
  let permissionProfileAttested = false;
  let threadSettingsWaiter;

  function assertLive(expectedThreadId = threadId, expectedTurnId = turnId) {
    requireValue(revocationReason === undefined, revocationReason ?? "BROKER_SESSION_REVOKED");
    requireValue(expectedThreadId === threadId, "BROKER_THREAD_MISMATCH");
    requireValue(expectedTurnId === turnId, "BROKER_TURN_MISMATCH");
  }

  function revoke(reasonCode) {
    revocationReason ??= reasonCode;
    throw brokerError(revocationReason);
  }

  async function startTurn(prompt) {
    if (threadId !== undefined) throw brokerError("BROKER_THREAD_ALREADY_STARTED");
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw brokerError("BROKER_PROMPT_REQUIRED");
    }
    promptSnapshotSha256 = await managedPromptSnapshotDigest(projectRoot, options.testHooks);
    const initializeResponse = await rpc.request("initialize", {
      clientInfo: {
        name: "sdd_codegraph_broker",
        title: "SDD CodeGraph Broker",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    validateRuntime(initializeResponse);
    rpc.notify("initialized", {});
    const threadResponse = await rpc.request("thread/start", {
      approvalPolicy: "never",
      cwd: projectRoot,
      dynamicTools: [createDynamicToolSpec()],
      ephemeral: true,
      permissions: activeProfile,
      runtimeWorkspaceRoots: [projectRoot],
    });
    validateThread(threadResponse, projectRoot, permissionProfile);
    permissionProfileAttested = validateResponsePermissionProfile(threadResponse, permissionProfile);
    threadId = threadResponse.thread.id;
    if (pendingThreadSettings) {
      const notification = pendingThreadSettings;
      pendingThreadSettings = undefined;
      handleThreadSettings(notification);
      requireValue(revocationReason === undefined, revocationReason ?? "BROKER_SESSION_REVOKED");
    }
    if (!permissionProfileAttested) await waitForPermissionAttestation();
    const turnRequest = {
      threadId,
      input: [{ type: "text", text: prompt }],
      approvalPolicy: "never",
      cwd: projectRoot,
      environments: [],
      permissions: activeProfile,
      runtimeWorkspaceRoots: [projectRoot],
    };
    const turnResponse = await rpc.request("turn/start", turnRequest);
    requireValue(typeof turnResponse?.turn?.id === "string", "BROKER_TURN_ID_MISSING");
    turnId = turnResponse.turn.id;
    return {
      sessionId: threadResponse.thread.sessionId,
      threadId,
      turnId,
    };
  }

  async function handleServerRequest(request) {
    try {
      return await withDeadline(
        async () => {
          assertLive(request?.params?.threadId, request?.params?.turnId);
          const resolved = resolveServerOperation(request, { operations, threadId, turnId });
          requireValue(typeof resolved.params.callId === "string" && resolved.params.callId.length > 0, "BROKER_CALL_ID_MISSING");
          requireValue(!usedCalls.has(resolved.params.callId), "BROKER_REPLAY_DETECTED");
          usedCalls.add(resolved.params.callId);
          requireValue(
            await managedPromptSnapshotDigest(projectRoot, options.testHooks) === promptSnapshotSha256,
            "BROKER_PROMPT_SNAPSHOT_CHANGED",
          );
          const result = await resolved.implementation();
          if (result?.trusted === true) return revoke("BROKER_POSITIVE_TRUST_FORBIDDEN");
          assertLive(resolved.params.threadId, resolved.params.turnId);
          return {
            contentItems: [{
              type: "inputText",
              text: toolText({ ...result, trusted: false, reason_code: RUNTIME_UNPROVEN }),
            }],
            success: true,
          };
        },
        operationTimeoutMs,
        "BROKER_OPERATION_TIMEOUT",
      );
    } catch (error) {
      return revoke(error?.message ?? "BROKER_SERVER_REQUEST_REJECTED");
    }
  }

  function handleNotification(notification) {
    if (notification?.method === "thread/settings/updated") {
      if (threadId === undefined) {
        if (pendingThreadSettings) revocationReason ??= "BROKER_THREAD_SETTINGS_AMBIGUOUS";
        else pendingThreadSettings = notification;
      } else {
        handleThreadSettings(notification);
      }
      return;
    }
    if (
      notification?.method === "turn/completed"
      || notification?.method === "thread/archived"
      || notification?.method === "error"
    ) {
      revocationReason ??= "BROKER_SESSION_ENDED";
    }
  }

  function handleThreadSettings(notification) {
    try {
      requireValue(notification?.params?.threadId === threadId, "BROKER_THREAD_MISMATCH");
      validateThreadSettings(notification.params.threadSettings, projectRoot, permissionProfile);
      permissionProfileAttested = true;
    } catch (error) {
      revocationReason ??= brokerReason(error) ? error.message : "BROKER_THREAD_SETTINGS_INVALID";
    }
    threadSettingsWaiter?.();
  }

  async function waitForPermissionAttestation() {
    const timeoutMs = options.testHooks?.permissionAttestationTimeoutMs
      ?? DEFAULT_PERMISSION_ATTESTATION_TIMEOUT_MS;
    try {
      await withDeadline(
        () => new Promise((resolve) => { threadSettingsWaiter = resolve; }),
        timeoutMs,
        "BROKER_PERMISSION_PROFILE_MISSING",
        () => { revocationReason ??= "BROKER_PERMISSION_PROFILE_MISSING"; },
      );
    } finally {
      threadSettingsWaiter = undefined;
    }
    requireValue(permissionProfileAttested, revocationReason ?? "BROKER_PERMISSION_PROFILE_MISSING");
  }

  function disconnect() {
    revocationReason ??= "BROKER_DISCONNECTED";
  }

  return Object.freeze({ disconnect, handleNotification, handleServerRequest, startTurn });
}

export function createJsonLineRpc(child, options = {}) {
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_RPC_INPUT_BYTES;
  const maxInFlightServerRequests = options.maxInFlightServerRequests ?? DEFAULT_MAX_IN_FLIGHT_SERVER_REQUESTS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let nextId = 1;
  let buffered = "";
  let inFlightServerRequests = 0;
  let serverRequestHandler;
  let notificationHandler;
  const pending = new Map();

  function send(message) {
    if (!child.stdin?.writable) throw brokerError("BROKER_APP_SERVER_DISCONNECTED");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async function receive(message) {
    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) request.reject(brokerError("BROKER_APP_SERVER_REQUEST_FAILED"));
      else request.resolve(message.result);
      return;
    }
    if (Object.hasOwn(message, "id") && typeof message.method === "string") {
      try {
        if (!serverRequestHandler) throw brokerError("BROKER_SERVER_REQUEST_REJECTED");
        if (inFlightServerRequests >= maxInFlightServerRequests) {
          throw brokerError("BROKER_TOO_MANY_IN_FLIGHT_REQUESTS");
        }
        inFlightServerRequests += 1;
        try {
          const result = await serverRequestHandler(message);
          send({ id: message.id, result });
        } finally {
          inFlightServerRequests -= 1;
        }
      } catch (error) {
        send({
          id: message.id,
          error: { code: -32000, message: error?.message ?? "BROKER_SERVER_REQUEST_REJECTED" },
        });
      }
      return;
    }
    notificationHandler?.(message);
  }

  const disconnect = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(brokerError("BROKER_APP_SERVER_DISCONNECTED"));
    }
    pending.clear();
    options.onDisconnect?.();
  };
  const abortProtocol = () => {
    child.kill();
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const index = buffered.indexOf("\n");
      const rawLine = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (Buffer.byteLength(rawLine) > maxInputBytes) return abortProtocol();
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message)) return abortProtocol();
        void receive(message).catch(abortProtocol);
      } catch {
        return abortProtocol();
      }
    }
    if (Buffer.byteLength(buffered) > maxInputBytes) abortProtocol();
  });
  child.once("error", disconnect);
  child.once("exit", disconnect);

  return {
    request(method, params) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!pending.delete(id)) return;
          reject(brokerError("BROKER_APP_SERVER_REQUEST_TIMEOUT"));
          child.kill();
        }, requestTimeoutMs);
        pending.set(id, { reject, resolve, timeout });
        try {
          send({ id, method, params });
        } catch (error) {
          clearTimeout(timeout);
          pending.delete(id);
          reject(error);
        }
      });
    },
    notify(method, params) { send({ method, params }); },
    onServerRequest(handler) { serverRequestHandler = handler; },
    onNotification(handler) { notificationHandler = handler; },
    close(options = {}) {
      child.stdin.end();
      if (options.kill !== false) child.kill();
    },
  };
}

export async function launchBrokerTurn(options) {
  assertSupportedNodeRuntime();
  const testOnlyUncontainedLaunch = options.testHooks?.allowUncontainedLaunch === true
    && typeof options.spawnProcess === "function"
    && typeof options.terminateProcess === "function";
  if (!testOnlyUncontainedLaunch) {
    options.onDiagnostic?.(`${PROCESS_CONTAINMENT_UNAVAILABLE}\n`);
    return {
      completion: { turn: { status: "disabled" } },
      trusted: false,
      reason_code: PROCESS_CONTAINMENT_UNAVAILABLE,
    };
  }
  const executable = options.codexExecutable ?? "codex";
  const terminateProcess = options.terminateProcess ?? terminateProcessTree;
  const child = (options.spawnProcess ?? spawn)(executable, ["app-server", "--stdio"], {
    cwd: path.resolve(options.targetPath),
    detached: process.platform !== "win32",
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (process.platform !== "win32" && child.pid) {
    const captureIdentity = options.captureProcessIdentity ?? captureProcessIdentity;
    child.identityPromise = captureIdentity(child.pid);
    void child.identityPromise.catch(() => {});
  }
  let broker;
  let rpc;
  let started;
  let terminationPromise;
  let resolveCompletion;
  let rejectCompletion;
  const earlyCompletions = [];
  const completed = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  void completed.catch(() => {});

  const terminate = ({ interrupt = false } = {}) => {
    if (terminationPromise) return terminationPromise;
    terminationPromise = (async () => {
      if (interrupt && rpc && started) {
        try {
          await withDeadline(
            () => rpc.request("turn/interrupt", { threadId: started.threadId, turnId: started.turnId }),
            options.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS,
            "BROKER_INTERRUPT_TIMEOUT",
          );
        } catch {
          /* Verified process-tree termination remains the authoritative cleanup. */
        }
      }
      if (rpc) rpc.close({ kill: false });
      else child.stdin?.end();
      try {
        await terminateProcess(child);
      } catch {
        throw brokerError("BROKER_APP_SERVER_TERMINATION_FAILED");
      }
    })();
    return terminationPromise;
  };

  const handleCompletion = (notification) => {
    if (!started) {
      earlyCompletions.push(notification);
      return;
    }
    if (
      notification?.params?.threadId !== started.threadId
      || notification?.params?.turn?.id !== started.turnId
    ) {
      rejectCompletion(brokerError("BROKER_COMPLETION_MISMATCH"));
      return;
    }
    broker.handleNotification(notification);
    resolveCompletion(notification.params);
  };

  try {
    return await withDeadline(
      async () => {
        if (child.identityPromise) await child.identityPromise;
        rpc = createJsonLineRpc(child, {
          onDisconnect: () => {
            broker?.disconnect();
            rejectCompletion(brokerError("BROKER_APP_SERVER_DISCONNECTED"));
          },
        });
        broker = await createAppServerBroker({ ...options, rpc });
        child.stderr?.on("data", (chunk) => options.onDiagnostic?.(String(chunk)));
        rpc.onServerRequest((request) => broker.handleServerRequest(request));
        rpc.onNotification((notification) => {
          if (notification?.method === "turn/completed") handleCompletion(notification);
          else broker.handleNotification(notification);
          options.onNotification?.(notification);
        });
        started = await broker.startTurn(options.prompt);
        while (earlyCompletions.length > 0) handleCompletion(earlyCompletions.shift());
        const completion = await completed;
        return { ...started, completion, trusted: false, reason_code: RUNTIME_UNPROVEN };
      },
      options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      "BROKER_TURN_TIMEOUT",
      () => terminate({ interrupt: true }),
    );
  } finally {
    broker?.disconnect();
    await terminate();
  }
}

export function brokerLaunchExitCode(result) {
  return result?.trusted === true && result?.completion?.turn?.status === "completed" ? 0 : 2;
}
