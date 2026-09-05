import assert from "node:assert/strict";
import fs from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

import test from "./classified-test.js";
import {
  BROKER_REASON_CODES,
  DOCKER_LAUNCHER_RESULT_SCHEMA,
  DOCKER_RUNTIME_CONTRACT,
  buildDockerCreateInvocation,
  validateDockerInspect,
  validateDockerLauncherResult,
} from "../src/docker-runtime-contract.js";

const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const RUN_ID = "b".repeat(64);
const PROJECT_ROOT = "/safe/project";
const APPROVED_IMAGE = Object.freeze({
  digest: IMAGE_DIGEST,
  reference: `registry.example/sdd/codex-app-server@${IMAGE_DIGEST}`,
  user: "10001:10001",
});

function runtimeInput(permissionProfile = "workspace-only", overrides = {}) {
  return {
    approvedImage: APPROVED_IMAGE,
    permissionProfile,
    projectRoot: PROJECT_ROOT,
    runId: RUN_ID,
    ...overrides,
  };
}

function safeInspect(permissionProfile = "workspace-only") {
  const readOnlyProject = permissionProfile === "read-only";
  return {
    capabilities: { add: [], drop: ["ALL"] },
    devices: [],
    image: { ...APPROVED_IMAGE },
    labels: {
      "io.github.gustavoarielms.sdd-codegraph.contract-version": "1",
      "io.github.gustavoarielms.sdd-codegraph.package": "@gustavoarielms/sdd-codegraph-cli",
      "io.github.gustavoarielms.sdd-codegraph.run-id": RUN_ID,
    },
    mounts: [
      {
        destination: "/workspace",
        propagation: "rprivate",
        readOnly: readOnlyProject,
        recursiveReadOnly: readOnlyProject,
        source: PROJECT_ROOT,
        type: "bind",
      },
      {
        destination: "/workspace/.codex",
        propagation: "rprivate",
        readOnly: true,
        recursiveReadOnly: true,
        source: `${PROJECT_ROOT}/.codex`,
        type: "bind",
      },
      {
        destination: "/run/codex",
        mode: 0o700,
        readOnly: false,
        sizeBytes: 67_108_864,
        type: "tmpfs",
      },
      {
        destination: "/tmp",
        mode: 0o1777,
        readOnly: false,
        sizeBytes: 67_108_864,
        type: "tmpfs",
      },
    ],
    namespaces: {
      ipc: "private",
      network: "bridge",
      pid: "private",
      user: "private",
      uts: "private",
    },
    noNewPrivileges: true,
    privileged: false,
    resources: {
      memoryBytes: 1_073_741_824,
      nanoCpus: 2_000_000_000,
      pidsLimit: 256,
    },
    rootfsReadOnly: true,
    workingDirectory: "/workspace",
  };
}

function clone(value) {
  return structuredClone(value);
}

function assertReason(callback, reasonCode) {
  assert.throws(callback, (error) => error?.message === reasonCode);
}

test("Docker runtime reason codes are stable, bounded, and closed", () => {
  assert.equal(Object.isFrozen(BROKER_REASON_CODES), true);
  assert.deepEqual(BROKER_REASON_CODES, [
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
  for (const reasonCode of BROKER_REASON_CODES) {
    assert.match(reasonCode, /^BROKER_[A-Z0-9_]+$/u);
    assert.ok(Buffer.byteLength(reasonCode) <= 128);
  }
});

test("Docker runtime input accepts only trusted fixed parameters", () => {
  assert.deepEqual(DOCKER_RUNTIME_CONTRACT.permissionProfiles, ["workspace-only", "read-only"]);
  assert.deepEqual(DOCKER_RUNTIME_CONTRACT.limits, {
    interruptTimeoutMs: 1_000,
    operationTimeoutMs: 30_000,
    removalTimeoutMs: 10_000,
    startupTimeoutMs: 30_000,
    stderrBytes: 1_048_576,
    stdoutBytes: 1_048_576,
    turnTimeoutMs: 120_000,
  });
  for (const permissionProfile of DOCKER_RUNTIME_CONTRACT.permissionProfiles) {
    assert.doesNotThrow(() => buildDockerCreateInvocation(runtimeInput(permissionProfile)));
  }

  assertReason(
    () => buildDockerCreateInvocation(runtimeInput("workspace", { permissionProfile: "workspace" })),
    "BROKER_DOCKER_CONTRACT_INPUT_INVALID",
  );
  for (const override of [
    { approvalPolicy: "on-request" },
    { dockerFlags: ["--privileged"] },
    { entrypoint: "/bin/sh" },
    { image: "attacker:latest" },
    { mounts: [] },
    { network: "host" },
  ]) {
    assertReason(
      () => buildDockerCreateInvocation({ ...runtimeInput(), ...override }),
      "BROKER_DOCKER_CONTRACT_INPUT_INVALID",
    );
  }
  assertReason(
    () => buildDockerCreateInvocation(runtimeInput("workspace-only", {
      approvedImage: { ...APPROVED_IMAGE, reference: "registry.example/sdd/codex-app-server:latest" },
    })),
    "BROKER_IMAGE_REFERENCE_MUTABLE",
  );
  assertReason(
    () => buildDockerCreateInvocation(runtimeInput("workspace-only", {
      approvedImage: { ...APPROVED_IMAGE, user: "root" },
    })),
    "BROKER_DOCKER_CONTRACT_INPUT_INVALID",
  );
  for (const override of [
    { approvedImage: { ...APPROVED_IMAGE, digest: [APPROVED_IMAGE.digest] } },
    { approvedImage: { ...APPROVED_IMAGE, reference: [APPROVED_IMAGE.reference] } },
    { approvedImage: { ...APPROVED_IMAGE, user: [APPROVED_IMAGE.user] } },
    { runId: [RUN_ID] },
  ]) {
    assertReason(
      () => buildDockerCreateInvocation(runtimeInput("workspace-only", override)),
      "BROKER_DOCKER_CONTRACT_INPUT_INVALID",
    );
  }
  for (const projectRoot of [
    "relative",
    "/safe/project,escape",
    "/safe/project\n--privileged",
    "/safe/project/../other",
    "/safe/project/",
  ]) {
    assertReason(
      () => buildDockerCreateInvocation(runtimeInput("workspace-only", { projectRoot })),
      "BROKER_DOCKER_CONTRACT_INPUT_INVALID",
    );
  }
});

test("Docker create argv is deterministic and package-owned", () => {
  assert.deepEqual(buildDockerCreateInvocation(runtimeInput()), {
    command: "docker",
    shell: false,
    args: [
      "create",
      "--pull=never",
      "--label=io.github.gustavoarielms.sdd-codegraph.package=@gustavoarielms/sdd-codegraph-cli",
      "--label=io.github.gustavoarielms.sdd-codegraph.contract-version=1",
      `--label=io.github.gustavoarielms.sdd-codegraph.run-id=${RUN_ID}`,
      "--read-only",
      "--privileged=false",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges=true",
      "--pids-limit=256",
      "--memory=1073741824",
      "--cpus=2",
      "--network=bridge",
      "--ipc=private",
      "--user=10001:10001",
      "--workdir=/workspace",
      "--env=CODEX_HOME=/run/codex",
      "--mount=type=bind,src=/safe/project,dst=/workspace,bind-propagation=rprivate",
      "--mount=type=bind,src=/safe/project/.codex,dst=/workspace/.codex,readonly,bind-propagation=rprivate,bind-recursive=readonly",
      "--mount=type=tmpfs,dst=/run/codex,tmpfs-size=67108864,tmpfs-mode=0700",
      "--mount=type=tmpfs,dst=/tmp,tmpfs-size=67108864,tmpfs-mode=01777",
      APPROVED_IMAGE.reference,
    ],
  });

  const readOnly = buildDockerCreateInvocation(runtimeInput("read-only"));
  assert.equal(
    readOnly.args.includes("--mount=type=bind,src=/safe/project,dst=/workspace,readonly,bind-propagation=rprivate,bind-recursive=readonly"),
    true,
  );
  assert.equal(readOnly.args.some((argument) => argument.includes("danger-full-access")), false);
  assert.equal(readOnly.args.some((argument) => argument.startsWith("--entrypoint")), false);
  assert.equal(readOnly.args.includes("--pid=private"), false);
  assert.equal(readOnly.args.includes("--uts=private"), false);
});

test("normalized Docker inspect accepts only the exact safe contract", () => {
  for (const permissionProfile of DOCKER_RUNTIME_CONTRACT.permissionProfiles) {
    assert.deepEqual(
      validateDockerInspect(safeInspect(permissionProfile), runtimeInput(permissionProfile)),
      safeInspect(permissionProfile),
    );
  }
});

test("normalized Docker inspect rejects every authority-changing variant", () => {
  const cases = [
    ["mutable image", (value) => { value.image.reference = "registry.example/sdd/codex-app-server:latest"; }, "BROKER_CONTAINER_IMAGE_MISMATCH"],
    ["wrong digest", (value) => { value.image.digest = `sha256:${"c".repeat(64)}`; }, "BROKER_CONTAINER_IMAGE_MISMATCH"],
    ["root user", (value) => { value.image.user = "0:0"; }, "BROKER_CONTAINER_USER_MISMATCH"],
    ["writable rootfs", (value) => { value.rootfsReadOnly = false; }, "BROKER_CONTAINER_READONLY_UNAVAILABLE"],
    ["privileged", (value) => { value.privileged = true; }, "BROKER_CONTAINER_PRIVILEGE_MISMATCH"],
    ["privilege escalation", (value) => { value.noNewPrivileges = false; }, "BROKER_CONTAINER_PRIVILEGE_MISMATCH"],
    ["host pid", (value) => { value.namespaces.pid = "host"; }, "BROKER_CONTAINER_NAMESPACE_MISMATCH"],
    ["host ipc", (value) => { value.namespaces.ipc = "host"; }, "BROKER_CONTAINER_NAMESPACE_MISMATCH"],
    ["host network", (value) => { value.namespaces.network = "host"; }, "BROKER_CONTAINER_NAMESPACE_MISMATCH"],
    ["host user namespace", (value) => { value.namespaces.user = "host"; }, "BROKER_CONTAINER_NAMESPACE_MISMATCH"],
    ["added capability", (value) => { value.capabilities.add.push("SYS_ADMIN"); }, "BROKER_CONTAINER_CAPABILITY_MISMATCH"],
    ["incomplete capability drop", (value) => { value.capabilities.drop = []; }, "BROKER_CONTAINER_CAPABILITY_MISMATCH"],
    ["device", (value) => { value.devices.push({ path: "/dev/kvm" }); }, "BROKER_CONTAINER_DEVICE_MISMATCH"],
    ["extra mount", (value) => { value.mounts.push({ destination: "/host", source: "/", type: "bind" }); }, "BROKER_CONTAINER_MOUNT_MISMATCH"],
    ["Docker socket", (value) => { value.mounts.push({ destination: "/var/run/docker.sock", source: "/var/run/docker.sock", type: "bind" }); }, "BROKER_CONTAINER_MOUNT_MISMATCH"],
    ["writable managed prompts", (value) => { value.mounts[1].readOnly = false; }, "BROKER_CONTAINER_MOUNT_MISMATCH"],
    ["non-recursive managed prompts", (value) => { value.mounts[1].recursiveReadOnly = false; }, "BROKER_CONTAINER_READONLY_UNAVAILABLE"],
    ["wrong project source", (value) => { value.mounts[0].source = "/other"; }, "BROKER_CONTAINER_MOUNT_MISMATCH"],
    ["missing resources", (value) => { delete value.resources.memoryBytes; }, "BROKER_CONTAINER_RESOURCE_MISMATCH"],
    ["unbounded pids", (value) => { value.resources.pidsLimit = 0; }, "BROKER_CONTAINER_RESOURCE_MISMATCH"],
    ["wrong labels", (value) => { value.labels["io.github.gustavoarielms.sdd-codegraph.run-id"] = "attacker"; }, "BROKER_CONTAINER_LABEL_MISMATCH"],
    ["extra authority field", (value) => { value.hostConfig = { privileged: true }; }, "BROKER_CONTAINER_INSPECT_INVALID"],
  ];

  for (const [name, mutate, reasonCode] of cases) {
    const inspect = clone(safeInspect());
    mutate(inspect);
    assert.throws(
      () => validateDockerInspect(inspect, runtimeInput()),
      (error) => error?.message === reasonCode,
      name,
    );
  }
});

test("Docker launcher results are strictly allowlisted and internally consistent", () => {
  const result = {
    completion: {
      threadId: "thread-main",
      turn: { id: "turn-main", status: "completed" },
    },
    container_image_digest: IMAGE_DIGEST,
    permission_profile: "workspace-only",
    prompt_snapshot_sha256: `sha256:${"d".repeat(64)}`,
    reason_code: "BROKER_RUNTIME_PROTECTED",
    runtime: "docker",
    sessionId: "session-main",
    threadId: "thread-main",
    trusted: true,
    turnId: "turn-main",
  };
  assert.deepEqual(validateDockerLauncherResult(result), result);
  assert.deepEqual(validateDockerLauncherResult({
    permission_profile: "read-only",
    reason_code: "BROKER_CONTAINER_IMAGE_MISMATCH",
    runtime: "docker",
    trusted: false,
  }), {
    permission_profile: "read-only",
    reason_code: "BROKER_CONTAINER_IMAGE_MISMATCH",
    runtime: "docker",
    trusted: false,
  });

  for (const mutate of [
    (value) => { value.error = "daemon: SENSITIVE"; },
    (value) => { value.projectPath = "/secret/project"; },
    (value) => { value.prompt = "secret prompt"; },
    (value) => { value.reason_code = "BROKER_ATTACKER_SUPPLIED"; },
    (value) => { value.container_image_digest = "sha256:not-a-digest"; },
    (value) => { value.completion.turn.id = "foreign-turn"; },
    (value) => { value.trusted = false; },
  ]) {
    const candidate = clone(result);
    mutate(candidate);
    assertReason(() => validateDockerLauncherResult(candidate), "BROKER_LAUNCH_RESULT_INVALID");
  }
  for (const field of ["prompt_snapshot_sha256", "container_image_digest"]) {
    const candidate = clone(result);
    candidate[field] = [candidate[field]];
    assertReason(() => validateDockerLauncherResult(candidate), "BROKER_LAUNCH_RESULT_INVALID");
  }
});

test("Docker launcher result schema is closed and requires semantic identity validation", () => {
  assert.equal(DOCKER_LAUNCHER_RESULT_SCHEMA.type, "object");
  assert.equal(DOCKER_LAUNCHER_RESULT_SCHEMA.additionalProperties, false);
  assert.equal(
    DOCKER_LAUNCHER_RESULT_SCHEMA.$comment,
    "Structural validation only; validateDockerLauncherResult is required for semantic identity correlation.",
  );
  assert.deepEqual(DOCKER_LAUNCHER_RESULT_SCHEMA.required, [
    "trusted",
    "reason_code",
    "runtime",
    "permission_profile",
  ]);
  assert.deepEqual(DOCKER_LAUNCHER_RESULT_SCHEMA.properties.reason_code.enum, BROKER_REASON_CODES);
  assert.deepEqual(DOCKER_LAUNCHER_RESULT_SCHEMA.properties.permission_profile.enum, [
    "workspace-only",
    "read-only",
  ]);
  assert.equal(DOCKER_LAUNCHER_RESULT_SCHEMA.properties.runtime.const, "docker");
  assert.equal(DOCKER_LAUNCHER_RESULT_SCHEMA.properties.completion.additionalProperties, false);
  const validate = new Ajv2020({ strict: true }).compile(DOCKER_LAUNCHER_RESULT_SCHEMA);
  assert.equal(validate({
    completion: { threadId: "thread-main", turn: { id: "turn-main", status: "completed" } },
    container_image_digest: IMAGE_DIGEST,
    permission_profile: "workspace-only",
    prompt_snapshot_sha256: `sha256:${"d".repeat(64)}`,
    reason_code: "BROKER_RUNTIME_PROTECTED",
    runtime: "docker",
    threadId: "thread-main",
    trusted: true,
    turnId: "turn-main",
  }), true);
  assert.equal(validate({
    permission_profile: "workspace-only",
    reason_code: "BROKER_RUNTIME_PROTECTED",
    runtime: "docker",
    trusted: true,
  }), false);
  assert.equal(validate({
    error: "daemon output",
    permission_profile: "read-only",
    reason_code: "BROKER_CONTAINER_IMAGE_MISMATCH",
    runtime: "docker",
    trusted: false,
  }), false);
  const foreignCompletion = {
    completion: { threadId: "foreign-thread", turn: { id: "foreign-turn", status: "completed" } },
    container_image_digest: IMAGE_DIGEST,
    permission_profile: "workspace-only",
    prompt_snapshot_sha256: `sha256:${"d".repeat(64)}`,
    reason_code: "BROKER_RUNTIME_PROTECTED",
    runtime: "docker",
    threadId: "thread-main",
    trusted: true,
    turnId: "turn-main",
  };
  assert.equal(validate(foreignCompletion), true);
  assertReason(
    () => validateDockerLauncherResult(foreignCompletion),
    "BROKER_LAUNCH_RESULT_INVALID",
  );
});

test("Docker Task 1 contract remains pure and cannot execute a daemon", async () => {
  const source = await fs.readFile(new URL("../src/docker-runtime-contract.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|\bspawn(?:Sync)?\b|\bexec(?:File|Sync)?\b/u);
  assert.doesNotMatch(source, /docker\s+(?:create|inspect|start|rm)/u);
});
