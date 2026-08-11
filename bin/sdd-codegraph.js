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

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

function usage() {
  return `sdd-codegraph

Usage:
  sdd-codegraph init [path]
  sdd-codegraph update [path]
  sdd-codegraph check [path]
  sdd-codegraph --version

Commands:
  init      Install managed Codex SDD files and initialize or sync CodeGraph.
  update    Refresh managed Codex SDD files and initialize or sync CodeGraph.
  check     Verify managed files and CodeGraph state without making changes.

The target path defaults to the current working directory.
`;
}

async function packageVersion() {
  const metadata = JSON.parse(await fs.readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  return metadata.version;
}

async function run() {
  const [command, target = process.cwd(), ...rest] = process.argv.slice(2);

  if (rest.length > 0) throw new Error(`Unexpected argument: ${rest[0]}`);

  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(usage());
    return;
  }

  if (command === "-v" || command === "--version") {
    process.stdout.write(`${await packageVersion()}\n`);
    return;
  }

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
