import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

const WINDOWS_TREE_KILL_TIMEOUT_MS = 5000;

function windowsTreeKillerPath() {
  const systemRoot = typeof process.env.SystemRoot === "string" && path.win32.isAbsolute(process.env.SystemRoot)
    ? process.env.SystemRoot
    : "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "taskkill.exe");
}

function validWindowsTreeKiller(executable) {
  return typeof executable === "string"
    && path.win32.isAbsolute(executable)
    && path.win32.basename(executable).toLowerCase() === "taskkill.exe"
    && path.win32.basename(path.win32.dirname(executable)).toLowerCase() === "system32";
}

async function terminateWindowsWithSystemTool({ executable, args }) {
  spawnSync(executable, args, {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
    timeout: WINDOWS_TREE_KILL_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}

function resolvedTerminationControl(injected) {
  return {
    platform: injected?.platform ?? process.platform,
    windowsExecutable: injected?.windowsExecutable ?? windowsTreeKillerPath(),
    terminateWindows: injected?.terminateWindows ?? terminateWindowsWithSystemTool,
  };
}

async function terminateProcessTree(child, control) {
  if (!child?.pid) return;
  if (control.platform === "win32") {
    if (!validWindowsTreeKiller(control.windowsExecutable)) throw new Error("unsafe Windows tree killer path");
    await control.terminateWindows({
      executable: control.windowsExecutable,
      args: ["/pid", String(child.pid), "/t", "/f"],
      pid: child.pid,
      timeoutMs: WINDOWS_TREE_KILL_TIMEOUT_MS,
    });
    try { child.kill("SIGKILL"); } catch { /* The root already exited with its tree. */ }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* The process group already exited. */ }
  }
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
  const terminationControl = resolvedTerminationControl(injectedTerminationControl);
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputBytes = 0;
    let reason;
    let child;
    let timer;
    let terminationPromise;

    const terminate = () => {
      terminationPromise ??= terminateProcessTree(child, terminationControl).catch(() => {
        try { child?.kill("SIGKILL"); } catch { /* The root already exited. */ }
      });
      return terminationPromise;
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ ...result, duration_ms: Math.max(0, Date.now() - started) });
    };

    const abort = () => {
      if (settled || reason) return;
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

    try {
      child = spawn(executable, args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        shell: false,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch {
      finish({ status: "error", reason_code: "COMMAND_SPAWN_FAILED" });
      return;
    }

    timer = setTimeout(() => {
      if (settled || reason) return;
      reason = "COMMAND_TIMEOUT";
      terminate();
    }, timeoutMs);

    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.on("error", async () => {
      if (reason) await terminationPromise;
      finish({ status: "error", reason_code: reason ?? "COMMAND_SPAWN_FAILED" });
    });
    child.on("close", async (code, signal) => {
      if (reason) {
        await terminationPromise;
        finish({ status: "error", reason_code: reason });
        return;
      }
      if (signal) {
        finish({ status: "error", reason_code: "COMMAND_SIGNALLED" });
        return;
      }
      finish({
        status: "completed",
        exit_code: code ?? 1,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
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
