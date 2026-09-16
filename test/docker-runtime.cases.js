import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { runDockerLifecycle } from "../src/docker-runtime.js";

import test from "./classified-test.js";
import {
  BROKER_REASON_CODES,
  DOCKER_LAUNCHER_RESULT_SCHEMA,
  DOCKER_RUNTIME_CONTRACT,
  buildDockerCreateInvocation,
  validateDockerInspect,
  validateDockerLauncherResult,
} from "../src/docker-runtime-contract.js";

const FIXTURE_IMAGE = JSON.parse(await fs.readFile(new URL("./fixtures/docker-runtime/image.json", import.meta.url), "utf8"));
const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE_CONFIG_DIGEST = `sha256:${"e".repeat(64)}`;
const RUN_ID = "b".repeat(64);
const PROJECT_ROOT = "/safe/project";
const IMAGE_LABELS = Object.freeze({
  "io.github.gustavoarielms.sdd-codegraph.contract-version": "1",
  "org.opencontainers.image.source": "https://github.com/gustavoarielms/multi-sdd-team",
  "org.opencontainers.image.version": "0.154.0",
});
const APPROVED_IMAGE = Object.freeze({
  command: Object.freeze(["--listen", "stdio://"]),
  configDigest: IMAGE_CONFIG_DIGEST,
  digest: IMAGE_DIGEST,
  entrypoint: Object.freeze(["/usr/local/libexec/sdd-codegraph/runtime-entrypoint"]),
  environment: Object.freeze([
    "PATH=/opt/openai/codex-app-server/codex-path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME=/run/codex",
    "CODEX_HOME=/run/codex",
  ]),
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
    image: {
      digest: APPROVED_IMAGE.digest,
      reference: APPROVED_IMAGE.reference,
      user: APPROVED_IMAGE.user,
    },
    labels: {
      ...IMAGE_LABELS,
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
        gid: 10001,
        mode: 0o700,
        uid: 10001,
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
    openStdin: true,
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
    "BROKER_RUNTIME_IMAGE_UNAVAILABLE",
    "BROKER_RUNTIME_IMAGE_MANIFEST_INVALID",
    "BROKER_RUNTIME_IMAGE_EVIDENCE_INVALID",
    "BROKER_RUNTIME_ATTESTATION_INVALID",
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
    "BROKER_CONTAINER_CLEANUP_UNPROVEN",
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
  assertReason(
    () => buildDockerCreateInvocation(runtimeInput("workspace-only", {
      approvedImage: { ...APPROVED_IMAGE, user: "2147483648:10001" },
    })),
    "BROKER_DOCKER_CONTRACT_INPUT_INVALID",
  );
  for (const override of [
    { approvedImage: { ...APPROVED_IMAGE, command: ["sh", "-c", "codex"] } },
    { approvedImage: { ...APPROVED_IMAGE, configDigest: [APPROVED_IMAGE.configDigest] } },
    { approvedImage: { ...APPROVED_IMAGE, digest: [APPROVED_IMAGE.digest] } },
    { approvedImage: { ...APPROVED_IMAGE, entrypoint: ["/bin/sh"] } },
    { approvedImage: { ...APPROVED_IMAGE, environment: ["TOKEN=secret"] } },
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
      "--interactive",
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
      "--tmpfs=/run/codex:rw,size=67108864,mode=0700,uid=10001,gid=10001",
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
    ["malformed image reference", (value) => { value.image.reference = { toString: null }; }, "BROKER_CONTAINER_IMAGE_MISMATCH"],
    ["root user", (value) => { value.image.user = "0:0"; }, "BROKER_CONTAINER_USER_MISMATCH"],
    ["closed stdin", (value) => { value.openStdin = false; }, "BROKER_CONTAINER_INSPECT_INVALID"],
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
    ["root-owned Codex state", (value) => { value.mounts[2].uid = 0; }, "BROKER_CONTAINER_MOUNT_MISMATCH"],
    ["missing resources", (value) => { delete value.resources.memoryBytes; }, "BROKER_CONTAINER_RESOURCE_MISMATCH"],
    ["unbounded pids", (value) => { value.resources.pidsLimit = 0; }, "BROKER_CONTAINER_RESOURCE_MISMATCH"],
    ["wrong labels", (value) => { value.labels["io.github.gustavoarielms.sdd-codegraph.run-id"] = "attacker"; }, "BROKER_CONTAINER_LABEL_MISMATCH"],
    ["missing image label", (value) => { delete value.labels["org.opencontainers.image.source"]; }, "BROKER_CONTAINER_LABEL_MISMATCH"],
    ["wrong image label", (value) => { value.labels["org.opencontainers.image.version"] = "latest"; }, "BROKER_CONTAINER_LABEL_MISMATCH"],
    ["unknown image label", (value) => { value.labels["org.opencontainers.image.extra"] = "unapproved"; }, "BROKER_CONTAINER_LABEL_MISMATCH"],
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

const CONTAINER_ID = "c".repeat(64);
const FOREIGN_CONTAINER_ID = "d".repeat(64);
const IMAGE_ID = IMAGE_CONFIG_DIGEST;
const UNAVAILABLE = "BROKER_PROCESS_CONTAINMENT_UNAVAILABLE";
const CLEANUP_UNPROVEN = "BROKER_CONTAINER_CLEANUP_UNPROVEN";

function rawContainer(input = runtimeInput()) {
  const normalized = safeInspect(input.permissionProfile);
  normalized.labels[DOCKER_RUNTIME_CONTRACT.labels.run] = input.runId;
  return {
    Id: CONTAINER_ID, Image: IMAGE_ID,
    Config: {
      Image: APPROVED_IMAGE.reference, User: APPROVED_IMAGE.user, OpenStdin: true,
      WorkingDir: "/workspace", Tty: false, Env: [...APPROVED_IMAGE.environment],
      Entrypoint: [...APPROVED_IMAGE.entrypoint], Cmd: [...APPROVED_IMAGE.command], Labels: normalized.labels,
      Volumes: null, Healthcheck: null,
    },
    State: { Status: "created", Running: false, Paused: false, Restarting: false, Dead: false },
    HostConfig: {
      ReadonlyRootfs: true, Privileged: false, CapAdd: null, CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges=true"], Devices: [], DeviceRequests: null,
      DeviceCgroupRules: null, PidMode: "", IpcMode: "private", NetworkMode: "bridge",
      UsernsMode: "", UTSMode: "", Memory: 1073741824, NanoCpus: 2000000000,
      PidsLimit: 256, Binds: null, VolumesFrom: null, AutoRemove: false,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 }, PortBindings: {},
      PublishAllPorts: false, ExtraHosts: null, Dns: [], DnsOptions: [], DnsSearch: [],
      GroupAdd: null, Runtime: "runc", CgroupnsMode: "private",
      Sysctls: null, StorageOpt: null, ContainerIDFile: "",
      Mounts: [
        { Type: "bind", Source: PROJECT_ROOT, Target: "/workspace", ReadOnly: input.permissionProfile === "read-only", BindOptions: { Propagation: "rprivate", ...(input.permissionProfile === "read-only" ? { ReadOnlyForceRecursive: true } : {}) } },
        { Type: "bind", Source: `${PROJECT_ROOT}/.codex`, Target: "/workspace/.codex", ReadOnly: true, BindOptions: { Propagation: "rprivate", ReadOnlyForceRecursive: true } },
        { Type: "tmpfs", Target: "/tmp", TmpfsOptions: { SizeBytes: 67108864, Mode: 1023 } },
      ],
      Tmpfs: { "/run/codex": "rw,size=67108864,mode=0700,uid=10001,gid=10001" },
    },
    Mounts: [...normalized.mounts.slice(0, 2).map((m) => ({ Type: "bind", Source: m.source, Destination: m.destination, RW: !m.readOnly, Propagation: "rprivate", Mode: "" })),
      { Type: "tmpfs", Source: "", Destination: "/tmp", Mode: "", RW: true, Propagation: "" }],
  };
}

function fakeDocker(overrides = {}) {
  const calls = [];
  const children = [];
  let input = runtimeInput();
  const image = {
    Id: IMAGE_ID, RepoDigests: [APPROVED_IMAGE.reference], Os: "linux", Architecture: "arm64",
    Config: { User: APPROVED_IMAGE.user, Entrypoint: [...APPROVED_IMAGE.entrypoint], Cmd: [...APPROVED_IMAGE.command], Env: [...APPROVED_IMAGE.environment], Volumes: null, Healthcheck: null, Labels: { ...IMAGE_LABELS } },
  };
  const steps = [
    { stdout: JSON.stringify({ Os: "linux", Arch: "arm64", Version: "28.0.0", ApiVersion: "1.48", Components: [{ Name: "Engine" }] }) },
    { stdout: JSON.stringify({ OSType: "linux", Architecture: "aarch64", OperatingSystem: "Docker Desktop", SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns", "name=userns"], DefaultRuntime: "runc", KernelVersion: "6.10.0-linuxkit" }) },
    { stdout: JSON.stringify([image]) },
    { stdout: `${CONTAINER_ID}\n` },
    { stdout: () => JSON.stringify([rawContainer(input)]) },
    { stdout: "ready\n", wait: true },
    { stdout: `${CONTAINER_ID}\n` },
    { code: 1, stdout: "[]\n", stderr: `Error: No such container: ${CONTAINER_ID}\n` },
    { stdout: "" },
  ];
  for (const [index, change] of Object.entries(overrides)) steps[Number(index)] = { ...steps[Number(index)], ...change };
  function spawnProcess(command, args, options) {
    const index = calls.length;
    calls.push({ command, args: [...args], options: structuredClone(options) });
    if (args.includes("create")) {
      input = runtimeInput(args.some((a) => a.includes("src=/safe/project,dst=/workspace,readonly")) ? "read-only" : "workspace-only", {
        runId: args.find((a) => a.startsWith(`--label=${DOCKER_RUNTIME_CONTRACT.labels.run}=`)).split("=").at(-1),
      });
    }
    const operation = args.slice(2);
    let slot = index;
    if (operation[0] === "rm") slot = 6;
    if (operation[0] === "container" && operation[1] === "inspect") slot = 4;
    if (operation[0] === "container" && operation[1] === "inspect" && calls.some((c) => c.args.includes("rm"))) slot = 7;
    if (operation[0] === "container" && operation[1] === "ls") slot = 8;
    const step = steps[slot];
    if (!step) throw new Error("unexpected process SENSITIVE");
    if (step.throw) throw new Error("SENSITIVE /secret/project TOKEN=secret");
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.writes = [];
    child.stdin = new Writable({ write(chunk, encoding, callback) { child.writes.push(Buffer.from(chunk)); if (!step.blockWrites) callback(); } });
    child.closed = false;
    child.finish = (code = step.code ?? 0, signal = step.signal ?? null) => {
      if (child.closed) return;
      child.closed = true;
      child.emit("exit", code, signal);
      child.stdout.end(); child.stderr.end();
      child.emit("close", code, signal);
    };
    child.kill = (signal) => { child.kills.push(signal); if (!step.ignoreKill) child.finish(null, signal); return true; };
    child.kills = [];
    children.push(child);
    queueMicrotask(() => {
      if (step.error) { child.emit("error", new Error("SENSITIVE daemon disconnected")); return; }
      if (step.hang) return;
      const out = typeof step.stdout === "function" ? step.stdout() : step.stdout;
      for (const piece of step.chunks ?? [out ?? ""]) {
        if (child.closed) break;
        child.stdout.write(piece);
      }
      if (step.stderr && !child.closed) child.stderr.write(step.stderr);
      if (!step.wait && !child.closed) child.finish();
    });
    return child;
  }
  return { calls, children, spawnProcess, steps, get input() { return input; } };
}

async function lifecycle(fake, extra = {}, input = {}) {
  return runDockerLifecycle({ approvedImage: APPROVED_IMAGE, permissionProfile: "workspace-only", projectRoot: PROJECT_ROOT, ...input }, {
    spawnProcess: fake.spawnProcess,
    testHooks: { host: { platform: "darwin", arch: "arm64", home: "/safe/host" } },
    operate: async (transport) => { await transport.write("request\n"); fake.children[5].finish(); },
    ...extra,
  });
}

function assertSanitized(result, code = UNAVAILABLE) {
  assert.equal(result.trusted, false);
  assert.equal(result.reason_code, code);
  assert.doesNotMatch(JSON.stringify(result), /SENSITIVE|secret|TOKEN|\/safe|stderr|stdout/u);
  assert.doesNotThrow(() => validateDockerLauncherResult(result));
}

function assertRemoval(fake) {
  const removal = fake.calls.find((c) => c.args.includes("rm"));
  assert.ok(removal, "force-remove attempted");
  assert.deepEqual(removal.args.slice(-3), ["rm", "--force", CONTAINER_ID]);
  assert.ok(fake.calls.some((c) => c.args.includes("inspect") && c.args.at(-1) === CONTAINER_ID));
  assert.ok(fake.calls.some((c) => c.args.includes("ls") && c.args.includes("--all") && c.args.includes("--no-trunc")));
}

function assertNoRuntimeProcessObservers(fake) {
  for (const child of fake.children) {
    for (const event of ["close", "disconnect", "error"]) assert.equal(child.listenerCount(event), 0);
    for (const stream of [child.stdout, child.stderr]) {
      for (const event of ["data", "error"]) assert.equal(stream.listenerCount(event), 0);
    }
    assert.equal(child.stdin.listenerCount("error"), 0);
  }
}

test("Docker lifecycle uses only owned argv and never grants trust", async () => {
  for (const permissionProfile of ["workspace-only", "read-only"]) {
    const fake = fakeDocker();
    assertSanitized(await lifecycle(fake, {}, { permissionProfile }));
    assert.equal(fake.calls.length, 9);
    assert.ok(fake.calls.some((call) => call.args.includes("start")));
    assertRemoval(fake);
    for (const call of fake.calls) {
      assert.equal(call.command, "docker");
      assert.equal(call.options.shell, false);
      assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"]);
      assert.ok(call.args[0].startsWith("--host=unix:///safe/host/.docker/run/docker.sock"));
      assert.ok(call.args[1].startsWith("--config="));
      assert.equal(call.options.env.DOCKER_HOST, undefined);
      assert.equal(call.options.env.DOCKER_CONTEXT, undefined);
      assert.equal(call.options.env.NODE_OPTIONS, undefined);
      assert.ok(!call.args.includes("pull") && !call.args.includes("build"));
    }
    const create = fake.calls[3].args.slice(2);
    const runId = create.find((arg) => arg.startsWith(`--label=${DOCKER_RUNTIME_CONTRACT.labels.run}=`)).split("=").at(-1);
    assert.match(runId, /^[a-f0-9]{64}$/u);
    assert.deepEqual(create, buildDockerCreateInvocation(runtimeInput(permissionProfile, { runId })).args);
  }
  assertSanitized(await runDockerLifecycle({ approvedImage: APPROVED_IMAGE, permissionProfile: "workspace-only", projectRoot: PROJECT_ROOT }));
});

test("real Docker fixture pins observed OCI bytes and passes strict image preflight", async () => {
  const read = (name) => fs.readFile(new URL(`./fixtures/docker-runtime/${name}`, import.meta.url));
  const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const manifestBytes = await read("manifest.json");
  const configBytes = await read("config.json");
  const manifest = JSON.parse(manifestBytes);
  const config = JSON.parse(configBytes);
  const record = JSON.parse(await read("build-record.json"));
  assert.equal(digest(manifestBytes), FIXTURE_IMAGE.digest);
  assert.equal(digest(configBytes), FIXTURE_IMAGE.configDigest);
  assert.equal(manifest.config.digest, FIXTURE_IMAGE.configDigest);
  assert.equal(manifest.config.size, configBytes.length);
  assert.equal(record.manifestDigest, FIXTURE_IMAGE.digest);
  assert.equal(record.configDigest, FIXTURE_IMAGE.configDigest);
  for (const [name, hash] of Object.entries(record.sources)) assert.equal(digest(await read(name)), hash);

  const fake = fakeDocker();
  fake.steps[2].stdout = JSON.stringify([{
    Id: digest(configBytes), RepoDigests: [FIXTURE_IMAGE.reference],
    Os: config.os, Architecture: config.architecture, Config: config.config,
  }]);
  fake.steps[4].stdout = () => {
    const container = rawContainer(fake.input);
    container.Image = digest(configBytes);
    container.Config = { ...container.Config, ...config.config, Image: FIXTURE_IMAGE.reference, Labels: container.Config.Labels };
    return JSON.stringify([container]);
  };
  assertSanitized(await lifecycle(fake, {}, { approvedImage: FIXTURE_IMAGE }));
  assert.ok(fake.calls.some((call) => call.args.includes("start")));
  assertRemoval(fake);
});

test("Docker lifecycle rejects malformed daemon image and container output", async () => {
  for (const index of [0, 1, 2, 4]) {
    for (const stdout of ["SENSITIVE", "{}{}", "null", "[]", "[{},{}]", "{\"a\":1,\"a\":2}"]) {
      const fake = fakeDocker({ [index]: { stdout } });
      const result = await lifecycle(fake);
      assert.equal(result.trusted, false);
      if (index === 4) {
        assert.ok(!fake.calls.some((call) => call.args.includes("rm")));
      } else assert.ok(!fake.calls.some((call) => call.args.includes("create")));
    }
  }
});

test("Docker lifecycle rejects invalid create IDs and uncertain cleanup", async () => {
  for (const stdout of ["", "c".repeat(12), `${CONTAINER_ID}\n${CONTAINER_ID}\n`, "x".repeat(64), `--host=tcp://attacker\n`, `["${CONTAINER_ID}"]`, ` ${CONTAINER_ID}`, `${CONTAINER_ID}\nSENSITIVE`]) {
    const fake = fakeDocker({ 3: { stdout } });
    const result = await lifecycle(fake);
    assertSanitized(result, CLEANUP_UNPROVEN);
    assert.ok(!fake.calls.some((c) => c.args.includes("start")));
    assert.ok(fake.calls.every((c) => !c.args.includes("--host=tcp://attacker")));
  }
});

test("Docker lifecycle bounds partial writes streams failures and cleanup", async () => {
  const fake = fakeDocker({ 3: { chunks: [CONTAINER_ID.slice(0, 7), CONTAINER_ID.slice(7), "\n"] }, 5: { chunks: ["rea", "dy\n"] } });
  assertSanitized(await lifecycle(fake));
  assert.equal(Buffer.concat(fake.children[5].writes).toString(), "request\n");
  assertRemoval(fake);
  for (const index of [5, 6, 7, 8]) {
    for (const change of [
      { code: 1, wait: false, stderr: "SENSITIVE /secret TOKEN=abc" },
      { signal: "SIGTERM", wait: false },
      { error: true },
      { stdout: "x".repeat(DOCKER_RUNTIME_CONTRACT.limits.stdoutBytes + 1), wait: false },
      { stderr: "x".repeat(DOCKER_RUNTIME_CONTRACT.limits.stderrBytes + 1), wait: false },
    ]) {
      const candidate = fakeDocker({ [index]: change });
      const result = await lifecycle(candidate);
      assert.equal(result.trusted, false);
      assertRemoval(candidate);
      if (index >= 6) assertSanitized(result, CLEANUP_UNPROVEN);
    }
  }
});

test("Docker lifecycle rejects inspect authority mismatches before start", async () => {
  for (const [mutate, ownershipValid] of [
    [(c) => { c.Id = "d".repeat(64); }, false],
    [(c) => { c.Image = `sha256:${"f".repeat(64)}`; }, true],
    [(c) => { c.Config.User = "0:0"; }, true],
    [(c) => { c.Config.Labels = {}; }, false],
    [(c) => { c.Mounts[1].RW = true; }, true],
    [(c) => { c.HostConfig.Mounts[1].BindOptions.ReadOnlyForceRecursive = false; }, true],
    [(c) => { c.HostConfig.Privileged = true; }, true],
    [(c) => { c.HostConfig.Devices = [{ PathOnHost: "/dev/kvm" }]; }, true],
    [(c) => { c.HostConfig.MaskedPaths = ["/workspace"]; }, true],
    [(c) => { c.HostConfig.EvilAuthority = true; }, true],
    [(c) => { c.Config.Env.push("DOCKER_HOST=tcp://attacker"); }, true],
  ]) {
    const fake = fakeDocker();
    const normal = fake.steps[4].stdout;
    fake.steps[4].stdout = () => { const c = JSON.parse(normal())[0]; mutate(c); return JSON.stringify([c]); };
    await lifecycle(fake);
    assert.ok(!fake.calls.some((c) => c.args.includes("start")));
    assert.equal(fake.calls.some((c) => c.args.includes("rm")), ownershipValid);
  }
});

test("Docker lifecycle proves absence by exact ID and unique ownership", async () => {
  for (const [index, change] of [
    [6, { stdout: `${CONTAINER_ID}\n${CONTAINER_ID}\n` }],
    [7, { code: 0, stdout: JSON.stringify([rawContainer()]), stderr: "" }],
    [7, { code: 1, stdout: "[]", stderr: "SENSITIVE daemon disconnected" }],
    [8, { stdout: `${CONTAINER_ID}\n` }],
    [8, { stdout: `${CONTAINER_ID}\n${CONTAINER_ID}\n` }],
  ]) {
    const fake = fakeDocker({ [index]: change });
    assertSanitized(await lifecycle(fake), CLEANUP_UNPROVEN);
    assertRemoval(fake);
  }
});

test("Docker lifecycle rejects target configuration and stays disabled by default", async () => {
  for (const extra of [{ runId: RUN_ID }, { dockerFlags: ["--privileged"] }, { env: { DOCKER_HOST: "tcp://attacker" } }, { shell: true }, { endpoint: "ssh://host" }, { trusted: true }]) {
    const fake = fakeDocker();
    const result = await lifecycle(fake, {}, extra);
    assertSanitized(result, "BROKER_DOCKER_CONTRACT_INPUT_INVALID");
    assert.equal(fake.calls.length, 0);
  }
});

function controlledClock() {
  let now = 0;
  let serial = 0;
  const timers = new Map();
  const fired = [];
  return {
    timers, fired,
    setTimeout(callback, ms) { const id = ++serial; timers.set(id, { at: now + ms, callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance() {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) return;
      timers.delete(next[0]); now = next[1].at; fired.push(next[1].ms); next[1].callback();
    },
  };
}

async function clockedLifecycle(fake, extra = {}) {
  const clock = controlledClock();
  let settled = false;
  const pending = lifecycle(fake, { ...extra, testHooks: { host: { platform: "darwin", arch: "arm64", home: "/safe/host" }, clock, ...extra.testHooks } });
  void pending.finally(() => { settled = true; });
  for (let iteration = 0; !settled && iteration < 200; iteration += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (!settled) clock.advance();
  }
  assert.ok(settled, "lifecycle must settle within bounded fake deadlines");
  return { result: await pending, clock };
}

test("Docker lifecycle enforces startup operation turn interrupt and removal deadlines", async () => {
  for (const [name, index, change, extra, expectedTimeout, expectedReason] of [
    ["version startup", 0, { hang: true }, {}, 30000, UNAVAILABLE],
    ["attach startup", 5, { hang: true }, {}, 30000, UNAVAILABLE],
    ["stdin write", 5, { blockWrites: true }, {}, 30000, UNAVAILABLE],
    ["turn callback", 5, {}, { operate: () => new Promise(() => {}) }, 120000, CLEANUP_UNPROVEN],
    ["interrupt callback", 5, {}, { operate: () => { throw new Error("SENSITIVE"); }, interrupt: () => new Promise(() => {}) }, 1000, UNAVAILABLE],
    ["force removal", 6, { hang: true }, {}, 10000, CLEANUP_UNPROVEN],
    ["absence inspection", 7, { hang: true }, {}, 10000, CLEANUP_UNPROVEN],
    ["ownership query", 8, { hang: true }, {}, 10000, CLEANUP_UNPROVEN],
    ["unclosed create", 3, { hang: true, ignoreKill: true }, {}, 30000, CLEANUP_UNPROVEN],
    ["unclosed attach", 5, { hang: true, ignoreKill: true }, {}, 30000, CLEANUP_UNPROVEN],
  ]) {
    const fake = fakeDocker({ [index]: change });
    const { result, clock } = await clockedLifecycle(fake, extra);
    assert.ok(clock.fired.includes(expectedTimeout), name);
    assertSanitized(result, expectedReason);
    assert.equal(clock.timers.size, 0, "no retained deadline after settlement");
    if (index >= 5) assert.ok(fake.calls.some((c) => c.args.includes("rm")));
  }
});

test("Docker lifecycle handles host signals abort and child disconnect without leaks", async () => {
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "abort", "disconnect"]) {
    const fake = fakeDocker();
    const signals = new EventEmitter();
    const controller = new AbortController();
    const { result, clock } = await clockedLifecycle(fake, {
      signal: controller.signal,
      testHooks: { signals },
      operate: () => {
        if (name === "abort") controller.abort("SENSITIVE");
        else if (name === "disconnect") fake.children[5].emit("disconnect");
        else signals.emit(name);
        return new Promise(() => {});
      },
    });
    assertSanitized(result, CLEANUP_UNPROVEN);
    assertRemoval(fake);
    assert.equal(clock.timers.size, 0);
    assert.equal(signals.eventNames().length, 0);
  }
});

test("Docker lifecycle handles backpressure invalid UTF8 and bounded input", async () => {
  for (const operate of [
    (transport) => transport.write("x".repeat(DOCKER_RUNTIME_CONTRACT.limits.stdoutBytes + 1)),
    (transport) => transport.write({ toString: () => "SENSITIVE" }),
    async (transport) => { await transport.write("first"); await transport.write("second"); throw new Error("SENSITIVE"); },
  ]) {
    const fake = fakeDocker();
    assertSanitized(await lifecycle(fake, { operate }));
    assertRemoval(fake);
  }
  const fake = fakeDocker({ 4: { chunks: [Buffer.from([0xff])] } });
  assert.equal((await lifecycle(fake)).trusted, false);
  assert.ok(!fake.calls.some((call) => call.args.includes("start")));
});

test("Docker lifecycle rejects daemon and approved image identity changes", async () => {
  for (const [index, mutate] of [
    [0, (v) => { v.Os = "windows"; }],
    [0, (v) => { v.Arch = "amd64"; }],
    [0, (v) => { v.ApiVersion = ["1.48"]; }],
    [0, (v) => { v.Components = [{ Name: "Podman Engine" }]; }],
    [1, (v) => { v.SecurityOptions.push("name=rootless"); }],
    [1, (v) => { v.DefaultRuntime = "attacker"; }],
    [1, (v) => { v.KernelVersion = "5.11.0"; }],
    [2, (v) => { v[0].RepoDigests = []; }],
    [2, (v) => { v[0].RepoDigests.push(APPROVED_IMAGE.reference); }],
    [2, (v) => { v[0].Id = `sha256:${"f".repeat(64)}`; }],
    [2, (v) => { v[0].Config.Entrypoint = ["/bin/sh"]; }],
    [2, (v) => { v[0].Config.Cmd = ["-c", "codex"]; }],
    [2, (v) => { v[0].Config.Env.push("TOKEN=secret"); }],
    [2, (v) => { v[0].Config.Labels = null; }],
    [2, (v) => { delete v[0].Config.Labels["org.opencontainers.image.source"]; }],
    [2, (v) => { v[0].Config.Labels["org.opencontainers.image.version"] = "latest"; }],
    [2, (v) => { v[0].Config.Labels["org.opencontainers.image.extra"] = "unapproved"; }],
    [2, (v) => { v[0].Config.Labels[DOCKER_RUNTIME_CONTRACT.labels.run] = RUN_ID; }],
    [2, (v) => { v[0].Config.User = "0"; }],
    [2, (v) => { v[0].Architecture = "amd64"; }],
    [2, (v) => { v[0].Config.Volumes = { "/workspace/.codex": {} }; }],
  ]) {
    const fake = fakeDocker();
    const response = JSON.parse(fake.steps[index].stdout);
    mutate(response);
    fake.steps[index].stdout = JSON.stringify(response);
    await lifecycle(fake);
    assert.ok(!fake.calls.some((c) => c.args.includes("create")));
  }
});

test("Docker lifecycle recovers only one exact ID with all ownership labels", async () => {
  const fake = fakeDocker({ 3: { stdout: "malformed" } });
  let queries = 0;
  fake.steps[8].stdout = () => ++queries === 1 ? `${CONTAINER_ID}\n` : "";
  await lifecycle(fake);
  assertRemoval(fake);
  assert.equal(queries, 2);
  for (const badLabels of [null, {}, { [DOCKER_RUNTIME_CONTRACT.labels.run]: RUN_ID }]) {
    const bad = fakeDocker({ 3: { stdout: "" }, 8: { stdout: `${CONTAINER_ID}\n` } });
    bad.steps[4].stdout = () => JSON.stringify([{ Id: CONTAINER_ID, Config: { Labels: badLabels } }]);
    assertSanitized(await lifecycle(bad), CLEANUP_UNPROVEN);
    assert.ok(!bad.calls.some((c) => c.args.includes("rm")));
  }
  for (const mutate of [
    (labels) => { delete labels["org.opencontainers.image.source"]; },
    (labels) => { labels["org.opencontainers.image.version"] = "latest"; },
    (labels) => { labels["org.opencontainers.image.extra"] = "unapproved"; },
  ]) {
    const bad = fakeDocker({ 3: { stdout: "" }, 8: { stdout: `${CONTAINER_ID}\n` } });
    bad.steps[4].stdout = () => {
      const raw = rawContainer(bad.input);
      mutate(raw.Config.Labels);
      return JSON.stringify([raw]);
    };
    assertSanitized(await lifecycle(bad), CLEANUP_UNPROVEN);
    assert.ok(!bad.calls.some((c) => c.args.includes("rm")));
  }
});

test("Docker lifecycle accepts Docker omitted false fields and unordered mount observations", async () => {
  const fake = fakeDocker();
  const normal = fake.steps[4].stdout;
  fake.steps[4].stdout = () => {
    const raw = JSON.parse(normal())[0];
    delete raw.HostConfig.Mounts[0].ReadOnly;
    raw.HostConfig.OomKillDisable = false;
    raw.Mounts.reverse();
    return JSON.stringify([raw]);
  };
  assertSanitized(await lifecycle(fake));
  assert.ok(fake.calls.some((c) => c.args.includes("start")));
});

test("Docker lifecycle accepts Engine 29 empty defaults and the standard interrupts mask", async () => {
  const fake = fakeDocker();
  const normal = fake.steps[4].stdout;
  fake.steps[4].stdout = () => {
    const raw = JSON.parse(normal())[0];
    raw.HostConfig.Dns = null;
    raw.HostConfig.Ulimits = [];
    raw.HostConfig.MaskedPaths = [
      "/proc/acpi", "/proc/asound", "/proc/interrupts", "/proc/kcore", "/proc/keys",
      "/proc/latency_stats", "/proc/sched_debug", "/proc/scsi", "/proc/timer_list",
      "/proc/timer_stats", "/sys/devices/virtual/powercap", "/sys/firmware",
    ];
    return JSON.stringify([raw]);
  };
  assertSanitized(await lifecycle(fake));
  assert.ok(fake.calls.some((call) => call.args.includes("start")));
});

test("Docker lifecycle requires daemon user namespace remapping", async () => {
  const fake = fakeDocker();
  const info = JSON.parse(fake.steps[1].stdout);
  info.SecurityOptions = info.SecurityOptions.filter((value) => value !== "name=userns");
  fake.steps[1].stdout = JSON.stringify(info);
  const result = await lifecycle(fake);
  assert.ok(!fake.calls.some((c) => c.args.includes("create")));
  assertSanitized(result);
  for (const mode of ["host", "private", "container:other"]) {
    const other = fakeDocker();
    const normal = other.steps[4].stdout;
    other.steps[4].stdout = () => {
      const raw = JSON.parse(normal())[0]; raw.HostConfig.UsernsMode = mode;
      return JSON.stringify([raw]);
    };
    await lifecycle(other);
    assert.ok(!other.calls.some((c) => c.args.includes("start")));
    assertRemoval(other);
  }
});

test("Docker lifecycle never removes an unowned create ID and recovers exact ownership", async () => {
  const fake = fakeDocker({ 3: { stdout: `${FOREIGN_CONTAINER_ID}\n` } });
  let ownershipQueries = 0;
  fake.steps[8].stdout = () => ++ownershipQueries === 1 ? `${CONTAINER_ID}\n` : "";
  fake.steps[4].stdout = () => {
    const requestedId = fake.calls.at(-1).args.at(-1);
    const raw = rawContainer(fake.input);
    if (requestedId === FOREIGN_CONTAINER_ID) {
      raw.Id = FOREIGN_CONTAINER_ID;
      raw.Config.Labels[DOCKER_RUNTIME_CONTRACT.labels.run] = "f".repeat(64);
    }
    return JSON.stringify([raw]);
  };

  const result = await lifecycle(fake);

  assert.equal(result.trusted, false);
  const removedIds = fake.calls.filter((call) => call.args.includes("rm")).map((call) => call.args.at(-1));
  assert.deepEqual(removedIds, [CONTAINER_ID]);
  assert.equal(removedIds.includes(FOREIGN_CONTAINER_ID), false);
  assert.equal(ownershipQueries, 2);
});

test("Docker lifecycle classifies an unclosed preflight process as cleanup unproven", async () => {
  const fake = fakeDocker({ 0: { hang: true, ignoreKill: true } });

  const { result, clock } = await clockedLifecycle(fake);

  assertSanitized(result, CLEANUP_UNPROVEN);
  assert.equal(clock.timers.size, 0);
  assertNoRuntimeProcessObservers(fake);
});

test("Docker lifecycle classifies an unclosed cleanup process as cleanup unproven", async () => {
  const fake = fakeDocker({ 6: { hang: true, ignoreKill: true } });

  const { result, clock } = await clockedLifecycle(fake);

  assertSanitized(result, CLEANUP_UNPROVEN);
  assert.equal(clock.timers.size, 0);
  assertNoRuntimeProcessObservers(fake);
});

test("Docker lifecycle aborts operate and rejects writes after turn timeout", async () => {
  const fake = fakeDocker();
  let observedSignal;
  let stopped = false;
  let writeRejected = false;

  const { result, clock } = await clockedLifecycle(fake, {
    operate: async (transport, signal) => {
      observedSignal = signal;
      if (!signal) return new Promise(() => {});
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      try { await transport.write("after-timeout"); } catch { writeRejected = true; }
      stopped = true;
    },
  });

  assertSanitized(result);
  assert.equal(observedSignal?.aborted, true);
  assert.equal(stopped, true);
  assert.equal(writeRejected, true);
  assert.equal(clock.timers.size, 0);
  assertNoRuntimeProcessObservers(fake);
});

test("Docker lifecycle bounds operate that ignores cancellation as cleanup unproven", async () => {
  const fake = fakeDocker();
  let observedSignal;

  const { result, clock } = await clockedLifecycle(fake, {
    operate: (transport, signal) => {
      observedSignal = signal;
      return new Promise(() => {});
    },
  });

  assertSanitized(result, CLEANUP_UNPROVEN);
  assert.equal(observedSignal?.aborted, true);
  assert.equal(clock.timers.size, 0);
  assertNoRuntimeProcessObservers(fake);
});
