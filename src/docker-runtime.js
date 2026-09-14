import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  BROKER_REASON_CODES,
  DOCKER_RUNTIME_CONTRACT as CONTRACT,
  buildDockerCreateInvocation,
  validateDockerInspect,
} from "./docker-runtime-contract.js";

const UNAVAILABLE = "BROKER_PROCESS_CONTAINMENT_UNAVAILABLE";
const INVALID = "BROKER_CONTAINER_INSPECT_INVALID";
const CLEANUP = "BROKER_CONTAINER_CLEANUP_UNPROVEN";
const FULL_ID = /^[a-f0-9]{64}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const LIMITS = CONTRACT.limits;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

function requireValue(condition, code = INVALID) {
  if (!condition) throw new Error(code);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value, keys) {
  requireValue(record(value) && Object.keys(value).every((key) => keys.includes(key)));
}

function equal(value, expected, code = INVALID) {
  requireValue(isDeepStrictEqual(value, expected), code);
}

function fullId(value) {
  requireValue(typeof value === "string" && FULL_ID.test(value));
  return value;
}

function idOutput(text) {
  requireValue(/^[a-f0-9]{64}\n?$/u.test(text));
  return fullId(text.replace(/\n$/u, ""));
}

// JSON.parse alone silently accepts duplicate keys. Check every object, including
// escaped keys, before accepting Docker output as authority.
function inspectJsonToken(stack, token) {
  const frame = stack.at(-1);
  if (token === "{" || token === "[") {
    requireValue(stack.length < 32);
    stack.push({ keys: token === "{" ? new Set() : null, key: token === "{" });
  } else if (token === "}" || token === "]") stack.pop();
  else if (frame?.keys) {
    if (token === ",") frame.key = true;
    else if (token === ":") frame.key = false;
    else if (frame.key && token.startsWith('"')) {
      const key = JSON.parse(token);
      requireValue(!frame.keys.has(key));
      frame.keys.add(key);
    }
  }
}

function parseJson(text) {
  const value = JSON.parse(text);
  const stack = [];
  for (const token of text.match(/"(?:\\.|[^"\\])*"|[{}[\],:]|[^\s{}[\],:]+/gu) ?? []) {
    inspectJsonToken(stack, token);
  }
  return value;
}

function singleton(text) {
  const result = parseJson(text);
  requireValue(Array.isArray(result) && result.length === 1 && record(result[0]));
  return result[0];
}

function localEndpoint(host) {
  if (host.platform === "linux") return "unix:///var/run/docker.sock";
  if (host.platform === "darwin") {
    requireValue(typeof host.home === "string" && path.posix.isAbsolute(host.home), UNAVAILABLE);
    return `unix://${path.posix.join(host.home, ".docker/run/docker.sock")}`;
  }
  if (host.platform === "win32") return "npipe:////./pipe/dockerDesktopLinuxEngine";
  throw new Error(UNAVAILABLE);
}

function architecture(arch) {
  if (arch === "x64" || arch === "amd64" || arch === "x86_64") return "amd64";
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  throw new Error(UNAVAILABLE);
}

function validateDaemon(server, info, host) {
  requireValue(record(server) && record(info), UNAVAILABLE);
  requireValue(server.Os === "linux" && info.OSType === "linux", UNAVAILABLE);
  equal(architecture(server.Arch), architecture(host.arch), UNAVAILABLE);
  equal(architecture(info.Architecture), architecture(host.arch), UNAVAILABLE);
  requireValue(typeof server.ApiVersion === "string" && /^1\.(?:4[4-9]|[5-9][0-9])$/u.test(server.ApiVersion), UNAVAILABLE);
  requireValue(Array.isArray(server.Components) && server.Components.some((c) => c.Name === "Engine"), UNAVAILABLE);
  requireValue(typeof info.OperatingSystem === "string" && !/podman|rootless/i.test(info.OperatingSystem), UNAVAILABLE);
  requireValue(Array.isArray(info.SecurityOptions) && info.SecurityOptions.every((v) => typeof v === "string" && !/rootless/i.test(v)), UNAVAILABLE);
  // Empty UsernsMode inherits the daemon default. It proves isolation only
  // when Docker itself reports user namespace remapping enabled.
  requireValue(info.SecurityOptions.includes("name=userns"), UNAVAILABLE);
  requireValue(info.DefaultRuntime === "runc", UNAVAILABLE);
  requireValue(typeof info.KernelVersion === "string", UNAVAILABLE);
  const kernel = /^(\d+)\.(\d+)\./u.exec(info.KernelVersion);
  requireValue(kernel && (Number(kernel[1]) > 5 || (Number(kernel[1]) === 5 && Number(kernel[2]) >= 12)), "BROKER_CONTAINER_READONLY_UNAVAILABLE");
}

function safeImage(image, input, host) {
  requireValue(typeof image.Id === "string" && DIGEST.test(image.Id), "BROKER_CONTAINER_IMAGE_MISMATCH");
  requireValue(Array.isArray(image.RepoDigests) && new Set(image.RepoDigests).size === image.RepoDigests.length
    && image.RepoDigests.includes(input.approvedImage.reference), "BROKER_CONTAINER_IMAGE_MISMATCH");
  requireValue(image.Os === "linux" && architecture(image.Architecture) === architecture(host.arch), "BROKER_CONTAINER_IMAGE_MISMATCH");
  requireValue(record(image.Config), "BROKER_CONTAINER_IMAGE_MISMATCH");
  equal(image.Config.User, input.approvedImage.user, "BROKER_CONTAINER_USER_MISMATCH");
  for (const key of ["Entrypoint", "Cmd", "Env"]) {
    requireValue(Array.isArray(image.Config[key]) && image.Config[key].every((item) => typeof item === "string"));
  }
  requireValue(image.Config.Entrypoint.length > 0);
  requireValue(image.Config.Volumes == null && image.Config.Healthcheck == null);
  return image;
}

// Docker's inspect carries metadata as well as authority. Unknown authority
// fields fail closed; known metadata is never copied into the normalized view.
function validateRawConfig(config, image) {
  onlyKeys(config, ["Hostname", "Domainname", "User", "AttachStdin", "AttachStdout", "AttachStderr", "ExposedPorts", "Tty", "OpenStdin", "StdinOnce", "Env", "Cmd", "Healthcheck", "ArgsEscaped", "Image", "Volumes", "WorkingDir", "Entrypoint", "NetworkDisabled", "MacAddress", "OnBuild", "Labels", "StopSignal", "StopTimeout", "Shell"]);
  requireValue(config.Tty === false && config.Volumes == null && config.Healthcheck == null);
  equal(config.Entrypoint, image.Config.Entrypoint);
  equal(config.Cmd, image.Config.Cmd);
  const environment = image.Config.Env.filter((v) => !v.startsWith("CODEX_HOME="));
  environment.push(`CODEX_HOME=${CONTRACT.codexHome}`);
  equal(config.Env, environment);
}

const HOST_DEFAULTS = Object.freeze({
  Binds: null, VolumesFrom: null, DeviceRequests: null, DeviceCgroupRules: null,
  AutoRemove: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
  PortBindings: {}, PublishAllPorts: false, ExtraHosts: null, Dns: [], DnsOptions: [], DnsSearch: [],
  GroupAdd: null, Runtime: "runc", CgroupnsMode: "private", Sysctls: null, StorageOpt: null,
  ContainerIDFile: "", Links: null, VolumeDriver: "", Cgroup: "", CgroupParent: "",
  CpuShares: 0, CpuPeriod: 0, CpuQuota: 0, CpuRealtimePeriod: 0, CpuRealtimeRuntime: 0,
  CpusetCpus: "", CpusetMems: "", BlkioWeight: 0, BlkioWeightDevice: [],
  BlkioDeviceReadBps: [], BlkioDeviceWriteBps: [], BlkioDeviceReadIOps: [], BlkioDeviceWriteIOps: [],
  MemoryReservation: 0, MemorySwap: 2147483648, MemorySwappiness: null, OomKillDisable: false,
  OomScoreAdj: 0, Ulimits: null, Init: false,
  MaskedPaths: ["/proc/asound", "/proc/acpi", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/timer_list", "/proc/timer_stats", "/proc/sched_debug", "/proc/scsi", "/sys/firmware", "/sys/devices/virtual/powercap"],
  ReadonlyPaths: ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"],
  Isolation: "", CpuCount: 0, CpuPercent: 0, IOMaximumIOps: 0, IOMaximumBandwidth: 0,
});
const OPTIONAL_MASKED_PATHS = new Set(["/proc/interrupts"]);

function validateHostDefault(key, value, expected) {
  if ((key === "Dns" || key === "Ulimits")
    && (value === null || (Array.isArray(value) && value.length === 0))) return;
  if (key === "MaskedPaths") {
    requireValue(Array.isArray(value) && value.every((item) => typeof item === "string"));
    const actual = new Set(value);
    requireValue(actual.size === value.length
      && expected.every((item) => actual.has(item))
      && [...actual].every((item) => expected.includes(item) || OPTIONAL_MASKED_PATHS.has(item)));
    return;
  }
  equal(value, expected);
}

function validateRawHost(host) {
  const authority = ["ReadonlyRootfs", "Privileged", "CapAdd", "CapDrop", "SecurityOpt", "Devices", "PidMode", "IpcMode", "NetworkMode", "UsernsMode", "UTSMode", "Memory", "NanoCpus", "PidsLimit", "Mounts", "Tmpfs", "LogConfig", "ShmSize", "ConsoleSize", "Annotations"];
  onlyKeys(host, [...authority, ...Object.keys(HOST_DEFAULTS)]);
  for (const [key, expected] of Object.entries(HOST_DEFAULTS)) {
    if (Object.hasOwn(host, key)) validateHostDefault(key, host[key], expected);
  }
  if (host.Annotations !== undefined) equal(host.Annotations, {});
  if (host.LogConfig !== undefined) equal(host.LogConfig, { Type: "json-file", Config: {} });
  if (host.ShmSize !== undefined) equal(host.ShmSize, 67108864);
}

function normalizedMounts(raw, input) {
  const host = raw.HostConfig;
  requireValue(Array.isArray(host.Mounts) && host.Mounts.length === 3, "BROKER_CONTAINER_MOUNT_MISMATCH");
  // --mount tmpfs is exposed in Mounts; --tmpfs is in HostConfig.Tmpfs.
  requireValue(Array.isArray(raw.Mounts) && raw.Mounts.length === 3, "BROKER_CONTAINER_MOUNT_MISMATCH");
  requireValue(new Set(raw.Mounts.map((mount) => mount.Destination)).size === 3, "BROKER_CONTAINER_MOUNT_MISMATCH");
  equal(raw.Mounts.find((mount) => mount.Destination === CONTRACT.tmp), {
    Type: "tmpfs", Source: "", Destination: CONTRACT.tmp, Mode: "", RW: true, Propagation: "",
  }, "BROKER_CONTAINER_MOUNT_MISMATCH");
  const binds = host.Mounts.slice(0, 2).map((mount) => {
    onlyKeys(mount, ["Type", "Source", "Target", "ReadOnly", "BindOptions"]);
    onlyKeys(mount.BindOptions, ["Propagation", "ReadOnlyForceRecursive"]);
    const readOnly = mount.ReadOnly ?? false;
    requireValue(typeof readOnly === "boolean");
    const observed = raw.Mounts.find((entry) => entry.Destination === mount.Target);
    onlyKeys(observed, ["Type", "Source", "Destination", "Mode", "RW", "Propagation"]);
    equal([observed.Type, observed.Source, observed.Destination, observed.RW, observed.Propagation],
      [mount.Type, mount.Source, mount.Target, !readOnly, mount.BindOptions.Propagation], "BROKER_CONTAINER_MOUNT_MISMATCH");
    return {
      type: mount.Type, source: mount.Source, destination: mount.Target,
      readOnly, propagation: mount.BindOptions.Propagation,
      recursiveReadOnly: mount.BindOptions.ReadOnlyForceRecursive === true,
    };
  });
  const [uid, gid = uid] = input.approvedImage.user.split(":").map(Number);
  equal(host.Tmpfs, { [CONTRACT.codexHome]: `rw,size=${CONTRACT.tmpfsSizeBytes},mode=0700,uid=${uid},gid=${gid}` }, "BROKER_CONTAINER_MOUNT_MISMATCH");
  equal(host.Mounts[2], { Type: "tmpfs", Target: CONTRACT.tmp, TmpfsOptions: { SizeBytes: CONTRACT.tmpfsSizeBytes, Mode: 0o1777 } }, "BROKER_CONTAINER_MOUNT_MISMATCH");
  return [...binds,
    { type: "tmpfs", destination: CONTRACT.codexHome, readOnly: false, uid, gid, mode: 0o700, sizeBytes: CONTRACT.tmpfsSizeBytes },
    { type: "tmpfs", destination: CONTRACT.tmp, readOnly: false, mode: 0o1777, sizeBytes: CONTRACT.tmpfsSizeBytes },
  ];
}

function normalizeInspect(raw, id, image, input) {
  onlyKeys(raw, ["Id", "Created", "Path", "Args", "State", "Image", "ResolvConfPath", "HostnamePath", "HostsPath", "LogPath", "Name", "RestartCount", "Driver", "Platform", "MountLabel", "ProcessLabel", "AppArmorProfile", "ExecIDs", "HostConfig", "GraphDriver", "SizeRw", "SizeRootFs", "Mounts", "Config", "NetworkSettings"]);
  equal(raw.Id, id);
  equal(raw.Image, image.Id, "BROKER_CONTAINER_IMAGE_MISMATCH");
  requireValue(raw.State?.Status === "created" && raw.State.Running === false
    && raw.State.Paused === false && raw.State.Restarting === false && raw.State.Dead === false);
  validateRawConfig(raw.Config, image);
  validateRawHost(raw.HostConfig);
  const host = raw.HostConfig;
  equal([host.PidMode, host.UTSMode, host.UsernsMode], ["", "", ""], "BROKER_CONTAINER_NAMESPACE_MISMATCH");
  equal(host.SecurityOpt, ["no-new-privileges=true"], "BROKER_CONTAINER_PRIVILEGE_MISMATCH");
  const normalized = {
    image: { reference: raw.Config.Image, digest: input.approvedImage.digest, user: raw.Config.User },
    openStdin: raw.Config.OpenStdin, workingDirectory: raw.Config.WorkingDir,
    rootfsReadOnly: host.ReadonlyRootfs, privileged: host.Privileged, noNewPrivileges: true,
    capabilities: { add: host.CapAdd === null ? [] : host.CapAdd, drop: host.CapDrop },
    devices: host.Devices,
    namespaces: { pid: host.PidMode === "" ? "private" : host.PidMode, ipc: host.IpcMode,
      network: host.NetworkMode, user: host.UsernsMode === "" ? "private" : host.UsernsMode,
      uts: host.UTSMode === "" ? "private" : host.UTSMode },
    resources: { memoryBytes: host.Memory, nanoCpus: host.NanoCpus, pidsLimit: host.PidsLimit },
    labels: raw.Config.Labels, mounts: normalizedMounts(raw, input),
  };
  return validateDockerInspect(normalized, input);
}

function clockFor(options) {
  return options.testHooks?.clock ?? { setTimeout, clearTimeout };
}

function deadline(work, ms, clock, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new Error(UNAVAILABLE));
    const timer = clock.setTimeout(abort, ms);
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { if (signal?.aborted) throw new Error(UNAVAILABLE); return work(); })
      .then((value) => finish(null, value), (error) => finish(error));
  });
}

function commandRunner(options, prefix, configDirectory, host) {
  const clock = clockFor(options);
  const processes = new Set();
  const run = (args, { timeout = LIMITS.operationTimeoutMs, signal, writeSignal = signal, attach = false } = {}) => {
    let child;
    let done = false;
    let closed = false;
    let failed = false;
    let outputSize = 0;
    let errorSize = 0;
    let inputSize = 0;
    let writing = false;
    const stdout = [];
    const stderr = [];
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => {});
    let finish;
    let timer;
    let killTimer;
    let resolveClosed;
    const closeObserved = new Promise((resolve) => { resolveClosed = resolve; });
    const abort = () => fail();
    const onStdout = (chunk) => collect(stdout, chunk, "stdout");
    const onStderr = (chunk) => collect(stderr, chunk, "stderr");
    const detachOperationalListeners = () => {
      signal?.removeEventListener("abort", abort);
      child?.stdout?.removeListener("data", onStdout);
      child?.stdout?.removeListener("error", fail);
      child?.stderr?.removeListener("data", onStderr);
      child?.stderr?.removeListener("error", fail);
      child?.stdin?.removeListener("error", fail);
      child?.removeListener("error", fail);
      child?.removeListener("disconnect", fail);
    };
    const completed = new Promise((resolve, reject) => {
      finish = (error, result) => {
        if (done) return;
        done = true;
        clock.clearTimeout(timer);
        clock.clearTimeout(killTimer);
        detachOperationalListeners();
        if (error) { rejectReady(error); reject(error); } else { resolveReady(); resolve(result); }
      };
    });
    void completed.catch(() => {});
    function fail() {
      if (done || failed) return;
      failed = true;
      const error = new Error(UNAVAILABLE);
      killTimer = clock.setTimeout(() => finish(error), LIMITS.interruptTimeoutMs);
      try { child?.stdin?.destroy(); child?.kill("SIGKILL"); } catch { /* Still bounded by killTimer. */ }
      if (closed || !child) finish(error);
    }
    function collect(chunks, chunk, kind) {
      if (done || failed) return;
      try {
        requireValue(Buffer.isBuffer(chunk) || typeof chunk === "string");
        const buffer = Buffer.from(chunk);
        if (kind === "stdout") outputSize += buffer.length;
        else errorSize += buffer.length;
        if (outputSize > LIMITS.stdoutBytes || errorSize > LIMITS.stderrBytes) return fail();
        chunks.push(buffer);
        if (attach && kind === "stdout" && buffer.length) resolveReady();
      } catch { fail(); }
    }
    function onClose(code, exitSignal) {
      closed = true;
      resolveClosed();
      if (failed || exitSignal || !Number.isInteger(code)) return finish(new Error(UNAVAILABLE));
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        finish(null, { code, stdout: decoder.decode(Buffer.concat(stdout)), stderr: decoder.decode(Buffer.concat(stderr)) });
      } catch { finish(new Error(UNAVAILABLE)); }
    }
    try {
      requireValue(!signal?.aborted, UNAVAILABLE);
      // No inherited environment, target cwd, context, config.json, or CLI flags.
      child = options.spawnProcess("docker", [...prefix, ...args], {
        cwd: configDirectory, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        env: host.platform === "win32"
          ? { PATH: "C:\\Program Files\\Docker\\Docker\\resources\\bin;C:\\Windows\\System32", SystemRoot: "C:\\Windows" }
          : { PATH: "/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin", LANG: "C", LC_ALL: "C" },
      });
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.stdout.on("error", fail); child.stderr.on("error", fail); child.stdin.on("error", fail);
      child.on("error", fail);
      child.on("disconnect", fail);
      child.once("close", onClose);
      timer = clock.setTimeout(fail, timeout);
      signal?.addEventListener("abort", abort, { once: true });
      if (!attach) child.stdin.end();
    } catch {
      if (!child) { closed = true; resolveClosed(); }
      fail();
    }
    const process = {
      ready, completed,
      get closed() { return closed; },
      stop: fail,
      closeObserved,
      dispose() {
        detachOperationalListeners();
        child?.removeListener("close", onClose);
      },
      transport: Object.freeze({
        async write(data) {
          try {
            requireValue(!writeSignal?.aborted && !done && !failed && !writing
              && (typeof data === "string" || Buffer.isBuffer(data)));
            const bytes = Buffer.from(data);
            inputSize += bytes.length;
            // Use the existing transport byte budget for stdin as well; no new
            // caller-configurable limit or unbounded write queue is introduced.
            requireValue(inputSize <= LIMITS.stdoutBytes);
            writing = true;
            await deadline(() => new Promise((resolve, reject) => {
              child.stdin.write(bytes, (error) => error ? reject(new Error(UNAVAILABLE)) : resolve());
            }), LIMITS.operationTimeoutMs, clock, writeSignal);
          } catch { fail(); throw new Error(UNAVAILABLE); }
          finally { writing = false; }
        },
        read() {
          // Bounded transport bytes are for the future package-owned RPC layer,
          // never canonical launcher evidence. stderr is never exposed.
          return Buffer.concat(stdout);
        },
      }),
    };
    processes.add(process);
    return process;
  };
  run.closeAll = async () => {
    const pending = [...processes];
    for (const process of pending) process.stop();
    let allClosed = false;
    try {
      await deadline(() => Promise.all(pending.map((process) => process.closeObserved)),
        LIMITS.interruptTimeoutMs, clock);
      allClosed = pending.every((process) => process.closed);
    } catch { /* Closure remains unproven. */ }
    finally { for (const process of pending) process.dispose(); }
    return allClosed;
  };
  return run;
}

async function successful(runner, args, options) {
  const result = await runner(args, options).completed;
  requireValue(result.code === 0 && result.stderr === "", UNAVAILABLE);
  return result.stdout;
}

function ownershipFilter(input) {
  return ["container", "ls", "--all", "--quiet", "--no-trunc",
    `--filter=label=${CONTRACT.labels.run}=${input.runId}`];
}

function validateOwnership(raw, candidate, input) {
  equal(raw.Id, candidate);
  equal(raw.Config?.Labels, {
    [CONTRACT.labels.package]: CONTRACT.packageName,
    [CONTRACT.labels.contract]: CONTRACT.contractVersion,
    [CONTRACT.labels.run]: input.runId,
  });
  return candidate;
}

async function proveCleanup(runner, id, input, bounded) {
  let proven = true;
  if (id) {
    try { equal(idOutput(await successful(runner, ["rm", "--force", id], bounded)), id); }
    catch { proven = false; }
    try {
      const absent = await runner(["container", "inspect", id], bounded).completed;
      requireValue(absent.code === 1 && /^\[\]\n?$/u.test(absent.stdout));
      requireValue(absent.stderr === `Error: No such container: ${id}\n`
        || absent.stderr === `Error response from daemon: No such container: ${id}\n`);
    } catch { proven = false; }
  } else proven = false;
  // Always query, even when removal or exact-ID inspection failed.
  try { equal(await successful(runner, ownershipFilter(input), bounded), ""); }
  catch { proven = false; }
  return proven;
}

async function recoverOwnedId(runner, input, bounded) {
  const candidate = idOutput(await successful(runner, ownershipFilter(input), bounded));
  const raw = singleton(await successful(runner, ["container", "inspect", candidate], bounded));
  return validateOwnership(raw, candidate, input);
}

function result(input, error) {
  const reason = BROKER_REASON_CODES.includes(error?.message) && error.message !== "BROKER_RUNTIME_PROTECTED"
    ? error.message : UNAVAILABLE;
  return { trusted: false, runtime: "docker", permission_profile: CONTRACT.permissionProfiles.includes(input?.permissionProfile) ? input.permissionProfile : "read-only", reason_code: reason };
}

function cancellation(options) {
  const controller = new AbortController();
  const operation = new AbortController();
  const onSignal = () => controller.abort();
  const source = options.testHooks?.signals ?? process;
  for (const name of SIGNALS) source.on(name, onSignal);
  options.signal?.addEventListener("abort", onSignal, { once: true });
  if (options.signal?.aborted) controller.abort();
  return {
    controller, operation, onSignal,
    dispose() {
      options.signal?.removeEventListener("abort", onSignal);
      for (const name of SIGNALS) source.removeListener(name, onSignal);
    },
  };
}

async function executeLifecycle(state) {
  const { input, options, clock, host, cancel } = state;
  const endpoint = localEndpoint(host);
  state.configDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sdd-docker-"));
  const runner = commandRunner(options, [`--host=${endpoint}`, `--config=${state.configDirectory}`], state.configDirectory, host);
  state.runner = runner;
  state.startupTimer = clock.setTimeout(cancel.onSignal, LIMITS.startupTimeoutMs);
  const startup = { signal: cancel.controller.signal };
  const server = parseJson(await successful(runner, ["version", "--format={{json .Server}}"], startup));
  const info = parseJson(await successful(runner, ["info", "--format={{json .}}"], startup));
  validateDaemon(server, info, host);
  const image = safeImage(singleton(await successful(runner, ["image", "inspect", input.approvedImage.reference], startup)), input, host);
  state.created = true;
  state.creating = runner(state.create.args, startup);
  const creation = await state.creating.completed;
  state.candidateId = idOutput(creation.stdout);
  requireValue(creation.code === 0 && creation.stderr === "", UNAVAILABLE);
  const raw = singleton(await successful(runner, ["container", "inspect", state.candidateId], startup));
  state.ownedId = validateOwnership(raw, state.candidateId, input);
  normalizeInspect(raw, state.candidateId, image, input);
  const operationSignal = AbortSignal.any([cancel.controller.signal, cancel.operation.signal]);
  const attached = runner(["start", "--attach", "--interactive", state.ownedId], {
    attach: true, timeout: LIMITS.turnTimeoutMs, signal: cancel.controller.signal,
    writeSignal: operationSignal,
  });
  state.attached = attached;
  await attached.ready;
  requireValue(!attached.closed, UNAVAILABLE);
  clock.clearTimeout(state.startupTimer);
  state.operation = Promise.resolve()
    .then(() => options.operate?.(attached.transport, operationSignal));
  state.operationSettled = state.operation.then(() => undefined, () => undefined);
  await Promise.race([
    deadline(() => state.operation, LIMITS.turnTimeoutMs, clock, operationSignal),
    attached.completed.then(
      () => { cancel.operation.abort(); throw new Error(UNAVAILABLE); },
      () => { cancel.operation.abort(); throw new Error(UNAVAILABLE); },
    ),
  ]);
}

async function removeLifecycleContainer(state) {
  const controller = new AbortController();
  const timer = state.clock.setTimeout(() => controller.abort(), LIMITS.removalTimeoutMs);
  const bounded = { timeout: LIMITS.removalTimeoutMs, signal: controller.signal };
  try {
    if (!state.ownedId) {
      try { state.ownedId = await recoverOwnedId(state.runner, state.input, bounded); }
      catch { /* Ambiguous ownership must never authorize removal. */ }
    }
    const cleaned = await proveCleanup(state.runner, state.ownedId, state.input, bounded);
    if (!cleaned || !state.creating.closed) state.failure = new Error(CLEANUP);
  } finally { state.clock.clearTimeout(timer); }
}

async function finishLifecycle(state) {
  const { attached, options, clock } = state;
  state.cancel.operation.abort();
  clock.clearTimeout(state.startupTimer);
  if (state.failure && attached && !attached.closed && typeof options.interrupt === "function") {
    try { await deadline(() => options.interrupt(attached.transport), LIMITS.interruptTimeoutMs, clock); }
    catch { /* Removal is authoritative even when interruption cannot complete. */ }
  }
  attached?.stop();
  if (state.operationSettled) {
    try { await deadline(() => state.operationSettled, LIMITS.interruptTimeoutMs, clock); }
    catch { state.failure = new Error(CLEANUP); }
  }
  if (state.created) await removeLifecycleContainer(state);
  if (attached) {
    try { await attached.completed; } catch { /* Never publish process details. */ }
    if (!attached.closed) state.failure = new Error(CLEANUP);
  }
  if (state.runner && !await state.runner.closeAll()) state.failure = new Error(CLEANUP);
  state.cancel.dispose();
  if (state.configDirectory) {
    try { await fs.rm(state.configDirectory, { recursive: true, force: true }); }
    catch { state.failure = new Error(CLEANUP); }
  }
}

/** Internal lifecycle seam only. No default spawner, approved manifest, auth,
 * broker RPC, or production activation exists in Task 2. Injected dependencies
 * belong to the host package, never to project configuration. This function
 * cannot emit trust, even after a completely successful simulated lifecycle. */
export async function runDockerLifecycle(input, options = {}) {
  const state = { options, clock: clockFor(options) };
  try {
    onlyKeys(input, ["approvedImage", "permissionProfile", "projectRoot"]);
    requireValue(Object.keys(input).length === 3, "BROKER_DOCKER_CONTRACT_INPUT_INVALID");
    state.input = structuredClone({ ...input, runId: randomBytes(32).toString("hex") });
    state.create = buildDockerCreateInvocation(state.input);
  } catch (error) {
    return result(input, new Error(error.message === INVALID ? "BROKER_DOCKER_CONTRACT_INPUT_INVALID" : error.message));
  }
  if (typeof options.spawnProcess !== "function") return result(input);
  state.host = options.testHooks?.host ?? { platform: process.platform, arch: process.arch, home: os.homedir() };
  state.cancel = cancellation(options);
  try { await executeLifecycle(state); }
  catch (error) { state.failure = error; }
  finally { await finishLifecycle(state); }
  return result(state.input, state.failure);
}
