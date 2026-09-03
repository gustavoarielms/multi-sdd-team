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
import { runGovernanceChecks } from "../src/governance-checks.js";
import { runEngineeringGates } from "../src/engineering-gates.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

function usage() {
  return `sdd-codegraph

Usage:
  sdd-codegraph init [path] [--permissions <profile>]
  sdd-codegraph update [path] [--permissions <profile>]
  sdd-codegraph check [path]
  sdd-codegraph check-governance [path]
  sdd-codegraph run-gates [path] [--comparison-base <full-commit-sha>]
  sdd-codegraph validate-result [file|-] [--agent <name>]
  sdd-codegraph --version

Commands:
  init      Install managed Codex SDD files and initialize or sync CodeGraph.
  update    Refresh managed Codex SDD files and initialize or sync CodeGraph.
  check     Verify managed files and CodeGraph state without making changes.
  check-governance
            Run deterministic governance checks and emit one canonical JSON result.
  run-gates
            Run the fail-closed deterministic engineering gates and emit one canonical JSON result.
  validate-result
            Validate one governance agent-result JSON document. Reads stdin by default.

The target path defaults to the current working directory.
Permission profiles: workspace-only (default), read-only, workspace, danger-full-access.
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
  let hasFile = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--agent") {
      expectedAgent = args[index + 1];
      if (!expectedAgent) throw new Error("--agent requires a value");
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    if (hasFile) throw new Error(`Unexpected argument: ${argument}`);
    file = argument;
    hasFile = true;
  }

  return { file, expectedAgent };
}

function parseRunGateArguments(args) {
  let target = process.cwd();
  let comparisonBase;
  let hasTarget = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--comparison-base") {
      comparisonBase = args[index + 1];
      if (!comparisonBase) throw new Error("--comparison-base requires a value");
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    if (hasTarget) throw new Error(`Unexpected argument: ${argument}`);
    target = argument;
    hasTarget = true;
  }
  return { target, comparisonBase };
}

async function validateResultCommand(args) {
  const { file, expectedAgent } = parseValidationArguments(args);
  const input = file === "-" ? await readStdin() : await fs.readFile(path.resolve(file), "utf8");
  const validation = await validateAgentResultText(input, { expectedAgent });
  if (!validation.ok) {
    process.stderr.write(`Governance result rejected: ${validation.errors.join("; ")}\n`);
    process.exitCode = 1;
    return;
  }
  const role = validation.value.producer.role;
  const statuses = validation.value.gate_decisions.map((gate) => gate.status).join(", ") || "none";
  process.stdout.write(`Governance result valid for ${role}; gate status: ${statuses}.\n`);
}

async function governanceCommand(args) {
  const [target = process.cwd(), ...rest] = args;
  if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);
  const result = await runGovernanceChecks(target);
  process.stdout.write(`${JSON.stringify(result.document)}\n`);
  if (!result.trusted) process.exitCode = 2;
  else if (result.blocking) process.exitCode = 1;
}

async function engineeringGatesCommand(args) {
  const { target, comparisonBase } = parseRunGateArguments(args);
  const result = await runEngineeringGates(target, { comparisonBase });
  process.stdout.write(`${JSON.stringify(result.document)}\n`);
  process.exitCode = result.exitCode;
}

function parseManagedInstallArguments(args) {
  let target = process.cwd();
  let permissions;
  let hasTarget = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--permissions") {
      permissions = args[index + 1];
      if (!permissions) throw new Error("--permissions requires a value");
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    if (hasTarget) throw new Error(`Unexpected argument: ${argument}`);
    target = argument;
    hasTarget = true;
  }
  return { target, permissions };
}

async function managedProjectCommand(command, args) {
  if (command === "init" || command === "update") {
    const { target, permissions } = parseManagedInstallArguments(args);
    const result = await installProject(target, { permissions });
    const graphAction = syncCodeGraph(result.projectRoot);
    const changed = result.changed.length === 0 ? "no managed files changed" : result.changed.join(", ");
    process.stdout.write(`SDD ${command} complete: ${changed}; CodeGraph ${graphAction}.\n`);
    return;
  }
  const [target = process.cwd(), ...rest] = args;
  if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);
  let files;
  try {
    files = await checkProjectFiles(target);
  } catch {
    process.stderr.write("Managed prompt protection: MANAGED_PROMPT_RUNTIME_UNPROVEN.\n");
    process.exitCode = 2;
    return;
  }
  if (!files.protection.trusted) {
    if (files.drift.length > 0) process.stderr.write(`Managed file drift: ${files.drift.join(", ")}\n`);
    process.stderr.write(`Managed prompt protection: ${files.protection.reason_code}.\n`);
    process.exitCode = 2;
    return;
  }
  const graph = checkCodeGraph(files.projectRoot);
  if (files.protection.trusted && files.drift.length === 0 && graph.ok) {
    process.stdout.write("SDD and CodeGraph check passed.\n");
    return;
  }
  if (files.drift.length > 0) process.stderr.write(`Managed file drift: ${files.drift.join(", ")}\n`);
  if (!graph.ok) process.stderr.write(`${graph.reason}\n`);
  process.exitCode = 1;
}

async function run() {
  const [requestedCommand, ...args] = process.argv.slice(2);
  const command = requestedCommand ?? "--help";
  switch (command) {
    case "-h":
    case "--help":
      process.stdout.write(usage());
      return;
    case "-v":
    case "--version":
      if (args.length > 0) throw new Error(`Unexpected argument: ${args[0]}`);
      process.stdout.write(`${await packageVersion()}\n`);
      return;
    case "validate-result":
      return validateResultCommand(args);
    case "check-governance":
      return governanceCommand(args);
    case "run-gates":
      return engineeringGatesCommand(args);
    case "init":
    case "update":
    case "check":
      return managedProjectCommand(command, args);
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
