import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import test from "./classified-test.js";
import { installProject, checkProjectFiles } from "../src/installer.js";
import { runGovernanceChecks } from "../src/governance-checks.js";
import { runGovernanceExecutor } from "../src/engineering-gates.js";
import {
  assertSupportedNodeRuntime,
} from "../src/runtime-attestation.js";
import {
  BROKER_TOOL_NAME,
  brokerLaunchExitCode,
  createAppServerBroker,
  createDynamicToolSpec,
  createJsonLineRpc,
  launchBrokerTurn,
} from "../src/app-server-broker.js";
import { captureProcessIdentity, terminateProcessTree } from "../src/engineering-gate-runtime.js";

function appServerThread(project, overrides = {}) {
  return {
    approvalPolicy: "never",
    activePermissionProfile: { id: ":read-only", extends: ":read-only" },
    cwd: project,
    sandbox: { type: "readOnly", networkAccess: false },
    thread: {
      id: "thread-main",
      sessionId: "session-main",
      cwd: project,
      cliVersion: "0.153.0-alpha.5",
    },
    ...overrides,
  };
}

function appServerRpc() {
  return {
    async request(method, params) {
      if (method === "initialize") return { platformFamily: "unix", platformOs: "macos", userAgent: "codex_cli_rs/test" };
      if (method === "thread/start") return appServerThread(params.cwd);
      if (method === "turn/start") return { turn: { id: "turn-main" } };
      throw new Error(`unexpected request ${method}`);
    },
    notify() {},
  };
}

function brokerToolCall(callId) {
  return {
    method: "item/tool/call",
    params: {
      arguments: { operation: "check" },
      callId,
      threadId: "thread-main",
      tool: BROKER_TOOL_NAME,
      turnId: "turn-main",
    },
  };
}

test("runtime attestation accepts only supported Node release lines", () => {
  for (const version of ["v22.14.0", "22.99.1", "v24.0.0", "24.19.0", "26.0.0"]) {
    assert.doesNotThrow(() => assertSupportedNodeRuntime(version));
  }
  for (const version of ["v20.20.2", "22.13.9", "23.9.0", "not-a-version"]) {
    assert.throws(() => assertSupportedNodeRuntime(version), /supported Node runtime/u);
  }
});

test("caller-minted runtime attestation cannot produce trusted protection", async (context) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-attestation-integration-"));
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await installProject(project);
  const runtimeAttestation = { forged: true, trusted: true };
  const promptProtection = {
    probe: async (directories, prompts) => ({
      fileWrites: prompts.map(() => "denied"),
      directoryMutations: directories.map(() => "denied"),
    }),
    runtimeAttestation,
    runtimeAttestationAuthorityKey: "attacker-controlled-public-key",
  };
  const checked = await checkProjectFiles(project, promptProtection);
  assert.equal(checked.protection.trusted, false);
  assert.equal(checked.protection.reason_code, "MANAGED_PROMPT_RUNTIME_UNPROVEN");
  const governance = await runGovernanceChecks(project, { promptProtection });
  assert.equal(governance.trusted, false);
  assert.equal(governance.blocking, true);
  const gate = await runGovernanceExecutor({
    target: project,
    runtimeAttestation,
    runtimeAttestationAuthorityKey: "attacker-controlled-public-key",
  });
  assert.equal(gate.status, "error");
  assert.equal(gate.reason_code, "GOVERNANCE_UNTRUSTWORTHY");
});

test("App Server broker binds the dynamic tool to the registered thread and turn", async (context) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-app-server-broker-"));
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await installProject(project);
  const projectRoot = await fs.realpath(project);
  const requests = [];
  const notifications = [];
  const rpc = {
    async request(method, params) {
      requests.push({ method, params });
      if (method === "initialize") return { platformFamily: "unix", platformOs: "macos", userAgent: "codex_cli_rs/0.153.0-alpha.5" };
      if (method === "thread/start") return appServerThread(params.cwd);
      if (method === "turn/start") return { turn: { id: "turn-main" } };
      throw new Error(`unexpected request ${method}`);
    },
    notify(method, params) { notifications.push({ method, params }); },
  };
  const broker = await createAppServerBroker({
    rpc,
    targetPath: project,
    operations: {
      check: async () => ({ detail: "protocol-only" }),
    },
  });
  const started = await broker.startTurn("verify the protected project");
  assert.equal(started.threadId, "thread-main");
  assert.equal(started.turnId, "turn-main");
  assert.equal(requests[0].method, "initialize");
  assert.equal(requests[0].params.capabilities.experimentalApi, true);
  assert.deepEqual(requests[1].params.dynamicTools, [createDynamicToolSpec()]);
  assert.equal(requests[1].params.permissions, ":read-only");
  assert.equal(requests[2].params.approvalPolicy, "never");
  assert.equal(requests[2].params.permissions, ":read-only");
  assert.deepEqual(requests[2].params.runtimeWorkspaceRoots, [projectRoot]);
  assert.deepEqual(notifications, [{ method: "initialized", params: {} }]);

  const response = await broker.handleServerRequest({
    method: "item/tool/call",
    params: {
      arguments: { operation: "check" },
      callId: "call-broker",
      threadId: "thread-main",
      tool: BROKER_TOOL_NAME,
      turnId: "turn-main",
    },
  });
  assert.equal(response.success, true);
  assert.deepEqual(JSON.parse(response.contentItems[0].text), {
    detail: "protocol-only",
    reason_code: "BROKER_RUNTIME_EVIDENCE_UNAVAILABLE",
    trusted: false,
  });
  await assert.rejects(() => broker.handleServerRequest({
    method: "item/tool/call",
    params: {
      arguments: { operation: "check" },
      callId: "call-broker",
      threadId: "thread-main",
      tool: BROKER_TOOL_NAME,
      turnId: "turn-main",
    },
  }), /BROKER_REPLAY_DETECTED/u);
  await assert.rejects(() => broker.handleServerRequest({
    method: "item/tool/call",
    params: {
      arguments: { operation: "check" },
      callId: "call-after-replay",
      threadId: "thread-main",
      tool: BROKER_TOOL_NAME,
      turnId: "turn-main",
    },
  }), /BROKER_REPLAY_DETECTED/u);

  const approvalBroker = await createAppServerBroker({
    rpc,
    targetPath: project,
    operations: { check: async () => ({ trusted: true }) },
  });
  await approvalBroker.startTurn("verify approval revocation");
  await assert.rejects(() => approvalBroker.handleServerRequest({
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-main", turnId: "turn-main" },
  }), /BROKER_APPROVAL_REQUESTED/u);
  await assert.rejects(() => approvalBroker.handleServerRequest({
    method: "item/tool/call",
    params: {
      arguments: { operation: "check" },
      callId: "call-after-approval",
      threadId: "thread-main",
      tool: BROKER_TOOL_NAME,
      turnId: "turn-main",
    },
  }), /BROKER_APPROVAL_REQUESTED/u);

  const snapshotBroker = await createAppServerBroker({
    rpc,
    targetPath: project,
    operations: { check: async () => ({ detail: "must-not-run" }) },
  });
  await snapshotBroker.startTurn("verify prompt snapshot binding");
  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, ".codex", "managed-prompts.json"), "utf8"));
  const promptPath = path.join(projectRoot, ".codex", ...manifest.prompts[0].path.split("/"));
  const originalPrompt = await fs.readFile(promptPath);
  await fs.appendFile(promptPath, "\n# changed after turn start\n");
  await assert.rejects(() => snapshotBroker.handleServerRequest({
    method: "item/tool/call",
    params: {
      arguments: { operation: "check" },
      callId: "call-after-prompt-change",
      threadId: "thread-main",
      tool: BROKER_TOOL_NAME,
      turnId: "turn-main",
    },
  }), /BROKER_PROMPT_SNAPSHOT_CHANGED/u);
  await fs.writeFile(promptPath, originalPrompt);

  const positiveBroker = await createAppServerBroker({
    rpc,
    targetPath: project,
    operations: { check: async () => ({ trusted: true }) },
  });
  await positiveBroker.startTurn("reject positive trust");
  await assert.rejects(() => positiveBroker.handleServerRequest({
    method: "item/tool/call",
    params: {
      arguments: { operation: "check" },
      callId: "call-positive",
      threadId: "thread-main",
      tool: BROKER_TOOL_NAME,
      turnId: "turn-main",
    },
  }), /BROKER_POSITIVE_TRUST_FORBIDDEN/u);

  const operationTimeoutBroker = await createAppServerBroker({
    rpc,
    targetPath: project,
    operationTimeoutMs: 5,
    operations: { check: async () => new Promise(() => {}) },
  });
  await operationTimeoutBroker.startTurn("bound the inspection operation");
  await assert.rejects(() => operationTimeoutBroker.handleServerRequest({
    method: "item/tool/call",
    params: {
      arguments: { operation: "check" },
      callId: "call-operation-timeout",
      threadId: "thread-main",
      tool: BROKER_TOOL_NAME,
      turnId: "turn-main",
    },
  }), /BROKER_OPERATION_TIMEOUT/u);

  const boundedProject = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-bounded-prompt-snapshot-"));
  context.after(() => fs.rm(boundedProject, { recursive: true, force: true }));
  await installProject(boundedProject);
  const boundedManifestPath = path.join(boundedProject, ".codex", "managed-prompts.json");
  const boundedManifest = JSON.parse(await fs.readFile(boundedManifestPath, "utf8"));
  boundedManifest.prompts = Array.from({ length: 65 }, (_, index) => ({
    path: `agents/generated-${index}.toml`,
    sha256: `sha256:${"0".repeat(64)}`,
  }));
  await fs.writeFile(boundedManifestPath, `${JSON.stringify(boundedManifest)}\n`);
  const boundedBroker = await createAppServerBroker({ rpc, targetPath: boundedProject });
  await assert.rejects(
    () => boundedBroker.startTurn("reject an oversized prompt inventory"),
    /BROKER_PROMPT_INVENTORY_TOO_LARGE/u,
  );

  const aggregateProject = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-aggregate-prompt-snapshot-"));
  context.after(() => fs.rm(aggregateProject, { recursive: true, force: true }));
  await installProject(aggregateProject);
  const aggregateManifestPath = path.join(aggregateProject, ".codex", "managed-prompts.json");
  const aggregateManifest = JSON.parse(await fs.readFile(aggregateManifestPath, "utf8"));
  aggregateManifest.prompts = [];
  for (let index = 0; index < 8; index += 1) {
    const relative = `agents/aggregate-${index}.toml`;
    await fs.writeFile(path.join(aggregateProject, ".codex", ...relative.split("/")), Buffer.alloc(1024 * 1024));
    aggregateManifest.prompts.push({ path: relative, sha256: `sha256:${"0".repeat(64)}` });
  }
  await fs.writeFile(aggregateManifestPath, `${JSON.stringify(aggregateManifest)}\n`);
  const aggregateBroker = await createAppServerBroker({ rpc, targetPath: aggregateProject });
  await assert.rejects(
    () => aggregateBroker.startTurn("reject an oversized aggregate prompt snapshot"),
    /BROKER_PROMPT_SNAPSHOT_TOO_LARGE/u,
  );
});

test("managed prompt snapshot framing binds each prompt's bytes to its path", async (context) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-prompt-framing-"));
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await installProject(project);
  const manifestPath = path.join(project, ".codex", "managed-prompts.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const firstRelative = "agents/framing-a.toml";
  const secondRelative = "agents/framing-b.toml";
  const firstPath = path.join(project, ".codex", ...firstRelative.split("/"));
  const secondPath = path.join(project, ".codex", ...secondRelative.split("/"));
  manifest.prompts = [
    { path: firstRelative, sha256: `sha256:${"0".repeat(64)}` },
    { path: secondRelative, sha256: `sha256:${"0".repeat(64)}` },
  ];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await fs.writeFile(firstPath, "left");
  await fs.writeFile(secondPath, `${secondRelative}right`);
  const observedDigests = [];
  let operationRuns = 0;
  const broker = await createAppServerBroker({
    rpc: appServerRpc(),
    targetPath: project,
    testHooks: {
      onPromptSnapshotDigest(digest) { observedDigests.push(digest); },
    },
    operations: { check: async () => { operationRuns += 1; return { trusted: false }; } },
  });
  await broker.startTurn("bind prompt records");

  await fs.writeFile(firstPath, `left${secondRelative}`);
  await fs.writeFile(secondPath, "right");

  await assert.rejects(
    () => broker.handleServerRequest(brokerToolCall("call-framing-redistribution")),
    /BROKER_PROMPT_SNAPSHOT_CHANGED/u,
  );
  assert.equal(observedDigests.length, 2);
  assert.notEqual(observedDigests[0], observedDigests[1]);
  assert.equal(operationRuns, 0);
});

test("managed prompt snapshot rejects a concurrent path replacement after open", async (context) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-prompt-replacement-"));
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await installProject(project);
  const projectRoot = await fs.realpath(project);
  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, ".codex", "managed-prompts.json"), "utf8"));
  const promptPath = path.join(projectRoot, ".codex", ...manifest.prompts[0].path.split("/"));
  const oversizedPath = path.join(project, "oversized-prompt.toml");
  await fs.writeFile(oversizedPath, Buffer.alloc(9 * 1024 * 1024));
  let armed = false;
  let observedReadBytes = 0;
  let operationRuns = 0;
  const broker = await createAppServerBroker({
    rpc: appServerRpc(),
    targetPath: project,
    testHooks: {
      async afterPromptFileOpen({ filePath }) {
        if (!armed || filePath !== promptPath) return;
        armed = false;
        await fs.rename(promptPath, `${promptPath}.opened`);
        await fs.rename(oversizedPath, promptPath);
      },
      onPromptFileRead({ bytesRead, filePath }) {
        if (filePath === promptPath) observedReadBytes += bytesRead;
      },
    },
    operations: { check: async () => { operationRuns += 1; return { trusted: false }; } },
  });
  await broker.startTurn("reject a replacement race");
  observedReadBytes = 0;
  armed = true;

  await assert.rejects(
    () => broker.handleServerRequest(brokerToolCall("call-concurrent-replacement")),
    /BROKER_PROMPT_SNAPSHOT_UNSAFE/u,
  );
  assert.equal(armed, false);
  assert.equal(observedReadBytes, 0);
  assert.equal(operationRuns, 0);
});

test("managed prompt snapshot rejects symlink files and escaping directory symlinks", async (context) => {
  const fileLinkProject = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-prompt-file-link-"));
  const directoryLinkProject = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-prompt-directory-link-"));
  const escapedAgents = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-prompt-escaped-agents-"));
  context.after(() => Promise.all([
    fs.rm(fileLinkProject, { recursive: true, force: true }),
    fs.rm(directoryLinkProject, { recursive: true, force: true }),
    fs.rm(escapedAgents, { recursive: true, force: true }),
  ]));

  await installProject(fileLinkProject);
  const fileManifest = JSON.parse(await fs.readFile(path.join(fileLinkProject, ".codex", "managed-prompts.json"), "utf8"));
  const linkedPrompt = path.join(fileLinkProject, ".codex", ...fileManifest.prompts[0].path.split("/"));
  const externalPrompt = path.join(fileLinkProject, "external-prompt.toml");
  await fs.writeFile(externalPrompt, "external");
  await fs.unlink(linkedPrompt);
  await fs.symlink(externalPrompt, linkedPrompt);
  const fileLinkBroker = await createAppServerBroker({ rpc: appServerRpc(), targetPath: fileLinkProject });
  await assert.rejects(
    () => fileLinkBroker.startTurn("reject a prompt symlink"),
    /BROKER_PROMPT_SNAPSHOT_UNSAFE/u,
  );

  await installProject(directoryLinkProject);
  const agentsPath = path.join(directoryLinkProject, ".codex", "agents");
  for (const entry of await fs.readdir(agentsPath)) {
    await fs.rename(path.join(agentsPath, entry), path.join(escapedAgents, entry));
  }
  await fs.rmdir(agentsPath);
  await fs.symlink(escapedAgents, agentsPath);
  const directoryLinkBroker = await createAppServerBroker({ rpc: appServerRpc(), targetPath: directoryLinkProject });
  await assert.rejects(
    () => directoryLinkBroker.startTurn("reject an escaping prompt directory"),
    /BROKER_PROMPT_SNAPSHOT_UNSAFE/u,
  );
});

test("managed prompt snapshot bounds a file that grows after descriptor validation", async (context) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-prompt-growth-"));
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await installProject(project);
  const projectRoot = await fs.realpath(project);
  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, ".codex", "managed-prompts.json"), "utf8"));
  const promptPath = path.join(projectRoot, ".codex", ...manifest.prompts[0].path.split("/"));
  let armed = false;
  let observedReadBytes = 0;
  let operationRuns = 0;
  const broker = await createAppServerBroker({
    rpc: appServerRpc(),
    targetPath: project,
    testHooks: {
      async afterPromptFileStat({ filePath }) {
        if (!armed || filePath !== promptPath) return;
        armed = false;
        await fs.appendFile(promptPath, Buffer.alloc(2 * 1024 * 1024));
      },
      onPromptFileRead({ bytesRead, filePath }) {
        if (filePath === promptPath) observedReadBytes += bytesRead;
      },
    },
    operations: { check: async () => { operationRuns += 1; return { trusted: false }; } },
  });
  await broker.startTurn("bound a growing prompt");
  observedReadBytes = 0;
  armed = true;

  await assert.rejects(
    () => broker.handleServerRequest(brokerToolCall("call-growing-prompt")),
    /BROKER_PROMPT_SNAPSHOT_TOO_LARGE/u,
  );
  assert.equal(armed, false);
  assert.equal(observedReadBytes, (1024 * 1024) + 1);
  assert.equal(operationRuns, 0);
});

test("managed prompt snapshot rejects a pre-existing oversized file without reading it", async (context) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-prompt-oversized-"));
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await installProject(project);
  const projectRoot = await fs.realpath(project);
  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, ".codex", "managed-prompts.json"), "utf8"));
  const promptPath = path.join(projectRoot, ".codex", ...manifest.prompts[0].path.split("/"));
  await fs.writeFile(promptPath, Buffer.alloc(2 * 1024 * 1024));
  let observedReadBytes = 0;
  const broker = await createAppServerBroker({
    rpc: appServerRpc(),
    targetPath: project,
    testHooks: {
      onPromptFileRead({ bytesRead, filePath }) {
        if (filePath === promptPath) observedReadBytes += bytesRead;
      },
    },
  });
  await assert.rejects(
    () => broker.startTurn("reject a pre-existing oversized prompt"),
    /BROKER_PROMPT_SNAPSHOT_TOO_LARGE/u,
  );
  assert.equal(observedReadBytes, 0);
});

test("POSIX containment cannot verify a reparented descendant outside the retained session", {
  skip: process.platform === "win32" ? "POSIX session escape regression" : false,
}, async (context) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-containment-limit-project-"));
  const fixtureState = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-containment-limit-state-"));
  const invokedPath = path.join(fixtureState, "invoked");
  const escapedPidPath = path.join(fixtureState, "escaped.pid");
  const previousFixtureState = process.env.SDD_BROKER_FIXTURE_STATE;
  process.env.SDD_BROKER_FIXTURE_STATE = JSON.stringify({ escapedPidPath, invokedPath });
  let escapedIdentity;
  context.after(async () => {
    if (previousFixtureState === undefined) delete process.env.SDD_BROKER_FIXTURE_STATE;
    else process.env.SDD_BROKER_FIXTURE_STATE = previousFixtureState;
    if (!escapedIdentity) {
      try {
        const pid = Number(await fs.readFile(escapedPidPath, "utf8"));
        escapedIdentity = await captureProcessIdentity(pid);
      } catch { /* The fixture did not create a surviving descendant. */ }
    }
    if (escapedIdentity) {
      await terminateProcessTree({
        pid: escapedIdentity.pid,
        identity: escapedIdentity,
        kill: (signal) => process.kill(escapedIdentity.pid, signal),
      });
    }
    await Promise.all([
      fs.rm(project, { recursive: true, force: true }),
      fs.rm(fixtureState, { recursive: true, force: true }),
    ]);
  });
  await installProject(project);
  const result = await launchBrokerTurn({
    codexExecutable: new URL("fixtures/escaped-app-server.js", import.meta.url).pathname,
    prompt: "exercise only the inert containment fixture",
    spawnProcess: spawn,
    targetPath: project,
    terminateProcess: terminateProcessTree,
    testHooks: { allowUncontainedLaunch: true },
    turnTimeoutMs: 2_000,
  });
  const escapedPid = Number(await fs.readFile(escapedPidPath, "utf8"));
  escapedIdentity = await captureProcessIdentity(escapedPid);
  assert.equal(result.reason_code, "BROKER_RUNTIME_EVIDENCE_UNAVAILABLE");
  assert.equal(escapedIdentity.pid, escapedPid);
});

test("broker launch stays disabled while escaped descendants lack verifiable containment", {
  skip: process.platform === "win32" ? "POSIX session escape regression" : false,
}, async (context) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-disabled-launch-project-"));
  const fixtureState = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-disabled-launch-state-"));
  const invokedPath = path.join(fixtureState, "invoked");
  const escapedPidPath = path.join(fixtureState, "escaped.pid");
  const previousFixtureState = process.env.SDD_BROKER_FIXTURE_STATE;
  process.env.SDD_BROKER_FIXTURE_STATE = JSON.stringify({ escapedPidPath, invokedPath });
  let escapedIdentity;
  context.after(async () => {
    if (previousFixtureState === undefined) delete process.env.SDD_BROKER_FIXTURE_STATE;
    else process.env.SDD_BROKER_FIXTURE_STATE = previousFixtureState;
    if (!escapedIdentity) {
      try {
        const pid = Number(await fs.readFile(escapedPidPath, "utf8"));
        escapedIdentity = await captureProcessIdentity(pid);
      } catch { /* The disabled launcher created no descendant. */ }
    }
    if (escapedIdentity) {
      await terminateProcessTree({
        pid: escapedIdentity.pid,
        identity: escapedIdentity,
        kill: (signal) => process.kill(escapedIdentity.pid, signal),
      });
    }
    await Promise.all([
      fs.rm(project, { recursive: true, force: true }),
      fs.rm(fixtureState, { recursive: true, force: true }),
    ]);
  });
  await installProject(project);
  const result = await launchBrokerTurn({
    codexExecutable: new URL("fixtures/escaped-app-server.js", import.meta.url).pathname,
    prompt: "do not launch without verifiable containment",
    targetPath: project,
    turnTimeoutMs: 2_000,
  });
  try {
    const pid = Number(await fs.readFile(escapedPidPath, "utf8"));
    escapedIdentity = await captureProcessIdentity(pid);
  } catch { /* Expected when launch is disabled. */ }
  assert.equal(result.reason_code, "BROKER_PROCESS_CONTAINMENT_UNAVAILABLE");
  assert.equal(brokerLaunchExitCode(result), 2);
  await assert.rejects(() => fs.access(invokedPath), { code: "ENOENT" });
});

test("CLI launch accepts only read-only and exits two without spawning App Server", () => {
  const cli = new URL("../bin/sdd-codegraph.js", import.meta.url).pathname;
  const disabled = spawnSync(process.execPath, [cli, "launch", process.cwd(), "--permissions", "read-only"], {
    encoding: "utf8",
    timeout: 1_000,
  });
  assert.equal(disabled.status, 2, disabled.stderr);
  assert.match(disabled.stderr, /BROKER_PROCESS_CONTAINMENT_UNAVAILABLE/u);
  const unsafe = spawnSync(process.execPath, [cli, "launch", process.cwd(), "--permissions", "workspace"], {
    encoding: "utf8",
    timeout: 1_000,
  });
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stderr, /launch requires read-only permissions/u);
});

test("broker does not expose run-gates while execution isolation is unavailable", () => {
  assert.deepEqual(createDynamicToolSpec().inputSchema.properties.operation.enum, ["check", "governance"]);
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
  }

  kill() {
    if (this.killed) return false;
    this.killed = true;
    this.emit("exit", 1, "SIGTERM");
    return true;
  }
}

function appServerChild(completion) {
  const child = new FakeChild();
  child.requests = [];
  let input = "";
  child.stdin.on("data", (chunk) => {
    input += String(chunk);
    while (input.includes("\n")) {
      const index = input.indexOf("\n");
      const line = input.slice(0, index);
      input = input.slice(index + 1);
      if (!line) continue;
      const request = JSON.parse(line);
      if (!Object.hasOwn(request, "id")) continue;
      child.requests.push(request);
      let result;
      if (request.method === "initialize") {
        result = { platformFamily: "unix", platformOs: "macos", userAgent: "codex_cli_rs/test" };
      } else if (request.method === "thread/start") {
        result = appServerThread(request.params.cwd);
      } else if (request.method === "turn/start") {
        result = { turn: { id: "turn-main" } };
      } else if (request.method === "turn/interrupt") {
        result = {};
      }
      child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      if (request.method === "turn/start" && completion) {
        const params = completion === true
          ? { threadId: "thread-main", turn: { id: "turn-main", status: "completed" } }
          : completion;
        setImmediate(() => child.stdout.write(`${JSON.stringify({
          method: "turn/completed",
          params,
        })}\n`));
      }
    }
  });
  return child;
}

test("JSONL RPC bounds input, request lifetime, and concurrent server requests", async (context) => {
  const oversizedChild = new FakeChild();
  createJsonLineRpc(oversizedChild, { maxInputBytes: 16 });
  oversizedChild.stdout.write("x".repeat(17));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(oversizedChild.killed, true);

  const primitiveChild = new FakeChild();
  createJsonLineRpc(primitiveChild);
  primitiveChild.stdout.write("42\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(primitiveChild.killed, true);

  const whitespaceChild = new FakeChild();
  createJsonLineRpc(whitespaceChild, { maxInputBytes: 16 });
  whitespaceChild.stdout.write(`${" ".repeat(17)}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(whitespaceChild.killed, true);

  const timeoutChild = new FakeChild();
  const timeoutRpc = createJsonLineRpc(timeoutChild, { requestTimeoutMs: 5 });
  await assert.rejects(() => timeoutRpc.request("initialize", {}), /BROKER_APP_SERVER_REQUEST_TIMEOUT/u);
  timeoutRpc.close();

  const concurrentChild = new FakeChild();
  let releaseFirst;
  const firstRequest = new Promise((resolve) => { releaseFirst = resolve; });
  const concurrentRpc = createJsonLineRpc(concurrentChild, { maxInFlightServerRequests: 1 });
  concurrentRpc.onServerRequest(async () => firstRequest);
  let replies = "";
  concurrentChild.stdin.on("data", (chunk) => { replies += String(chunk); });
  concurrentChild.stdout.write(`${JSON.stringify({ id: 1, method: "first", params: {} })}\n`);
  concurrentChild.stdout.write(`${JSON.stringify({ id: 2, method: "second", params: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(replies, /BROKER_TOO_MANY_IN_FLIGHT_REQUESTS/u);
  releaseFirst({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  concurrentRpc.close();

  const project = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-launch-timeout-"));
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  await installProject(project);
  let completedTerminations = 0;
  const completedLaunch = await launchBrokerTurn({
    prompt: "complete without a trusted outcome",
    spawnProcess: () => appServerChild(true),
    targetPath: project,
    terminateProcess: async (child) => {
      completedTerminations += 1;
      child.kill();
    },
    testHooks: { allowUncontainedLaunch: true },
    turnTimeoutMs: 100,
  });
  assert.equal(completedLaunch.trusted, false);
  assert.equal(brokerLaunchExitCode(completedLaunch), 2);
  assert.equal(completedTerminations, 1);

  const neverCompletesChild = appServerChild(false);
  await assert.rejects(() => launchBrokerTurn({
    prompt: "never complete",
    spawnProcess: () => neverCompletesChild,
    targetPath: project,
    terminateProcess: async (child) => child.kill(),
    testHooks: { allowUncontainedLaunch: true },
    turnTimeoutMs: 50,
  }), /BROKER_TURN_TIMEOUT/u);
  assert.equal(neverCompletesChild.requests.some((request) => request.method === "turn/interrupt"), true);

  for (const completion of [
    { threadId: "thread-other", turn: { id: "turn-main", status: "completed" } },
    { threadId: "thread-main", turn: { id: "turn-other", status: "completed" } },
  ]) {
    await assert.rejects(() => launchBrokerTurn({
      prompt: "reject a foreign completion",
      spawnProcess: () => appServerChild(completion),
      targetPath: project,
      terminateProcess: async (child) => child.kill(),
      testHooks: { allowUncontainedLaunch: true },
      turnTimeoutMs: 100,
    }), /BROKER_COMPLETION_MISMATCH/u);
  }

  const silentChild = new FakeChild();
  let releaseTermination;
  let terminationStarted = false;
  const terminationGate = new Promise((resolve) => { releaseTermination = resolve; });
  const startupTimeout = launchBrokerTurn({
    prompt: "bound the complete startup lifecycle",
    requestTimeoutMs: 20,
    spawnProcess: () => silentChild,
    targetPath: project,
    terminateProcess: async (child) => {
      terminationStarted = true;
      await terminationGate;
      child.kill();
    },
    testHooks: { allowUncontainedLaunch: true },
    turnTimeoutMs: 5,
  }).then(
    () => new Error("launch unexpectedly completed"),
    (error) => error,
  );
  await new Promise((resolve) => setTimeout(resolve, 15));
  const observedTermination = terminationStarted;
  releaseTermination();
  const startupError = await startupTimeout;
  assert.equal(observedTermination, true);
  assert.match(startupError.message, /BROKER_TURN_TIMEOUT/u);
});
