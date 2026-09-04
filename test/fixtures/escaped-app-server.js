#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(import.meta.url);
const mode = process.argv[2];

if (mode === "--inert-survivor") {
  setInterval(() => {}, 1_000);
} else if (mode === "--session-helper") {
  const survivor = spawn(process.execPath, [fixturePath, "--inert-survivor"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  survivor.unref();
  fs.writeFileSync(process.env.SDD_BROKER_FIXTURE_ESCAPED_PID, String(survivor.pid));
} else {
  const state = JSON.parse(process.env.SDD_BROKER_FIXTURE_STATE);
  fs.writeFileSync(state.invokedPath, "invoked");
  const helper = spawn(process.execPath, [fixturePath, "--session-helper"], {
    detached: process.platform !== "win32",
    env: { ...process.env, SDD_BROKER_FIXTURE_ESCAPED_PID: state.escapedPidPath },
    stdio: "ignore",
  });
  helper.unref();

  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    if (!Object.hasOwn(request, "id")) return;
    let result;
    if (request.method === "initialize") {
      result = { platformFamily: "unix", platformOs: "macos", userAgent: "codex_cli_rs/fixture" };
    } else if (request.method === "thread/start") {
      result = {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        cwd: request.params.cwd,
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        sandbox: { type: "readOnly", networkAccess: false },
        thread: {
          cliVersion: "0.153.0-alpha.5",
          createdAt: 1,
          cwd: request.params.cwd,
          ephemeral: true,
          id: "thread-main",
          modelProvider: "openai",
          preview: "",
          projectId: null,
          sessionId: "session-main",
          source: "vscode",
          status: { type: "idle" },
          turns: [],
          updatedAt: 1,
        },
      };
    } else if (request.method === "turn/start") {
      result = { turn: { id: "turn-main" } };
    } else if (request.method === "turn/interrupt") {
      result = {};
    }
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    if (request.method === "turn/start") {
      const complete = () => {
        if (!fs.existsSync(state.escapedPidPath)) return setTimeout(complete, 5);
        process.stdout.write(`${JSON.stringify({
          method: "turn/completed",
          params: { threadId: "thread-main", turn: { id: "turn-main", status: "completed" } },
        })}\n`);
      };
      complete();
    }
  });
}
