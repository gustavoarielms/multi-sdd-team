import { ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

const WINDOWS_TREE_KILL_TIMEOUT_MS = 5000;
const PROCESS_TREE_VERIFY_TIMEOUT_MS = 1000;
const PROCESS_TREE_VERIFY_INTERVAL_MS = 10;
const PROCESS_TREE_FINAL_KILL_RESERVE_MS = 100;
const LINUX_PROCESS_STAT_LIMIT = 4096;
const LINUX_PROCESS_SCAN_LIMIT = 32768;
const EXECUTOR_BOUNDARY_ENV = "SDD_ENGINEERING_EXECUTOR_BOUNDARY";
const COMMAND_SUPERVISOR_FLAG = "--engineering-command-supervisor";
const runtimePath = fileURLToPath(import.meta.url);
let ownershipRequestSequence = 0;

function processDeadline(timeoutMs = PROCESS_TREE_VERIFY_TIMEOUT_MS, now = performance.now.bind(performance)) {
  return { expiresAt: now() + timeoutMs, now };
}

function remainingMilliseconds(deadline) {
  return Math.max(0, Math.ceil(deadline.expiresAt - deadline.now()));
}

function freezeDeadline(deadline) {
  const remaining = remainingMilliseconds(deadline);
  const reserve = Math.min(PROCESS_TREE_FINAL_KILL_RESERVE_MS, Math.max(1, Math.floor(remaining / 4)));
  return { expiresAt: deadline.expiresAt - reserve, now: deadline.now };
}

function retainedLiveChild(child) {
  return child instanceof ChildProcess && child.exitCode === null && child.signalCode === null;
}

async function beforeDeadline(operation, deadline) {
  const remaining = remainingMilliseconds(deadline);
  if (remaining <= 0) throw new Error("process inventory deadline exceeded");
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("process inventory deadline exceeded")), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function windowsTreeKillerPath() {
  const systemRoot = typeof process.env.SystemRoot === "string" && path.win32.isAbsolute(process.env.SystemRoot)
    ? process.env.SystemRoot
    : "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "taskkill.exe");
}

function windowsTreeVerifierPath() {
  return path.win32.join(path.win32.dirname(windowsTreeKillerPath()), "tasklist.exe");
}

function validWindowsTreeKiller(executable) {
  return typeof executable === "string"
    && path.win32.isAbsolute(executable)
    && path.win32.basename(executable).toLowerCase() === "taskkill.exe"
    && path.win32.basename(path.win32.dirname(executable)).toLowerCase() === "system32";
}

function validWindowsTreeVerifier(executable) {
  return typeof executable === "string"
    && path.win32.isAbsolute(executable)
    && path.win32.basename(executable).toLowerCase() === "tasklist.exe"
    && path.win32.basename(path.win32.dirname(executable)).toLowerCase() === "system32";
}

async function terminateWindowsWithSystemTool({ executable, args, timeoutMs }) {
  const result = spawnSync(executable, args, {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
    timeout: Math.max(1, Math.min(WINDOWS_TREE_KILL_TIMEOUT_MS, timeoutMs)),
    killSignal: "SIGKILL",
  });
  if (result.error || result.status !== 0) throw new Error("Windows process tree termination failed");
}

export function windowsProcessExited(executable, pid, run = spawnSync, timeoutMs = PROCESS_TREE_VERIFY_TIMEOUT_MS) {
  if (timeoutMs <= 0) throw new Error("process inventory deadline exceeded");
  const result = run(executable, ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true,
    timeout: Math.max(1, Math.min(WINDOWS_TREE_KILL_TIMEOUT_MS, timeoutMs)),
  });
  if (result.error || result.status !== 0) throw new Error("Windows process tree verification failed");
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  const parsed = lines.map((line) => line.match(
    /^"(?:[^"]|"")*","(\d+)","(?:[^"]|"")*","(?:[^"]|"")*","(?:[^"]|"")*"$/,
  ));
  if (parsed.some((match) => !match)) throw new Error("invalid Windows process inventory");
  return !parsed.some((match) => match[1] === String(pid));
}

export async function verifyWindowsProcessExited(executable, pid, injected = {}) {
  const now = injected.now ?? performance.now.bind(performance);
  const wait = injected.wait ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const probe = injected.probe ?? windowsProcessExited;
  const deadline = processDeadline(injected.timeoutMs, now);
  while (remainingMilliseconds(deadline) > 0) {
    const exited = await beforeDeadline(
      () => probe(executable, pid, undefined, remainingMilliseconds(deadline)),
      deadline,
    );
    if (exited) return;
    await beforeDeadline(() => wait(Math.min(
      PROCESS_TREE_VERIFY_INTERVAL_MS,
      remainingMilliseconds(deadline),
    )), deadline);
  }
  throw new Error("Windows process tree termination could not be verified before deadline");
}

function resolvedDeadlineControl(injected) {
  return {
    inventory: injected?.inventory,
    signal: injected?.signal ?? process.kill,
    rootIdentity: injected?.rootIdentity,
    now: injected?.now ?? performance.now.bind(performance),
    wait: injected?.wait ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay))),
    timeoutMs: injected?.timeoutMs ?? PROCESS_TREE_VERIFY_TIMEOUT_MS,
  };
}

function resolvedTerminationControl(injected) {
  return {
    platform: injected?.platform ?? process.platform,
    windowsExecutable: injected?.windowsExecutable ?? windowsTreeKillerPath(),
    windowsVerifierExecutable: injected?.windowsVerifierExecutable ?? windowsTreeVerifierPath(),
    terminateWindows: injected?.terminateWindows ?? terminateWindowsWithSystemTool,
    verifyWindows: injected?.verifyWindows ?? verifyWindowsProcessExited,
    verifyTerminated: injected?.verifyTerminated,
    ...resolvedDeadlineControl(injected),
  };
}

export function parseLinuxProcessGroup(source) {
  if (Buffer.byteLength(source) > LINUX_PROCESS_STAT_LIMIT) throw new Error("invalid Linux process stat");
  const commandEnd = source.lastIndexOf(") ");
  const fields = commandEnd < 2 ? [] : source.slice(commandEnd + 2).trim().split(" ");
  const group = Number(fields[2]);
  if (!/^[A-Za-z]$/.test(fields[0] ?? "") || !Number.isSafeInteger(group) || group <= 0) {
    throw new Error("invalid Linux process stat");
  }
  return { state: fields[0], group };
}

export async function readLinuxProcessGroup(file) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(LINUX_PROCESS_STAT_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseLinuxProcessGroup(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

export function parseLinuxProcessIdentity(source) {
  if (Buffer.byteLength(source) > LINUX_PROCESS_STAT_LIMIT) throw new Error("invalid Linux process stat");
  const commandEnd = source.lastIndexOf(") ");
  const fields = commandEnd < 2 ? [] : source.slice(commandEnd + 2).trim().split(" ");
  const pid = Number(source.slice(0, source.indexOf(" ")));
  const identity = {
    pid,
    state: fields[0],
    parent: Number(fields[1]),
    group: Number(fields[2]),
    session: Number(fields[3]),
    startTime: fields[19],
  };
  if (
    ![identity.pid, identity.parent, identity.group, identity.session].every(Number.isSafeInteger)
    || identity.pid <= 0
    || !/^[A-Za-z]$/.test(identity.state ?? "")
    || !/^\d+$/.test(identity.startTime ?? "")
  ) throw new Error("invalid Linux process stat");
  return identity;
}

export async function readLinuxProcessIdentity(file) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(LINUX_PROCESS_STAT_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseLinuxProcessIdentity(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

export function parsePosixProcessInventory(source) {
  const identities = [];
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([A-Za-z?]\S*)\s+(.+?)\s*$/);
    if (!match) throw new Error("invalid process inventory");
    identities.push({
      pid: Number(match[1]),
      parent: Number(match[2]),
      group: Number(match[3]),
      session: Number(match[4]),
      state: match[5],
      startTime: match[6],
    });
  }
  return identities;
}

async function linuxProcessInventory(deadline) {
  const entries = (await beforeDeadline(() => fs.readdir("/proc"), deadline))
    .filter((entry) => /^\d+$/.test(entry));
  if (entries.length > LINUX_PROCESS_SCAN_LIMIT) throw new Error("Linux process scan limit exceeded");
  const identities = [];
  for (const entry of entries) {
    try {
      identities.push(await beforeDeadline(
        () => readLinuxProcessIdentity(path.join("/proc", entry, "stat")),
        deadline,
      ));
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes(error?.code)) continue;
      throw error;
    }
  }
  return identities;
}

function readPosixProcessInventory(deadline) {
  const timeout = remainingMilliseconds(deadline);
  if (timeout <= 0) throw new Error("process inventory deadline exceeded");
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,sess=,state=,lstart="], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    shell: false,
    timeout,
  });
  if (result.error || result.status !== 0) throw new Error("process inventory failed");
  return result.stdout;
}

function posixProcessInventory(deadline) {
  try {
    return parsePosixProcessInventory(readPosixProcessInventory(deadline));
  } catch (error) {
    if (error?.message !== "invalid process inventory") throw error;
    return parsePosixProcessInventory(readPosixProcessInventory(deadline));
  }
}

function posixProcessIdentity(pid, deadline, run = spawnSync) {
  const timeout = remainingMilliseconds(deadline);
  if (timeout <= 0) throw new Error("process inventory deadline exceeded");
  const result = run(
    "/bin/ps",
    ["-p", String(pid), "-o", "pid=,ppid=,pgid=,sess=,state=,lstart="],
    {
      encoding: "utf8",
      maxBuffer: LINUX_PROCESS_STAT_LIMIT,
      shell: false,
      timeout,
    },
  );
  if (result.error) throw new Error("spawned process identity unavailable");
  if (result.status === 1 && result.stdout.trim() === "") return undefined;
  if (result.status !== 0) throw new Error("spawned process identity unavailable");
  const identities = parsePosixProcessInventory(result.stdout);
  if (identities.length !== 1 || identities[0].pid !== pid) {
    throw new Error("spawned process identity unavailable");
  }
  return identities[0];
}

function terminalProcess(identity) {
  return ["Z", "X", "x"].includes(identity?.state?.[0]);
}

function sameProcess(expected, actual) {
  return Boolean(
    expected
    && actual
    && expected.pid === actual.pid
    && expected.startTime === actual.startTime
    && expected.session === actual.session
    && expected.group === actual.group
  );
}

async function processInventory(control, deadline) {
  if (control.inventory) return beforeDeadline(() => control.inventory(deadline), deadline);
  if (control.platform === "linux") return linuxProcessInventory(deadline);
  return posixProcessInventory(deadline);
}

export async function linuxProcessGroupExited(pid, injected = {}) {
  const directory = injected.directory ?? "/proc";
  const readdir = injected.readdir ?? fs.readdir;
  const read = injected.read ?? readLinuxProcessGroup;
  const deadline = processDeadline(injected.timeoutMs, injected.now ?? performance.now.bind(performance));
  const entries = (await beforeDeadline(() => readdir(directory), deadline))
    .filter((entry) => /^\d+$/.test(entry));
  if (entries.length > LINUX_PROCESS_SCAN_LIMIT) throw new Error("Linux process scan limit exceeded");
  for (const entry of entries) {
    let process;
    try {
      process = await beforeDeadline(() => read(path.join(directory, entry, "stat")), deadline);
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes(error?.code)) continue;
      throw error;
    }
    if (process.group === pid && !["Z", "X", "x"].includes(process.state)) return false;
  }
  return true;
}

function descendantsOf(root, inventory) {
  const owned = new Map([[root.pid, root]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const identity of inventory) {
      if (!owned.has(identity.pid) && owned.has(identity.parent)) {
        owned.set(identity.pid, identity);
        changed = true;
      }
    }
  }
  return [...owned.values()];
}

function observableOwnedTree(root, inventory) {
  const owned = new Map(descendantsOf(root, inventory).map((identity) => [identity.pid, identity]));
  if (root.pid === root.group) {
    for (const identity of membersOfRetainedDomain(root, inventory)) owned.set(identity.pid, identity);
  }
  return [...owned.values()];
}

async function currentOwnedIdentity(expected, control, deadline) {
  let current;
  if (control.inventory) {
    const inventory = await processInventory(control, deadline);
    current = inventory.find((identity) => identity.pid === expected.pid);
  } else {
    try {
      current = await beforeDeadline(
        () => control.platform === "linux"
          ? readLinuxProcessIdentity(`/proc/${expected.pid}/stat`)
          : posixProcessIdentity(expected.pid, deadline),
        deadline,
      );
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error?.code)) throw error;
    }
  }
  return sameProcess(expected, current) && !terminalProcess(current) ? current : undefined;
}

async function signalOwnedIdentity(identity, signal, control, deadline) {
  if (!await currentOwnedIdentity(identity, control, deadline)) return false;
  try {
    control.signal(identity.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function rememberOwned(captured, identities) {
  identities.forEach((identity) => captured.set(identity.pid, identity));
  return identities;
}

async function freezeOwnedTree(root, captured, control, deadline, initialInventory) {
  let inventory = initialInventory ?? await processInventory(control, deadline);
  const currentRoot = inventory.find((identity) => identity.pid === root.pid);
  if (!sameProcess(root, currentRoot) || terminalProcess(currentRoot)) return [];
  let owned = rememberOwned(captured, observableOwnedTree(root, inventory));
  for (const identity of owned) await signalOwnedIdentity(identity, "SIGSTOP", control, deadline);
  inventory = await processInventory(control, deadline);
  owned = rememberOwned(captured, observableOwnedTree(root, inventory).filter((identity) => (
    sameProcess(identity, inventory.find((current) => current.pid === identity.pid))
  )));
  for (const identity of owned) await signalOwnedIdentity(identity, "SIGSTOP", control, deadline);
  return owned;
}

function membersOfRetainedDomain(root, inventory) {
  if (root.pid !== root.group) throw new Error("owned process group unavailable");
  return inventory.filter((identity) => (
    identity.pid !== root.pid
    && identity.group === root.group
    && (root.session <= 0 || identity.session === root.session)
    && !terminalProcess(identity)
  ));
}

async function freezeRetainedDomain(root, captured, control, deadline, initialInventory) {
  let inventory = initialInventory ?? await processInventory(control, deadline);
  let owned = rememberOwned(captured, membersOfRetainedDomain(root, inventory));
  for (const identity of owned) await signalOwnedIdentity(identity, "SIGSTOP", control, deadline);
  inventory = await processInventory(control, deadline);
  owned = rememberOwned(captured, membersOfRetainedDomain(root, inventory));
  for (const identity of owned) await signalOwnedIdentity(identity, "SIGSTOP", control, deadline);
}

async function verifyOwnedTreeExited(owned, control, deadline) {
  while (remainingMilliseconds(deadline) > 0) {
    const current = await Promise.all(owned.map((expected) => currentOwnedIdentity(expected, control, deadline)));
    const survivor = current.some(Boolean);
    if (!survivor) return;
    await beforeDeadline(
      () => control.wait(Math.min(PROCESS_TREE_VERIFY_INTERVAL_MS, remainingMilliseconds(deadline))),
      deadline,
    );
  }
  throw new Error("process tree termination could not be verified before deadline");
}

async function killCapturedTree(captured, control, deadline) {
  const identities = [...captured.values()].reverse();
  let firstError;
  for (const identity of identities) {
    try {
      await signalOwnedIdentity(identity, "SIGKILL", control, deadline);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
  await verifyOwnedTreeExited(identities, control, deadline);
}

async function terminateCapturedOwnership(freeze, control, deadline) {
  const captured = new Map();
  try {
    await freeze(captured, control, freezeDeadline(deadline));
    await killCapturedTree(captured, control, deadline);
  } catch (error) {
    try {
      if (captured.size > 0) await killCapturedTree(captured, control, deadline);
      error.cleanupVerified = true;
    } catch (cleanupError) {
      cleanupError.ownedIdentities = [...captured.values()];
      throw cleanupError;
    }
    throw error;
  }
}

async function terminatePosixOwnedTree(child, control, deadline) {
  const firstInventory = await processInventory(control, deadline);
  const discoveredRoot = firstInventory.find((identity) => identity.pid === child.pid);
  const capturedRoot = child.identityPromise
    ? await beforeDeadline(() => child.identityPromise, deadline)
    : undefined;
  const root = control.rootIdentity ?? child.identity ?? capturedRoot;
  if (!root) throw new Error("owned process identity unavailable");
  if (discoveredRoot && !sameProcess(root, discoveredRoot)) {
    const error = new Error("owned process identity changed");
    error.code = "PROCESS_IDENTITY_CHANGED";
    throw error;
  }
  if (sameProcess(root, discoveredRoot) && !terminalProcess(discoveredRoot)) {
    await terminateCapturedOwnership(
      (captured, terminationControl, terminationDeadline) => freezeOwnedTree(
        root,
        captured,
        terminationControl,
        terminationDeadline,
        firstInventory,
      ),
      control,
      deadline,
    );
    return;
  }
  if (root.pid !== root.group) return;
  await terminateCapturedOwnership(
    (captured, terminationControl, terminationDeadline) => freezeRetainedDomain(
      root,
      captured,
      terminationControl,
      terminationDeadline,
      firstInventory,
    ),
    control,
    deadline,
  );
}

async function terminateWindowsOwnedTree(child, control, deadline) {
  if (!retainedLiveChild(child)) throw new Error("retained Windows process ownership unavailable");
  if (!validWindowsTreeKiller(control.windowsExecutable)) throw new Error("unsafe Windows tree killer path");
  if (!control.verifyTerminated && !validWindowsTreeVerifier(control.windowsVerifierExecutable)) {
    throw new Error("unsafe Windows tree verifier path");
  }
  try {
    await beforeDeadline(() => control.terminateWindows({
      executable: control.windowsExecutable,
      args: ["/pid", String(child.pid), "/t", "/f"],
      pid: child.pid,
      timeoutMs: remainingMilliseconds(deadline),
    }), deadline);
  } catch {
    /* Verification below decides whether an already-exited tree is safe. */
  }
  try { child.kill("SIGKILL"); } catch { /* The root already exited with its tree. */ }
  if (control.verifyTerminated) {
    await beforeDeadline(() => control.verifyTerminated(child.pid, deadline), deadline);
    return;
  }
  await beforeDeadline(() => control.verifyWindows(control.windowsVerifierExecutable, child.pid, {
    timeoutMs: remainingMilliseconds(deadline),
    now: control.now,
    wait: control.wait,
  }), deadline);
}

export async function terminateProcessTree(child, injectedControl) {
  if (!child?.pid) return;
  const control = resolvedTerminationControl(injectedControl);
  const deadline = processDeadline(control.timeoutMs, control.now);
  if (control.platform === "win32") {
    await terminateWindowsOwnedTree(child, control, deadline);
    return;
  }
  if (control.verifyTerminated) {
    try { control.signal(-child.pid, "SIGKILL"); } catch { /* The injected verifier decides. */ }
    await beforeDeadline(() => control.verifyTerminated(child.pid, deadline), deadline);
    return;
  }
  try {
    await terminatePosixOwnedTree(child, control, deadline);
  } catch (error) {
    if (typeof child.spawnfile === "string" && error?.code !== "PROCESS_IDENTITY_CHANGED") {
      try { child.kill("SIGKILL"); } catch { /* Retained child handle already closed. */ }
    }
    throw error;
  }
}

export async function captureProcessIdentity(pid, injected = {}) {
  const platform = injected.platform ?? process.platform;
  const now = injected.now ?? performance.now.bind(performance);
  const deadline = processDeadline(injected.timeoutMs ?? PROCESS_TREE_VERIFY_TIMEOUT_MS, now);
  let identity;
  try {
    identity = await beforeDeadline(() => {
      if (injected.readPosixIdentity) return injected.readPosixIdentity(pid, deadline);
      if (platform === "linux") return readLinuxProcessIdentity(`/proc/${pid}/stat`);
      return posixProcessIdentity(pid, deadline, injected.runPosixIdentity);
    }, deadline);
  } catch (error) {
    if (!["ENOENT", "ESRCH"].includes(error?.code)) throw error;
  }
  if (!identity || identity.pid !== pid || terminalProcess(identity)) {
    throw new Error("spawned process identity unavailable");
  }
  return identity;
}

function reportOwnedProcessGroup(action, identity) {
  if (
    !identity
    || process.env[EXECUTOR_BOUNDARY_ENV] !== "1"
    || !process.connected
    || !process.send
  ) return;
  try {
    process.send({ type: "owned_process_group", action, identity }, () => {});
  } catch {
    /* The parent boundary is already terminating. */
  }
}

function requestOwnedProcessGroup(identity, timeoutMs) {
  if (
    !identity
    || process.env[EXECUTOR_BOUNDARY_ENV] !== "1"
    || !process.connected
    || !process.send
  ) return Promise.resolve(false);
  const requestId = `${process.pid}:${ownershipRequestSequence += 1}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener("message", onMessage);
      process.removeListener("disconnect", onDisconnect);
      operation(value);
    };
    const onMessage = (message) => {
      if (message?.type !== "owned_process_group_ack" || message.requestId !== requestId) return;
      finish(resolve, message.accepted === true);
    };
    const onDisconnect = () => finish(reject, new Error("executor ownership channel disconnected"));
    const timer = setTimeout(
      () => finish(reject, new Error("executor ownership acknowledgement timed out")),
      Math.max(1, timeoutMs),
    );
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    try {
      process.send({
        type: "owned_process_group",
        action: "register",
        identity,
        requestId,
      }, (error) => {
        if (error) finish(reject, new Error("executor ownership registration failed"));
      });
    } catch {
      finish(reject, new Error("executor ownership registration failed"));
    }
  });
}

function supervisedCommandSpawn(cwd, input, detached) {
  return spawn(process.execPath, [runtimePath, COMMAND_SUPERVISOR_FLAG], {
    cwd,
    env: supervisorEnvironment(),
    detached,
    shell: false,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe", "ipc"],
  });
}

function startSupervisedCommand(child, executable, args, env, onError) {
  try {
    child.send({ type: "start_command", executable, args, env: commandEnvironment(env) }, (error) => {
      if (error) onError();
    });
  } catch {
    onError();
  }
}

function releaseVerifiedChildResources(child) {
  try { if (child?.connected) child.disconnect(); } catch { /* The owned IPC channel already closed. */ }
}

function readableCompletion(stream) {
  if (!stream || stream.readableEnded || stream.closed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("close", resolve);
    stream.once("error", reject);
  });
}

async function runCommandSupervisor() {
  let command;
  let commandReported = false;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    if (command?.pid) {
      try { await terminateProcessTree(command); } catch { /* The owner also verifies the supervisor tree. */ }
    }
    process.exit();
  };
  const reportCommandOutcome = (message) => {
    if (commandReported) return;
    commandReported = true;
    try {
      process.send?.(message, (error) => {
        if (error) close();
      });
    } catch {
      close();
    }
  };
  process.once("disconnect", close);
  process.once("message", (message) => {
    if (message?.type !== "start_command") {
      close();
      return;
    }
    try {
      command = spawn(message.executable, message.args, {
        cwd: process.cwd(),
        env: message.env,
        detached: false,
        shell: false,
        stdio: "inherit",
      });
      process.send?.({ type: "command_started" }, (error) => {
        if (error) close();
      });
    } catch {
      reportCommandOutcome({ type: "command_error" });
      return;
    }
    command.once("error", () => {
      reportCommandOutcome({ type: "command_error" });
    });
    command.once("close", (code, signal) => {
      reportCommandOutcome({ type: "command_close", code, signal });
    });
  });
}

function commandEnvironment(env) {
  if (!Object.hasOwn(env, EXECUTOR_BOUNDARY_ENV)) return env;
  const childEnv = { ...env };
  delete childEnv[EXECUTOR_BOUNDARY_ENV];
  return childEnv;
}

function supervisorEnvironment() {
  const systemRoot = process.env.SystemRoot;
  if (process.platform !== "win32" || typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot)) {
    return {};
  }
  return { SystemRoot: systemRoot };
}

export function runBoundedCommand(executable, args, options) {
  const {
    cwd,
    timeoutMs,
    maxOutputBytes,
    env = process.env,
    input,
    signal,
    terminationControl: injectedTerminationControl,
  } = options;
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputBytes = 0;
    let reason;
    let child;
    let targetOutcome;
    const boundaryOwned = process.env[EXECUTOR_BOUNDARY_ENV] === "1" && process.connected && process.send;
    let startupPromise = Promise.resolve();
    let startupResolve;
    let outputCompletion = Promise.resolve();
    let timer;
    let terminationPromise;

    const resultAfterDrain = () => {
      if (reason) return { status: "error", reason_code: reason };
      return typeof targetOutcome === "function" ? targetOutcome() : targetOutcome;
    };

    const terminate = (result = { status: "error", reason_code: reason }) => {
      if (terminationPromise) return terminationPromise;
      targetOutcome = result;
      const cleanupNow = injectedTerminationControl?.now ?? performance.now.bind(performance);
      const cleanupTimeout = injectedTerminationControl?.timeoutMs ?? PROCESS_TREE_VERIFY_TIMEOUT_MS;
      const cleanupDeadline = processDeadline(cleanupTimeout, cleanupNow);
      const startupDeadline = {
        expiresAt: cleanupDeadline.expiresAt - Math.max(1, Math.floor(cleanupTimeout / 2)),
        now: cleanupNow,
      };
      terminationPromise = beforeDeadline(() => startupPromise, startupDeadline).catch(() => {}).then(
        () => terminateProcessTree(child, {
          ...injectedTerminationControl,
          now: cleanupNow,
          timeoutMs: remainingMilliseconds(cleanupDeadline),
        }),
      ).then(
        () => beforeDeadline(() => outputCompletion, cleanupDeadline),
      ).then(
        () => finish(resultAfterDrain(), true),
        (error) => {
          error?.ownedIdentities?.forEach((identity) => reportOwnedProcessGroup("register", identity));
          finish(
            { status: "error", reason_code: "COMMAND_TERMINATION_FAILED" },
            error?.cleanupVerified === true,
          );
        },
      );
      return terminationPromise;
    };

    const finish = (result, cleanupVerified) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (cleanupVerified) {
        reportOwnedProcessGroup("unregister", child?.identity);
        releaseVerifiedChildResources(child);
      }
      resolve({ ...result, duration_ms: Math.max(0, Date.now() - started) });
    };

    const abort = () => {
      if (settled || reason || terminationPromise) return;
      reason = "EXECUTOR_ABORTED";
      terminate();
    };

    const capture = (stream, chunk) => {
      if (settled || reason) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        reason = "COMMAND_OUTPUT_LIMIT";
        terminate();
        return;
      }
      if (stream === "stdout") stdout = Buffer.concat([stdout, chunk]);
      else stderr = Buffer.concat([stderr, chunk]);
    };

    const ownershipFailure = () => {
      if (settled || reason || terminationPromise) return;
      reason = "COMMAND_OWNERSHIP_HANDOFF_FAILED";
      terminate();
    };

    const settleStartup = () => {
      if (!startupResolve) return;
      startupResolve();
      startupResolve = undefined;
    };

    const beginSupervisedCommand = () => {
      startupPromise = new Promise((resolve) => {
        startupResolve = resolve;
      });
      startSupervisedCommand(child, executable, args, env, () => {
        settleStartup();
        ownershipFailure();
      });
    };

    const prepareSupervisedCommand = async (identity) => {
      child.identity = identity;
      try {
        if (boundaryOwned) {
          const accepted = await requestOwnedProcessGroup(
            identity,
            Math.max(1, timeoutMs - (Date.now() - started)),
          );
          if (!accepted) throw new Error("executor ownership registration rejected");
        }
        if (settled || reason) return;
        beginSupervisedCommand();
      } catch {
        ownershipFailure();
      }
    };

    try {
      child = supervisedCommandSpawn(
        cwd,
        input,
        process.platform !== "win32",
      );
      if (process.platform !== "win32") {
        const captureIdentity = injectedTerminationControl?.captureIdentity ?? captureProcessIdentity;
        child.identityPromise = captureIdentity(child.pid);
        child.identityPromise.then(prepareSupervisedCommand, ownershipFailure);
      } else {
        beginSupervisedCommand();
      }
    } catch {
      finish({ status: "error", reason_code: "COMMAND_SPAWN_FAILED" }, true);
      return;
    }

    timer = setTimeout(() => {
      if (settled || reason || terminationPromise) return;
      reason = "COMMAND_TIMEOUT";
      terminate();
    }, timeoutMs);

    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    outputCompletion = Promise.all([
      readableCompletion(child.stdout),
      readableCompletion(child.stderr),
    ]);
    child.on("message", (message) => {
      if (message?.type === "command_started") settleStartup();
      if (message?.type === "command_close" && !reason && !terminationPromise) {
        settleStartup();
        terminate(message.signal
          ? { status: "error", reason_code: "COMMAND_SIGNALLED" }
          : () => ({
            status: "completed",
            exit_code: message.code ?? 1,
            stdout: stdout.toString("utf8"),
            stderr: stderr.toString("utf8"),
          }));
      }
      if (message?.type === "command_error" && !reason && !terminationPromise) {
        reason = "COMMAND_SPAWN_FAILED";
        settleStartup();
        terminate();
      }
    });
    child.on("error", async () => {
      settleStartup();
      if (terminationPromise) {
        await terminationPromise;
        return;
      }
      reason ??= "COMMAND_SPAWN_FAILED";
      await terminate();
    });
    child.on("close", async () => {
      settleStartup();
      if (!terminationPromise) {
        reason ??= "COMMAND_SPAWN_FAILED";
        terminate();
      }
      await terminationPromise;
    });
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

if (process.argv[2] === COMMAND_SUPERVISOR_FLAG) {
  await runCommandSupervisor();
}

export async function listTrackedFiles(target, patterns, limits) {
  const [command, deletedCommand] = await Promise.all([
    runBoundedCommand("git", ["-C", target, "ls-files", "-z", "--", ...patterns], { cwd: target, ...limits }),
    runBoundedCommand("git", ["-C", target, "ls-files", "-z", "--deleted", "--", ...patterns], { cwd: target, ...limits }),
  ]);
  if (command.status === "error" || deletedCommand.status === "error") return command.status === "error" ? command : deletedCommand;
  if (command.exit_code !== 0 || deletedCommand.exit_code !== 0) return { status: "error", reason_code: "TRACKED_FILES_UNAVAILABLE" };
  const deleted = new Set(deletedCommand.stdout.split("\0").filter(Boolean));
  const files = command.stdout.split("\0").filter((relative) => relative && !deleted.has(relative)).sort();
  let realTarget;
  try {
    realTarget = await fs.realpath(target);
  } catch {
    return { status: "error", reason_code: "SOURCE_UNAVAILABLE" };
  }
  for (const relative of files) {
    const absolute = path.resolve(realTarget, relative);
    if (!isContained(realTarget, absolute)) return { status: "error", reason_code: "SOURCE_UNSAFE_PATH" };
    try {
      const real = await fs.realpath(absolute);
      if (!isContained(realTarget, real)) return { status: "error", reason_code: "SOURCE_UNSAFE_PATH" };
    } catch {
      return { status: "error", reason_code: "SOURCE_UNAVAILABLE" };
    }
  }
  return { status: "completed", files };
}
