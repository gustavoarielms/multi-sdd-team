#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkCodeGraph,
  checkProjectFiles,
  installProject,
  syncCodeGraph,
} from "../src/installer.js";
import { validateAgentResultText } from "../src/governance-validator.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

function usage() {
  return `sdd-codegraph

Usage:
  sdd-codegraph init [path]
  sdd-codegraph update [path]
  sdd-codegraph check [path]
  sdd-codegraph validate-result [file|-] [--agent <name>] [--runtime <runtime>]
  sdd-codegraph --version

Commands:
  init      Install managed Codex SDD files and initialize or sync CodeGraph.
  update    Refresh managed Codex SDD files and initialize or sync CodeGraph.
  check     Verify managed files and CodeGraph state without making changes.
  validate-result
            Validate one governance agent-result JSON document. Reads stdin by default.

The target path defaults to the current working directory.
`;
}

async function packageVersion() {
  const metadata = JSON.parse(await fs.readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  return metadata.version;
}

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function parseValidationArguments(args) {
  let file = "-";
  let expectedAgent;
  let expectedRuntime;
  let hasFile = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--agent") {
      expectedAgent = args[index + 1];
      if (!expectedAgent) throw new Error("--agent requires a value");
      index += 1;
      continue;
    }
    if (argument === "--runtime") {
      expectedRuntime = args[index + 1];
      if (!expectedRuntime) throw new Error("--runtime requires a value");
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    if (hasFile) throw new Error(`Unexpected argument: ${argument}`);
    file = argument;
    hasFile = true;
  }

  return { file, expectedAgent, expectedRuntime };
}

async function run() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(usage());
    return;
  }

  if (command === "-v" || command === "--version") {
    if (args.length > 0) throw new Error(`Unexpected argument: ${args[0]}`);
    process.stdout.write(`${await packageVersion()}\n`);
    return;
  }

  if (command === "validate-result") {
    const { file, expectedAgent, expectedRuntime } = parseValidationArguments(args);
    const input = file === "-" ? await readStdin() : await fs.readFile(path.resolve(file), "utf8");
    const validation = await validateAgentResultText(input, { expectedAgent, expectedRuntime });
    if (!validation.ok) {
      process.stderr.write(`Governance result rejected: ${validation.errors.join("; ")}\n`);
      process.exitCode = 1;
      return;
    }
    const role = validation.value.producer.role;
    const statuses = validation.value.gate_decisions.map((gate) => gate.status).join(", ") || "none";
    process.stdout.write(`Governance result valid for ${role}; gate status: ${statuses}.\n`);
    return;
  }

  const [target = process.cwd(), ...rest] = args;
  if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);

  if (command === "init" || command === "update") {
    const result = await installProject(target);
    const graphAction = syncCodeGraph(result.projectRoot);
    const changed = result.changed.length === 0 ? "no managed files changed" : result.changed.join(", ");
    process.stdout.write(`SDD ${command} complete: ${changed}; CodeGraph ${graphAction}.\n`);
    return;
  }

  if (command === "check") {
    const files = await checkProjectFiles(target);
    const graph = checkCodeGraph(files.projectRoot);
    if (files.drift.length === 0 && graph.ok) {
      process.stdout.write("SDD and CodeGraph check passed.\n");
      return;
    }

    if (files.drift.length > 0) {
      process.stderr.write(`Managed file drift: ${files.drift.join(", ")}\n`);
    }
    if (!graph.ok) process.stderr.write(`${graph.reason}\n`);
    process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
