import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function runBoundedCommand(executable, args, options) {
  const {
    cwd,
    timeoutMs,
    maxOutputBytes,
    env = process.env,
    input,
  } = options;
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let outputBytes = 0;
    let reason;
    let child;
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, duration_ms: Math.max(0, Date.now() - started) });
    };

    const capture = (stream, chunk) => {
      if (settled || reason) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        reason = "COMMAND_OUTPUT_LIMIT";
        child.kill("SIGKILL");
        return;
      }
      if (stream === "stdout") stdout = Buffer.concat([stdout, chunk]);
      else stderr = Buffer.concat([stderr, chunk]);
    };

    try {
      child = spawn(executable, args, {
        cwd,
        env,
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
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.on("error", () => finish({ status: "error", reason_code: "COMMAND_SPAWN_FAILED" }));
    child.on("close", (code, signal) => {
      if (reason) {
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
  const command = await runBoundedCommand("git", ["-C", target, "ls-files", "-z", "--", ...patterns], {
    cwd: target,
    ...limits,
  });
  if (command.status === "error") return command;
  if (command.exit_code !== 0) return { status: "error", reason_code: "TRACKED_FILES_UNAVAILABLE" };
  const files = command.stdout.split("\0").filter(Boolean).sort();
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
